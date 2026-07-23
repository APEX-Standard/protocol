use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};

use crate::handlers;
use crate::models::*;
use crate::notifications;
use crate::replay_buffer::{ReplayBuffer, ReplayItem, ReplayResult};
use crate::state::{ReferenceTradingState, ACCOUNT_ID, INSTRUMENT_ID};
use crate::tick_engine::{TickEngine, TickEvent};

/// Shared state for the HTTP transport.
pub struct HttpState {
    sessions: Mutex<HashMap<String, SessionData>>,
    trading_state: Arc<ReferenceTradingState>,
    replay_buffer: Arc<ReplayBuffer>,
    /// Broadcast channel for SSE events.
    /// Each event is (session_id, sse_event_id, json_rpc_message).
    event_tx: broadcast::Sender<(String, String, Value)>,
    tick_engine: Mutex<Option<TickEngine>>,
    tick_event_tx: tokio::sync::mpsc::UnboundedSender<TickEvent>,
}

struct SessionData {
    subscriptions: HashSet<String>,
    #[allow(dead_code)]
    initialized: bool,
    /// Cancellation flag for the current SSE stream.  When a new GET arrives,
    /// the previous flag is set to `true` so the old stream exits on the next
    /// event or timeout.
    sse_cancelled: Arc<AtomicBool>,
}

impl HttpState {
    fn new(
        trading_state: Arc<ReferenceTradingState>,
        replay_buffer: Arc<ReplayBuffer>,
        event_tx: broadcast::Sender<(String, String, Value)>,
        tick_event_tx: tokio::sync::mpsc::UnboundedSender<TickEvent>,
    ) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            trading_state,
            replay_buffer,
            event_tx,
            tick_engine: Mutex::new(None),
            tick_event_tx,
        }
    }

    /// Emit a JSON-RPC notification to all sessions via SSE.
    fn emit_notification(&self, session_id: &str, notification: Value) {
        let event_id = self.replay_buffer.store(session_id, notification.clone());
        let _ = self
            .event_tx
            .send((session_id.to_owned(), event_id, notification));
    }

    /// Emit a notification to a specific session and also broadcast to SSE.
    fn emit_to_session(&self, session_id: &str, notification: Value) {
        self.emit_notification(session_id, notification);
    }

    /// Emit resource updated notifications for given URIs.
    /// Only sends to sessions that have subscribed to the specific URI
    /// via `resources/subscribe`. APEX domain notifications bypass this
    /// and always broadcast.
    async fn notify_resource_updates(&self, session_id: &str, uris: &[String]) {
        // Collect subscribed URIs under the lock, then emit without holding it.
        let subscribed: Vec<String> = {
            let sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get(session_id) {
                uris.iter()
                    .filter(|uri| session.subscriptions.contains(uri.as_str()))
                    .cloned()
                    .collect()
            } else {
                return;
            }
        };
        for uri in &subscribed {
            let notif = json!({
                "jsonrpc": "2.0",
                "method": "notifications/resources/updated",
                "params": { "uri": uri }
            });
            self.emit_to_session(session_id, notif);
        }
    }
}

type SharedState = Arc<HttpState>;

/// Start the HTTP/SSE server on the given port.
pub async fn start_http_server(port: u16) {
    let trading_state = Arc::new(ReferenceTradingState::default());
    let replay_buffer = Arc::new(ReplayBuffer::new());
    let (event_tx, _) = broadcast::channel::<(String, String, Value)>(4096);
    let (tick_event_tx, tick_event_rx) = tokio::sync::mpsc::unbounded_channel::<TickEvent>();

    let state = Arc::new(HttpState::new(
        trading_state,
        replay_buffer,
        event_tx,
        tick_event_tx,
    ));

    // Spawn the tick event processor
    spawn_tick_event_processor(state.clone(), tick_event_rx);

    let app = Router::new()
        .route("/mcp", post(handle_post))
        .route("/mcp", get(handle_get))
        .route("/mcp", delete(handle_delete))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("failed to bind");

    eprintln!(
        "APEX Protocol Reference Server v{} listening on http://localhost:{port}/mcp",
        SERVER_VERSION
    );

    axum::serve(listener, app).await.expect("server error");
}

fn spawn_tick_event_processor(
    state: SharedState,
    mut tick_rx: tokio::sync::mpsc::UnboundedReceiver<TickEvent>,
) {
    let state = state.clone();
    tokio::spawn(async move {
        // We need a "current session" to emit events to.
        // In our simple model, we broadcast to all sessions.
        while let Some(event) = tick_rx.recv().await {
            let sessions: Vec<String> = {
                let sessions = state.sessions.lock().await;
                sessions.keys().cloned().collect()
            };

            match event {
                TickEvent::QuoteUpdate { mid, bid, ask } => {
                    state.trading_state.update_quote(mid, bid, ask);
                    let uris = state.trading_state.bump_resources_list(&[
                        crate::state::quote_uri(),
                        crate::state::features_uri(),
                    ]);
                    for sid in &sessions {
                        state.notify_resource_updates(sid, &uris).await;
                    }
                }
                TickEvent::CandleClose { timeframe, candle } => {
                    let candle_uri = crate::state::candles_uri(&timeframe);
                    let uris = state
                        .trading_state
                        .bump_resources_list(std::slice::from_ref(&candle_uri));

                    let seq = state.trading_state.get_sequence(&candle_uri);
                    let notif = notifications::candle_closed(notifications::CandleClosedParams {
                        instrument_id: INSTRUMENT_ID,
                        timeframe: &timeframe,
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        volume: candle.volume,
                        candle_sequence: seq,
                    });

                    for sid in &sessions {
                        state.emit_to_session(sid, notif.clone());
                        state.notify_resource_updates(sid, &uris).await;
                    }
                }
                TickEvent::CandleUpdate { timeframe } => {
                    let candle_uri = crate::state::candles_uri(&timeframe);
                    for sid in &sessions {
                        state
                            .notify_resource_updates(sid, std::slice::from_ref(&candle_uri))
                            .await;
                    }
                }
                TickEvent::FeatureUpdate => {
                    let features_uri = crate::state::features_uri();
                    for sid in &sessions {
                        state
                            .notify_resource_updates(sid, std::slice::from_ref(&features_uri))
                            .await;
                    }
                }
            }
        }
    });
}

async fn handle_post(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    let body: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                [("content-type", "application/json")],
                json!({"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": null}).to_string(),
            )
                .into_response();
        }
    };

    let method = body["method"].as_str().unwrap_or("");
    let id = body.get("id").cloned();
    let params = body.get("params").cloned().unwrap_or(json!({}));

    // Handle initialize (no session required)
    if method == "initialize" {
        let session_id = uuid::Uuid::new_v4().to_string();
        {
            let mut sessions = state.sessions.lock().await;
            sessions.insert(
                session_id.clone(),
                SessionData {
                    subscriptions: HashSet::new(),
                    initialized: true,
                    sse_cancelled: Arc::new(AtomicBool::new(false)),
                },
            );
        }

        let result = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": { "listChanged": false },
                "resources": { "subscribe": true, "listChanged": true }
            },
            "serverInfo": {
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
                "apex_version": "0.2.0-alpha",
            }
        });

        let response = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        });

        return (
            StatusCode::OK,
            [
                ("content-type", "application/json"),
                ("mcp-session-id", &session_id),
            ],
            response.to_string(),
        )
            .into_response();
    }

    // All other methods require a session
    let session_header = headers.get("mcp-session-id");

    if session_header.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json")],
            json!({"jsonrpc": "2.0", "error": {"code": -32600, "message": "Missing Mcp-Session-Id header"}, "id": id}).to_string(),
        )
            .into_response();
    }

    let session_id = session_header
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();

    {
        let sessions = state.sessions.lock().await;
        if !sessions.contains_key(&session_id) {
            return (
                StatusCode::NOT_FOUND,
                [("content-type", "application/json")],
                json!({"jsonrpc": "2.0", "error": {"code": -32000, "message": "Unknown session"}, "id": id}).to_string(),
            )
                .into_response();
        }
    }

    // Handle notifications (no id field) -> return 202
    if id.is_none() || body.get("id").is_none() {
        // This is a notification like notifications/initialized
        return (StatusCode::ACCEPTED, "").into_response();
    }

    let response = dispatch_method(&state, &session_id, method, &params, id.clone()).await;

    (
        StatusCode::OK,
        [
            ("content-type", "application/json"),
            ("mcp-session-id", &session_id),
        ],
        response.to_string(),
    )
        .into_response()
}

async fn handle_get(State(state): State<SharedState>, headers: HeaderMap) -> impl IntoResponse {
    let session_id = match headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        Some(id) => id.to_owned(),
        None => {
            return (StatusCode::BAD_REQUEST, "Missing mcp-session-id header").into_response();
        }
    };

    let cancel_flag = {
        let mut sessions = state.sessions.lock().await;
        match sessions.get_mut(&session_id) {
            Some(session) => {
                // Cancel any previous SSE stream for this session.
                session.sse_cancelled.store(true, Ordering::SeqCst);
                // Create a new cancel flag for the incoming stream.
                let flag = Arc::new(AtomicBool::new(false));
                session.sse_cancelled = flag.clone();
                flag
            }
            None => {
                return (StatusCode::NOT_FOUND, "Unknown session").into_response();
            }
        }
    };

    let last_event_id = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_owned());

    // Pre-compute replay items synchronously before starting the stream.
    // The replay buffer now classifies events: required ones are sent verbatim,
    // consecutive non-required events are collapsed into gap_fill markers.
    let replay_events: Vec<(String, String)> = if let Some(last_id) = &last_event_id {
        match state.replay_buffer.replay_after(last_id) {
            ReplayResult::Items(items) => items
                .into_iter()
                .map(|item| match item {
                    ReplayItem::Event(e) => {
                        let data = serde_json::to_string(&e.message).unwrap_or_default();
                        (e.id.to_string(), data)
                    }
                    ReplayItem::GapFill {
                        id,
                        elided_count,
                        from_id,
                        to_id,
                    } => {
                        let notif =
                            ReplayBuffer::gap_fill_notification(id, elided_count, from_id, to_id);
                        let data = serde_json::to_string(&notif).unwrap_or_default();
                        (id.to_string(), data)
                    }
                })
                .collect(),
            ReplayResult::Failed {
                oldest_available_id,
            } => {
                let notif =
                    notifications::replay_failed("event_id_outside_log", oldest_available_id);
                let event_id = state.replay_buffer.next_event_id();
                let data = serde_json::to_string(&notif).unwrap_or_default();
                vec![(event_id.to_string(), data)]
            }
        }
    } else {
        vec![]
    };

    // Subscribe to broadcast AFTER computing replay to avoid interleaving
    let mut rx = state.event_tx.subscribe();

    let stream = async_stream::stream! {
        // First, yield any pre-computed replay events
        for (event_id, data) in replay_events {
            if cancel_flag.load(Ordering::SeqCst) {
                break;
            }
            yield Ok::<_, Infallible>(
                Event::default()
                    .id(event_id)
                    .event("message")
                    .data(data),
            );
        }

        // Then stream live events.
        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                break;
            }
            match rx.recv().await {
                Ok((_sid, event_id, message)) => {
                    if cancel_flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let data = serde_json::to_string(&message).unwrap_or_default();
                    yield Ok::<_, Infallible>(
                        Event::default()
                            .id(event_id)
                            .event("message")
                            .data(data),
                    );
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    };

    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::new())
        .into_response()
}

async fn handle_delete(State(state): State<SharedState>, headers: HeaderMap) -> impl IntoResponse {
    let session_id = match headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        Some(id) => id.to_owned(),
        None => {
            return (StatusCode::BAD_REQUEST, "Missing mcp-session-id header").into_response();
        }
    };

    let mut sessions = state.sessions.lock().await;
    if sessions.remove(&session_id).is_none() {
        return (StatusCode::NOT_FOUND, "Unknown session").into_response();
    }

    // If no sessions remain, stop the tick engine
    if sessions.is_empty() {
        let mut engine_guard = state.tick_engine.lock().await;
        if let Some(engine) = engine_guard.as_mut() {
            engine.stop();
            eprintln!("Tick engine stopped — no active sessions");
        }
        *engine_guard = None;
    }

    StatusCode::OK.into_response()
}

/// Dispatch a JSON-RPC method to the appropriate handler.
async fn dispatch_method(
    state: &SharedState,
    session_id: &str,
    method: &str,
    params: &Value,
    id: Option<Value>,
) -> Value {
    let result = match method {
        "tools/list" => Ok(tools_list()),
        "tools/call" => {
            let tool_name = params["name"].as_str().unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            handle_tool_call(state, session_id, tool_name, &args).await
        }
        "resources/list" => Ok(resources_list(state)),
        "resources/read" => {
            let uri = params["uri"].as_str().unwrap_or("");
            handle_resource_read(state, uri)
        }
        "resources/subscribe" => {
            let uri = params["uri"].as_str().unwrap_or("").to_owned();
            let mut sessions = state.sessions.lock().await;
            if let Some(session) = sessions.get_mut(session_id) {
                session.subscriptions.insert(uri);
            }
            Ok(json!({}))
        }
        "resources/unsubscribe" => {
            let uri = params["uri"].as_str().unwrap_or("").to_owned();
            let mut sessions = state.sessions.lock().await;
            if let Some(session) = sessions.get_mut(session_id) {
                session.subscriptions.remove(&uri);
            }
            Ok(json!({}))
        }
        _ => Err(json!({
            "code": -32601,
            "message": format!("Method not found: {method}")
        })),
    };

    match result {
        Ok(result_value) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result_value
        }),
        Err(error_value) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": error_value
        }),
    }
}

fn tools_list() -> Value {
    json!({
        "tools": [
            // session.authenticate: mutating (creates session), non-destructive, idempotent
            tool_desc("apex.session.authenticate", "Establish an authenticated trading session.", json!({
                "type": "object",
                "properties": {
                    "token": { "type": "string", "description": "Broker-issued JWT or OAuth token" },
                    "token_type": { "type": "string", "default": "jwt" },
                    "account_id": { "type": "string" },
                    "hub_session_id": { "type": "string" }
                },
                "required": ["token"]
            }), ann_mutating_idempotent()),
            // session.capabilities: read-only
            tool_desc("apex.session.capabilities", "Query the full capability manifest.", json!({
                "type": "object", "properties": {}
            }), ann_read_only()),
            // session.heartbeat: read-only
            tool_desc("apex.session.heartbeat", "Keep-alive ping.", json!({
                "type": "object",
                "properties": { "timestamp": { "type": "string" } },
                "required": ["timestamp"]
            }), ann_read_only()),
            // session.acknowledge: read-only
            tool_desc("apex.session.acknowledge", "Acknowledge receipt of events through a given event ID.", json!({
                "type": "object",
                "properties": {
                    "last_event_id": { "type": "string", "description": "The highest event ID the client has processed" }
                },
                "required": ["last_event_id"]
            }), ann_read_only()),
            // account.summary: read-only
            tool_desc("apex.account.summary", "Current account state.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "currency": { "type": "string" }
                },
                "required": ["account_id"]
            }), ann_read_only()),
            // account.positions: read-only
            tool_desc("apex.account.positions", "All open positions.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "instrument_id": { "type": "string" },
                    "profile": { "type": "string" }
                },
                "required": ["account_id"]
            }), ann_read_only()),
            // account.orders: read-only
            tool_desc("apex.account.orders", "Known orders.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "status": { "type": "string", "default": "all" },
                    "instrument_id": { "type": "string" }
                },
                "required": ["account_id"]
            }), ann_read_only()),
            // account.history: read-only
            tool_desc("apex.account.history", "Closed trades and funding events.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "from": { "type": "string" },
                    "to": { "type": "string" },
                    "event_type": { "type": "string", "default": "all" },
                    "limit": { "type": "integer", "default": 100 },
                    "cursor": { "type": "string" }
                },
                "required": ["account_id", "from", "to"]
            }), ann_read_only()),
            // order.place: destructive, non-idempotent
            tool_desc("apex.order.place", "Unified order entry.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "order": { "type": "object" }
                },
                "required": ["account_id", "order"]
            }), ann_destructive()),
            // order.modify: destructive, non-idempotent
            tool_desc("apex.order.modify", "Amend a working order.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "target_type": { "type": "string" },
                    "target_id": { "type": "string" },
                    "modifications": { "type": "object" }
                },
                "required": ["account_id", "target_type", "target_id", "modifications"]
            }), ann_destructive()),
            // order.cancel: destructive, idempotent
            tool_desc("apex.order.cancel", "Cancel a working order.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "order_id": { "type": "string" },
                    "reason": { "type": "string" }
                },
                "required": ["account_id", "order_id"]
            }), ann_destructive_idempotent()),
            // position.close: destructive, non-idempotent
            tool_desc("apex.position.close", "Close an open position fully or partially.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "position_id": { "type": "string" },
                    "quantity": { "type": "number", "description": "Partial close quantity. Omit to close the full position." }
                },
                "required": ["account_id", "position_id"]
            }), ann_destructive()),
            // order.status: read-only
            tool_desc("apex.order.status", "Query order state.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "order_id": { "type": "string" }
                },
                "required": ["account_id", "order_id"]
            }), ann_read_only()),
            // market.quote: read-only
            tool_desc("apex.market.quote", "Current bid/ask/mid.", json!({
                "type": "object",
                "properties": {
                    "instrument_id": { "type": "string" },
                    "broker_symbol": { "type": "string" }
                }
            }), ann_read_only()),
            // market.snapshot: read-only
            tool_desc("apex.market.snapshot", "OHLCV candle data.", json!({
                "type": "object",
                "properties": {
                    "instrument_id": { "type": "string" },
                    "timeframe": { "type": "string" },
                    "from": { "type": "string" },
                    "to": { "type": "string" },
                    "limit": { "type": "integer", "default": 200 }
                },
                "required": ["instrument_id", "timeframe", "from"]
            }), ann_read_only()),
            // market.search: read-only
            tool_desc("apex.market.search", "Discover instruments.", json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "profile": { "type": "string" },
                    "limit": { "type": "integer", "default": 20 }
                },
                "required": ["query"]
            }), ann_read_only()),
            // market.details: read-only
            tool_desc("apex.market.details", "Full contract specification.", json!({
                "type": "object",
                "properties": {
                    "instrument_id": { "type": "string" }
                },
                "required": ["instrument_id"]
            }), ann_read_only()),
            // risk.check: read-only
            tool_desc("apex.risk.check", "Pre-trade margin check.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "order": { "type": "object" }
                },
                "required": ["account_id", "order"]
            }), ann_read_only()),
            // risk.limits: read-only
            tool_desc("apex.risk.limits", "Account risk limits.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" }
                },
                "required": ["account_id"]
            }), ann_read_only()),
            // reference.test tools: mutating, non-destructive, idempotent (fault injection)
            tool_desc("reference.test.set_realtime_state", "Fault injection for testing.", json!({
                "type": "object",
                "properties": {
                    "quote_stale": { "type": "boolean" },
                    "risk_stale": { "type": "boolean" },
                    "force_sequence_gap": { "type": "boolean" },
                    "kill_switch_active": { "type": "boolean" },
                    "partial_fill_next_order": { "type": "boolean" }
                }
            }), ann_mutating_idempotent()),
            tool_desc("reference.test.force_candle_close", "Force-close a partial candle.", json!({
                "type": "object",
                "properties": {
                    "timeframe": { "type": "string", "enum": ["M1", "M5", "H1"] }
                },
                "required": ["timeframe"]
            }), ann_mutating_idempotent()),
            tool_desc("reference.test.stop_ticks", "Stop the tick engine. Test-only tool for deterministic event counts.", json!({
                "type": "object",
                "properties": {}
            }), ann_mutating_idempotent()),
            // fx.rollover: read-only
            tool_desc("apex.fx.rollover", "Query swap/rollover rates for an FX instrument.", json!({
                "type": "object",
                "properties": {
                    "instrument_id": { "type": "string", "description": "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)" },
                    "as_of": { "type": "string", "description": "ISO8601 timestamp — defaults to now" }
                },
                "required": ["instrument_id"]
            }), ann_read_only()),
            // fx.exposure: read-only
            tool_desc("apex.fx.exposure", "Net currency exposure across open FX positions.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string", "description": "Trading account ID" },
                    "base_currency": { "type": "string", "description": "Denominate all exposures in this currency" }
                },
                "required": ["account_id", "base_currency"]
            }), ann_read_only()),
            // fx.conversion: read-only
            tool_desc("apex.fx.conversion", "Real-time cross-currency conversion rate.", json!({
                "type": "object",
                "properties": {
                    "from_currency": { "type": "string", "description": "Source currency code (e.g. EUR)" },
                    "to_currency": { "type": "string", "description": "Target currency code (e.g. USD)" },
                    "amount": { "type": "number", "description": "Amount to convert" }
                },
                "required": ["from_currency", "to_currency", "amount"]
            }), ann_read_only()),
            // cfd.corporate_actions: read-only
            tool_desc("apex.cfd.corporate_actions", "Query upcoming corporate actions for CFD instruments.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string", "description": "Trading account ID" },
                    "instrument_id": { "type": "string", "description": "Filter by APEX canonical instrument ID" },
                    "from": { "type": "string", "description": "ISO8601 start date" },
                    "to": { "type": "string", "description": "ISO8601 end date" }
                },
                "required": ["account_id"]
            }), ann_read_only()),
            // cfd.dividend_adjustment: read-only
            tool_desc("apex.cfd.dividend_adjustment", "Query dividend adjustments for CFD positions.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string", "description": "Trading account ID" },
                    "status": { "type": "string", "description": "Filter by status (default: all)" },
                    "from": { "type": "string", "description": "ISO8601 start date" },
                    "to": { "type": "string", "description": "ISO8601 end date" }
                },
                "required": ["account_id"]
            }), ann_read_only()),
            // crypto.funding_rate: read-only
            tool_desc("apex.crypto.funding_rate", "Query funding rate for a perpetual instrument.", json!({
                "type": "object",
                "properties": {
                    "instrument_id": { "type": "string", "description": "APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)" }
                },
                "required": ["instrument_id"]
            }), ann_read_only()),
            // crypto.liquidation_estimate: read-only
            tool_desc("apex.crypto.liquidation_estimate", "Estimate liquidation price for a perpetual position.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string", "description": "Trading account ID" },
                    "instrument_id": { "type": "string", "description": "APEX canonical instrument ID" },
                    "side": { "type": "string", "description": "Position side: buy or sell" },
                    "quantity": { "type": "number", "description": "Position quantity" },
                    "leverage": { "type": "number", "description": "Leverage multiplier" },
                    "margin_mode": { "type": "string", "description": "Margin mode: cross or isolated" },
                    "entry_price": { "type": "number", "description": "Entry price" }
                },
                "required": ["account_id", "instrument_id", "side", "quantity", "leverage", "margin_mode", "entry_price"]
            }), ann_read_only()),
            // crypto.transfer: mutating, non-destructive, non-idempotent
            tool_desc("apex.crypto.transfer", "Transfer funds between wallets (spot, futures, funding).", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string", "description": "Trading account ID" },
                    "from_wallet": { "type": "string", "enum": ["spot", "futures", "funding"], "description": "Source wallet" },
                    "to_wallet": { "type": "string", "enum": ["spot", "futures", "funding"], "description": "Destination wallet" },
                    "currency": { "type": "string", "description": "Currency to transfer (e.g. USDT)" },
                    "amount": { "type": "number", "description": "Amount to transfer" }
                },
                "required": ["account_id", "from_wallet", "to_wallet", "currency", "amount"]
            }), ann_mutating()),
            // futures.contract_chain: read-only
            tool_desc("apex.futures.contract_chain", "List dated contracts for a futures contract root with expirations and liquidity.", json!({
                "type": "object",
                "properties": {
                    "root": { "type": "string", "description": "APEX contract root ID (e.g. APEX:FUT:ES)" },
                    "include_expired": { "type": "boolean", "description": "Include expired contracts (default: false)" }
                },
                "required": ["root"]
            }), ann_read_only()),
            // futures.margin_schedule: read-only
            tool_desc("apex.futures.margin_schedule", "Per-contract margin requirements: exchange overnight and broker intraday margins.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string", "description": "Trading account ID" },
                    "instrument_id": { "type": "string", "description": "Filter by APEX canonical instrument ID (e.g. APEX:FUT:ESZ26)" }
                },
                "required": ["account_id"]
            }), ann_read_only()),
        ]
    })
}

/// Tool annotations: read-only, non-destructive, idempotent.
fn ann_read_only() -> Value {
    json!({ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true })
}

/// Tool annotations: mutating, non-destructive, idempotent (e.g. authenticate).
fn ann_mutating_idempotent() -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true })
}

/// Tool annotations: destructive, non-idempotent (e.g. order.place, order.modify, position.close).
fn ann_destructive() -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false })
}

/// Tool annotations: destructive, idempotent (e.g. order.cancel).
fn ann_destructive_idempotent() -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true })
}

/// Tool annotations: mutating, non-destructive, non-idempotent (e.g. crypto.transfer).
fn ann_mutating() -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false })
}

fn tool_desc(name: &str, description: &str, input_schema: Value, annotations: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "annotations": annotations
    })
}

fn resources_list(state: &SharedState) -> Value {
    let resources: Vec<Value> = state
        .trading_state
        .list_resources()
        .into_iter()
        .map(|(name, uri, description)| {
            json!({
                "uri": uri,
                "name": name,
                "description": description,
                "mimeType": "application/json"
            })
        })
        .collect();

    json!({ "resources": resources })
}

fn handle_resource_read(state: &SharedState, uri: &str) -> Result<Value, Value> {
    let payload = state
        .trading_state
        .read_resource_payload(uri)
        .ok_or_else(|| {
            json!({
                "code": -32002,
                "message": "Resource not found"
            })
        })?;

    Ok(json!({
        "contents": [{
            "uri": uri,
            "mimeType": "application/json",
            "text": serde_json::to_string(&payload).unwrap_or_default()
        }]
    }))
}

async fn handle_tool_call(
    state: &SharedState,
    session_id: &str,
    tool_name: &str,
    args: &Value,
) -> Result<Value, Value> {
    let result = match tool_name {
        "apex.session.authenticate" => {
            let token = args["token"].as_str().unwrap_or("");
            let account_id = args["account_id"].as_str();
            let payload = handlers::handle_authenticate(&state.trading_state, token, account_id);

            // Start tick engine on successful authentication (no error field)
            if payload.get("error").is_none() {
                let mut engine_guard = state.tick_engine.lock().await;
                if engine_guard.is_none() {
                    let mut engine = TickEngine::new(state.tick_event_tx.clone());
                    engine.start();
                    *engine_guard = Some(engine);
                    eprintln!("Tick engine started after authentication");
                }
            }

            json_result_value(&payload)
        }
        "apex.session.capabilities" => json_result_value(&handlers::handle_capabilities()),
        "apex.session.heartbeat" => json_result_value(&handlers::handle_heartbeat()),
        "apex.session.acknowledge" => {
            // HTTP-specific: uses replay buffer
            let last_event_id = args["last_event_id"].as_str().unwrap_or("0");
            let (acknowledged_through, buffer_depth) =
                state.replay_buffer.acknowledge(last_event_id);
            json_result_value(&json!({
                "acknowledged_through": acknowledged_through,
                "buffer_depth": buffer_depth,
            }))
        }
        "reference.test.set_realtime_state" => {
            // HTTP-specific: emit kill switch notification
            let was_kill_switch = state
                .trading_state
                .read_resource_payload(&crate::state::risk_uri())
                .and_then(|p| p["kill_switch_active"].as_bool())
                .unwrap_or(false);

            let payload = handlers::handle_set_realtime_state(
                &state.trading_state,
                args["quote_stale"].as_bool(),
                args["risk_stale"].as_bool(),
                args["force_sequence_gap"].as_bool(),
                args["kill_switch_active"].as_bool(),
                args["partial_fill_next_order"].as_bool(),
            );

            if !was_kill_switch && args["kill_switch_active"].as_bool() == Some(true) {
                let seq = state.trading_state.get_sequence(&crate::state::risk_uri());
                let notif = notifications::kill_switch_engaged(seq);
                state.emit_to_session(session_id, notif);
            }

            json_result_value(&payload)
        }
        "reference.test.force_candle_close" => {
            // HTTP-only tool (no shared handler — tick engine is HTTP-specific)
            let timeframe = args["timeframe"].as_str().unwrap_or("M1");
            let engine_guard = state.tick_engine.lock().await;
            if let Some(engine) = engine_guard.as_ref() {
                engine.force_candle_close(timeframe);
            }
            tool_result_structured(&json!({
                "closed": true,
                "timeframe": timeframe,
            }))
        }
        "reference.test.stop_ticks" => {
            // HTTP-only tool
            let mut engine_guard = state.tick_engine.lock().await;
            if let Some(engine) = engine_guard.as_mut() {
                engine.stop();
            }
            tool_result_structured(&json!({
                "stopped": true,
            }))
        }
        "apex.account.summary" => {
            let account_id = args["account_id"].as_str().unwrap_or("");
            let currency = args["currency"].as_str().map(|s| s.to_owned());
            json_result_value(&handlers::handle_account_summary(
                &state.trading_state,
                account_id,
                currency,
            ))
        }
        "apex.account.positions" => {
            json_result_value(&handlers::handle_account_positions(&state.trading_state))
        }
        "apex.account.orders" => {
            json_result_value(&handlers::handle_account_orders(&state.trading_state))
        }
        "apex.account.history" => json_result_value(&handlers::handle_account_history()),
        "apex.order.place" => {
            let order = args.get("order").cloned().unwrap_or(json!({}));

            match handlers::handle_order_place(&state.trading_state, &order) {
                Ok((payload, updates)) => {
                    state.notify_resource_updates(session_id, &updates).await;

                    // HTTP-specific: emit order fill/partial fill notifications
                    let status = payload["status"].as_str().unwrap_or("");
                    let order_id = payload["order_id"].as_str().unwrap_or("");
                    let is_market = order["order_type"].as_str() == Some("market");

                    if is_market {
                        let fill_seq = state.trading_state.get_sequence(&crate::state::fills_uri());
                        let side = order["side"].as_str().unwrap_or("buy");
                        let fill_quantity = payload["fill_quantity"]
                            .as_str()
                            .and_then(|v| v.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let instrument_id =
                            order["instrument_id"].as_str().unwrap_or(INSTRUMENT_ID);
                        let account_id = args["account_id"].as_str().unwrap_or(ACCOUNT_ID);

                        if status == "filled" {
                            let notif = notifications::order_filled(
                                order_id,
                                side,
                                1.08755,
                                fill_quantity,
                                account_id,
                                instrument_id,
                                fill_seq,
                            );
                            state.emit_to_session(session_id, notif);
                        } else if status == "partially_filled" {
                            let remaining = payload["remaining_quantity"]
                                .as_str()
                                .and_then(|v| v.parse::<f64>().ok())
                                .unwrap_or(0.0);
                            let notif = notifications::order_partially_filled(
                                notifications::PartialFillParams {
                                    order_id,
                                    side,
                                    fill_price: 1.08755,
                                    fill_quantity,
                                    remaining_quantity: remaining,
                                    account_id,
                                    instrument_id,
                                    fill_sequence: fill_seq,
                                },
                            );
                            state.emit_to_session(session_id, notif);
                        }
                    }

                    json_result_value(&payload)
                }
                Err(err_payload) => {
                    // HTTP-specific: emit rejection notification on kill switch
                    let seq = state.trading_state.get_sequence(&crate::state::risk_uri());
                    let reason = err_payload["error"]["message"].as_str().unwrap_or("");
                    let code = err_payload["error"]["code"].as_str().unwrap_or("");
                    if !code.is_empty() {
                        let notif = notifications::order_rejected(code, reason, seq);
                        state.emit_to_session(session_id, notif);
                    }
                    json_result_value(&err_payload)
                }
            }
        }
        "apex.order.modify" => {
            let target_type = args["target_type"].as_str().unwrap_or("order");
            let target_id = args["target_id"].as_str().unwrap_or("");
            let mods = args.get("modifications").cloned().unwrap_or(json!({}));

            match handlers::handle_order_modify(&state.trading_state, target_type, target_id, &mods)
            {
                Ok((payload, updates)) => {
                    state.notify_resource_updates(session_id, &updates).await;
                    json_result_value(&payload)
                }
                Err(err_payload) => json_result_value(&err_payload),
            }
        }
        "apex.order.cancel" => {
            let order_id = args["order_id"].as_str().unwrap_or("");
            let (payload, updates) = handlers::handle_order_cancel(&state.trading_state, order_id);
            state.notify_resource_updates(session_id, &updates).await;
            json_result_value(&payload)
        }
        "apex.position.close" => {
            let position_id = args["position_id"].as_str().unwrap_or("");
            let requested_quantity = args.get("quantity").and_then(Value::as_f64);

            match handlers::handle_position_close(
                &state.trading_state,
                position_id,
                requested_quantity,
            ) {
                Ok((payload, updates)) => {
                    state.notify_resource_updates(session_id, &updates).await;

                    // HTTP-specific: emit fill notification
                    let order_id = payload["order_id"].as_str().unwrap_or("");
                    let fill_seq = state.trading_state.get_sequence(&crate::state::fills_uri());
                    let account_id = args["account_id"].as_str().unwrap_or(ACCOUNT_ID);
                    let close_quantity = payload["fill_quantity"]
                        .as_str()
                        .and_then(|v| v.parse::<f64>().ok())
                        .unwrap_or(0.0);
                    // Reconstruct close_side from the position data
                    let close_side = if payload["status"].as_str() == Some("filled")
                        || payload["status"].as_str() == Some("partially_filled")
                    {
                        // We need to re-derive close_side; look at the order payload
                        // The fill is always the opposite of the original position side
                        // Since we already closed, we check the state. For simplicity,
                        // derive from position_id again.
                        if let Some((_inst, side, _qty)) =
                            state.trading_state.find_position(position_id)
                        {
                            if side == "buy" {
                                "sell"
                            } else {
                                "buy"
                            }
                        } else {
                            // Position was fully closed and removed; default based on
                            // convention.  In practice the position was just closed above
                            // so for full closes find_position may return None.
                            "sell"
                        }
                    } else {
                        "sell"
                    };
                    let instrument_id = payload
                        .get("instrument_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(INSTRUMENT_ID);
                    let notif = notifications::order_filled(
                        order_id,
                        close_side,
                        1.08755,
                        close_quantity,
                        account_id,
                        instrument_id,
                        fill_seq,
                    );
                    state.emit_to_session(session_id, notif);

                    json_result_value(&payload)
                }
                Err(err_payload) => {
                    // Emit rejection notification if kill switch
                    if state
                        .trading_state
                        .read_resource_payload(&crate::state::risk_uri())
                        .and_then(|p| p["kill_switch_active"].as_bool())
                        .unwrap_or(false)
                    {
                        let seq = state.trading_state.get_sequence(&crate::state::risk_uri());
                        let reason = err_payload["error"]["message"].as_str().unwrap_or("");
                        let code = err_payload["error"]["code"].as_str().unwrap_or("");
                        let notif = notifications::order_rejected(code, reason, seq);
                        state.emit_to_session(session_id, notif);
                    }
                    json_result_value(&err_payload)
                }
            }
        }
        "apex.order.status" => {
            let order_id = args["order_id"].as_str().unwrap_or("");
            json_result_value(&handlers::handle_order_status(
                &state.trading_state,
                order_id,
            ))
        }
        "apex.market.quote" => {
            let instrument_id = args["instrument_id"].as_str().map(|s| s.to_owned());
            let broker_symbol = args["broker_symbol"].as_str().map(|s| s.to_owned());
            json_result_value(&handlers::handle_market_quote(
                &state.trading_state,
                instrument_id,
                broker_symbol,
            ))
        }
        "apex.market.snapshot" => {
            let instrument_id = args["instrument_id"]
                .as_str()
                .unwrap_or(INSTRUMENT_ID)
                .to_owned();
            let timeframe = args["timeframe"].as_str().unwrap_or("M1").to_owned();
            json_result_value(&handlers::handle_market_snapshot(instrument_id, timeframe))
        }
        "apex.market.search" => {
            let query = args["query"].as_str().unwrap_or("");
            json_result_value(&handlers::handle_market_search(query))
        }
        "apex.market.details" => {
            let instrument_id = args["instrument_id"].as_str().unwrap_or("");
            json_result_value(&handlers::handle_market_details(instrument_id))
        }
        "apex.risk.check" => {
            let order = args.get("order").cloned().unwrap_or(json!({}));
            let quantity = order["quantity"].as_f64().unwrap_or(0.0);
            json_result_value(&handlers::handle_risk_check(quantity))
        }
        "apex.risk.limits" => {
            let account_id = args["account_id"].as_str().unwrap_or(ACCOUNT_ID);
            json_result_value(&handlers::handle_risk_limits(
                &state.trading_state,
                account_id,
            ))
        }
        "apex.fx.rollover" => {
            let instrument_id = args["instrument_id"].as_str().unwrap_or("");
            json_result_value(&handlers::handle_fx_rollover(instrument_id))
        }
        "apex.fx.exposure" => {
            let account_id = args["account_id"].as_str().unwrap_or("");
            let base_currency = args["base_currency"].as_str().unwrap_or("USD");
            json_result_value(&handlers::handle_fx_exposure(
                &state.trading_state,
                account_id,
                base_currency,
            ))
        }
        "apex.fx.conversion" => {
            let from_currency = args["from_currency"].as_str().unwrap_or("");
            let to_currency = args["to_currency"].as_str().unwrap_or("");
            let amount = args["amount"].as_f64().unwrap_or(0.0);
            json_result_value(&handlers::handle_fx_conversion(
                from_currency,
                to_currency,
                amount,
            ))
        }
        "apex.cfd.corporate_actions" => {
            let account_id = args["account_id"].as_str().unwrap_or("");
            json_result_value(&handlers::handle_cfd_corporate_actions(account_id))
        }
        "apex.cfd.dividend_adjustment" => {
            let account_id = args["account_id"].as_str().unwrap_or("");
            json_result_value(&handlers::handle_cfd_dividend_adjustment(account_id))
        }
        "apex.crypto.funding_rate" => {
            let instrument_id = args["instrument_id"].as_str().unwrap_or("");
            json_result_value(&handlers::handle_crypto_funding_rate(instrument_id))
        }
        "apex.crypto.liquidation_estimate" => {
            let instrument_id = args["instrument_id"].as_str().unwrap_or("");
            let side = args["side"].as_str().unwrap_or("buy");
            let quantity = args["quantity"].as_f64().unwrap_or(0.0);
            let leverage = args["leverage"].as_f64().unwrap_or(1.0);
            let entry_price = args["entry_price"].as_f64().unwrap_or(0.0);
            json_result_value(&handlers::handle_crypto_liquidation_estimate(
                instrument_id,
                side,
                quantity,
                leverage,
                entry_price,
            ))
        }
        "apex.crypto.transfer" => {
            let account_id = args["account_id"].as_str().unwrap_or("");
            let from_wallet = args["from_wallet"].as_str().unwrap_or("");
            let to_wallet = args["to_wallet"].as_str().unwrap_or("");
            let currency = args["currency"].as_str().unwrap_or("");
            let amount = args["amount"].as_f64().unwrap_or(0.0);
            json_result_value(&handlers::handle_crypto_transfer(
                account_id,
                from_wallet,
                to_wallet,
                currency,
                amount,
            ))
        }
        "apex.futures.contract_chain" => {
            let root = args["root"].as_str().unwrap_or("");
            let include_expired = args["include_expired"].as_bool().unwrap_or(false);
            json_result_value(&handlers::handle_futures_contract_chain(root, include_expired))
        }
        "apex.futures.margin_schedule" => {
            let account_id = args["account_id"].as_str().unwrap_or("");
            let instrument_id = args["instrument_id"].as_str().unwrap_or("");
            json_result_value(&handlers::handle_futures_margin_schedule(
                account_id,
                instrument_id,
            ))
        }
        _ => {
            return Err(json!({
                "code": -32601,
                "message": format!("Unknown tool: {tool_name}")
            }));
        }
    };

    Ok(result)
}

/// Build a tool result in text content format (compatible with extractPayload).
fn json_result_value<T: serde::Serialize>(payload: &T) -> Value {
    let text = serde_json::to_string(payload).expect("payload should serialize");
    json!({
        "content": [{ "type": "text", "text": text }]
    })
}

/// Build a tool result with structuredContent (for reference.test.force_candle_close).
fn tool_result_structured(payload: &Value) -> Value {
    let text = serde_json::to_string(payload).expect("payload should serialize");
    json!({
        "structuredContent": payload,
        "content": [{ "type": "text", "text": text }]
    })
}
