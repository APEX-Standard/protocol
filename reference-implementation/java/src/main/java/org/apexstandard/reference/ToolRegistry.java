package org.apexstandard.reference;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.spec.McpSchema;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.apexstandard.reference.ProtocolModels.*;

final class ToolRegistry {
    static final String SERVER_NAME = "apex-reference";
    static final String SERVER_VERSION = "0.1.0";

    private final ObjectMapper mapper;
    private final ReferenceTradingState state;
    private final String transportMode;
    private final NotificationDispatcher dispatcher;
    private final ReplayBuffer replayBuffer;

    ToolRegistry(ObjectMapper mapper, ReferenceTradingState state, String transportMode, NotificationDispatcher dispatcher) {
        this(mapper, state, transportMode, dispatcher, null);
    }

    ToolRegistry(ObjectMapper mapper, ReferenceTradingState state, String transportMode,
                 NotificationDispatcher dispatcher, ReplayBuffer replayBuffer) {
        this.mapper = mapper;
        this.state = state;
        this.transportMode = transportMode != null ? transportMode : "streamable_http";
        this.dispatcher = dispatcher;
        this.replayBuffer = replayBuffer;
    }

    // ── MCP SDK tool specifications ────────────────────────────────────

    List<McpServerFeatures.SyncToolSpecification> createToolSpecifications() {
        List<McpServerFeatures.SyncToolSpecification> specs = new ArrayList<>();

        registerSessionSpecs(specs);
        registerAccountSpecs(specs);
        registerOrderSpecs(specs);
        registerPositionSpecs(specs);
        registerMarketSpecs(specs);
        registerRiskSpecs(specs);
        registerFxSpecs(specs);
        registerCfdSpecs(specs);
        registerCryptoSpecs(specs);
        registerFuturesSpecs(specs);

        return specs;
    }

    // ── Schema property helpers ─────────────────────────────────────────

    private static Map<String, Object> strProp(String description) {
        var m = new LinkedHashMap<String, Object>();
        m.put("type", "string");
        if (description != null) m.put("description", description);
        return m;
    }

    private static Map<String, Object> numProp(String description) {
        var m = new LinkedHashMap<String, Object>();
        m.put("type", "number");
        if (description != null) m.put("description", description);
        return m;
    }

    private static Map<String, Object> boolProp(boolean defaultValue, String description) {
        var m = new LinkedHashMap<String, Object>();
        m.put("type", "boolean");
        if (description != null) m.put("description", description);
        m.put("default", defaultValue);
        return m;
    }

    private static Map<String, Object> intProp(String description, int min, int max, int defaultValue) {
        var m = new LinkedHashMap<String, Object>();
        m.put("type", "integer");
        if (description != null) m.put("description", description);
        m.put("minimum", min);
        m.put("maximum", max);
        m.put("default", defaultValue);
        return m;
    }

    static Map<String, Object> enumProp(String description, String defaultValue, String... values) {
        var m = new LinkedHashMap<String, Object>();
        m.put("type", "string");
        if (description != null) m.put("description", description);
        m.put("enum", List.of(values));
        if (defaultValue != null) m.put("default", defaultValue);
        return m;
    }

    private static Map<String, Object> objProp(String description, Map<String, Object> properties, List<String> required) {
        var m = new LinkedHashMap<String, Object>();
        m.put("type", "object");
        if (description != null) m.put("description", description);
        m.put("properties", properties);
        if (required != null && !required.isEmpty()) m.put("required", required);
        return m;
    }

    // ── Registration helpers ────────────────────────────────────────────

    private void registerSpec(List<McpServerFeatures.SyncToolSpecification> specs,
            String name, String description, McpSchema.JsonSchema inputSchema,
            java.util.function.Function<Map<String, Object>, Object> handler) {
        McpSchema.Tool tool = McpSchema.Tool.builder()
            .name(name)
            .description(description)
            .inputSchema(inputSchema)
            .annotations(annotationsFor(name))
            .build();
        specs.add(new McpServerFeatures.SyncToolSpecification(tool,
            (exchange, request) -> {
                Map<String, Object> args = request.arguments() != null ? request.arguments() : Map.of();
                Object payload;
                try { payload = handler.apply(args); }
                catch (Exception e) { payload = apexError("APEX_5000", "internal", e.getMessage() != null ? e.getMessage() : "Internal error"); }
                boolean isError = payload instanceof ProtocolModels.ApexErrorEnvelope;
                try {
                    String json = mapper.writeValueAsString(payload);
                    return McpSchema.CallToolResult.builder()
                        .content(List.of(new McpSchema.TextContent(json)))
                        .isError(isError)
                        .build();
                } catch (Exception e) {
                    return McpSchema.CallToolResult.builder()
                        .content(List.of(new McpSchema.TextContent("{\"error\":\"serialization_failed\"}")))
                        .isError(true)
                        .build();
                }
            }));
    }

    private McpSchema.ToolAnnotations annotationsFor(String name) {
        boolean readOnly = name.startsWith("apex.account.")
            || name.startsWith("apex.market.")
            || name.startsWith("apex.risk.")
            || name.startsWith("apex.fx.")
            || name.startsWith("apex.cfd.")
            || name.startsWith("apex.futures.")
            || "apex.crypto.funding_rate".equals(name)
            || "apex.crypto.liquidation_estimate".equals(name)
            || "apex.order.status".equals(name)
            || "apex.session.capabilities".equals(name)
            || "apex.session.heartbeat".equals(name)
            || "apex.session.acknowledge".equals(name);
        boolean destructive = "apex.order.place".equals(name)
            || "apex.order.modify".equals(name)
            || "apex.order.cancel".equals(name)
            || "apex.position.close".equals(name);
        boolean idempotent = readOnly
            || "apex.session.authenticate".equals(name)
            || "apex.order.cancel".equals(name);
        return new McpSchema.ToolAnnotations(null, readOnly, destructive, idempotent, null, null);
    }

    // ── Spec registration by domain ─────────────────────────────────────

    private void registerSessionSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        registerSpec(specs,
            "apex.session.authenticate",
            "Establish an authenticated trading session. The broker validates credentials directly and binds the result to the MCP session.",
            new McpSchema.JsonSchema("object", Map.of(
                "token", strProp("Broker-issued JWT or OAuth token"),
                "token_type", enumProp(null, "jwt", "jwt", "oauth2"),
                "account_id", strProp("Optional — broker may derive from token"),
                "hub_session_id", strProp("Optional session reference from caller")
            ), List.of("token"), false, null, null),
            args -> {
                String token = argStr(args, "token", "");
                if (token.length() < 10) {
                    return apexError("APEX_4001", "auth", "Invalid or expired token");
                }
                state.fireOnAuthenticated();
                return new SessionResponse(
                    UUID.randomUUID().toString(),
                    argStr(args, "account_id", "ACC_12345"),
                    nowPlusHours(1),
                    coreTools(),
                    List.of("fx"),
                    "reference-broker",
                    "APEX Reference Broker"
                );
            }
        );

        registerSpec(specs,
            "apex.session.capabilities",
            "Query the full capability manifest of this broker implementation.",
            new McpSchema.JsonSchema("object", Map.of(), List.of(), false, null, null),
            args -> {
                Object realtimeContract = Map.ofEntries(
                    Map.entry("transport_mode", transportMode),
                    Map.entry("reconnect_mode", "session_replay"),
                    Map.entry("max_retention_events", 10000),
                    Map.entry("max_retention_seconds", 0),
                    Map.entry("quote_freshness_ms", 1000),
                    Map.entry("account_freshness_ms", 2000),
                    Map.entry("tick_interval_ms", 2000),
                    Map.entry("notifications", List.of(
                        "notifications/apex.order.filled",
                        "notifications/apex.order.partially_filled",
                        "notifications/apex.order.rejected",
                        "notifications/apex.market.candle_closed",
                        "notifications/apex.risk.kill_switch_engaged",
                        "notifications/apex.session.replay_failed",
                        "notifications/apex.session.gap_fill"
                    ))
                );
                return new CapabilitiesResponse(
                    SERVER_VERSION,
                    "reference-broker",
                    coreTools(),
                    Map.of("fx", SERVER_VERSION),
                    null,
                    Map.of("orders_per_second", 10, "market_data_per_second", 100),
                    List.of("market", "limit", "stop", "stop_limit"),
                    List.of("GTC", "IOC", "FOK", "DAY"),
                    Map.of("realtime", true, "autonomous", false),
                    realtimeContract
                );
            }
        );

        registerSpec(specs,
            "apex.session.heartbeat",
            "Keep-alive ping. Hub marks session degraded if response exceeds 500ms.",
            new McpSchema.JsonSchema("object", Map.of(
                "timestamp", strProp("ISO8601 timestamp")
            ), List.of("timestamp"), false, null, null),
            args -> new HeartbeatResponse(now(), "ok")
        );

        registerSpec(specs,
            "apex.session.acknowledge",
            "Acknowledge receipt of SSE events through a given event ID. Acknowledged events may be pruned from the replay buffer.",
            new McpSchema.JsonSchema("object", Map.of(
                "last_event_id", strProp("The SSE event ID through which all events have been processed")
            ), List.of("last_event_id"), false, null, null),
            args -> {
                if (replayBuffer == null) {
                    return Map.of("acknowledged_through", "0", "buffer_depth", 0);
                }
                return replayBuffer.acknowledge(argStr(args, "last_event_id", "0"));
            }
        );

        registerSpec(specs,
            "reference.test.set_realtime_state",
            "Reference-only fault injection for conformance and resilience testing.",
            new McpSchema.JsonSchema("object", Map.of(
                "quote_stale", boolProp(false, null),
                "risk_stale", boolProp(false, null),
                "force_sequence_gap", boolProp(false, null),
                "kill_switch_active", boolProp(false, null),
                "partial_fill_next_order", boolProp(false, null)
            ), List.of(), false, null, null),
            args -> {
                boolean wasKillSwitchActive = state.isKillSwitchActive();
                Map<String, Object> faults = state.setFaults(
                    argBool(args, "quote_stale"),
                    argBool(args, "risk_stale"),
                    argBool(args, "force_sequence_gap"),
                    argBool(args, "kill_switch_active"),
                    argBool(args, "partial_fill_next_order")
                );
                if (!wasKillSwitchActive && Boolean.TRUE.equals(argBool(args, "kill_switch_active")) && dispatcher != null) {
                    int riskSeq = state.getSequence(ReferenceTradingState.RISK_URI);
                    dispatcher.emit(NotificationDispatcher.killSwitchEngagedNotification(riskSeq));
                }
                return Map.of("ok", true, "faults", faults);
            }
        );
    }

    private void registerAccountSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        registerSpec(specs,
            "apex.account.summary",
            "Current account state — balances, margin utilisation, equity.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "currency", strProp("Response currency. Defaults to account base currency.")
            ), List.of("account_id"), false, null, null),
            args -> {
                String accountId = argStr(args, "account_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                return state.accountSummary(argStr(args, "currency", "USD"));
            }
        );

        registerSpec(specs,
            "apex.account.positions",
            "All open positions with live P&L.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)"),
                "profile", strProp(null)
            ), List.of("account_id"), false, null, null),
            args -> state.positionsResponse()
        );

        registerSpec(specs,
            "apex.account.orders",
            "Known orders and their current lifecycle state.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "status", enumProp(null, "all", "working", "partially_filled", "filled", "cancelled", "rejected", "expired", "all"),
                "instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")
            ), List.of("account_id"), false, null, null),
            args -> state.ordersResponse()
        );

        var historyProps = new LinkedHashMap<String, Object>();
        historyProps.put("account_id", strProp(null));
        historyProps.put("from", strProp("ISO8601 start date"));
        historyProps.put("to", strProp("ISO8601 end date"));
        historyProps.put("event_type", enumProp(null, "all", "trade", "funding", "cash", "corporate_action", "all"));
        historyProps.put("limit", intProp(null, 1, 500, 100));
        historyProps.put("cursor", strProp("Pagination cursor"));
        registerSpec(specs,
            "apex.account.history",
            "Closed trades and funding events.",
            new McpSchema.JsonSchema("object", historyProps, List.of("account_id", "from", "to"), false, null, null),
            args -> new AccountHistoryResponse(List.of(), null, false)
        );
    }

    private void registerOrderSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        // apex.order.place — nested object schema with many fields, use LinkedHashMap
        var slProps = new LinkedHashMap<String, Object>();
        slProps.put("type", enumProp(null, null, "price", "pips", "ticks", "percent"));
        slProps.put("value", numProp(null));

        var tpProps = new LinkedHashMap<String, Object>();
        tpProps.put("type", enumProp(null, null, "price", "pips", "ticks", "percent"));
        tpProps.put("value", numProp(null));

        var tsProps = new LinkedHashMap<String, Object>();
        tsProps.put("type", enumProp(null, null, "pips", "ticks", "percent"));
        tsProps.put("value", numProp(null));

        var orderProps = new LinkedHashMap<String, Object>();
        orderProps.put("instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)"));
        orderProps.put("broker_symbol", strProp(null));
        orderProps.put("side", enumProp(null, null, "buy", "sell"));
        orderProps.put("order_type", enumProp(null, null, "market", "limit", "stop", "stop_limit"));
        orderProps.put("quantity", numProp(null));
        orderProps.put("quantity_unit", enumProp(null, "base_units", "base_units", "shares", "contracts"));
        orderProps.put("time_in_force", enumProp(null, "GTC", "GTC", "IOC", "FOK", "DAY"));
        orderProps.put("limit_price", numProp(null));
        orderProps.put("stop_price", numProp(null));
        orderProps.put("profile", strProp(null));
        orderProps.put("client_order_id", strProp(null));
        orderProps.put("strategy_id", strProp(null));
        orderProps.put("comment", strProp(null));
        orderProps.put("stop_loss", objProp("Stop loss protection", slProps, List.of("type", "value")));
        orderProps.put("take_profit", objProp("Take profit protection", tpProps, List.of("type", "value")));
        orderProps.put("trailing_stop", objProp("Trailing stop protection", tsProps, List.of("type", "value")));
        orderProps.put("profile_data", objProp("Profile-specific fields", Map.of(), null));

        registerSpec(specs,
            "apex.order.place",
            "Unified order entry across all asset classes. Profile-composable.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "order", objProp(null, orderProps, List.of("instrument_id", "side", "order_type", "quantity"))
            ), List.of("account_id", "order"), false, null, null),
            args -> {
                Map<String, Object> order = argMap(args, "order");
                if (order.isEmpty()) {
                    return apexError("APEX_4011", "validation", "order is required");
                }
                if (!ReferenceTradingState.INSTRUMENT_ID.equals(argStr(order, "instrument_id", ""))) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                String orderType = argStr(order, "order_type", "market");
                double quantity = argDouble(order, "quantity", 0);
                if ("limit".equals(orderType) && !order.containsKey("limit_price")) {
                    return apexError("APEX_4011", "validation", "limit_price required for limit orders");
                }
                Map<String, Object> acceptance = state.orderAcceptance();
                if (!Boolean.TRUE.equals(acceptance.get("ok"))) {
                    if (dispatcher != null) {
                        int riskSeq = state.getSequence(ReferenceTradingState.RISK_URI);
                        dispatcher.emit(NotificationDispatcher.orderRejectedNotification(
                            String.valueOf(acceptance.get("code")),
                            String.valueOf(acceptance.get("message")),
                            riskSeq
                        ));
                    }
                    return apexError(
                        String.valueOf(acceptance.get("code")),
                        String.valueOf(acceptance.get("category")),
                        String.valueOf(acceptance.get("message"))
                    );
                }
                Object result = state.createOrder(args);
                state.fireResourceUpdates(
                    ReferenceTradingState.ORDERS_URI, ReferenceTradingState.POSITIONS_URI,
                    ReferenceTradingState.FILLS_URI, ReferenceTradingState.RISK_URI,
                    ReferenceTradingState.DECISION_CONTEXT_URI);
                if (result instanceof ProtocolModels.ApexErrorEnvelope) {
                    return result;
                }
                if (dispatcher != null && "market".equals(orderType)) {
                    Map<String, Object> lastOrder = state.getLastOrder();
                    if (lastOrder != null) {
                        int fillSeq = state.getSequence(ReferenceTradingState.FILLS_URI);
                        String status = String.valueOf(lastOrder.get("status"));
                        if ("filled".equals(status)) {
                            dispatcher.emit(NotificationDispatcher.orderFilledNotification(lastOrder, fillSeq));
                        } else if ("partially_filled".equals(status)) {
                            dispatcher.emit(NotificationDispatcher.orderPartiallyFilledNotification(lastOrder, fillSeq));
                        }
                    }
                }
                return result;
            }
        );

        // apex.order.modify
        var modSlProps = new LinkedHashMap<String, Object>();
        modSlProps.put("type", enumProp(null, null, "price", "pips", "ticks", "percent"));
        modSlProps.put("value", numProp(null));

        var modTpProps = new LinkedHashMap<String, Object>();
        modTpProps.put("type", enumProp(null, null, "price", "pips", "ticks", "percent"));
        modTpProps.put("value", numProp(null));

        var modTsProps = new LinkedHashMap<String, Object>();
        modTsProps.put("type", enumProp(null, null, "pips", "ticks", "percent"));
        modTsProps.put("value", numProp(null));

        var modProps = new LinkedHashMap<String, Object>();
        modProps.put("limit_price", numProp(null));
        modProps.put("stop_price", numProp(null));
        modProps.put("quantity", numProp(null));
        modProps.put("stop_loss", objProp("Stop loss protection", modSlProps, List.of("type", "value")));
        modProps.put("take_profit", objProp("Take profit protection", modTpProps, List.of("type", "value")));
        modProps.put("trailing_stop", objProp("Trailing stop protection", modTsProps, List.of("type", "value")));

        registerSpec(specs,
            "apex.order.modify",
            "Amend a working order or an open position's protection settings.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "target_type", enumProp(null, null, "order", "position"),
                "target_id", strProp(null),
                "modifications", objProp(null, modProps, null)
            ), List.of("account_id", "target_type", "target_id", "modifications"), false, null, null),
            args -> {
                String targetType = argStr(args, "target_type", "");
                Map<String, Object> modifications = argMap(args, "modifications");
                if ("position".equals(targetType)
                    && (modifications.containsKey("limit_price")
                    || modifications.containsKey("stop_price")
                    || modifications.containsKey("quantity"))) {
                    return apexError("APEX_4011", "validation", "positions may only amend stop_loss, take_profit, or trailing_stop");
                }
                state.modifyOrder(argStr(args, "target_id", ""));
                state.fireResourceUpdates(ReferenceTradingState.ORDERS_URI, ReferenceTradingState.DECISION_CONTEXT_URI);
                return new OrderModifyResponse(
                    targetType,
                    argStr(args, "target_id", ""),
                    "modified",
                    null,
                    now()
                );
            }
        );

        registerSpec(specs,
            "apex.order.cancel",
            "Cancel a working or partially filled order.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "order_id", strProp(null),
                "reason", strProp("Agent-provided reason for audit trail")
            ), List.of("account_id", "order_id"), false, null, null),
            args -> {
                String orderId = argStr(args, "order_id", "");
                state.cancelOrder(orderId);
                state.fireResourceUpdates(ReferenceTradingState.ORDERS_URI, ReferenceTradingState.DECISION_CONTEXT_URI);
                return new OrderCancelResponse(orderId, "cancelled", null, now());
            }
        );

        registerSpec(specs,
            "apex.order.status",
            "Query the current state of a single order.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "order_id", strProp(null)
            ), List.of("account_id", "order_id"), false, null, null),
            args -> {
                Object result = state.orderStatus(argStr(args, "order_id", ""));
                if (result == null) {
                    return apexError("APEX_4011", "validation", "Unknown order");
                }
                return result;
            }
        );
    }

    private void registerPositionSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        registerSpec(specs,
            "apex.position.close",
            "Close an open position fully or partially. Executes as an opposite-direction market order.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "position_id", strProp(null),
                "quantity", numProp("Quantity to close. Omit for full close.")
            ), List.of("account_id", "position_id"), false, null, null),
            args -> {
                String positionId = argStr(args, "position_id", "");
                if (positionId.isBlank()) {
                    return apexError("APEX_4011", "validation", "position_id is required");
                }
                Map<String, Object> acceptance = state.orderAcceptance();
                if (!Boolean.TRUE.equals(acceptance.get("ok"))) {
                    if (dispatcher != null) {
                        int riskSeq = state.getSequence(ReferenceTradingState.RISK_URI);
                        dispatcher.emit(NotificationDispatcher.orderRejectedNotification(
                            String.valueOf(acceptance.get("code")),
                            String.valueOf(acceptance.get("message")),
                            riskSeq
                        ));
                    }
                    return apexError(
                        String.valueOf(acceptance.get("code")),
                        String.valueOf(acceptance.get("category")),
                        String.valueOf(acceptance.get("message"))
                    );
                }
                Double quantity = args.containsKey("quantity") ? argDouble(args, "quantity", 0) : null;
                ProtocolModels.PositionCloseResponse result = state.closePosition(positionId, quantity);
                state.fireResourceUpdates(
                    ReferenceTradingState.ORDERS_URI, ReferenceTradingState.POSITIONS_URI,
                    ReferenceTradingState.FILLS_URI, ReferenceTradingState.RISK_URI,
                    ReferenceTradingState.DECISION_CONTEXT_URI);
                if (result == null) {
                    return apexError("APEX_4011", "validation", "Position not found: " + positionId);
                }
                if (dispatcher != null) {
                    Map<String, Object> lastOrder = state.getLastOrder();
                    if (lastOrder != null) {
                        int fillSeq = state.getSequence(ReferenceTradingState.FILLS_URI);
                        dispatcher.emit(NotificationDispatcher.orderFilledNotification(lastOrder, fillSeq));
                    }
                }
                return result;
            }
        );
    }

    private void registerMarketSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        registerSpec(specs,
            "apex.market.quote",
            "Current bid/ask/mid for an instrument.",
            new McpSchema.JsonSchema("object", Map.of(
                "instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)"),
                "broker_symbol", strProp("Alternative to instrument_id")
            ), List.of(), false, null, null),
            args -> {
                String instrumentId = argStr(args, "instrument_id", "");
                String brokerSymbol = argStr(args, "broker_symbol", "");
                boolean hasId = !instrumentId.isEmpty();
                boolean hasSym = !brokerSymbol.isEmpty();
                if (!hasId && !hasSym) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                if (hasId && !ReferenceTradingState.INSTRUMENT_ID.equals(instrumentId)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                if (!hasId && !ReferenceTradingState.BROKER_SYMBOL.equals(brokerSymbol)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                return state.quoteResponse(instrumentId, brokerSymbol);
            }
        );

        var snapshotProps = new LinkedHashMap<String, Object>();
        snapshotProps.put("instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)"));
        snapshotProps.put("timeframe", enumProp(null, null, "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"));
        snapshotProps.put("from", strProp("ISO8601 start time"));
        snapshotProps.put("to", strProp("ISO8601 end time (defaults to now)"));
        snapshotProps.put("limit", intProp(null, 1, 1000, 200));
        registerSpec(specs,
            "apex.market.snapshot",
            "OHLCV candle data for an instrument.",
            new McpSchema.JsonSchema("object", snapshotProps, List.of("instrument_id", "timeframe", "from"), false, null, null),
            args -> new MarketSnapshotResponse(argStr(args, "instrument_id", ""), argStr(args, "timeframe", ""), List.of())
        );

        registerSpec(specs,
            "apex.market.search",
            "Discover instruments by keyword, asset class, or profile.",
            new McpSchema.JsonSchema("object", Map.of(
                "query", strProp(null),
                "profile", enumProp(null, null, "fx", "cfd", "crypto", "futures", "fixed_income"),
                "limit", intProp(null, 1, 50, 20)
            ), List.of("query"), false, null, null),
            args -> {
                String query = argStr(args, "query", "").toUpperCase();
                List<SearchInstrument> instruments = !query.isEmpty() && "EURUSD".contains(query)
                    ? List.of(new SearchInstrument("APEX:FX:EURUSD", "EURUSD", "Euro / US Dollar", "fx", true))
                    : List.of();
                return new MarketSearchResponse(instruments);
            }
        );

        registerSpec(specs,
            "apex.market.details",
            "Full contract specification for an instrument.",
            new McpSchema.JsonSchema("object", Map.of(
                "instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")
            ), List.of("instrument_id"), false, null, null),
            args -> {
                String instrumentId = argStr(args, "instrument_id", "");
                if (!ReferenceTradingState.INSTRUMENT_ID.equals(instrumentId)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                return new MarketDetailsResponse(
                    instrumentId,
                    "EURUSD",
                    "Euro / US Dollar",
                    "fx",
                    "EUR",
                    "USD",
                    dec(0.0001),
                    100000,
                    "base_units",
                    "lots",
                    dec(1000),
                    dec(50000000),
                    dec(1000),
                    dec(0.5),
                    dec(0.0),
                    "variable",
                    dec(0.8),
                    List.of(new TradingHours("monday", "00:00", "23:59", "UTC")),
                    Map.of()
                );
            }
        );
    }

    private void registerRiskSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        var riskOrderProps = new LinkedHashMap<String, Object>();
        riskOrderProps.put("instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)"));
        riskOrderProps.put("side", enumProp(null, null, "buy", "sell"));
        riskOrderProps.put("order_type", enumProp(null, null, "market", "limit", "stop", "stop_limit"));
        riskOrderProps.put("quantity", numProp(null));

        registerSpec(specs,
            "apex.risk.check",
            "Pre-trade margin and exposure check. Call before placing large orders.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null),
                "order", objProp(null, riskOrderProps, List.of("instrument_id", "side", "order_type", "quantity"))
            ), List.of("account_id", "order"), false, null, null),
            args -> {
                Map<String, Object> order = argMap(args, "order");
                double quantity = argDouble(order, "quantity", 0);
                double requiredMargin = (quantity / 100000.0) * 500.0;
                return new RiskCheckResponse(
                    true,
                    dec(requiredMargin),
                    dec(9750.00),
                    dec(9750.00 - requiredMargin),
                    dec(quantity),
                    List.of(),
                    null
                );
            }
        );

        registerSpec(specs,
            "apex.risk.limits",
            "Current account-level risk limits and utilisation.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp(null)
            ), List.of("account_id"), false, null, null),
            args -> new RiskLimitsResponse(
                argStr(args, "account_id", ""),
                dec(5000000),
                50,
                dec(-1000.00),
                dec(-150.00),
                dec(100),
                dec(50),
                List.of(),
                Boolean.TRUE.equals(((Map<?, ?>) state.readResource(ReferenceTradingState.RISK_URI)).get("kill_switch_active"))
            )
        );
    }

    private void registerFxSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        registerSpec(specs,
            "apex.fx.rollover",
            "Query swap/rollover rates for an FX instrument. Rates are expressed in account currency per lot per night.",
            new McpSchema.JsonSchema("object", Map.of(
                "instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)"),
                "as_of", strProp("ISO8601 timestamp — defaults to now")
            ), List.of("instrument_id"), false, null, null),
            args -> {
                String instrumentId = argStr(args, "instrument_id", "");
                if (!ReferenceTradingState.INSTRUMENT_ID.equals(instrumentId)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                return new FxRolloverResponse(
                    ReferenceTradingState.INSTRUMENT_ID,
                    ReferenceTradingState.BROKER_SYMBOL,
                    dec(-0.5),
                    dec(0.3),
                    "USD",
                    "lot",
                    100000,
                    "Wednesday",
                    nextRolloverTime(),
                    now()
                );
            }
        );

        registerSpec(specs,
            "apex.fx.exposure",
            "Net currency exposure across open FX positions. Critical for agents managing portfolio-level currency risk.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp("Trading account ID"),
                "base_currency", strProp("Denominate all exposures in this currency")
            ), List.of("account_id", "base_currency"), false, null, null),
            args -> {
                String accountId = argStr(args, "account_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                String baseCurrency = argStr(args, "base_currency", "USD");
                var positionsResponse = state.positionsResponse();
                var positions = positionsResponse.positions();
                long eurNetUnits = 0;
                List<String> contributingPositions = new java.util.ArrayList<>();
                for (var pos : positions) {
                    if (ReferenceTradingState.INSTRUMENT_ID.equals(pos.instrument_id())) {
                        long qty = (long) Double.parseDouble(pos.quantity());
                        if ("buy".equals(pos.side())) {
                            eurNetUnits += qty;
                        } else {
                            eurNetUnits -= qty;
                        }
                        contributingPositions.add(pos.position_id());
                    }
                }
                double rate = 1.0875;
                double valueInBase = "EUR".equals(baseCurrency) ? eurNetUnits : eurNetUnits * rate;
                String netDirection = eurNetUnits > 0 ? "long" : eurNetUnits < 0 ? "short" : "flat";
                return new FxExposureResponse(
                    accountId,
                    baseCurrency,
                    List.of(new ExposureEntry(
                        "EUR",
                        dec(eurNetUnits),
                        netDirection,
                        dec(valueInBase),
                        List.copyOf(contributingPositions)
                    )),
                    dec(Math.abs(valueInBase)),
                    now()
                );
            }
        );

        registerSpec(specs,
            "apex.fx.conversion",
            "Real-time cross-currency conversion rate. Used by agents to calculate P&L in a target currency.",
            new McpSchema.JsonSchema("object", Map.of(
                "from_currency", strProp("Source currency code (e.g. EUR)"),
                "to_currency", strProp("Target currency code (e.g. USD)"),
                "amount", numProp("Amount to convert")
            ), List.of("from_currency", "to_currency", "amount"), false, null, null),
            args -> {
                String fromCurrency = argStr(args, "from_currency", "");
                String toCurrency = argStr(args, "to_currency", "");
                double amount = argDouble(args, "amount", 0);
                if (fromCurrency.isEmpty() || toCurrency.isEmpty()) {
                    return apexError("APEX_4011", "validation", "from_currency, to_currency, and amount are all required");
                }
                double midRate = 1.0875;
                double rate;
                if (fromCurrency.equals(toCurrency)) {
                    rate = 1.0;
                } else if ("EUR".equals(fromCurrency) && "USD".equals(toCurrency)) {
                    rate = midRate;
                } else if ("USD".equals(fromCurrency) && "EUR".equals(toCurrency)) {
                    rate = 1.0 / midRate;
                } else {
                    return apexError("APEX_4010", "validation", "Unsupported currency pair");
                }
                return new FxConversionResponse(
                    fromCurrency,
                    toCurrency,
                    dec(Math.round(rate * 10000000.0) / 10000000.0),
                    dec(Math.round(amount * rate * 100.0) / 100.0),
                    now()
                );
            }
        );
    }

    private void registerCfdSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        registerSpec(specs,
            "apex.cfd.corporate_actions",
            "Query upcoming corporate actions for CFD instruments. Reference implementation returns an empty array.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp("Trading account ID"),
                "instrument_id", strProp("Filter by APEX canonical instrument ID"),
                "from", strProp("ISO8601 start date"),
                "to", strProp("ISO8601 end date")
            ), List.of("account_id"), false, null, null),
            args -> {
                String accountId = argStr(args, "account_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                return new CfdCorporateActionsResponse(List.of());
            }
        );

        registerSpec(specs,
            "apex.cfd.dividend_adjustment",
            "Query dividend adjustments for CFD positions. Reference implementation returns an empty array.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp("Trading account ID"),
                "status", strProp("Filter by status (default: all)"),
                "from", strProp("ISO8601 start date"),
                "to", strProp("ISO8601 end date")
            ), List.of("account_id"), false, null, null),
            args -> {
                String accountId = argStr(args, "account_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                return new CfdDividendAdjustmentResponse(List.of());
            }
        );
    }

    private void registerCryptoSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        final String PERP_INSTRUMENT_ID = "APEX:CRYPTO:PERP:BTCUSDT";
        final String PERP_BROKER_SYMBOL = "BTCUSDT";

        registerSpec(specs,
            "apex.crypto.funding_rate",
            "Query funding rate for a perpetual instrument. Returns simulated data for BTCUSDT.",
            new McpSchema.JsonSchema("object", Map.of(
                "instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)")
            ), List.of("instrument_id"), false, null, null),
            args -> {
                String instrumentId = argStr(args, "instrument_id", "");
                if (!PERP_INSTRUMENT_ID.equals(instrumentId)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                long[] funding = nextFundingTime();
                String fundingTimeStr = Instant.ofEpochMilli(funding[0]).toString();
                long countdown = funding[1];
                return new CryptoFundingRateResponse(
                    PERP_INSTRUMENT_ID,
                    PERP_BROKER_SYMBOL,
                    dec(0.0001),
                    dec(0.1095),
                    dec(0.00012),
                    8,
                    fundingTimeStr,
                    countdown,
                    dec(50000.00),
                    dec(50050.00),
                    now()
                );
            }
        );

        var liqProps = new LinkedHashMap<String, Object>();
        liqProps.put("account_id", strProp("Trading account ID"));
        liqProps.put("instrument_id", strProp("APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)"));
        liqProps.put("side", strProp("Position side: buy or sell"));
        liqProps.put("quantity", numProp("Position quantity"));
        liqProps.put("leverage", numProp("Leverage multiplier"));
        liqProps.put("margin_mode", strProp("Margin mode: cross or isolated"));
        liqProps.put("entry_price", numProp("Entry price"));
        registerSpec(specs,
            "apex.crypto.liquidation_estimate",
            "Estimate liquidation price for a perpetual position based on leverage and margin mode.",
            new McpSchema.JsonSchema("object", liqProps,
                List.of("account_id", "instrument_id", "side", "quantity", "leverage", "margin_mode", "entry_price"),
                false, null, null),
            args -> {
                String instrumentId = argStr(args, "instrument_id", "");
                if (!PERP_INSTRUMENT_ID.equals(instrumentId)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                String side = argStr(args, "side", "buy");
                double quantity = argDouble(args, "quantity", 0);
                double leverage = argDouble(args, "leverage", 1);
                double entryPrice = argDouble(args, "entry_price", 0);
                double marginRequired = (entryPrice * quantity) / leverage;
                double maintenanceMargin = marginRequired / 2;
                double liquidationPrice;
                if ("buy".equals(side)) {
                    liquidationPrice = entryPrice * (1 - (1.0 / leverage) * 0.95);
                } else {
                    liquidationPrice = entryPrice * (1 + (1.0 / leverage) * 0.95);
                }
                liquidationPrice = Math.round(liquidationPrice * 100.0) / 100.0;
                double distancePct = Math.round(Math.abs(entryPrice - liquidationPrice) / entryPrice * 100.0 * 100.0) / 100.0;
                return new CryptoLiquidationEstimateResponse(
                    PERP_INSTRUMENT_ID,
                    side,
                    dec(entryPrice),
                    dec(liquidationPrice),
                    dec(Math.round(marginRequired * 100.0) / 100.0),
                    dec(Math.round(maintenanceMargin * 100.0) / 100.0),
                    "USDT",
                    dec(distancePct),
                    List.of()
                );
            }
        );

        var transferProps = new LinkedHashMap<String, Object>();
        transferProps.put("account_id", strProp("Trading account ID"));
        transferProps.put("from_wallet", enumProp("Source wallet", null, "spot", "futures", "funding"));
        transferProps.put("to_wallet", enumProp("Destination wallet", null, "spot", "futures", "funding"));
        transferProps.put("currency", strProp("Currency to transfer (e.g. USDT)"));
        transferProps.put("amount", numProp("Amount to transfer"));
        registerSpec(specs,
            "apex.crypto.transfer",
            "Transfer funds between wallets (spot, futures, funding). Reference implementation simulates instant completion.",
            new McpSchema.JsonSchema("object", transferProps,
                List.of("account_id", "from_wallet", "to_wallet", "currency", "amount"),
                false, null, null),
            args -> {
                String accountId = argStr(args, "account_id", "");
                String fromWallet = argStr(args, "from_wallet", "");
                String toWallet = argStr(args, "to_wallet", "");
                String currency = argStr(args, "currency", "");
                double amount = argDouble(args, "amount", 0);
                if (accountId.isEmpty() || fromWallet.isEmpty() || toWallet.isEmpty() || currency.isEmpty()) {
                    return apexError("APEX_4011", "validation", "All fields are required: account_id, from_wallet, to_wallet, currency, amount");
                }
                if (fromWallet.equals(toWallet)) {
                    return apexError("APEX_4011", "validation", "from_wallet and to_wallet must be different");
                }
                return new CryptoTransferResponse(
                    UUID.randomUUID().toString(),
                    fromWallet,
                    toWallet,
                    currency,
                    dec(amount),
                    "completed",
                    null,
                    now()
                );
            }
        );
    }

    private void registerFuturesSpecs(List<McpServerFeatures.SyncToolSpecification> specs) {
        // Mock chain is a fixed snapshot as of 2026-11-06 (42 days before ESZ26 expiry):
        // ESU26 has expired, ESZ26 is front month, ESH27 is next out.
        final String FUT_ROOT_ID = "APEX:FUT:ES";
        final String FUT_EXPIRED_ID = "APEX:FUT:ESU26";
        final String FUT_FRONT_MONTH_ID = "APEX:FUT:ESZ26";
        final String FUT_NEXT_MONTH_ID = "APEX:FUT:ESH27";

        registerSpec(specs,
            "apex.futures.contract_chain",
            "List dated contracts for a futures contract root with expirations and liquidity. Reference implementation serves the E-mini S&P 500 chain.",
            new McpSchema.JsonSchema("object", Map.of(
                "root", strProp("APEX contract root ID (e.g. APEX:FUT:ES)"),
                "include_expired", boolProp(false, "Include expired contracts (default: false)")
            ), List.of("root"), false, null, null),
            args -> {
                String root = argStr(args, "root", "");
                boolean includeExpired = Boolean.TRUE.equals(args.get("include_expired"));
                if (root.isEmpty()) {
                    return apexError("APEX_4011", "validation", "root is required");
                }
                if (!FUT_ROOT_ID.equals(root)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                List<FuturesContract> contracts = new ArrayList<>();
                if (includeExpired) {
                    contracts.add(new FuturesContract(FUT_EXPIRED_ID, "2026-09", "2026-09-18", null,
                        "cash", false, 0, 0, "inactive"));
                }
                contracts.add(new FuturesContract(FUT_FRONT_MONTH_ID, "2026-12", "2026-12-18", null,
                    "cash", true, 1250000, 2100000, "active"));
                contracts.add(new FuturesContract(FUT_NEXT_MONTH_ID, "2027-03", "2027-03-19", null,
                    "cash", false, 41000, 98000, "active"));
                return new FuturesContractChainResponse(FUT_ROOT_ID, contracts);
            }
        );

        registerSpec(specs,
            "apex.futures.margin_schedule",
            "Per-contract margin requirements: exchange overnight margins and broker intraday margins. Reference implementation serves the ESZ26 schedule.",
            new McpSchema.JsonSchema("object", Map.of(
                "account_id", strProp("Trading account ID"),
                "instrument_id", strProp("Filter by APEX canonical instrument ID (e.g. APEX:FUT:ESZ26)")
            ), List.of("account_id"), false, null, null),
            args -> {
                String accountId = argStr(args, "account_id", "");
                String instrumentId = argStr(args, "instrument_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                if (!instrumentId.isEmpty() && !FUT_FRONT_MONTH_ID.equals(instrumentId)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }
                var window = new LinkedHashMap<String, Object>();
                window.put("day", "monday");
                window.put("from", "08:30");
                window.put("to", "15:45");
                window.put("timezone", "America/Chicago");
                return new FuturesMarginScheduleResponse(List.of(
                    new FuturesMarginScheduleEntry(FUT_FRONT_MONTH_ID, "USD",
                        "15500.00", "14000.00", "500.00", List.of(window), now())
                ));
            }
        );
    }

    // ── Utility methods ──────────────────────────────────────────────────

    private static List<String> coreTools() {
        return List.of("apex.session.*", "apex.account.*", "apex.order.*", "apex.position.*", "apex.market.*", "apex.risk.*");
    }

    private static long[] nextFundingTime() {
        Instant now = Instant.now();
        java.time.ZonedDateTime utcNow = now.atZone(java.time.ZoneOffset.UTC);
        int currentHour = utcNow.getHour();
        int nextBoundary = ((currentHour / 8) + 1) * 8;
        java.time.ZonedDateTime next;
        if (nextBoundary >= 24) {
            next = utcNow.plusDays(1).withHour(0).withMinute(0).withSecond(0).withNano(0);
        } else {
            next = utcNow.withHour(nextBoundary).withMinute(0).withSecond(0).withNano(0);
        }
        long countdownSeconds = Math.max(0, java.time.Duration.between(now, next.toInstant()).getSeconds());
        return new long[]{ next.toInstant().toEpochMilli(), countdownSeconds };
    }

    private static String nextRolloverTime() {
        Instant now = Instant.now();
        java.time.ZonedDateTime utcNow = now.atZone(java.time.ZoneOffset.UTC);
        java.time.ZonedDateTime today21 = utcNow.withHour(21).withMinute(0).withSecond(0).withNano(0);
        if (!today21.toInstant().isAfter(now)) {
            today21 = today21.plusDays(1);
        }
        return today21.toInstant().toString();
    }

    static ApexErrorEnvelope apexError(String code, String category, String message) {
        Integer retryAfter = "rate_limit".equals(category) ? 1 : null;
        return new ApexErrorEnvelope(new ApexError(code, category, message, null, UUID.randomUUID().toString(), retryAfter));
    }

    private static String now() {
        return Instant.now().toString();
    }

    private static String nowPlusHours(int hours) {
        return Instant.now().plus(hours, ChronoUnit.HOURS).toString();
    }

    static String argStr(Map<String, Object> args, String key, String defaultValue) {
        Object value = args.get(key);
        return value == null ? defaultValue : value.toString();
    }

    static double argDouble(Map<String, Object> args, String key, double defaultValue) {
        Object value = args.get(key);
        if (value == null) {
            return defaultValue;
        }
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        return Double.parseDouble(value.toString());
    }

    static Boolean argBool(Map<String, Object> args, String key) {
        Object value = args.get(key);
        return value instanceof Boolean bool ? bool : null;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> argMap(Map<String, Object> args, String key) {
        Object value = args.get(key);
        return value instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
    }
}
