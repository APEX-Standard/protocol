use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use rmcp::{
    model::*,
    service::{Peer, RequestContext, RoleServer},
    tool, Error as McpError, ServerHandler,
};

use crate::helpers::{apex_error, hours_from_now, json_result, next_funding_time, next_rollover_time, now_iso};
use crate::models::*;
use crate::state::{ReferenceTradingState, ACCOUNT_ID, BROKER_SYMBOL, INSTRUMENT_ID};

#[derive(Debug, Clone)]
pub struct ApexServer {
    state: Arc<ReferenceTradingState>,
    peer: Arc<Mutex<Option<Peer<RoleServer>>>>,
    subscriptions: Arc<Mutex<HashSet<String>>>,
}

impl ApexServer {
    pub fn new() -> Self {
        Self {
            state: Arc::new(ReferenceTradingState::default()),
            peer: Arc::new(Mutex::new(None)),
            subscriptions: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    async fn notify_updates(&self, uris: Vec<String>) {
        let subscribed = {
            let subscriptions = self
                .subscriptions
                .lock()
                .expect("subscription mutex poisoned");
            uris.into_iter()
                .filter(|uri| subscriptions.contains(uri))
                .collect::<Vec<_>>()
        };

        let peer = {
            let peer = self.peer.lock().expect("peer mutex poisoned");
            peer.clone()
        };

        if let Some(peer) = peer {
            for uri in subscribed {
                let _ = peer
                    .notify_resource_updated(ResourceUpdatedNotificationParam { uri })
                    .await;
            }
        }
    }
}

// NOTE: Tool annotations (readOnlyHint, destructiveHint, idempotentHint) per the MCP spec
// are not yet supported by the rmcp 0.1.x `#[tool]` macro.  The `Tool` struct in rmcp 0.1.5
// lacks an `annotations` field, so there is no way to attach them via the proc-macro today.
//
// Annotations ARE emitted in the HTTP/Streamable-HTTP transport (see transport/http.rs) where
// tool descriptors are built manually as JSON.  When a future rmcp release adds annotation
// support to the macro, each `#[tool(...)]` below should be extended, e.g.:
//
//   #[tool(name = "...", description = "...", annotations(read_only = true, destructive = false, idempotent = true))]
//
// Desired annotation mapping for reference:
//   readOnly=true, destructive=false, idempotent=true:
//     session.capabilities, session.heartbeat, session.acknowledge,
//     account.summary, account.positions, account.orders, account.history,
//     order.status, market.quote, market.snapshot, market.search, market.details,
//     risk.check, risk.limits, fx.rollover, fx.exposure, fx.conversion,
//     cfd.corporate_actions, cfd.dividend_adjustment,
//     crypto.funding_rate, crypto.liquidation_estimate
//   readOnly=false, destructive=false, idempotent=true:
//     session.authenticate
//   readOnly=false, destructive=true, idempotent=false:
//     order.place, order.modify, position.close
//   readOnly=false, destructive=true, idempotent=true:
//     order.cancel
//   readOnly=false, destructive=false, idempotent=false:
//     crypto.transfer

#[tool(tool_box)]
impl ApexServer {
    #[tool(
        name = "apex.session.authenticate",
        description = "Establish an authenticated trading session. The broker validates credentials directly and binds the result to the MCP session."
    )]
    async fn session_authenticate(
        &self,
        #[tool(aggr)] input: AuthenticateInput,
    ) -> Result<CallToolResult, McpError> {
        if input.token.len() < 10 {
            return Ok(json_result(&apex_error(
                "APEX_4001",
                "auth",
                "Invalid or expired token",
                None,
            )));
        }

        Ok(json_result(&SessionResponse {
            session_id: uuid::Uuid::new_v4().to_string(),
            account_id: input.account_id.unwrap_or_else(|| ACCOUNT_ID.to_owned()),
            expires_at: hours_from_now(1),
            capabilities: CORE_CAPABILITIES
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            profiles: vec!["fx".to_owned()],
            broker_id: "reference-broker".to_owned(),
            broker_name: "APEX Reference Broker".to_owned(),
        }))
    }

    #[tool(
        name = "apex.session.capabilities",
        description = "Query the full capability manifest of this broker implementation."
    )]
    async fn session_capabilities(&self) -> Result<CallToolResult, McpError> {
        Ok(json_result(&CapabilitiesResponse {
            apex_version: SERVER_VERSION.to_owned(),
            broker_id: "reference-broker".to_owned(),
            core_tools: CORE_CAPABILITIES
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            profiles: serde_json::json!({ "fx": SERVER_VERSION }),
            vendor_extensions: None,
            rate_limits: serde_json::json!({
                "orders_per_second": 10,
                "market_data_per_second": 100
            }),
            supported_order_types: vec![
                "market".to_owned(),
                "limit".to_owned(),
                "stop".to_owned(),
                "stop_limit".to_owned(),
            ],
            supported_tif: vec![
                "GTC".to_owned(),
                "IOC".to_owned(),
                "FOK".to_owned(),
                "DAY".to_owned(),
            ],
            production_profiles: serde_json::json!({
                "realtime": true,
                "autonomous": false
            }),
            realtime_contract: serde_json::json!({
                "transport_mode": "stdio",
                "reconnect_mode": "no_replay",
                "quote_freshness_ms": 1000,
                "account_freshness_ms": 2000
            }),
        }))
    }

    #[tool(
        name = "apex.session.heartbeat",
        description = "Keep-alive ping. Hub marks session degraded if response exceeds 500ms."
    )]
    async fn session_heartbeat(
        &self,
        #[tool(aggr)] _input: HeartbeatInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&HeartbeatResponse {
            timestamp: now_iso(),
            status: "ok".to_owned(),
        }))
    }

    #[tool(
        name = "apex.session.acknowledge",
        description = "Acknowledge receipt of SSE events. Server discards acknowledged events."
    )]
    async fn session_acknowledge(
        &self,
        #[tool(aggr)] _input: AcknowledgeInput,
    ) -> Result<CallToolResult, McpError> {
        // No-op in stdio mode (no replay buffer)
        Ok(json_result(&serde_json::json!({
            "acknowledged_through": "0",
            "buffer_depth": 0,
        })))
    }

    #[tool(
        name = "reference.test.set_realtime_state",
        description = "Reference-only fault injection for conformance and resilience testing."
    )]
    async fn reference_set_realtime_state(
        &self,
        #[tool(aggr)] input: ReferenceRealtimeStateInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&serde_json::json!({
            "ok": true,
            "faults": self
                .state
                .set_faults(
                    input.quote_stale,
                    input.risk_stale,
                    input.force_sequence_gap,
                    input.kill_switch_active,
                    input.partial_fill_next_order,
                ),
        })))
    }

    #[tool(
        name = "apex.account.summary",
        description = "Current account state — balances, margin utilisation, equity."
    )]
    async fn account_summary(
        &self,
        #[tool(aggr)] input: AccountSummaryInput,
    ) -> Result<CallToolResult, McpError> {
        if input.account_id.is_empty() {
            return Ok(json_result(&apex_error("APEX_4011", "validation", "account_id is required", None)));
        }
        Ok(json_result(
            &self.state.account_summary_payload(input.currency),
        ))
    }

    #[tool(
        name = "apex.account.positions",
        description = "All open positions with live P&L."
    )]
    async fn account_positions(
        &self,
        #[tool(aggr)] _input: AccountPositionsInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&self.state.positions_payload()))
    }

    #[tool(
        name = "apex.account.orders",
        description = "Known orders and their current lifecycle state."
    )]
    async fn account_orders(
        &self,
        #[tool(aggr)] _input: AccountOrdersInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&self.state.orders_payload()))
    }

    #[tool(
        name = "apex.account.history",
        description = "Closed trades and funding events."
    )]
    async fn account_history(
        &self,
        #[tool(aggr)] _input: AccountHistoryInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&AccountHistoryResponse {
            events: vec![],
            next_cursor: None,
            has_more: false,
        }))
    }

    #[tool(
        name = "apex.order.place",
        description = "Unified order entry across all asset classes. Profile-composable."
    )]
    async fn order_place(
        &self,
        #[tool(aggr)] input: OrderPlaceInput,
    ) -> Result<CallToolResult, McpError> {
        if let Err((code, category, message)) = self.state.order_acceptance() {
            return Ok(json_result(&apex_error(code, category, message, None)));
        }

        if input.order.order_type == "limit" && input.order.limit_price.is_none() {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "limit_price required for limit orders",
                None,
            )));
        }

        let order_value = serde_json::to_value(&input.order).expect("order should serialize");
        let (payload, updates) = self.state.create_order(&order_value);
        self.notify_updates(updates).await;
        Ok(json_result(&payload))
    }

    #[tool(
        name = "apex.order.modify",
        description = "Amend a working order or an open position's protection settings."
    )]
    async fn order_modify(
        &self,
        #[tool(aggr)] input: OrderModifyInput,
    ) -> Result<CallToolResult, McpError> {
        if input.target_type == "position"
            && (input.modifications.limit_price.is_some()
                || input.modifications.stop_price.is_some()
                || input.modifications.quantity.is_some())
        {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "positions may only amend stop_loss, take_profit, or trailing_stop",
                None,
            )));
        }

        let updates = self.state.modify_order(&input.target_id);
        self.notify_updates(updates).await;

        Ok(json_result(&OrderModifyResponse {
            target_type: input.target_type,
            target_id: input.target_id,
            status: "modified".to_owned(),
            rejection_reason: None,
            updated_at: now_iso(),
        }))
    }

    #[tool(
        name = "apex.order.cancel",
        description = "Cancel a working or partially filled order."
    )]
    async fn order_cancel(
        &self,
        #[tool(aggr)] input: OrderCancelInput,
    ) -> Result<CallToolResult, McpError> {
        let updates = self.state.cancel_order(&input.order_id);
        self.notify_updates(updates).await;

        Ok(json_result(&OrderCancelResponse {
            order_id: input.order_id,
            status: "cancelled".to_owned(),
            rejection_reason: None,
            cancelled_at: now_iso(),
        }))
    }

    #[tool(
        name = "apex.position.close",
        description = "Close an open position fully or partially by placing an opposite-direction market order."
    )]
    async fn position_close(
        &self,
        #[tool(aggr)] input: PositionCloseInput,
    ) -> Result<CallToolResult, McpError> {
        if let Err((code, category, message)) = self.state.order_acceptance() {
            return Ok(json_result(&apex_error(code, category, message, None)));
        }

        let (instrument_id, side, total_quantity) =
            match self.state.find_position(&input.position_id) {
                Some(pos) => pos,
                None => {
                    return Ok(json_result(&apex_error(
                        "APEX_4011",
                        "validation",
                        &format!("Unknown position: {}", input.position_id),
                        None,
                    )));
                }
            };

        let close_quantity = input.quantity.unwrap_or(total_quantity);
        let close_side = if side == "buy" { "sell" } else { "buy" };

        let (order_payload, updates) = self.state.close_position(
            &input.position_id,
            close_quantity,
            &instrument_id,
            close_side,
        );
        self.notify_updates(updates).await;

        let remaining = total_quantity - close_quantity;
        let status = if remaining <= 0.0 { "filled" } else { "partially_filled" };

        Ok(json_result(&PositionCloseResponse {
            order_id: order_payload["order_id"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            position_id: input.position_id,
            status: status.to_owned(),
            fill_price: order_payload["fill_price"].as_f64().unwrap_or(1.08755),
            fill_quantity: close_quantity,
            remaining_quantity: if remaining > 0.0 { remaining } else { 0.0 },
            closed_at: now_iso(),
        }))
    }

    #[tool(
        name = "apex.order.status",
        description = "Query the current state of a single order."
    )]
    async fn order_status(
        &self,
        #[tool(aggr)] input: OrderStatusInput,
    ) -> Result<CallToolResult, McpError> {
        match self.state.order_status_payload(&input.order_id) {
            Some(order) => Ok(json_result(&order)),
            None => Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                &format!("Unknown order: {}", input.order_id),
                None,
            ))),
        }
    }

    #[tool(
        name = "apex.market.quote",
        description = "Current bid/ask/mid for an instrument."
    )]
    async fn market_quote(
        &self,
        #[tool(aggr)] input: MarketQuoteInput,
    ) -> Result<CallToolResult, McpError> {
        // Validate instrument
        let has_id = input.instrument_id.as_deref().is_some_and(|s| !s.is_empty());
        let has_sym = input.broker_symbol.as_deref().is_some_and(|s| !s.is_empty());
        if !has_id && !has_sym {
            return Ok(json_result(&apex_error("APEX_4010", "validation", "Unknown instrument", None)));
        }
        if has_id && input.instrument_id.as_deref() != Some(INSTRUMENT_ID) {
            return Ok(json_result(&apex_error("APEX_4010", "validation", "Unknown instrument", None)));
        }
        if !has_id && input.broker_symbol.as_deref() != Some(BROKER_SYMBOL) {
            return Ok(json_result(&apex_error("APEX_4010", "validation", "Unknown instrument", None)));
        }

        Ok(json_result(
            &self
                .state
                .quote_payload(input.instrument_id, input.broker_symbol),
        ))
    }

    #[tool(
        name = "apex.market.snapshot",
        description = "OHLCV candle data for an instrument."
    )]
    async fn market_snapshot(
        &self,
        #[tool(aggr)] input: MarketSnapshotInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&MarketSnapshotResponse {
            instrument_id: input.instrument_id,
            timeframe: input.timeframe,
            candles: vec![],
        }))
    }

    #[tool(
        name = "apex.market.search",
        description = "Discover instruments by keyword, asset class, or profile."
    )]
    async fn market_search(
        &self,
        #[tool(aggr)] input: MarketSearchInput,
    ) -> Result<CallToolResult, McpError> {
        let instruments = if !input.query.is_empty() && "EURUSD".contains(&input.query.to_uppercase()) {
            vec![SearchInstrument {
                instrument_id: INSTRUMENT_ID.to_owned(),
                broker_symbol: BROKER_SYMBOL.to_owned(),
                display_name: "Euro / US Dollar".to_owned(),
                profile: "fx".to_owned(),
                is_tradeable: true,
            }]
        } else {
            vec![]
        };

        Ok(json_result(&MarketSearchResponse { instruments }))
    }

    #[tool(
        name = "apex.market.details",
        description = "Full contract specification for an instrument."
    )]
    async fn market_details(
        &self,
        #[tool(aggr)] input: MarketDetailsInput,
    ) -> Result<CallToolResult, McpError> {
        if input.instrument_id != INSTRUMENT_ID {
            return Ok(json_result(&apex_error("APEX_4010", "validation", "Unknown instrument", None)));
        }

        Ok(json_result(&MarketDetailsResponse {
            instrument_id: input.instrument_id,
            broker_symbol: BROKER_SYMBOL.to_owned(),
            display_name: "Euro / US Dollar".to_owned(),
            profile: "fx".to_owned(),
            base_currency: "EUR".to_owned(),
            quote_currency: "USD".to_owned(),
            pip_size: 0.0001,
            lot_size: 100000,
            quantity_unit: "base_units".to_owned(),
            broker_quantity_unit: "lots".to_owned(),
            min_quantity: 1000,
            max_quantity: 50000000,
            quantity_step: 1000,
            margin_rate_pct: 0.5,
            commission_per_lot: 0.0,
            spread_type: "variable".to_owned(),
            typical_spread_pips: 0.8,
            trading_hours: vec![TradingHours {
                day: "monday".to_owned(),
                open: "00:00".to_owned(),
                close: "23:59".to_owned(),
                timezone: "UTC".to_owned(),
            }],
            profile_data: serde_json::json!({}),
        }))
    }

    #[tool(
        name = "apex.risk.check",
        description = "Pre-trade margin and exposure check. Call before placing large orders."
    )]
    async fn risk_check(
        &self,
        #[tool(aggr)] input: RiskCheckInput,
    ) -> Result<CallToolResult, McpError> {
        let required_margin = (input.order.quantity / 100000.0) * 500.0;
        let available_margin = 9750.0;

        Ok(json_result(&RiskCheckResponse {
            approved: true,
            required_margin,
            available_margin,
            margin_after_trade: available_margin - required_margin,
            exposure_increase: input.order.quantity,
            warnings: vec![],
            rejection_reason: None,
        }))
    }

    #[tool(
        name = "apex.risk.limits",
        description = "Current account-level risk limits and utilisation."
    )]
    async fn risk_limits(
        &self,
        #[tool(aggr)] input: RiskLimitsInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&RiskLimitsResponse {
            account_id: input.account_id,
            max_position_size: 5000000,
            max_open_orders: 50,
            daily_loss_limit: -1000.0,
            daily_loss_used: -150.0,
            margin_call_level_pct: 100,
            stop_out_level_pct: 50,
            restricted_instruments: vec![],
            kill_switch_active: self
                .state
                .read_resource_payload(&crate::state::risk_uri())
                .and_then(|payload| payload["kill_switch_active"].as_bool())
                .unwrap_or(false),
        }))
    }

    #[tool(
        name = "apex.fx.rollover",
        description = "Query swap/rollover rates for an FX instrument. Rates are expressed in account currency per lot per night."
    )]
    async fn fx_rollover(
        &self,
        #[tool(aggr)] input: FxRolloverInput,
    ) -> Result<CallToolResult, McpError> {
        if input.instrument_id != INSTRUMENT_ID {
            return Ok(json_result(&apex_error(
                "APEX_4010",
                "validation",
                "Unknown instrument",
                None,
            )));
        }

        Ok(json_result(&FxRolloverResponse {
            instrument_id: INSTRUMENT_ID.to_owned(),
            broker_symbol: BROKER_SYMBOL.to_owned(),
            rollover_long: -0.5,
            rollover_short: 0.3,
            rollover_currency: "USD".to_owned(),
            rollover_per: "lot".to_owned(),
            lot_size: 100000,
            triple_rollover_day: "Wednesday".to_owned(),
            next_rollover_time: next_rollover_time(),
            as_of: now_iso(),
        }))
    }

    #[tool(
        name = "apex.fx.exposure",
        description = "Net currency exposure across open FX positions. Critical for agents managing portfolio-level currency risk."
    )]
    async fn fx_exposure(
        &self,
        #[tool(aggr)] input: FxExposureInput,
    ) -> Result<CallToolResult, McpError> {
        if input.account_id.is_empty() {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "account_id is required",
                None,
            )));
        }

        let positions_payload = self.state.positions_payload();
        let positions = positions_payload["positions"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        let mut eur_net_units: i64 = 0;
        let mut contributing_positions = vec![];

        for pos in &positions {
            if pos["instrument_id"].as_str() == Some(INSTRUMENT_ID) {
                let qty = pos["quantity"].as_i64().unwrap_or(0);
                let side = pos["side"].as_str().unwrap_or("");
                if side == "buy" {
                    eur_net_units += qty;
                } else {
                    eur_net_units -= qty;
                }
                if let Some(pid) = pos["position_id"].as_str() {
                    contributing_positions.push(pid.to_owned());
                }
            }
        }

        let rate = 1.0875_f64;
        let value_in_base = if input.base_currency == "EUR" {
            eur_net_units as f64
        } else {
            eur_net_units as f64 * rate
        };

        let net_direction = if eur_net_units > 0 {
            "long"
        } else if eur_net_units < 0 {
            "short"
        } else {
            "flat"
        };

        Ok(json_result(&FxExposureResponse {
            account_id: input.account_id,
            base_currency: input.base_currency,
            exposures: vec![ExposureEntry {
                currency: "EUR".to_owned(),
                net_units: eur_net_units,
                net_direction: net_direction.to_owned(),
                value_in_base,
                contributing_positions,
            }],
            total_gross_exposure: value_in_base.abs(),
            as_of: now_iso(),
        }))
    }

    #[tool(
        name = "apex.fx.conversion",
        description = "Real-time cross-currency conversion rate. Used by agents to calculate P&L in a target currency."
    )]
    async fn fx_conversion(
        &self,
        #[tool(aggr)] input: FxConversionInput,
    ) -> Result<CallToolResult, McpError> {
        if input.from_currency.is_empty() || input.to_currency.is_empty() {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "from_currency, to_currency, and amount are all required",
                None,
            )));
        }

        let mid_rate = 1.0875_f64;
        let rate = if input.from_currency == input.to_currency {
            1.0
        } else if input.from_currency == "EUR" && input.to_currency == "USD" {
            mid_rate
        } else if input.from_currency == "USD" && input.to_currency == "EUR" {
            1.0 / mid_rate
        } else {
            return Ok(json_result(&apex_error(
                "APEX_4010",
                "validation",
                "Unsupported currency pair",
                None,
            )));
        };

        Ok(json_result(&FxConversionResponse {
            from_currency: input.from_currency,
            to_currency: input.to_currency,
            rate: (rate * 10_000_000.0).round() / 10_000_000.0,
            converted_amount: (input.amount * rate * 100.0).round() / 100.0,
            timestamp: now_iso(),
        }))
    }

    // CFD profile tools

    #[tool(
        name = "apex.cfd.corporate_actions",
        description = "Query upcoming corporate actions for CFD instruments. Reference implementation returns an empty array."
    )]
    async fn cfd_corporate_actions(
        &self,
        #[tool(aggr)] input: CfdCorporateActionsInput,
    ) -> Result<CallToolResult, McpError> {
        if input.account_id.is_empty() {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "account_id is required",
                None,
            )));
        }

        Ok(json_result(&CfdCorporateActionsResponse {
            corporate_actions: vec![],
        }))
    }

    #[tool(
        name = "apex.cfd.dividend_adjustment",
        description = "Query dividend adjustments for CFD positions. Reference implementation returns an empty array."
    )]
    async fn cfd_dividend_adjustment(
        &self,
        #[tool(aggr)] input: CfdDividendAdjustmentInput,
    ) -> Result<CallToolResult, McpError> {
        if input.account_id.is_empty() {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "account_id is required",
                None,
            )));
        }

        Ok(json_result(&CfdDividendAdjustmentResponse {
            adjustments: vec![],
        }))
    }

    // Crypto profile tools

    #[tool(
        name = "apex.crypto.funding_rate",
        description = "Query funding rate for a perpetual instrument. Returns simulated data for BTCUSDT."
    )]
    async fn crypto_funding_rate(
        &self,
        #[tool(aggr)] input: CryptoFundingRateInput,
    ) -> Result<CallToolResult, McpError> {
        const PERP_INSTRUMENT_ID: &str = "APEX:CRYPTO:PERP:BTCUSDT";
        const PERP_BROKER_SYMBOL: &str = "BTCUSDT";

        if input.instrument_id != PERP_INSTRUMENT_ID {
            return Ok(json_result(&apex_error(
                "APEX_4010",
                "validation",
                "Unknown instrument",
                None,
            )));
        }

        let (funding_time, countdown) = next_funding_time();

        Ok(json_result(&CryptoFundingRateResponse {
            instrument_id: PERP_INSTRUMENT_ID.to_owned(),
            broker_symbol: PERP_BROKER_SYMBOL.to_owned(),
            current_rate: 0.0001,
            current_rate_annualised: 0.1095,
            predicted_rate: 0.00012,
            funding_interval_hours: 8,
            next_funding_time: funding_time,
            countdown_seconds: countdown,
            index_price: 50000.00,
            mark_price: 50050.00,
            timestamp: now_iso(),
        }))
    }

    #[tool(
        name = "apex.crypto.liquidation_estimate",
        description = "Estimate liquidation price for a perpetual position based on leverage and margin mode."
    )]
    async fn crypto_liquidation_estimate(
        &self,
        #[tool(aggr)] input: CryptoLiquidationEstimateInput,
    ) -> Result<CallToolResult, McpError> {
        const PERP_INSTRUMENT_ID: &str = "APEX:CRYPTO:PERP:BTCUSDT";

        if input.instrument_id != PERP_INSTRUMENT_ID {
            return Ok(json_result(&apex_error(
                "APEX_4010",
                "validation",
                "Unknown instrument",
                None,
            )));
        }

        let margin_required = (input.entry_price * input.quantity) / input.leverage;
        let maintenance_margin = margin_required / 2.0;

        let liquidation_price = if input.side == "buy" {
            input.entry_price * (1.0 - (1.0 / input.leverage) * 0.95)
        } else {
            input.entry_price * (1.0 + (1.0 / input.leverage) * 0.95)
        };
        let liquidation_price = (liquidation_price * 100.0).round() / 100.0;

        let distance_pct = ((input.entry_price - liquidation_price).abs() / input.entry_price * 100.0 * 100.0).round() / 100.0;

        Ok(json_result(&CryptoLiquidationEstimateResponse {
            instrument_id: PERP_INSTRUMENT_ID.to_owned(),
            side: input.side,
            entry_price: input.entry_price,
            liquidation_price,
            margin_required: (margin_required * 100.0).round() / 100.0,
            maintenance_margin: (maintenance_margin * 100.0).round() / 100.0,
            margin_currency: "USDT".to_owned(),
            distance_pct,
            warnings: vec![],
        }))
    }

    #[tool(
        name = "apex.crypto.transfer",
        description = "Transfer funds between wallets (spot, futures, funding). Reference implementation simulates instant completion."
    )]
    async fn crypto_transfer(
        &self,
        #[tool(aggr)] input: CryptoTransferInput,
    ) -> Result<CallToolResult, McpError> {
        if input.account_id.is_empty()
            || input.from_wallet.is_empty()
            || input.to_wallet.is_empty()
            || input.currency.is_empty()
        {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "All fields are required: account_id, from_wallet, to_wallet, currency, amount",
                None,
            )));
        }

        if input.from_wallet == input.to_wallet {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "from_wallet and to_wallet must be different",
                None,
            )));
        }

        Ok(json_result(&CryptoTransferResponse {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            from_wallet: input.from_wallet,
            to_wallet: input.to_wallet,
            currency: input.currency,
            amount: input.amount,
            status: "completed".to_owned(),
            rejection_reason: None,
            completed_at: now_iso(),
        }))
    }
}

#[tool(tool_box)]
impl ServerHandler for ApexServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_resources_subscribe()
                .enable_resources_list_changed()
                .build(),
            server_info: Implementation {
                name: SERVER_NAME.to_owned(),
                version: SERVER_VERSION.to_owned(),
            },
            instructions: Some(
                serde_json::json!({ "apex_version": "0.1.0-alpha" }).to_string(),
            ),
        }
    }

    fn set_peer(&mut self, peer: Peer<RoleServer>) {
        *self.peer.lock().expect("peer mutex poisoned") = Some(peer);
    }

    fn get_peer(&self) -> Option<Peer<RoleServer>> {
        self.peer.lock().expect("peer mutex poisoned").clone()
    }

    async fn list_resources(
        &self,
        _request: PaginatedRequestParam,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let resources = self
            .state
            .list_resources()
            .into_iter()
            .map(|(name, uri, description)| {
                RawResource::new(uri, name)
                    .no_annotation()
                    .with_description(Some(description))
                    .with_mime_type(Some("application/json".to_owned()))
            })
            .collect();

        Ok(ListResourcesResult {
            next_cursor: None,
            resources,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParam,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        let payload = self
            .state
            .read_resource_payload(&request.uri)
            .ok_or_else(|| McpError::resource_not_found("Resource not found", None))?;

        Ok(ReadResourceResult {
            contents: vec![ResourceContents::TextResourceContents {
                uri: request.uri,
                mime_type: Some("application/json".to_owned()),
                text: serde_json::to_string(&payload).expect("resource payload should serialize"),
            }],
        })
    }

    async fn subscribe(
        &self,
        request: SubscribeRequestParam,
        _context: RequestContext<RoleServer>,
    ) -> Result<(), McpError> {
        self.subscriptions
            .lock()
            .expect("subscription mutex poisoned")
            .insert(request.uri);
        Ok(())
    }

    async fn unsubscribe(
        &self,
        request: UnsubscribeRequestParam,
        _context: RequestContext<RoleServer>,
    ) -> Result<(), McpError> {
        self.subscriptions
            .lock()
            .expect("subscription mutex poisoned")
            .remove(&request.uri);
        Ok(())
    }
}

trait ResourceExt {
    fn with_description(self, description: Option<String>) -> Self;
    fn with_mime_type(self, mime_type: Option<String>) -> Self;
}

impl ResourceExt for Resource {
    fn with_description(mut self, description: Option<String>) -> Self {
        self.raw.description = description;
        self
    }

    fn with_mime_type(mut self, mime_type: Option<String>) -> Self {
        self.raw.mime_type = mime_type;
        self
    }
}
