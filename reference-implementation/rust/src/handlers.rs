//! Shared tool handler business logic.
//!
//! Each function takes the trading state (and any input args) and returns a
//! `serde_json::Value` result. HTTP transport code extracts parameters and
//! emits notifications after the handler returns.

use serde_json::{json, Value};

use crate::helpers::{apex_error, dec, hours_from_now, next_funding_time, next_rollover_time, now_iso};
use crate::models::*;
use crate::state::{ReferenceTradingState, ACCOUNT_ID, BROKER_SYMBOL, INSTRUMENT_ID};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

pub fn handle_authenticate(
    state: &ReferenceTradingState,
    token: &str,
    account_id: Option<&str>,
) -> Value {
    let _ = state; // unused — pure credential check
    if token.len() < 10 {
        return serde_json::to_value(apex_error(
            "APEX_4001",
            "auth",
            "Invalid or expired token",
            None,
        ))
        .expect("serialize");
    }

    serde_json::to_value(SessionResponse {
        session_id: uuid::Uuid::new_v4().to_string(),
        account_id: account_id
            .map(|s| s.to_owned())
            .unwrap_or_else(|| ACCOUNT_ID.to_owned()),
        expires_at: hours_from_now(1),
        capabilities: CORE_CAPABILITIES.iter().map(|v| (*v).to_owned()).collect(),
        profiles: vec!["fx".to_owned()],
        broker_id: "reference-broker".to_owned(),
        broker_name: "APEX Reference Broker".to_owned(),
    })
    .expect("serialize")
}

pub fn handle_capabilities() -> Value {
    let realtime_contract = json!({
        "transport_mode": "streamable_http",
        "reconnect_mode": "session_replay",
        "max_retention_events": 10000,
        "max_retention_seconds": 0,
        "quote_freshness_ms": 1000,
        "account_freshness_ms": 2000,
        "tick_interval_ms": 2000,
        "notifications": [
            "notifications/apex.order.filled",
            "notifications/apex.order.partially_filled",
            "notifications/apex.order.rejected",
            "notifications/apex.market.candle_closed",
            "notifications/apex.risk.kill_switch_engaged",
            "notifications/apex.session.replay_failed",
            "notifications/apex.session.gap_fill"
        ]
    });

    serde_json::to_value(CapabilitiesResponse {
        apex_version: SERVER_VERSION.to_owned(),
        broker_id: "reference-broker".to_owned(),
        core_tools: CORE_CAPABILITIES.iter().map(|v| (*v).to_owned()).collect(),
        profiles: json!({ "fx": SERVER_VERSION }),
        vendor_extensions: None,
        rate_limits: json!({
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
        production_profiles: json!({
            "realtime": true,
            "autonomous": false
        }),
        realtime_contract,
    })
    .expect("serialize")
}

pub fn handle_heartbeat() -> Value {
    serde_json::to_value(HeartbeatResponse {
        timestamp: now_iso(),
        status: "ok".to_owned(),
    })
    .expect("serialize")
}

// ---------------------------------------------------------------------------
// Reference / test
// ---------------------------------------------------------------------------

pub fn handle_set_realtime_state(
    state: &ReferenceTradingState,
    quote_stale: Option<bool>,
    risk_stale: Option<bool>,
    force_sequence_gap: Option<bool>,
    kill_switch_active: Option<bool>,
    partial_fill_next_order: Option<bool>,
) -> Value {
    json!({
        "ok": true,
        "faults": state.set_faults(
            quote_stale,
            risk_stale,
            force_sequence_gap,
            kill_switch_active,
            partial_fill_next_order,
        ),
    })
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

pub fn handle_account_summary(
    state: &ReferenceTradingState,
    account_id: &str,
    currency: Option<String>,
) -> Value {
    if account_id.is_empty() {
        return serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "account_id is required",
            None,
        ))
        .expect("serialize");
    }
    serde_json::to_value(state.account_summary_payload(currency)).expect("serialize")
}

pub fn handle_account_positions(state: &ReferenceTradingState) -> Value {
    serde_json::to_value(state.positions_payload()).expect("serialize")
}

pub fn handle_account_orders(state: &ReferenceTradingState) -> Value {
    serde_json::to_value(state.orders_payload()).expect("serialize")
}

pub fn handle_account_history() -> Value {
    serde_json::to_value(AccountHistoryResponse {
        events: vec![],
        next_cursor: None,
        has_more: false,
    })
    .expect("serialize")
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/// Validates and places an order.  Returns `(payload, resource_update_uris)`.
/// The caller is responsible for emitting any fill notifications.
pub fn handle_order_place(
    state: &ReferenceTradingState,
    order: &Value,
) -> Result<(Value, Vec<String>), Value> {
    if let Err((code, category, message)) = state.order_acceptance() {
        return Err(
            serde_json::to_value(apex_error(code, category, message, None)).expect("serialize"),
        );
    }

    if order["order_type"].as_str() == Some("limit")
        && order.get("limit_price").map_or(true, |v| v.is_null())
    {
        return Err(serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "limit_price required for limit orders",
            None,
        ))
        .expect("serialize"));
    }

    let (payload, updates) = state.create_order(order);
    Ok((serde_json::to_value(payload).expect("serialize"), updates))
}

/// Validates and modifies an order/position.  Returns `(response_payload, resource_update_uris)`.
pub fn handle_order_modify(
    state: &ReferenceTradingState,
    target_type: &str,
    target_id: &str,
    modifications: &Value,
) -> Result<(Value, Vec<String>), Value> {
    if target_type == "position"
        && (modifications.get("limit_price").is_some()
            || modifications.get("stop_price").is_some()
            || modifications.get("quantity").is_some())
    {
        return Err(serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "positions may only amend stop_loss, take_profit, or trailing_stop",
            None,
        ))
        .expect("serialize"));
    }

    let updates = state.modify_order(target_id);
    let response = serde_json::to_value(OrderModifyResponse {
        target_type: target_type.to_owned(),
        target_id: target_id.to_owned(),
        status: "modified".to_owned(),
        rejection_reason: None,
        updated_at: now_iso(),
    })
    .expect("serialize");

    Ok((response, updates))
}

pub fn handle_order_cancel(state: &ReferenceTradingState, order_id: &str) -> (Value, Vec<String>) {
    let updates = state.cancel_order(order_id);
    let response = serde_json::to_value(OrderCancelResponse {
        order_id: order_id.to_owned(),
        status: "cancelled".to_owned(),
        rejection_reason: None,
        cancelled_at: now_iso(),
    })
    .expect("serialize");

    (response, updates)
}

/// Close a position.  Returns `(response_payload, resource_update_uris)` on success.
/// The caller is responsible for emitting fill notifications.
pub fn handle_position_close(
    state: &ReferenceTradingState,
    position_id: &str,
    requested_quantity: Option<f64>,
) -> Result<(Value, Vec<String>), Value> {
    if let Err((code, category, message)) = state.order_acceptance() {
        return Err(
            serde_json::to_value(apex_error(code, category, message, None)).expect("serialize"),
        );
    }

    let (instrument_id, side, total_quantity) = match state.find_position(position_id) {
        Some(pos) => pos,
        None => {
            return Err(serde_json::to_value(apex_error(
                "APEX_4011",
                "validation",
                &format!("Unknown position: {position_id}"),
                None,
            ))
            .expect("serialize"));
        }
    };

    let close_quantity = requested_quantity.unwrap_or(total_quantity);
    let close_side = if side == "buy" { "sell" } else { "buy" };

    let (order_payload, updates) =
        state.close_position(position_id, close_quantity, &instrument_id, close_side);

    let remaining = total_quantity - close_quantity;
    let status = if remaining <= 0.0 {
        "filled"
    } else {
        "partially_filled"
    };

    let response = serde_json::to_value(PositionCloseResponse {
        order_id: order_payload["order_id"].as_str().unwrap_or("").to_owned(),
        position_id: position_id.to_owned(),
        status: status.to_owned(),
        fill_price: dec(order_payload["fill_price"]
            .as_str()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(1.08755)),
        fill_quantity: dec(close_quantity),
        remaining_quantity: dec(if remaining > 0.0 { remaining } else { 0.0 }),
        closed_at: now_iso(),
    })
    .expect("serialize");

    Ok((response, updates))
}

pub fn handle_order_status(state: &ReferenceTradingState, order_id: &str) -> Value {
    match state.order_status_payload(order_id) {
        Some(order) => serde_json::to_value(order).expect("serialize"),
        None => serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            &format!("Unknown order: {order_id}"),
            None,
        ))
        .expect("serialize"),
    }
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

pub fn handle_market_quote(
    state: &ReferenceTradingState,
    instrument_id: Option<String>,
    broker_symbol: Option<String>,
) -> Value {
    let has_id = instrument_id.as_deref().is_some_and(|s| !s.is_empty());
    let has_sym = broker_symbol.as_deref().is_some_and(|s| !s.is_empty());

    if !has_id && !has_sym {
        return serde_json::to_value(apex_error(
            "APEX_4010",
            "validation",
            "Unknown instrument",
            None,
        ))
        .expect("serialize");
    }
    if has_id && instrument_id.as_deref() != Some(INSTRUMENT_ID) {
        return serde_json::to_value(apex_error(
            "APEX_4010",
            "validation",
            "Unknown instrument",
            None,
        ))
        .expect("serialize");
    }
    if !has_id && broker_symbol.as_deref() != Some(BROKER_SYMBOL) {
        return serde_json::to_value(apex_error(
            "APEX_4010",
            "validation",
            "Unknown instrument",
            None,
        ))
        .expect("serialize");
    }

    serde_json::to_value(state.quote_payload(instrument_id, broker_symbol)).expect("serialize")
}

pub fn handle_market_snapshot(instrument_id: String, timeframe: String) -> Value {
    serde_json::to_value(MarketSnapshotResponse {
        instrument_id,
        timeframe,
        candles: vec![],
    })
    .expect("serialize")
}

pub fn handle_market_search(query: &str) -> Value {
    let instruments = if !query.is_empty() && "EURUSD".contains(&query.to_uppercase()) {
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

    serde_json::to_value(MarketSearchResponse { instruments }).expect("serialize")
}

pub fn handle_market_details(instrument_id: &str) -> Value {
    if instrument_id != INSTRUMENT_ID {
        return serde_json::to_value(apex_error(
            "APEX_4010",
            "validation",
            "Unknown instrument",
            None,
        ))
        .expect("serialize");
    }

    serde_json::to_value(MarketDetailsResponse {
        instrument_id: instrument_id.to_owned(),
        broker_symbol: BROKER_SYMBOL.to_owned(),
        display_name: "Euro / US Dollar".to_owned(),
        profile: "fx".to_owned(),
        base_currency: "EUR".to_owned(),
        quote_currency: "USD".to_owned(),
        pip_size: dec(0.0001),
        lot_size: 100000,
        quantity_unit: "base_units".to_owned(),
        broker_quantity_unit: "lots".to_owned(),
        min_quantity: dec(1000.0),
        max_quantity: dec(50000000.0),
        quantity_step: dec(1000.0),
        margin_rate_pct: dec(0.5),
        commission_per_lot: dec(0.0),
        spread_type: "variable".to_owned(),
        typical_spread_pips: dec(0.8),
        trading_hours: vec![TradingHours {
            day: "monday".to_owned(),
            open: "00:00".to_owned(),
            close: "23:59".to_owned(),
            timezone: "UTC".to_owned(),
        }],
        profile_data: json!({}),
    })
    .expect("serialize")
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

pub fn handle_risk_check(quantity: f64) -> Value {
    let required_margin = (quantity / 100000.0) * 500.0;
    let available_margin = 9750.0;

    serde_json::to_value(RiskCheckResponse {
        approved: true,
        required_margin: dec(required_margin),
        available_margin: dec(available_margin),
        margin_after_trade: dec(available_margin - required_margin),
        exposure_increase: dec(quantity),
        warnings: vec![],
        rejection_reason: None,
    })
    .expect("serialize")
}

pub fn handle_risk_limits(state: &ReferenceTradingState, account_id: &str) -> Value {
    serde_json::to_value(RiskLimitsResponse {
        account_id: account_id.to_owned(),
        max_position_size: dec(5000000.0),
        max_open_orders: 50,
        daily_loss_limit: dec(-1000.0),
        daily_loss_used: dec(-150.0),
        margin_call_level_pct: dec(100.0),
        stop_out_level_pct: dec(50.0),
        restricted_instruments: vec![],
        kill_switch_active: state
            .read_resource_payload(&crate::state::risk_uri())
            .and_then(|payload| payload["kill_switch_active"].as_bool())
            .unwrap_or(false),
    })
    .expect("serialize")
}

// ---------------------------------------------------------------------------
// FX profile
// ---------------------------------------------------------------------------

pub fn handle_fx_rollover(instrument_id: &str) -> Value {
    if instrument_id != INSTRUMENT_ID {
        return serde_json::to_value(apex_error(
            "APEX_4010",
            "validation",
            "Unknown instrument",
            None,
        ))
        .expect("serialize");
    }

    serde_json::to_value(FxRolloverResponse {
        instrument_id: INSTRUMENT_ID.to_owned(),
        broker_symbol: BROKER_SYMBOL.to_owned(),
        rollover_long: dec(-0.5),
        rollover_short: dec(0.3),
        rollover_currency: "USD".to_owned(),
        rollover_per: "lot".to_owned(),
        lot_size: 100000,
        triple_rollover_day: "Wednesday".to_owned(),
        next_rollover_time: next_rollover_time(),
        as_of: now_iso(),
    })
    .expect("serialize")
}

pub fn handle_fx_exposure(
    state: &ReferenceTradingState,
    account_id: &str,
    base_currency: &str,
) -> Value {
    if account_id.is_empty() {
        return serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "account_id is required",
            None,
        ))
        .expect("serialize");
    }

    let positions_payload = state.positions_payload();
    let positions = positions_payload["positions"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let mut eur_net_units: i64 = 0;
    let mut contributing_positions = vec![];

    for pos in &positions {
        if pos["instrument_id"].as_str() == Some(INSTRUMENT_ID) {
            let qty = pos["quantity"]
                .as_str()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
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
    let value_in_base = if base_currency == "EUR" {
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

    serde_json::to_value(FxExposureResponse {
        account_id: account_id.to_owned(),
        base_currency: base_currency.to_owned(),
        exposures: vec![ExposureEntry {
            currency: "EUR".to_owned(),
            net_units: dec(eur_net_units as f64),
            net_direction: net_direction.to_owned(),
            value_in_base: dec(value_in_base),
            contributing_positions,
        }],
        total_gross_exposure: dec(value_in_base.abs()),
        as_of: now_iso(),
    })
    .expect("serialize")
}

pub fn handle_fx_conversion(from_currency: &str, to_currency: &str, amount: f64) -> Value {
    if from_currency.is_empty() || to_currency.is_empty() {
        return serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "from_currency, to_currency, and amount are all required",
            None,
        ))
        .expect("serialize");
    }

    let mid_rate = 1.0875_f64;
    let rate_result = if from_currency == to_currency {
        Some(1.0)
    } else if from_currency == "EUR" && to_currency == "USD" {
        Some(mid_rate)
    } else if from_currency == "USD" && to_currency == "EUR" {
        Some(1.0 / mid_rate)
    } else {
        None
    };

    match rate_result {
        Some(rate) => serde_json::to_value(FxConversionResponse {
            from_currency: from_currency.to_owned(),
            to_currency: to_currency.to_owned(),
            rate: dec((rate * 10_000_000.0).round() / 10_000_000.0),
            converted_amount: dec((amount * rate * 100.0).round() / 100.0),
            timestamp: now_iso(),
        })
        .expect("serialize"),
        None => serde_json::to_value(apex_error(
            "APEX_4010",
            "validation",
            "Unsupported currency pair",
            None,
        ))
        .expect("serialize"),
    }
}

// ---------------------------------------------------------------------------
// CFD profile
// ---------------------------------------------------------------------------

pub fn handle_cfd_corporate_actions(account_id: &str) -> Value {
    if account_id.is_empty() {
        return serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "account_id is required",
            None,
        ))
        .expect("serialize");
    }

    serde_json::to_value(CfdCorporateActionsResponse {
        corporate_actions: vec![],
    })
    .expect("serialize")
}

pub fn handle_cfd_dividend_adjustment(account_id: &str) -> Value {
    if account_id.is_empty() {
        return serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "account_id is required",
            None,
        ))
        .expect("serialize");
    }

    serde_json::to_value(CfdDividendAdjustmentResponse {
        adjustments: vec![],
    })
    .expect("serialize")
}

// ---------------------------------------------------------------------------
// Crypto profile
// ---------------------------------------------------------------------------

const PERP_INSTRUMENT_ID: &str = "APEX:CRYPTO:PERP:BTCUSDT";
const PERP_BROKER_SYMBOL: &str = "BTCUSDT";

pub fn handle_crypto_funding_rate(instrument_id: &str) -> Value {
    if instrument_id != PERP_INSTRUMENT_ID {
        return serde_json::to_value(apex_error(
            "APEX_4010",
            "validation",
            "Unknown instrument",
            None,
        ))
        .expect("serialize");
    }

    let (funding_time, countdown) = next_funding_time();

    serde_json::to_value(CryptoFundingRateResponse {
        instrument_id: PERP_INSTRUMENT_ID.to_owned(),
        broker_symbol: PERP_BROKER_SYMBOL.to_owned(),
        current_rate: dec(0.0001),
        current_rate_annualised: dec(0.1095),
        predicted_rate: dec(0.00012),
        funding_interval_hours: 8,
        next_funding_time: funding_time,
        countdown_seconds: countdown,
        index_price: dec(50000.00),
        mark_price: dec(50050.00),
        timestamp: now_iso(),
    })
    .expect("serialize")
}

pub fn handle_crypto_liquidation_estimate(
    instrument_id: &str,
    side: &str,
    quantity: f64,
    leverage: f64,
    entry_price: f64,
) -> Value {
    if instrument_id != PERP_INSTRUMENT_ID {
        return serde_json::to_value(apex_error(
            "APEX_4010",
            "validation",
            "Unknown instrument",
            None,
        ))
        .expect("serialize");
    }

    let margin_required = (entry_price * quantity) / leverage;
    let maintenance_margin = margin_required / 2.0;

    let liquidation_price = if side == "buy" {
        entry_price * (1.0 - (1.0 / leverage) * 0.95)
    } else {
        entry_price * (1.0 + (1.0 / leverage) * 0.95)
    };
    let liquidation_price = (liquidation_price * 100.0).round() / 100.0;

    let distance_pct =
        ((entry_price - liquidation_price).abs() / entry_price * 100.0 * 100.0).round() / 100.0;

    serde_json::to_value(CryptoLiquidationEstimateResponse {
        instrument_id: PERP_INSTRUMENT_ID.to_owned(),
        side: side.to_owned(),
        entry_price: dec(entry_price),
        liquidation_price: dec(liquidation_price),
        margin_required: dec((margin_required * 100.0).round() / 100.0),
        maintenance_margin: dec((maintenance_margin * 100.0).round() / 100.0),
        margin_currency: "USDT".to_owned(),
        distance_pct: dec(distance_pct),
        warnings: vec![],
    })
    .expect("serialize")
}

pub fn handle_crypto_transfer(
    account_id: &str,
    from_wallet: &str,
    to_wallet: &str,
    currency: &str,
    amount: f64,
) -> Value {
    if account_id.is_empty()
        || from_wallet.is_empty()
        || to_wallet.is_empty()
        || currency.is_empty()
    {
        return serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "All fields are required: account_id, from_wallet, to_wallet, currency, amount",
            None,
        ))
        .expect("serialize");
    }

    if from_wallet == to_wallet {
        return serde_json::to_value(apex_error(
            "APEX_4011",
            "validation",
            "from_wallet and to_wallet must be different",
            None,
        ))
        .expect("serialize");
    }

    serde_json::to_value(CryptoTransferResponse {
        transfer_id: uuid::Uuid::new_v4().to_string(),
        from_wallet: from_wallet.to_owned(),
        to_wallet: to_wallet.to_owned(),
        currency: currency.to_owned(),
        amount: dec(amount),
        status: "completed".to_owned(),
        rejection_reason: None,
        completed_at: now_iso(),
    })
    .expect("serialize")
}
