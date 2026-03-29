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

use crate::helpers::{apex_error, hours_from_now, now_iso};
use crate::models::*;
use crate::notifications;
use crate::replay_buffer::{ReplayBuffer, ReplayItem, ReplayResult};
use crate::state::{ReferenceTradingState, ACCOUNT_ID, BROKER_SYMBOL, INSTRUMENT_ID};
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
        let _ = self.event_tx.send((session_id.to_owned(), event_id, notification));
    }

    /// Emit a notification to a specific session and also broadcast to SSE.
    fn emit_to_session(&self, session_id: &str, notification: Value) {
        self.emit_notification(session_id, notification);
    }

    /// Emit resource updated notifications for given URIs.
    /// In Streamable HTTP mode, all notifications go through the SSE stream
    /// regardless of subscription state — the client handles filtering.
    async fn notify_resource_updates(&self, session_id: &str, uris: &[String]) {
        for uri in uris {
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
                    let uris = state.trading_state.bump_resources_list(&[candle_uri.clone()]);

                    let seq = state.trading_state.get_sequence(&candle_uri);
                    let notif = notifications::candle_closed(
                        INSTRUMENT_ID,
                        &timeframe,
                        candle.open,
                        candle.high,
                        candle.low,
                        candle.close,
                        candle.volume,
                        seq,
                    );

                    for sid in &sessions {
                        state.emit_to_session(sid, notif.clone());
                        state.notify_resource_updates(sid, &uris).await;
                    }
                }
                TickEvent::CandleUpdate { timeframe } => {
                    let candle_uri = crate::state::candles_uri(&timeframe);
                    for sid in &sessions {
                        state.notify_resource_updates(sid, &[candle_uri.clone()]).await;
                    }
                }
                TickEvent::FeatureUpdate => {
                    let features_uri = crate::state::features_uri();
                    for sid in &sessions {
                        state.notify_resource_updates(sid, &[features_uri.clone()]).await;
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
                "apex_version": "0.1.0-alpha",
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

async fn handle_get(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let session_id = match headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
    {
        Some(id) => id.to_owned(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                "Missing mcp-session-id header",
            )
                .into_response();
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
                return (
                    StatusCode::NOT_FOUND,
                    "Unknown session",
                )
                    .into_response();
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
                        let notif = ReplayBuffer::gap_fill_notification(
                            id,
                            elided_count,
                            from_id,
                            to_id,
                        );
                        let data = serde_json::to_string(&notif).unwrap_or_default();
                        (id.to_string(), data)
                    }
                })
                .collect(),
            ReplayResult::Failed { oldest_available_id } => {
                let notif = notifications::replay_failed(
                    "event_id_outside_log",
                    oldest_available_id,
                );
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

async fn handle_delete(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let session_id = match headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
    {
        Some(id) => id.to_owned(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                "Missing mcp-session-id header",
            )
                .into_response();
        }
    };

    let mut sessions = state.sessions.lock().await;
    if sessions.remove(&session_id).is_none() {
        return (
            StatusCode::NOT_FOUND,
            "Unknown session",
        )
            .into_response();
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
            tool_desc("apex.session.authenticate", "Establish an authenticated trading session.", json!({
                "type": "object",
                "properties": {
                    "token": { "type": "string", "description": "Broker-issued JWT or OAuth token" },
                    "token_type": { "type": "string", "default": "jwt" },
                    "account_id": { "type": "string" },
                    "hub_session_id": { "type": "string" }
                },
                "required": ["token"]
            })),
            tool_desc("apex.session.capabilities", "Query the full capability manifest.", json!({
                "type": "object", "properties": {}
            })),
            tool_desc("apex.session.heartbeat", "Keep-alive ping.", json!({
                "type": "object",
                "properties": { "timestamp": { "type": "string" } },
                "required": ["timestamp"]
            })),
            tool_desc("apex.session.acknowledge", "Acknowledge receipt of events through a given event ID.", json!({
                "type": "object",
                "properties": {
                    "last_event_id": { "type": "string", "description": "The highest event ID the client has processed" }
                },
                "required": ["last_event_id"]
            })),
            tool_desc("apex.account.summary", "Current account state.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "currency": { "type": "string" }
                },
                "required": ["account_id"]
            })),
            tool_desc("apex.account.positions", "All open positions.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "instrument_id": { "type": "string" },
                    "profile": { "type": "string" }
                },
                "required": ["account_id"]
            })),
            tool_desc("apex.account.orders", "Known orders.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "status": { "type": "string", "default": "all" },
                    "instrument_id": { "type": "string" }
                },
                "required": ["account_id"]
            })),
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
            })),
            tool_desc("apex.order.place", "Unified order entry.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "order": { "type": "object" }
                },
                "required": ["account_id", "order"]
            })),
            tool_desc("apex.order.modify", "Amend a working order.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "target_type": { "type": "string" },
                    "target_id": { "type": "string" },
                    "modifications": { "type": "object" }
                },
                "required": ["account_id", "target_type", "target_id", "modifications"]
            })),
            tool_desc("apex.order.cancel", "Cancel a working order.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "order_id": { "type": "string" },
                    "reason": { "type": "string" }
                },
                "required": ["account_id", "order_id"]
            })),
            tool_desc("apex.position.close", "Close an open position fully or partially.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "position_id": { "type": "string" },
                    "quantity": { "type": "number", "description": "Partial close quantity. Omit to close the full position." }
                },
                "required": ["account_id", "position_id"]
            })),
            tool_desc("apex.order.status", "Query order state.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "order_id": { "type": "string" }
                },
                "required": ["account_id", "order_id"]
            })),
            tool_desc("apex.market.quote", "Current bid/ask/mid.", json!({
                "type": "object",
                "properties": {
                    "instrument_id": { "type": "string" },
                    "broker_symbol": { "type": "string" }
                }
            })),
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
            })),
            tool_desc("apex.market.search", "Discover instruments.", json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "profile": { "type": "string" },
                    "limit": { "type": "integer", "default": 20 }
                },
                "required": ["query"]
            })),
            tool_desc("apex.market.details", "Full contract specification.", json!({
                "type": "object",
                "properties": {
                    "instrument_id": { "type": "string" }
                },
                "required": ["instrument_id"]
            })),
            tool_desc("apex.risk.check", "Pre-trade margin check.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "order": { "type": "object" }
                },
                "required": ["account_id", "order"]
            })),
            tool_desc("apex.risk.limits", "Account risk limits.", json!({
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" }
                },
                "required": ["account_id"]
            })),
            tool_desc("reference.test.set_realtime_state", "Fault injection for testing.", json!({
                "type": "object",
                "properties": {
                    "quote_stale": { "type": "boolean" },
                    "risk_stale": { "type": "boolean" },
                    "force_sequence_gap": { "type": "boolean" },
                    "kill_switch_active": { "type": "boolean" },
                    "partial_fill_next_order": { "type": "boolean" }
                }
            })),
            tool_desc("reference.test.force_candle_close", "Force-close a partial candle.", json!({
                "type": "object",
                "properties": {
                    "timeframe": { "type": "string", "enum": ["M1", "M5", "H1"] }
                },
                "required": ["timeframe"]
            })),
            tool_desc("reference.test.stop_ticks", "Stop the tick engine. Test-only tool for deterministic event counts.", json!({
                "type": "object",
                "properties": {}
            })),
        ]
    })
}

fn tool_desc(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema
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
            if token.len() < 10 {
                json_result_value(&apex_error(
                    "APEX_4001",
                    "auth",
                    "Invalid or expired token",
                    None,
                ))
            } else {
                // Start tick engine on authentication
                {
                    let mut engine_guard = state.tick_engine.lock().await;
                    if engine_guard.is_none() {
                        let mut engine = TickEngine::new(state.tick_event_tx.clone());
                        engine.start();
                        *engine_guard = Some(engine);
                        eprintln!("Tick engine started after authentication");
                    }
                }

                let account_id = args["account_id"]
                    .as_str()
                    .unwrap_or(ACCOUNT_ID);
                json_result_value(&SessionResponse {
                    session_id: uuid::Uuid::new_v4().to_string(),
                    account_id: account_id.to_owned(),
                    expires_at: hours_from_now(1),
                    capabilities: CORE_CAPABILITIES
                        .iter()
                        .map(|v| (*v).to_owned())
                        .collect(),
                    profiles: vec!["fx".to_owned()],
                    broker_id: "reference-broker".to_owned(),
                    broker_name: "APEX Reference Broker".to_owned(),
                })
            }
        }
        "apex.session.capabilities" => {
            json_result_value(&CapabilitiesResponse {
                apex_version: SERVER_VERSION.to_owned(),
                broker_id: "reference-broker".to_owned(),
                core_tools: CORE_CAPABILITIES
                    .iter()
                    .map(|v| (*v).to_owned())
                    .collect(),
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
                realtime_contract: json!({
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
                }),
            })
        }
        "apex.session.heartbeat" => {
            json_result_value(&HeartbeatResponse {
                timestamp: now_iso(),
                status: "ok".to_owned(),
            })
        }
        "apex.session.acknowledge" => {
            let last_event_id = args["last_event_id"].as_str().unwrap_or("0");
            let (acknowledged_through, buffer_depth) =
                state.replay_buffer.acknowledge(last_event_id);
            json_result_value(&json!({
                "acknowledged_through": acknowledged_through,
                "buffer_depth": buffer_depth,
            }))
        }
        "reference.test.set_realtime_state" => {
            let was_kill_switch = state
                .trading_state
                .read_resource_payload(&crate::state::risk_uri())
                .and_then(|p| p["kill_switch_active"].as_bool())
                .unwrap_or(false);

            let faults = state.trading_state.set_faults(
                args["quote_stale"].as_bool(),
                args["risk_stale"].as_bool(),
                args["force_sequence_gap"].as_bool(),
                args["kill_switch_active"].as_bool(),
                args["partial_fill_next_order"].as_bool(),
            );

            // Emit kill switch notification if just activated
            if !was_kill_switch && args["kill_switch_active"].as_bool() == Some(true) {
                let seq = state.trading_state.get_sequence(&crate::state::risk_uri());
                let notif = notifications::kill_switch_engaged(seq);
                state.emit_to_session(session_id, notif);
            }

            json_result_value(&json!({
                "ok": true,
                "faults": faults,
            }))
        }
        "reference.test.force_candle_close" => {
            let timeframe = args["timeframe"].as_str().unwrap_or("M1");
            let engine_guard = state.tick_engine.lock().await;
            if let Some(engine) = engine_guard.as_ref() {
                engine.force_candle_close(timeframe);
            }
            // Return structuredContent style
            tool_result_structured(&json!({
                "closed": true,
                "timeframe": timeframe,
            }))
        }
        "reference.test.stop_ticks" => {
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
            if account_id.is_empty() {
                json_result_value(&apex_error("APEX_4011", "validation", "account_id is required", None))
            } else {
                let currency = args["currency"].as_str().map(|s| s.to_owned());
                json_result_value(&state.trading_state.account_summary_payload(currency))
            }
        }
        "apex.account.positions" => {
            json_result_value(&state.trading_state.positions_payload())
        }
        "apex.account.orders" => {
            json_result_value(&state.trading_state.orders_payload())
        }
        "apex.account.history" => {
            json_result_value(&AccountHistoryResponse {
                events: vec![],
                next_cursor: None,
                has_more: false,
            })
        }
        "apex.order.place" => {
            if let Err((code, category, message)) = state.trading_state.order_acceptance() {
                // Emit rejection notification
                let seq = state.trading_state.get_sequence(&crate::state::risk_uri());
                let notif = notifications::order_rejected(code, message, seq);
                state.emit_to_session(session_id, notif);

                json_result_value(&apex_error(code, category, message, None))
            } else {
                let order = args.get("order").cloned().unwrap_or(json!({}));

                if order["order_type"].as_str() == Some("limit")
                    && order.get("limit_price").is_none()
                {
                    json_result_value(&apex_error(
                        "APEX_4011",
                        "validation",
                        "limit_price required for limit orders",
                        None,
                    ))
                } else {
                    let (payload, updates) = state.trading_state.create_order(&order);

                    // Notify resource updates
                    state.notify_resource_updates(session_id, &updates).await;

                    // Emit order fill/partial fill notifications
                    let status = payload["status"].as_str().unwrap_or("");
                    let order_id = payload["order_id"].as_str().unwrap_or("");
                    let is_market = order["order_type"].as_str() == Some("market");

                    if is_market {
                        let fill_seq =
                            state.trading_state.get_sequence(&crate::state::fills_uri());
                        let side = order["side"].as_str().unwrap_or("buy");
                        let fill_quantity = payload["fill_quantity"].as_f64().unwrap_or(0.0);
                        let instrument_id = order["instrument_id"]
                            .as_str()
                            .unwrap_or(INSTRUMENT_ID);
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
                            let remaining =
                                payload["remaining_quantity"].as_f64().unwrap_or(0.0);
                            let notif = notifications::order_partially_filled(
                                order_id,
                                side,
                                1.08755,
                                fill_quantity,
                                remaining,
                                account_id,
                                instrument_id,
                                fill_seq,
                            );
                            state.emit_to_session(session_id, notif);
                        }
                    }

                    json_result_value(&payload)
                }
            }
        }
        "apex.order.modify" => {
            let target_type = args["target_type"].as_str().unwrap_or("order");
            let target_id = args["target_id"].as_str().unwrap_or("");
            let mods = args.get("modifications").cloned().unwrap_or(json!({}));

            if target_type == "position"
                && (mods.get("limit_price").is_some()
                    || mods.get("stop_price").is_some()
                    || mods.get("quantity").is_some())
            {
                json_result_value(&apex_error(
                    "APEX_4011",
                    "validation",
                    "positions may only amend stop_loss, take_profit, or trailing_stop",
                    None,
                ))
            } else {
                let updates = state.trading_state.modify_order(target_id);
                state.notify_resource_updates(session_id, &updates).await;
                json_result_value(&OrderModifyResponse {
                    target_type: target_type.to_owned(),
                    target_id: target_id.to_owned(),
                    status: "modified".to_owned(),
                    rejection_reason: None,
                    updated_at: now_iso(),
                })
            }
        }
        "apex.order.cancel" => {
            let order_id = args["order_id"].as_str().unwrap_or("");
            let updates = state.trading_state.cancel_order(order_id);
            state.notify_resource_updates(session_id, &updates).await;
            json_result_value(&OrderCancelResponse {
                order_id: order_id.to_owned(),
                status: "cancelled".to_owned(),
                rejection_reason: None,
                cancelled_at: now_iso(),
            })
        }
        "apex.position.close" => {
            if let Err((code, category, message)) = state.trading_state.order_acceptance() {
                let seq = state.trading_state.get_sequence(&crate::state::risk_uri());
                let notif = notifications::order_rejected(code, message, seq);
                state.emit_to_session(session_id, notif);
                json_result_value(&apex_error(code, category, message, None))
            } else {
                let position_id = args["position_id"].as_str().unwrap_or("");
                let requested_quantity = args.get("quantity").and_then(Value::as_f64);

                match state.trading_state.find_position(position_id) {
                    Some((instrument_id, side, total_quantity)) => {
                        let close_quantity = requested_quantity.unwrap_or(total_quantity);
                        let close_side = if side == "buy" { "sell" } else { "buy" };

                        let (order_payload, updates) = state.trading_state.close_position(
                            position_id,
                            close_quantity,
                            &instrument_id,
                            close_side,
                        );
                        state.notify_resource_updates(session_id, &updates).await;

                        // Emit fill notification
                        let order_id = order_payload["order_id"].as_str().unwrap_or("");
                        let fill_seq =
                            state.trading_state.get_sequence(&crate::state::fills_uri());
                        let account_id = args["account_id"].as_str().unwrap_or(ACCOUNT_ID);
                        let notif = notifications::order_filled(
                            order_id,
                            close_side,
                            1.08755,
                            close_quantity,
                            account_id,
                            &instrument_id,
                            fill_seq,
                        );
                        state.emit_to_session(session_id, notif);

                        let remaining = total_quantity - close_quantity;
                        let status = if remaining <= 0.0 {
                            "filled"
                        } else {
                            "partially_filled"
                        };

                        json_result_value(&PositionCloseResponse {
                            order_id: order_id.to_owned(),
                            position_id: position_id.to_owned(),
                            status: status.to_owned(),
                            fill_price: order_payload["fill_price"]
                                .as_f64()
                                .unwrap_or(1.08755),
                            fill_quantity: close_quantity,
                            remaining_quantity: if remaining > 0.0 { remaining } else { 0.0 },
                            closed_at: now_iso(),
                        })
                    }
                    None => json_result_value(&apex_error(
                        "APEX_4011",
                        "validation",
                        &format!("Unknown position: {position_id}"),
                        None,
                    )),
                }
            }
        }
        "apex.order.status" => {
            let order_id = args["order_id"].as_str().unwrap_or("");
            match state.trading_state.order_status_payload(order_id) {
                Some(order) => json_result_value(&order),
                None => json_result_value(&apex_error(
                    "APEX_4011",
                    "validation",
                    &format!("Unknown order: {order_id}"),
                    None,
                )),
            }
        }
        "apex.market.quote" => {
            let instrument_id = args["instrument_id"].as_str().map(|s| s.to_owned());
            let broker_symbol = args["broker_symbol"].as_str().map(|s| s.to_owned());
            let has_id = instrument_id.as_deref().is_some_and(|s| !s.is_empty());
            let has_sym = broker_symbol.as_deref().is_some_and(|s| !s.is_empty());
            if !has_id && !has_sym {
                json_result_value(&apex_error("APEX_4010", "validation", "Unknown instrument", None))
            } else if has_id && instrument_id.as_deref() != Some(INSTRUMENT_ID) {
                json_result_value(&apex_error("APEX_4010", "validation", "Unknown instrument", None))
            } else if !has_id && broker_symbol.as_deref() != Some(BROKER_SYMBOL) {
                json_result_value(&apex_error("APEX_4010", "validation", "Unknown instrument", None))
            } else {
                json_result_value(&state.trading_state.quote_payload(instrument_id, broker_symbol))
            }
        }
        "apex.market.snapshot" => {
            let instrument_id = args["instrument_id"]
                .as_str()
                .unwrap_or(INSTRUMENT_ID)
                .to_owned();
            let timeframe = args["timeframe"].as_str().unwrap_or("M1").to_owned();
            json_result_value(&MarketSnapshotResponse {
                instrument_id,
                timeframe,
                candles: vec![],
            })
        }
        "apex.market.search" => {
            let query = args["query"].as_str().unwrap_or("");
            let instruments =
                if !query.is_empty() && "EURUSD".contains(&query.to_uppercase()) {
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
            json_result_value(&MarketSearchResponse { instruments })
        }
        "apex.market.details" => {
            let instrument_id = args["instrument_id"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            if instrument_id != INSTRUMENT_ID {
                json_result_value(&apex_error("APEX_4010", "validation", "Unknown instrument", None))
            } else {
            json_result_value(&MarketDetailsResponse {
                instrument_id,
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
                profile_data: json!({}),
            })
            }
        }
        "apex.risk.check" => {
            let order = args.get("order").cloned().unwrap_or(json!({}));
            let quantity = order["quantity"].as_f64().unwrap_or(0.0);
            let required_margin = (quantity / 100000.0) * 500.0;
            let available_margin = 9750.0;
            json_result_value(&RiskCheckResponse {
                approved: true,
                required_margin,
                available_margin,
                margin_after_trade: available_margin - required_margin,
                exposure_increase: quantity,
                warnings: vec![],
                rejection_reason: None,
            })
        }
        "apex.risk.limits" => {
            let account_id = args["account_id"]
                .as_str()
                .unwrap_or(ACCOUNT_ID)
                .to_owned();
            json_result_value(&RiskLimitsResponse {
                account_id,
                max_position_size: 5000000,
                max_open_orders: 50,
                daily_loss_limit: -1000.0,
                daily_loss_used: -150.0,
                margin_call_level_pct: 100,
                stop_out_level_pct: 50,
                restricted_instruments: vec![],
                kill_switch_active: state
                    .trading_state
                    .read_resource_payload(&crate::state::risk_uri())
                    .and_then(|p| p["kill_switch_active"].as_bool())
                    .unwrap_or(false),
            })
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
