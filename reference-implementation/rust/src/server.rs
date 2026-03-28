use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use rmcp::{
    model::*,
    service::{Peer, RequestContext, RoleServer},
    tool, Error as McpError, ServerHandler,
};

use crate::helpers::{apex_error, hours_from_now, json_result, now_iso};
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
            instructions: None,
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
