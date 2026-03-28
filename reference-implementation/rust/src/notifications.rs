use serde_json::{json, Value};

use crate::helpers::now_iso;
use crate::state::ACCOUNT_ID;

const INSTRUMENT_ID: &str = "APEX:FX:EURUSD";

fn build_apex_notification(method: &str, opts: NotificationOpts) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": {
            "event_id": format!("evt_{}", &uuid::Uuid::new_v4().to_string()[..8]),
            "event_type": method,
            "account_id": opts.account_id.unwrap_or_else(|| ACCOUNT_ID.to_owned()),
            "instrument_id": opts.instrument_id.unwrap_or_else(|| INSTRUMENT_ID.to_owned()),
            "resource_uri": opts.resource_uri,
            "timestamp": now_iso(),
            "sequence": opts.sequence,
            "payload": opts.payload,
        }
    })
}

struct NotificationOpts {
    account_id: Option<String>,
    instrument_id: Option<String>,
    resource_uri: String,
    sequence: u64,
    payload: Value,
}

pub fn order_filled(
    order_id: &str,
    side: &str,
    fill_price: f64,
    fill_quantity: f64,
    account_id: &str,
    instrument_id: &str,
    fill_sequence: u64,
) -> Value {
    build_apex_notification(
        "notifications/apex.order.filled",
        NotificationOpts {
            account_id: Some(account_id.to_owned()),
            instrument_id: Some(instrument_id.to_owned()),
            resource_uri: format!("apex://account/fills/{account_id}"),
            sequence: fill_sequence,
            payload: json!({
                "order_id": order_id,
                "side": side,
                "fill_price": fill_price,
                "fill_quantity": fill_quantity,
                "commission": -0.5,
                "position_id": "pos_001",
            }),
        },
    )
}

pub fn order_partially_filled(
    order_id: &str,
    side: &str,
    fill_price: f64,
    fill_quantity: f64,
    remaining_quantity: f64,
    account_id: &str,
    instrument_id: &str,
    fill_sequence: u64,
) -> Value {
    build_apex_notification(
        "notifications/apex.order.partially_filled",
        NotificationOpts {
            account_id: Some(account_id.to_owned()),
            instrument_id: Some(instrument_id.to_owned()),
            resource_uri: format!("apex://account/fills/{account_id}"),
            sequence: fill_sequence,
            payload: json!({
                "order_id": order_id,
                "side": side,
                "fill_price": fill_price,
                "fill_quantity": fill_quantity,
                "remaining_quantity": remaining_quantity,
            }),
        },
    )
}

#[allow(dead_code)]
pub fn order_rejected(code: &str, reason: &str, risk_sequence: u64) -> Value {
    build_apex_notification(
        "notifications/apex.order.rejected",
        NotificationOpts {
            account_id: None,
            instrument_id: None,
            resource_uri: format!("apex://account/risk/{ACCOUNT_ID}"),
            sequence: risk_sequence,
            payload: json!({
                "code": code,
                "reason": reason,
            }),
        },
    )
}

pub fn candle_closed(
    instrument_id: &str,
    timeframe: &str,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: u64,
    candle_sequence: u64,
) -> Value {
    build_apex_notification(
        "notifications/apex.market.candle_closed",
        NotificationOpts {
            account_id: None,
            instrument_id: Some(instrument_id.to_owned()),
            resource_uri: format!(
                "apex://market/candles/{instrument_id}?timeframe={timeframe}&limit=200"
            ),
            sequence: candle_sequence,
            payload: json!({
                "instrument_id": instrument_id,
                "timeframe": timeframe,
                "open": open,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
                "complete": true,
            }),
        },
    )
}

pub fn kill_switch_engaged(risk_sequence: u64) -> Value {
    build_apex_notification(
        "notifications/apex.risk.kill_switch_engaged",
        NotificationOpts {
            account_id: None,
            instrument_id: None,
            resource_uri: format!("apex://account/risk/{ACCOUNT_ID}"),
            sequence: risk_sequence,
            payload: json!({
                "account_id": ACCOUNT_ID,
                "reason": "Daily loss limit exceeded",
            }),
        },
    )
}

pub fn replay_failed(reason: &str, last_available_id: Option<u64>) -> Value {
    // replay_failed uses a simpler format (not the full APEX envelope)
    // to match the TypeScript SDK's EventStore behavior
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/apex.session.replay_failed",
        "params": {
            "reason": reason,
            "last_available_id": last_available_id.map(|id| id.to_string()),
        }
    })
}
