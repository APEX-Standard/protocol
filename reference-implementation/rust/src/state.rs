use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::helpers::{apex_error, dec, hours_ago, now_iso};

pub const ACCOUNT_ID: &str = "ACC_12345";
pub const INSTRUMENT_ID: &str = "APEX:FX:EURUSD";
pub const BROKER_SYMBOL: &str = "EURUSD";

pub fn quote_uri() -> String {
    format!("apex://market/quote/{INSTRUMENT_ID}")
}

pub fn candles_uri(timeframe: &str) -> String {
    format!("apex://market/candles/{INSTRUMENT_ID}?timeframe={timeframe}&limit=200")
}

pub fn features_uri() -> String {
    format!("apex://market/features/{INSTRUMENT_ID}")
}

pub fn account_summary_uri() -> String {
    format!("apex://account/summary/{ACCOUNT_ID}")
}

pub fn positions_uri() -> String {
    format!("apex://account/positions/{ACCOUNT_ID}")
}

pub fn orders_uri() -> String {
    format!("apex://account/orders/{ACCOUNT_ID}")
}

pub fn fills_uri() -> String {
    format!("apex://account/fills/{ACCOUNT_ID}")
}

pub fn risk_uri() -> String {
    format!("apex://account/risk/{ACCOUNT_ID}")
}

pub fn decision_context_uri() -> String {
    format!("apex://agent/decision-context/{INSTRUMENT_ID}")
}

#[derive(Debug)]
struct InnerState {
    resource_sequences: HashMap<String, u64>,
    orders: Vec<Value>,
    fills: Vec<Value>,
    quote_stale: bool,
    risk_stale: bool,
    force_sequence_gap: bool,
    kill_switch_active: bool,
    partial_fill_next_order: bool,
    live_mid: f64,
    live_bid: f64,
    live_ask: f64,
}

impl Default for InnerState {
    fn default() -> Self {
        Self {
            resource_sequences: HashMap::new(),
            orders: Vec::new(),
            fills: Vec::new(),
            quote_stale: false,
            risk_stale: false,
            force_sequence_gap: false,
            kill_switch_active: false,
            partial_fill_next_order: false,
            live_mid: 1.08750,
            live_bid: 1.08740,
            live_ask: 1.08760,
        }
    }
}

#[derive(Debug, Default)]
pub struct ReferenceTradingState {
    inner: Mutex<InnerState>,
}

impl ReferenceTradingState {
    pub fn update_quote(&self, mid: f64, bid: f64, ask: f64) {
        let mut inner = self.inner.lock().expect("state mutex poisoned");
        inner.live_mid = mid;
        inner.live_bid = bid;
        inner.live_ask = ask;
    }

    pub fn bump_resources_list(&self, uris: &[String]) -> Vec<String> {
        let mut inner = self.inner.lock().expect("state mutex poisoned");
        self.bump_sequences(&mut inner, uris)
    }

    pub fn get_sequence(&self, uri: &str) -> u64 {
        let inner = self.inner.lock().expect("state mutex poisoned");
        inner.resource_sequences.get(uri).copied().unwrap_or(1)
    }

    pub fn account_summary_payload(&self, currency: Option<String>) -> Value {
        json!({
            "account_id": ACCOUNT_ID,
            "account_base_currency": "USD",
            "response_currency": currency.unwrap_or_else(|| "USD".to_owned()),
            "balance": dec(10000.0),
            "equity": dec(10250.0),
            "used_margin": dec(500.0),
            "free_margin": dec(9750.0),
            "margin_level_pct": dec(2050.0),
            "unrealised_pnl": dec(250.0),
            "realised_pnl_today": dec(0.0),
            "as_of": if self.inner.lock().expect("state mutex poisoned").risk_stale {
                (chrono::Utc::now() - chrono::Duration::seconds(5))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            } else {
                now_iso()
            },
        })
    }

    pub fn positions_payload(&self) -> Value {
        json!({
            "account_id": ACCOUNT_ID,
            "positions": [{
                "position_id": "pos_001",
                "instrument_id": INSTRUMENT_ID,
                "broker_symbol": BROKER_SYMBOL,
                "side": "buy",
                "quantity": dec(100000.0),
                "quantity_unit": "base_units",
                "broker_quantity": "1.0",
                "broker_quantity_unit": "lots",
                "open_price": dec(1.0850),
                "current_price": dec(1.0875),
                "unrealised_pnl": dec(250.0),
                "unrealised_pnl_currency": "USD",
                "used_margin": dec(500.0),
                "open_time": hours_ago(1),
                "stop_loss": dec(1.0800),
                "take_profit": dec(1.1000),
                "profile_data": {
                    "rollover_long_daily": dec(-2.5),
                    "rollover_short_daily": dec(1.8),
                    "accrued_rollover": dec(-7.5),
                    "pip_value": dec(10.0),
                    "pip_value_currency": "USD"
                }
            }],
            "total_unrealised_pnl": dec(250.0),
            "as_of": now_iso(),
        })
    }

    pub fn orders_payload(&self) -> Value {
        let inner = self.inner.lock().expect("state mutex poisoned");
        json!({
            "account_id": ACCOUNT_ID,
            "orders": inner.orders,
            "as_of": now_iso(),
        })
    }

    pub fn quote_payload(
        &self,
        instrument_id: Option<String>,
        broker_symbol: Option<String>,
    ) -> Value {
        let inner = self.inner.lock().expect("state mutex poisoned");
        let spread = ((inner.live_ask - inner.live_bid) * 100000.0).round() / 100000.0;
        json!({
            "instrument_id": instrument_id.unwrap_or_else(|| INSTRUMENT_ID.to_owned()),
            "broker_symbol": broker_symbol.unwrap_or_else(|| BROKER_SYMBOL.to_owned()),
            "bid": dec(inner.live_bid),
            "ask": dec(inner.live_ask),
            "mid": dec(inner.live_mid),
            "spread": dec(spread),
            "timestamp": if inner.quote_stale {
                (chrono::Utc::now() - chrono::Duration::seconds(5))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            } else {
                now_iso()
            },
            "is_tradeable": true,
            "market_status": "open",
        })
    }

    pub fn order_status_payload(&self, order_id: &str) -> Option<Value> {
        let inner = self.inner.lock().expect("state mutex poisoned");
        inner
            .orders
            .iter()
            .find(|order| order["order_id"] == order_id)
            .map(|order| {
                let mut o = order.clone();
                o["as_of"] = json!(now_iso());
                o
            })
    }

    pub fn create_order(&self, order: &Value) -> (Value, Vec<String>) {
        let mut inner = self.inner.lock().expect("state mutex poisoned");
        let order_type = order["order_type"].as_str().unwrap_or("market");
        let quantity = order["quantity"].as_f64().unwrap_or(0.0);
        let is_market = order_type == "market";
        let is_partial_fill = is_market && inner.partial_fill_next_order;
        let order_id = format!("ord_{:x}", uuid::Uuid::new_v4().as_u128());
        let now = now_iso();
        let fill_quantity = if is_partial_fill {
            quantity / 2.0
        } else {
            quantity
        };
        let remaining_quantity = quantity - fill_quantity;

        let side = match order["side"].as_str() {
            Some("buy") | Some("sell") => order["side"].as_str().unwrap(),
            _ => {
                let err = apex_error(
                    "APEX_4011",
                    "validation",
                    "side is required and must be 'buy' or 'sell'",
                    None,
                );
                return (
                    serde_json::to_value(err).expect("error should serialize"),
                    vec![],
                );
            }
        };

        let order_record = json!({
            "order_id": order_id,
            "client_order_id": order.get("client_order_id").cloned().unwrap_or(Value::Null),
            "account_id": ACCOUNT_ID,
            "instrument_id": order["instrument_id"].as_str().unwrap_or(INSTRUMENT_ID),
            "broker_symbol": order.get("broker_symbol").and_then(Value::as_str).unwrap_or(BROKER_SYMBOL),
            "side": side,
            "order_type": order_type,
            "quantity": dec(quantity),
            "quantity_unit": order.get("quantity_unit").and_then(Value::as_str).unwrap_or("base_units"),
            "limit_price": order.get("limit_price").and_then(Value::as_f64).map(dec),
            "stop_price": order.get("stop_price").and_then(Value::as_f64).map(dec),
            "time_in_force": order.get("time_in_force").and_then(Value::as_str).unwrap_or("GTC"),
            "status": if is_partial_fill {
                "partially_filled"
            } else if is_market {
                "filled"
            } else {
                "working"
            },
            "filled_quantity": dec(if is_market { fill_quantity } else { 0.0 }),
            "remaining_quantity": dec(if is_market { remaining_quantity } else { quantity }),
            "average_fill_price": if is_market { json!(dec(1.08755)) } else { Value::Null },
            "reason": Value::Null,
            "created_at": now,
            "updated_at": now,
        });
        inner.orders.push(order_record.clone());
        inner.partial_fill_next_order = false;

        if is_market {
            inner.fills.insert(
                0,
                json!({
                    "fill_id": format!("fill_{order_id}"),
                    "order_id": order_id,
                    "account_id": ACCOUNT_ID,
                    "instrument_id": order_record["instrument_id"],
                    "side": order_record["side"],
                    "fill_quantity": dec(fill_quantity),
                    "fill_price": dec(1.08755),
                    "commission": dec(-0.5),
                    "commission_currency": "USD",
                    "liquidity_flag": "taker",
                    "position_id": "pos_001",
                    "timestamp": now,
                }),
            );
        }

        let uris = self.bump_sequences(
            &mut inner,
            &[
                orders_uri(),
                positions_uri(),
                fills_uri(),
                risk_uri(),
                decision_context_uri(),
            ],
        );

        (
            json!({
                "order_id": order_id,
                "client_order_id": order_record["client_order_id"],
                "status": if is_partial_fill {
                    "partially_filled"
                } else if is_market {
                    "filled"
                } else {
                    "working"
                },
                "fill_price": if is_market { json!(dec(1.08755)) } else { Value::Null },
                "fill_quantity": dec(if is_market { fill_quantity } else { 0.0 }),
                "remaining_quantity": dec(if is_market { remaining_quantity } else { quantity }),
                "position_id": if is_market { json!("pos_001") } else { Value::Null },
                "rejection_reason": Value::Null,
                "created_at": now,
            }),
            uris,
        )
    }

    pub fn order_acceptance(&self) -> Result<(), (&'static str, &'static str, &'static str)> {
        let inner = self.inner.lock().expect("state mutex poisoned");
        if inner.quote_stale {
            return Err(("APEX_4024", "operational", "Quote state is stale"));
        }
        if inner.risk_stale {
            return Err(("APEX_4024", "operational", "Risk state is stale"));
        }
        if inner.force_sequence_gap {
            return Err(("APEX_4025", "operational", "Sequence continuity is broken"));
        }
        if inner.kill_switch_active {
            return Err(("APEX_4023", "risk", "Kill switch is active"));
        }
        Ok(())
    }

    pub fn set_faults(
        &self,
        quote_stale: Option<bool>,
        risk_stale: Option<bool>,
        force_sequence_gap: Option<bool>,
        kill_switch_active: Option<bool>,
        partial_fill_next_order: Option<bool>,
    ) -> Value {
        let mut inner = self.inner.lock().expect("state mutex poisoned");
        if let Some(value) = quote_stale {
            inner.quote_stale = value;
        }
        if let Some(value) = risk_stale {
            inner.risk_stale = value;
        }
        if let Some(value) = force_sequence_gap {
            inner.force_sequence_gap = value;
        }
        if let Some(value) = kill_switch_active {
            inner.kill_switch_active = value;
        }
        if let Some(value) = partial_fill_next_order {
            inner.partial_fill_next_order = value;
        }

        json!({
            "quote_stale": inner.quote_stale,
            "risk_stale": inner.risk_stale,
            "force_sequence_gap": inner.force_sequence_gap,
            "kill_switch_active": inner.kill_switch_active,
            "partial_fill_next_order": inner.partial_fill_next_order,
        })
    }

    pub fn modify_order(&self, target_id: &str) -> Vec<String> {
        let mut inner = self.inner.lock().expect("state mutex poisoned");
        for order in &mut inner.orders {
            if order["order_id"] == target_id {
                order["updated_at"] = json!(now_iso());
            }
        }
        self.bump_sequences(&mut inner, &[orders_uri(), decision_context_uri()])
    }

    /// Look up a position by ID from the positions payload.
    /// Returns (instrument_id, side, total_quantity) or None if not found.
    pub fn find_position(&self, position_id: &str) -> Option<(String, String, f64)> {
        let payload = self.positions_payload();
        let positions = payload["positions"].as_array()?;
        for pos in positions {
            if pos["position_id"].as_str() == Some(position_id) {
                let instrument_id = pos["instrument_id"]
                    .as_str()
                    .unwrap_or(INSTRUMENT_ID)
                    .to_owned();
                let side = pos["side"].as_str().unwrap_or("buy").to_owned();
                let quantity = pos["quantity"]
                    .as_str()
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                return Some((instrument_id, side, quantity));
            }
        }
        None
    }

    /// Close (fully or partially) a position by placing an opposite-direction
    /// market order. Returns (payload, resource_update_uris).
    pub fn close_position(
        &self,
        position_id: &str,
        close_quantity: f64,
        instrument_id: &str,
        close_side: &str,
    ) -> (Value, Vec<String>) {
        let order = json!({
            "instrument_id": instrument_id,
            "side": close_side,
            "order_type": "market",
            "quantity": close_quantity,
            "quantity_unit": "base_units",
            "time_in_force": "IOC",
            "comment": format!("Close position {position_id}"),
        });
        self.create_order(&order)
    }

    pub fn cancel_order(&self, order_id: &str) -> Vec<String> {
        let mut inner = self.inner.lock().expect("state mutex poisoned");
        for order in &mut inner.orders {
            if order["order_id"] == order_id {
                order["status"] = json!("cancelled");
                order["remaining_quantity"] = json!(dec(0.0));
                order["updated_at"] = json!(now_iso());
            }
        }
        self.bump_sequences(&mut inner, &[orders_uri(), decision_context_uri()])
    }

    pub fn list_resources(&self) -> Vec<(String, String, String)> {
        vec![
            (
                "quote".to_owned(),
                quote_uri(),
                "Live top-of-book quote".to_owned(),
            ),
            (
                "candles-m1".to_owned(),
                candles_uri("M1"),
                "M1 candles".to_owned(),
            ),
            (
                "candles-m5".to_owned(),
                candles_uri("M5"),
                "M5 candles".to_owned(),
            ),
            (
                "candles-h1".to_owned(),
                candles_uri("H1"),
                "H1 candles".to_owned(),
            ),
            (
                "features".to_owned(),
                features_uri(),
                "Derived market features".to_owned(),
            ),
            (
                "account-summary".to_owned(),
                account_summary_uri(),
                "Realtime account summary".to_owned(),
            ),
            (
                "account-positions".to_owned(),
                positions_uri(),
                "Realtime positions".to_owned(),
            ),
            (
                "account-orders".to_owned(),
                orders_uri(),
                "Realtime orders".to_owned(),
            ),
            (
                "account-fills".to_owned(),
                fills_uri(),
                "Realtime fills".to_owned(),
            ),
            (
                "account-risk".to_owned(),
                risk_uri(),
                "Realtime risk state".to_owned(),
            ),
            (
                "decision-context".to_owned(),
                decision_context_uri(),
                "Model-ready decision context".to_owned(),
            ),
        ]
    }

    pub fn read_resource_payload(&self, uri: &str) -> Option<Value> {
        match uri {
            uri if uri == quote_uri() => Some(self.envelope(uri, self.quote_payload(None, None), 1000)),
            uri if uri == candles_uri("M1") => Some(self.candles_payload(uri, "M1", 1.0875)),
            uri if uri == candles_uri("M5") => Some(self.candles_payload(uri, "M5", 1.0868)),
            uri if uri == candles_uri("H1") => Some(self.candles_payload(uri, "H1", 1.0842)),
            uri if uri == features_uri() => Some(self.envelope(uri, json!({
                "instrument_id": INSTRUMENT_ID,
                "as_of": now_iso(),
                "quote": { "bid": dec(1.08740), "ask": dec(1.08760), "mid": dec(1.08750), "spread": dec(0.00020) },
                "returns": { "r_1s": 0.00002, "r_5s": 0.00005, "r_1m": 0.0008 },
                "volatility": { "rv_1m": 0.12, "rv_5m": 0.37, "rv_30m": 0.55 },
                "book": { "top_level_imbalance": 0.21, "depth_imbalance": 0.18, "microprice": 1.08753 },
                "flow": { "trade_intensity_30s": 0.67, "aggressor_imbalance_30s": 0.44 },
                "regime": { "label": "trend_up", "confidence": 0.81 },
                "execution": { "liquidity_score": 0.79, "expected_slippage_bps": 0.6 }
            }), 2000)),
            uri if uri == account_summary_uri() => Some(self.envelope(uri, self.account_summary_payload(None), 2000)),
            uri if uri == positions_uri() => Some(self.envelope(uri, self.positions_payload(), 2000)),
            uri if uri == orders_uri() => Some(self.envelope(uri, self.orders_payload(), 2000)),
            uri if uri == fills_uri() => {
                let fills = {
                    let inner = self.inner.lock().expect("state mutex poisoned");
                    inner.fills.clone()
                };
                Some(self.envelope(uri, json!({"account_id": ACCOUNT_ID, "as_of": now_iso(), "fills": fills}), 2000))
            }
            uri if uri == risk_uri() => {
                let inner = self.inner.lock().expect("state mutex poisoned");
                let as_of = if inner.risk_stale {
                    (chrono::Utc::now() - chrono::Duration::seconds(5))
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                } else {
                    now_iso()
                };
                let kill_switch = inner.kill_switch_active;
                drop(inner);
                Some(self.envelope(uri, json!({
                    "account_id": ACCOUNT_ID,
                    "as_of": as_of,
                    "available_margin": dec(9750.0),
                    "kill_switch_active": kill_switch,
                    "max_position_size": dec(5000000.0),
                    "max_open_orders": 50,
                    "daily_loss_limit": dec(-1000.0),
                    "daily_loss_used": dec(-150.0),
                    "restricted_instruments": [],
                    "margin_call_level_pct": dec(100.0),
                    "stop_out_level_pct": dec(50.0)
                }), 2000))
            }
            uri if uri == decision_context_uri() => Some(self.envelope(uri, json!({
                "instrument_id": INSTRUMENT_ID,
                "timestamp": now_iso(),
                "market": {
                    "quote_resource": quote_uri(),
                    "feature_resource": features_uri(),
                    "candle_resources": [candles_uri("M1"), candles_uri("M5"), candles_uri("H1")]
                },
                "account": {
                    "summary_resource": account_summary_uri(),
                    "positions_resource": positions_uri(),
                    "orders_resource": orders_uri(),
                    "risk_resource": risk_uri()
                },
                "constraints": {
                    "kill_switch_active": self.inner.lock().expect("state mutex poisoned").kill_switch_active,
                    "max_position_size": dec(5000000.0),
                    "max_open_orders": 50
                }
            }), 5000)),
            _ => None,
        }
    }

    fn envelope(&self, uri: &str, payload: Value, stale_after_ms: u64) -> Value {
        let mut object = payload.as_object().cloned().unwrap_or_default();
        let inner = self.inner.lock().expect("state mutex poisoned");
        object.insert(
            "sequence".to_owned(),
            json!(inner.resource_sequences.get(uri).copied().unwrap_or(1)),
        );
        object.insert("stale_after_ms".to_owned(), json!(stale_after_ms));
        Value::Object(object)
    }

    fn candles_payload(&self, uri: &str, timeframe: &str, close: f64) -> Value {
        self.envelope(
            uri,
            json!({
                "instrument_id": INSTRUMENT_ID,
                "timeframe": timeframe,
                "partial_candle_included": true,
                "as_of": now_iso(),
                "candles": [{
                    "time": now_iso(),
                    "open": dec(close - 0.0006),
                    "high": dec(close + 0.0008),
                    "low": dec(close - 0.0010),
                    "close": dec(close),
                    "volume": 125000,
                    "complete": true
                }]
            }),
            60000,
        )
    }

    fn bump_sequences(&self, inner: &mut InnerState, uris: &[String]) -> Vec<String> {
        let mut unique = Vec::new();
        let mut seen = HashSet::new();
        for uri in uris {
            let increment = if inner.force_sequence_gap { 5 } else { 1 };
            *inner.resource_sequences.entry(uri.clone()).or_insert(1) += increment;
            if seen.insert(uri.clone()) {
                unique.push(uri.clone());
            }
        }
        inner.force_sequence_gap = false;
        unique
    }
}
