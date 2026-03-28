#![allow(dead_code)]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const SERVER_NAME: &str = "apex-reference";
pub const SERVER_VERSION: &str = "0.1.0";

pub const CORE_CAPABILITIES: [&str; 5] = [
    "apex.session.*",
    "apex.account.*",
    "apex.order.*",
    "apex.market.*",
    "apex.risk.*",
];

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AuthenticateInput {
    /// Broker-issued JWT or OAuth token
    pub token: String,
    /// Token type
    #[serde(default = "default_token_type")]
    pub token_type: String,
    /// Optional — broker may derive from token
    #[serde(default)]
    pub account_id: Option<String>,
    /// Optional session reference from caller
    #[serde(default)]
    pub hub_session_id: Option<String>,
}

fn default_token_type() -> String {
    "jwt".to_owned()
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct HeartbeatInput {
    /// ISO8601 timestamp
    pub timestamp: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AccountSummaryInput {
    pub account_id: String,
    /// Response currency. Defaults to account base currency.
    #[serde(default)]
    pub currency: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AccountPositionsInput {
    pub account_id: String,
    /// Must be a valid APEX canonical instrument ID (e.g. APEX:FX:EURUSD)
    #[serde(default)]
    pub instrument_id: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AccountOrdersInput {
    pub account_id: String,
    #[serde(default = "default_order_status_filter")]
    pub status: String,
    #[serde(default)]
    pub instrument_id: Option<String>,
}

fn default_order_status_filter() -> String {
    "all".to_owned()
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AccountHistoryInput {
    pub account_id: String,
    /// ISO8601 start date
    pub from: String,
    /// ISO8601 end date
    pub to: String,
    #[serde(default = "default_event_type")]
    pub event_type: String,
    #[serde(default = "default_history_limit")]
    pub limit: u32,
    /// Pagination cursor
    #[serde(default)]
    pub cursor: Option<String>,
}

fn default_event_type() -> String {
    "all".to_owned()
}

fn default_history_limit() -> u32 {
    100
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct PriceStop {
    #[serde(rename = "type")]
    pub stop_type: String,
    pub value: f64,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct TrailingStop {
    #[serde(rename = "type")]
    pub trailing_type: String,
    pub value: f64,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct OrderSpec {
    pub instrument_id: String,
    #[serde(default)]
    pub broker_symbol: Option<String>,
    pub side: String,
    pub order_type: String,
    pub quantity: f64,
    #[serde(default = "default_quantity_unit")]
    pub quantity_unit: String,
    #[serde(default = "default_tif")]
    pub time_in_force: String,
    #[serde(default)]
    pub limit_price: Option<f64>,
    #[serde(default)]
    pub stop_price: Option<f64>,
    #[serde(default)]
    pub stop_loss: Option<PriceStop>,
    #[serde(default)]
    pub take_profit: Option<PriceStop>,
    #[serde(default)]
    pub trailing_stop: Option<TrailingStop>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub profile_data: Option<serde_json::Value>,
    #[serde(default)]
    pub client_order_id: Option<String>,
    #[serde(default)]
    pub strategy_id: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

fn default_quantity_unit() -> String {
    "base_units".to_owned()
}

fn default_tif() -> String {
    "GTC".to_owned()
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OrderPlaceInput {
    pub account_id: String,
    pub order: OrderSpec,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OrderModifications {
    #[serde(default)]
    pub limit_price: Option<f64>,
    #[serde(default)]
    pub stop_price: Option<f64>,
    #[serde(default)]
    pub quantity: Option<f64>,
    #[serde(default)]
    pub stop_loss: Option<PriceStop>,
    #[serde(default)]
    pub take_profit: Option<PriceStop>,
    #[serde(default)]
    pub trailing_stop: Option<TrailingStop>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OrderModifyInput {
    pub account_id: String,
    pub target_type: String,
    pub target_id: String,
    pub modifications: OrderModifications,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OrderCancelInput {
    pub account_id: String,
    pub order_id: String,
    /// Agent-provided reason for audit trail
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OrderStatusInput {
    pub account_id: String,
    pub order_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MarketQuoteInput {
    #[serde(default)]
    pub instrument_id: Option<String>,
    #[serde(default)]
    pub broker_symbol: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MarketSnapshotInput {
    pub instrument_id: String,
    pub timeframe: String,
    pub from: String,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default = "default_snapshot_limit")]
    pub limit: u32,
}

fn default_snapshot_limit() -> u32 {
    200
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MarketSearchInput {
    pub query: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default = "default_search_limit")]
    pub limit: u32,
}

fn default_search_limit() -> u32 {
    20
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MarketDetailsInput {
    pub instrument_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RiskOrderSpec {
    pub instrument_id: String,
    pub side: String,
    pub order_type: String,
    pub quantity: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RiskCheckInput {
    pub account_id: String,
    pub order: RiskOrderSpec,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RiskLimitsInput {
    pub account_id: String,
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub session_id: String,
    pub account_id: String,
    pub expires_at: String,
    pub capabilities: Vec<String>,
    pub profiles: Vec<String>,
    pub broker_id: String,
    pub broker_name: String,
}

#[derive(Debug, Serialize)]
pub struct CapabilitiesResponse {
    pub apex_version: String,
    pub broker_id: String,
    pub core_tools: Vec<String>,
    pub profiles: serde_json::Value,
    pub vendor_extensions: Option<serde_json::Value>,
    pub rate_limits: serde_json::Value,
    pub supported_order_types: Vec<String>,
    pub supported_tif: Vec<String>,
    pub realtime_contract: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct ReferenceRealtimeStateInput {
    #[serde(default)]
    pub quote_stale: Option<bool>,
    #[serde(default)]
    pub risk_stale: Option<bool>,
    #[serde(default)]
    pub force_sequence_gap: Option<bool>,
    #[serde(default)]
    pub kill_switch_active: Option<bool>,
    #[serde(default)]
    pub partial_fill_next_order: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct HeartbeatResponse {
    pub timestamp: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct AccountSummaryResponse {
    pub account_id: String,
    pub account_base_currency: String,
    pub response_currency: String,
    pub balance: f64,
    pub equity: f64,
    pub used_margin: f64,
    pub free_margin: f64,
    pub margin_level_pct: f64,
    pub unrealised_pnl: f64,
    pub realised_pnl_today: f64,
    pub as_of: String,
}

#[derive(Debug, Serialize)]
pub struct PositionProfileData {
    pub rollover_long_daily: f64,
    pub rollover_short_daily: f64,
    pub accrued_rollover: f64,
    pub pip_value: f64,
    pub pip_value_currency: String,
}

#[derive(Debug, Serialize)]
pub struct Position {
    pub position_id: String,
    pub instrument_id: String,
    pub broker_symbol: String,
    pub side: String,
    pub quantity: i64,
    pub quantity_unit: String,
    pub broker_quantity: String,
    pub broker_quantity_unit: String,
    pub open_price: f64,
    pub current_price: f64,
    pub unrealised_pnl: f64,
    pub unrealised_pnl_currency: String,
    pub used_margin: f64,
    pub open_time: String,
    pub stop_loss: f64,
    pub take_profit: f64,
    pub profile_data: PositionProfileData,
}

#[derive(Debug, Serialize)]
pub struct AccountPositionsResponse {
    pub positions: Vec<Position>,
    pub total_unrealised_pnl: f64,
    pub as_of: String,
}

#[derive(Debug, Serialize)]
pub struct AccountOrdersResponse {
    pub orders: Vec<serde_json::Value>,
    pub as_of: String,
}

#[derive(Debug, Serialize)]
pub struct AccountHistoryResponse {
    pub events: Vec<serde_json::Value>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct OrderPlaceResponse {
    pub order_id: String,
    pub client_order_id: Option<String>,
    pub status: String,
    pub fill_price: Option<f64>,
    pub fill_quantity: f64,
    pub remaining_quantity: f64,
    pub position_id: Option<String>,
    pub rejection_reason: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct OrderModifyResponse {
    pub target_type: String,
    pub target_id: String,
    pub status: String,
    pub rejection_reason: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct OrderCancelResponse {
    pub order_id: String,
    pub status: String,
    pub rejection_reason: Option<String>,
    pub cancelled_at: String,
}

#[derive(Debug, Serialize)]
pub struct MarketQuoteResponse {
    pub instrument_id: String,
    pub broker_symbol: String,
    pub bid: f64,
    pub ask: f64,
    pub mid: f64,
    pub spread: f64,
    pub timestamp: String,
    pub is_tradeable: bool,
    pub market_status: String,
}

#[derive(Debug, Serialize)]
pub struct MarketSnapshotResponse {
    pub instrument_id: String,
    pub timeframe: String,
    pub candles: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct SearchInstrument {
    pub instrument_id: String,
    pub broker_symbol: String,
    pub display_name: String,
    pub profile: String,
    pub is_tradeable: bool,
}

#[derive(Debug, Serialize)]
pub struct MarketSearchResponse {
    pub instruments: Vec<SearchInstrument>,
}

#[derive(Debug, Serialize)]
pub struct TradingHours {
    pub day: String,
    pub open: String,
    pub close: String,
    pub timezone: String,
}

#[derive(Debug, Serialize)]
pub struct MarketDetailsResponse {
    pub instrument_id: String,
    pub broker_symbol: String,
    pub display_name: String,
    pub profile: String,
    pub base_currency: String,
    pub quote_currency: String,
    pub pip_size: f64,
    pub lot_size: i64,
    pub quantity_unit: String,
    pub broker_quantity_unit: String,
    pub min_quantity: i64,
    pub max_quantity: i64,
    pub quantity_step: i64,
    pub margin_rate_pct: f64,
    pub commission_per_lot: f64,
    pub spread_type: String,
    pub typical_spread_pips: f64,
    pub trading_hours: Vec<TradingHours>,
    pub profile_data: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct RiskCheckResponse {
    pub approved: bool,
    pub required_margin: f64,
    pub available_margin: f64,
    pub margin_after_trade: f64,
    pub exposure_increase: f64,
    pub warnings: Vec<serde_json::Value>,
    pub rejection_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RiskLimitsResponse {
    pub account_id: String,
    pub max_position_size: i64,
    pub max_open_orders: i64,
    pub daily_loss_limit: f64,
    pub daily_loss_used: f64,
    pub margin_call_level_pct: i64,
    pub stop_out_level_pct: i64,
    pub restricted_instruments: Vec<serde_json::Value>,
    pub kill_switch_active: bool,
}
