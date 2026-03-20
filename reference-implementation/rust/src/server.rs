use rmcp::{model::*, tool, Error as McpError, ServerHandler};

use crate::helpers::{apex_error, hours_ago, hours_from_now, json_result, now_iso};
use crate::models::*;

#[derive(Debug, Clone)]
pub struct ApexServer;

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
            account_id: input.account_id.unwrap_or_else(|| "ACC_12345".to_owned()),
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
        name = "apex.account.summary",
        description = "Current account state — balances, margin utilisation, equity."
    )]
    async fn account_summary(
        &self,
        #[tool(aggr)] input: AccountSummaryInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&AccountSummaryResponse {
            account_id: input.account_id,
            account_base_currency: "USD".to_owned(),
            response_currency: input.currency.unwrap_or_else(|| "USD".to_owned()),
            balance: 10000.0,
            equity: 10250.0,
            used_margin: 500.0,
            free_margin: 9750.0,
            margin_level_pct: 2050.0,
            unrealised_pnl: 250.0,
            realised_pnl_today: 0.0,
            as_of: now_iso(),
        }))
    }

    #[tool(
        name = "apex.account.positions",
        description = "All open positions with live P&L."
    )]
    async fn account_positions(
        &self,
        #[tool(aggr)] input: AccountPositionsInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&AccountPositionsResponse {
            positions: vec![Position {
                position_id: "pos_001".to_owned(),
                instrument_id: input
                    .instrument_id
                    .unwrap_or_else(|| "APEX:FX:EURUSD".to_owned()),
                broker_symbol: "EURUSD".to_owned(),
                side: "buy".to_owned(),
                quantity: 100000,
                quantity_unit: "base_units".to_owned(),
                broker_quantity: "1.0".to_owned(),
                broker_quantity_unit: "lots".to_owned(),
                open_price: 1.0850,
                current_price: 1.0875,
                unrealised_pnl: 250.0,
                unrealised_pnl_currency: "USD".to_owned(),
                used_margin: 500.0,
                open_time: hours_ago(1),
                stop_loss: 1.0800,
                take_profit: 1.1000,
                profile_data: PositionProfileData {
                    rollover_long_daily: -2.5,
                    rollover_short_daily: 1.8,
                    accrued_rollover: -7.5,
                    pip_value: 10.0,
                    pip_value_currency: "USD".to_owned(),
                },
            }],
            total_unrealised_pnl: 250.0,
            as_of: now_iso(),
        }))
    }

    #[tool(
        name = "apex.account.orders",
        description = "Known orders and their current lifecycle state."
    )]
    async fn account_orders(
        &self,
        #[tool(aggr)] _input: AccountOrdersInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&AccountOrdersResponse {
            orders: vec![],
            as_of: now_iso(),
        }))
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
        if input.order.order_type == "limit" && input.order.limit_price.is_none() {
            return Ok(json_result(&apex_error(
                "APEX_4011",
                "validation",
                "limit_price required for limit orders",
                None,
            )));
        }

        let is_market = input.order.order_type == "market";

        Ok(json_result(&OrderPlaceResponse {
            order_id: format!("ord_{}", &uuid::Uuid::new_v4().to_string()[..8]),
            client_order_id: input.order.client_order_id,
            status: if is_market {
                "filled".to_owned()
            } else {
                "working".to_owned()
            },
            fill_price: is_market.then_some(1.08755),
            fill_quantity: if is_market { input.order.quantity } else { 0.0 },
            remaining_quantity: if is_market { 0.0 } else { input.order.quantity },
            position_id: is_market.then_some("pos_001".to_owned()),
            rejection_reason: None,
            created_at: now_iso(),
        }))
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
        Ok(json_result(&OrderStatusResponse {
            order_id: input.order_id,
            status: "working".to_owned(),
            filled_quantity: 0,
            as_of: now_iso(),
        }))
    }

    #[tool(
        name = "apex.market.quote",
        description = "Current bid/ask/mid for an instrument."
    )]
    async fn market_quote(
        &self,
        #[tool(aggr)] input: MarketQuoteInput,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_result(&MarketQuoteResponse {
            instrument_id: input
                .instrument_id
                .unwrap_or_else(|| "APEX:FX:EURUSD".to_owned()),
            broker_symbol: input.broker_symbol.unwrap_or_else(|| "EURUSD".to_owned()),
            bid: 1.08740,
            ask: 1.08760,
            mid: 1.08750,
            spread: 0.00020,
            timestamp: now_iso(),
            is_tradeable: true,
            market_status: "open".to_owned(),
        }))
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
        let instruments = if "EURUSD".contains(&input.query.to_uppercase()) {
            vec![SearchInstrument {
                instrument_id: "APEX:FX:EURUSD".to_owned(),
                broker_symbol: "EURUSD".to_owned(),
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
            broker_symbol: "EURUSD".to_owned(),
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
            kill_switch_active: false,
        }))
    }
}

#[tool(tool_box)]
impl ServerHandler for ApexServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities {
                tools: Some(ToolsCapability::default()),
                ..Default::default()
            },
            server_info: Implementation {
                name: SERVER_NAME.to_owned(),
                version: SERVER_VERSION.to_owned(),
            },
            instructions: None,
        }
    }
}
