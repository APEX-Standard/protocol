use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    service::{Peer, RequestContext, RoleServer},
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};

use crate::handlers;
use crate::helpers::json_result;
use crate::models::*;

#[derive(Debug, Clone)]
pub struct ApexServer {
    state: Arc<crate::state::ReferenceTradingState>,
    peer: Arc<Mutex<Option<Peer<RoleServer>>>>,
    subscriptions: Arc<Mutex<HashSet<String>>>,
    tool_router: ToolRouter<Self>,
}

impl ApexServer {
    pub fn new() -> Self {
        Self {
            state: Arc::new(crate::state::ReferenceTradingState::default()),
            peer: Arc::new(Mutex::new(None)),
            subscriptions: Arc::new(Mutex::new(HashSet::new())),
            tool_router: Self::tool_router(),
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

#[tool_router]
impl ApexServer {
    #[tool(
        name = "apex.session.authenticate",
        description = "Establish an authenticated trading session. The broker validates credentials directly and binds the result to the MCP session.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn session_authenticate(
        &self,
        Parameters(input): Parameters<AuthenticateInput>,
    ) -> Result<CallToolResult, McpError> {
        let payload = handlers::handle_authenticate(
            &self.state,
            &input.token,
            input.account_id.as_deref(),
        );
        Ok(json_result(&payload))
    }

    #[tool(
        name = "apex.session.capabilities",
        description = "Query the full capability manifest of this broker implementation.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn session_capabilities(&self) -> Result<CallToolResult, McpError> {
        let payload = handlers::handle_capabilities("stdio");
        Ok(json_result(&payload))
    }

    #[tool(
        name = "apex.session.heartbeat",
        description = "Keep-alive ping. Hub marks session degraded if response exceeds 500ms.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn session_heartbeat(
        &self,
        Parameters(_input): Parameters<HeartbeatInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_heartbeat()))
    }

    #[tool(
        name = "apex.session.acknowledge",
        description = "Acknowledge receipt of SSE events. Server discards acknowledged events.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn session_acknowledge(
        &self,
        Parameters(_input): Parameters<AcknowledgeInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_acknowledge_stdio()))
    }

    #[tool(
        name = "reference.test.set_realtime_state",
        description = "Reference-only fault injection for conformance and resilience testing.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn reference_set_realtime_state(
        &self,
        Parameters(input): Parameters<ReferenceRealtimeStateInput>,
    ) -> Result<CallToolResult, McpError> {
        let payload = handlers::handle_set_realtime_state(
            &self.state,
            input.quote_stale,
            input.risk_stale,
            input.force_sequence_gap,
            input.kill_switch_active,
            input.partial_fill_next_order,
        );
        Ok(json_result(&payload))
    }

    #[tool(
        name = "apex.account.summary",
        description = "Current account state — balances, margin utilisation, equity.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn account_summary(
        &self,
        Parameters(input): Parameters<AccountSummaryInput>,
    ) -> Result<CallToolResult, McpError> {
        let payload =
            handlers::handle_account_summary(&self.state, &input.account_id, input.currency);
        Ok(json_result(&payload))
    }

    #[tool(
        name = "apex.account.positions",
        description = "All open positions with live P&L.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn account_positions(
        &self,
        Parameters(_input): Parameters<AccountPositionsInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_account_positions(&self.state)))
    }

    #[tool(
        name = "apex.account.orders",
        description = "Known orders and their current lifecycle state.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn account_orders(
        &self,
        Parameters(_input): Parameters<AccountOrdersInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_account_orders(&self.state)))
    }

    #[tool(
        name = "apex.account.history",
        description = "Closed trades and funding events.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn account_history(
        &self,
        Parameters(_input): Parameters<AccountHistoryInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_account_history()))
    }

    #[tool(
        name = "apex.order.place",
        description = "Unified order entry across all asset classes. Profile-composable.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false)
    )]
    async fn order_place(
        &self,
        Parameters(input): Parameters<OrderPlaceInput>,
    ) -> Result<CallToolResult, McpError> {
        let order_value = serde_json::to_value(&input.order).expect("order should serialize");
        match handlers::handle_order_place(&self.state, &order_value) {
            Ok((payload, updates)) => {
                self.notify_updates(updates).await;
                Ok(json_result(&payload))
            }
            Err(err_payload) => Ok(json_result(&err_payload)),
        }
    }

    #[tool(
        name = "apex.order.modify",
        description = "Amend a working order or an open position's protection settings.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false)
    )]
    async fn order_modify(
        &self,
        Parameters(input): Parameters<OrderModifyInput>,
    ) -> Result<CallToolResult, McpError> {
        // Build a JSON object from the modifications fields for the shared handler
        let mut mods_value = serde_json::Map::new();
        if let Some(v) = input.modifications.limit_price {
            mods_value.insert("limit_price".into(), serde_json::json!(v));
        }
        if let Some(v) = input.modifications.stop_price {
            mods_value.insert("stop_price".into(), serde_json::json!(v));
        }
        if let Some(v) = input.modifications.quantity {
            mods_value.insert("quantity".into(), serde_json::json!(v));
        }
        if input.modifications.stop_loss.is_some() {
            mods_value.insert("stop_loss".into(), serde_json::json!(true));
        }
        if input.modifications.take_profit.is_some() {
            mods_value.insert("take_profit".into(), serde_json::json!(true));
        }
        if input.modifications.trailing_stop.is_some() {
            mods_value.insert("trailing_stop".into(), serde_json::json!(true));
        }
        let mods_value = serde_json::Value::Object(mods_value);
        match handlers::handle_order_modify(
            &self.state,
            &input.target_type,
            &input.target_id,
            &mods_value,
        ) {
            Ok((payload, updates)) => {
                self.notify_updates(updates).await;
                Ok(json_result(&payload))
            }
            Err(err_payload) => Ok(json_result(&err_payload)),
        }
    }

    #[tool(
        name = "apex.order.cancel",
        description = "Cancel a working or partially filled order.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true)
    )]
    async fn order_cancel(
        &self,
        Parameters(input): Parameters<OrderCancelInput>,
    ) -> Result<CallToolResult, McpError> {
        let (payload, updates) = handlers::handle_order_cancel(&self.state, &input.order_id);
        self.notify_updates(updates).await;
        Ok(json_result(&payload))
    }

    #[tool(
        name = "apex.position.close",
        description = "Close an open position fully or partially by placing an opposite-direction market order.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false)
    )]
    async fn position_close(
        &self,
        Parameters(input): Parameters<PositionCloseInput>,
    ) -> Result<CallToolResult, McpError> {
        match handlers::handle_position_close(&self.state, &input.position_id, input.quantity) {
            Ok((payload, updates)) => {
                self.notify_updates(updates).await;
                Ok(json_result(&payload))
            }
            Err(err_payload) => Ok(json_result(&err_payload)),
        }
    }

    #[tool(
        name = "apex.order.status",
        description = "Query the current state of a single order.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn order_status(
        &self,
        Parameters(input): Parameters<OrderStatusInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_order_status(
            &self.state,
            &input.order_id,
        )))
    }

    #[tool(
        name = "apex.market.quote",
        description = "Current bid/ask/mid for an instrument.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn market_quote(
        &self,
        Parameters(input): Parameters<MarketQuoteInput>,
    ) -> Result<CallToolResult, McpError> {
        let payload = handlers::handle_market_quote(
            &self.state,
            input.instrument_id,
            input.broker_symbol,
        );
        Ok(json_result(&payload))
    }

    #[tool(
        name = "apex.market.snapshot",
        description = "OHLCV candle data for an instrument.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn market_snapshot(
        &self,
        Parameters(input): Parameters<MarketSnapshotInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_market_snapshot(
            input.instrument_id,
            input.timeframe,
        )))
    }

    #[tool(
        name = "apex.market.search",
        description = "Discover instruments by keyword, asset class, or profile.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn market_search(
        &self,
        Parameters(input): Parameters<MarketSearchInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_market_search(&input.query)))
    }

    #[tool(
        name = "apex.market.details",
        description = "Full contract specification for an instrument.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn market_details(
        &self,
        Parameters(input): Parameters<MarketDetailsInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_market_details(
            &input.instrument_id,
        )))
    }

    #[tool(
        name = "apex.risk.check",
        description = "Pre-trade margin and exposure check. Call before placing large orders.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn risk_check(
        &self,
        Parameters(input): Parameters<RiskCheckInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_risk_check(
            input.order.quantity,
        )))
    }

    #[tool(
        name = "apex.risk.limits",
        description = "Current account-level risk limits and utilisation.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn risk_limits(
        &self,
        Parameters(input): Parameters<RiskLimitsInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_risk_limits(
            &self.state,
            &input.account_id,
        )))
    }

    #[tool(
        name = "apex.fx.rollover",
        description = "Query swap/rollover rates for an FX instrument. Rates are expressed in account currency per lot per night.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn fx_rollover(
        &self,
        Parameters(input): Parameters<FxRolloverInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_fx_rollover(
            &input.instrument_id,
        )))
    }

    #[tool(
        name = "apex.fx.exposure",
        description = "Net currency exposure across open FX positions. Critical for agents managing portfolio-level currency risk.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn fx_exposure(
        &self,
        Parameters(input): Parameters<FxExposureInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_fx_exposure(
            &self.state,
            &input.account_id,
            &input.base_currency,
        )))
    }

    #[tool(
        name = "apex.fx.conversion",
        description = "Real-time cross-currency conversion rate. Used by agents to calculate P&L in a target currency.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn fx_conversion(
        &self,
        Parameters(input): Parameters<FxConversionInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_fx_conversion(
            &input.from_currency,
            &input.to_currency,
            input.amount,
        )))
    }

    // CFD profile tools

    #[tool(
        name = "apex.cfd.corporate_actions",
        description = "Query upcoming corporate actions for CFD instruments. Reference implementation returns an empty array.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn cfd_corporate_actions(
        &self,
        Parameters(input): Parameters<CfdCorporateActionsInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_cfd_corporate_actions(
            &input.account_id,
        )))
    }

    #[tool(
        name = "apex.cfd.dividend_adjustment",
        description = "Query dividend adjustments for CFD positions. Reference implementation returns an empty array.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn cfd_dividend_adjustment(
        &self,
        Parameters(input): Parameters<CfdDividendAdjustmentInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_cfd_dividend_adjustment(
            &input.account_id,
        )))
    }

    // Crypto profile tools

    #[tool(
        name = "apex.crypto.funding_rate",
        description = "Query funding rate for a perpetual instrument. Returns simulated data for BTCUSDT.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn crypto_funding_rate(
        &self,
        Parameters(input): Parameters<CryptoFundingRateInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_crypto_funding_rate(
            &input.instrument_id,
        )))
    }

    #[tool(
        name = "apex.crypto.liquidation_estimate",
        description = "Estimate liquidation price for a perpetual position based on leverage and margin mode.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn crypto_liquidation_estimate(
        &self,
        Parameters(input): Parameters<CryptoLiquidationEstimateInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_crypto_liquidation_estimate(
            &input.instrument_id,
            &input.side,
            input.quantity,
            input.leverage,
            input.entry_price,
        )))
    }

    #[tool(
        name = "apex.crypto.transfer",
        description = "Transfer funds between wallets (spot, futures, funding). Reference implementation simulates instant completion.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn crypto_transfer(
        &self,
        Parameters(input): Parameters<CryptoTransferInput>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&handlers::handle_crypto_transfer(
            &input.account_id,
            &input.from_wallet,
            &input.to_wallet,
            &input.currency,
            input.amount,
        )))
    }
}

#[tool_handler]
impl ServerHandler for ApexServer {
    fn get_info(&self) -> ServerInfo {
        // NOTE: rmcp's `Implementation` struct does not support arbitrary extra
        // fields, so we cannot place `apex_version` inside `serverInfo` for the
        // stdio transport the way the HTTP transport does.  The APEX spec wants
        // it in `serverInfo`, but the MCP SDK's typed `Implementation` only has
        // `name`, `version`, `title`, `description`, `icons`, `website_url`.
        // We place it in `instructions` as a structured JSON string so clients
        // can still discover it.  The HTTP transport (which builds raw JSON)
        // includes `apex_version` directly in `serverInfo`.
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_resources_subscribe()
                .enable_resources_list_changed()
                .build(),
        )
        .with_server_info(Implementation::new(SERVER_NAME, SERVER_VERSION))
        .with_instructions(serde_json::json!({ "apex_version": "0.1.0-alpha" }).to_string())
    }

    async fn on_initialized(&self, context: rmcp::service::NotificationContext<RoleServer>) {
        *self.peer.lock().expect("peer mutex poisoned") = Some(context.peer);
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let resources = self
            .state
            .list_resources()
            .into_iter()
            .map(|(name, uri, description)| {
                RawResource::new(uri, name)
                    .with_description(description)
                    .with_mime_type("application/json")
                    .no_annotation()
            })
            .collect();

        Ok(ListResourcesResult {
            meta: None,
            next_cursor: None,
            resources,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        let payload = self
            .state
            .read_resource_payload(&request.uri)
            .ok_or_else(|| McpError::resource_not_found("Resource not found", None))?;

        Ok(ReadResourceResult::new(vec![
            ResourceContents::TextResourceContents {
                uri: request.uri,
                mime_type: Some("application/json".to_owned()),
                text: serde_json::to_string(&payload).expect("resource payload should serialize"),
                meta: None,
            },
        ]))
    }

    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
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
        request: UnsubscribeRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<(), McpError> {
        self.subscriptions
            .lock()
            .expect("subscription mutex poisoned")
            .remove(&request.uri);
        Ok(())
    }
}
