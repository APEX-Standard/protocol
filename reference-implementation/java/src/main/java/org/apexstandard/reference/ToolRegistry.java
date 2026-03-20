package org.apexstandard.reference;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.apexstandard.reference.ProtocolModels.*;

final class ToolRegistry {
    static final String SERVER_NAME = "apex-reference";
    static final String SERVER_VERSION = "0.1.0";

    private final ObjectMapper mapper;
    private final SchemaBuilder schema;

    ToolRegistry(ObjectMapper mapper) {
        this.mapper = mapper;
        this.schema = new SchemaBuilder(mapper);
    }

    Map<String, ToolDefinition> createTools() {
        Map<String, ToolDefinition> tools = new LinkedHashMap<>();

        registerSessionTools(tools);
        registerAccountTools(tools);
        registerOrderTools(tools);
        registerMarketTools(tools);
        registerRiskTools(tools);

        return tools;
    }

    private void registerSessionTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.session.authenticate",
            "Establish an authenticated trading session. The broker validates credentials directly and binds the result to the MCP session.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "token", "Broker-issued JWT or OAuth token", true);
                schema.enumProp(props, req, "token_type", null, false, "jwt", "jwt", "oauth2");
                schema.stringProp(props, req, "account_id", "Optional — broker may derive from token", false);
                schema.stringProp(props, req, "hub_session_id", "Optional session reference from caller", false);
            }),
            args -> {
                String token = argStr(args, "token", "");
                if (token.length() < 10) {
                    return apexError("APEX_4001", "auth", "Invalid or expired token");
                }

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

        registerTool(
            tools,
            "apex.session.capabilities",
            "Query the full capability manifest of this broker implementation.",
            schema.objectSchema((props, req) -> {
            }),
            args -> new CapabilitiesResponse(
                SERVER_VERSION,
                "reference-broker",
                coreTools(),
                Map.of("fx", SERVER_VERSION),
                null,
                Map.of("orders_per_second", 10, "market_data_per_second", 100),
                List.of("market", "limit", "stop", "stop_limit"),
                List.of("GTC", "IOC", "FOK", "DAY")
            )
        );

        registerTool(
            tools,
            "apex.session.heartbeat",
            "Keep-alive ping. Hub marks session degraded if response exceeds 500ms.",
            schema.objectSchema((props, req) -> schema.stringProp(props, req, "timestamp", "ISO8601 timestamp", true)),
            args -> new HeartbeatResponse(now(), "ok")
        );
    }

    private void registerAccountTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.account.summary",
            "Current account state — balances, margin utilisation, equity.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.stringProp(props, req, "currency", "Response currency. Defaults to account base currency.", false);
            }),
            args -> new AccountSummaryResponse(
                argStr(args, "account_id", ""),
                "USD",
                argStr(args, "currency", "USD"),
                10000.00,
                10250.00,
                500.00,
                9750.00,
                2050.00,
                250.00,
                0.00,
                now()
            )
        );

        registerTool(
            tools,
            "apex.account.positions",
            "All open positions with live P&L.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", false);
                schema.stringProp(props, req, "profile", null, false);
            }),
            args -> new AccountPositionsResponse(
                List.of(new Position(
                    "pos_001",
                    argStr(args, "instrument_id", "APEX:FX:EURUSD"),
                    "EURUSD",
                    "buy",
                    100000,
                    "base_units",
                    "1.0",
                    "lots",
                    1.0850,
                    1.0875,
                    250.00,
                    "USD",
                    500.00,
                    nowMinusHours(1),
                    1.0800,
                    1.1000,
                    new PositionProfileData(-2.50, 1.80, -7.50, 10.00, "USD")
                )),
                250.00,
                now()
            )
        );

        registerTool(
            tools,
            "apex.account.orders",
            "Known orders and their current lifecycle state.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.enumProp(props, req, "status", null, false, "all", "working", "partially_filled", "filled", "cancelled", "rejected", "expired", "all");
                schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", false);
            }),
            args -> new OrderListResponse(List.of(), now())
        );

        registerTool(
            tools,
            "apex.account.history",
            "Closed trades and funding events.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.stringProp(props, req, "from", "ISO8601 start date", true);
                schema.stringProp(props, req, "to", "ISO8601 end date", true);
                schema.enumProp(props, req, "event_type", null, false, "all", "trade", "funding", "cash", "corporate_action", "all");
                schema.integerProp(props, req, "limit", null, false, 1, 500, 100);
                schema.stringProp(props, req, "cursor", "Pagination cursor", false);
            }),
            args -> new AccountHistoryResponse(List.of(), null, false)
        );
    }

    private void registerOrderTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.order.place",
            "Unified order entry across all asset classes. Profile-composable.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.objectProp(props, req, "order", null, true, (orderProps, orderReq) -> {
                    schema.stringProp(orderProps, orderReq, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", true);
                    schema.stringProp(orderProps, orderReq, "broker_symbol", null, false);
                    schema.enumProp(orderProps, orderReq, "side", null, true, null, "buy", "sell");
                    schema.enumProp(orderProps, orderReq, "order_type", null, true, null, "market", "limit", "stop", "stop_limit");
                    schema.numberProp(orderProps, orderReq, "quantity", null, true);
                    schema.enumProp(orderProps, orderReq, "quantity_unit", null, false, "base_units", "base_units", "shares", "contracts");
                    schema.enumProp(orderProps, orderReq, "time_in_force", null, false, "GTC", "GTC", "IOC", "FOK", "DAY");
                    schema.numberProp(orderProps, orderReq, "limit_price", null, false);
                    schema.numberProp(orderProps, orderReq, "stop_price", null, false);
                    schema.stringProp(orderProps, orderReq, "profile", null, false);
                    schema.stringProp(orderProps, orderReq, "client_order_id", null, false);
                    schema.stringProp(orderProps, orderReq, "strategy_id", null, false);
                    schema.stringProp(orderProps, orderReq, "comment", null, false);
                });
            }),
            args -> {
                Map<String, Object> order = argMap(args, "order");
                if (order.isEmpty()) {
                    return apexError("APEX_4011", "validation", "order is required");
                }

                String orderType = argStr(order, "order_type", "market");
                double quantity = argDouble(order, "quantity", 0);
                if ("limit".equals(orderType) && !order.containsKey("limit_price")) {
                    return apexError("APEX_4011", "validation", "limit_price required for limit orders");
                }

                boolean isMarketOrder = "market".equals(orderType);
                String clientOrderId = argStr(order, "client_order_id", "");

                return new OrderPlacementResponse(
                    "ord_" + UUID.randomUUID().toString().substring(0, 8),
                    clientOrderId.isEmpty() ? null : clientOrderId,
                    isMarketOrder ? "filled" : "working",
                    isMarketOrder ? 1.08755 : null,
                    isMarketOrder ? quantity : 0.0,
                    isMarketOrder ? 0.0 : quantity,
                    isMarketOrder ? "pos_001" : null,
                    null,
                    now()
                );
            }
        );

        registerTool(
            tools,
            "apex.order.modify",
            "Amend a working order or an open position's protection settings.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.enumProp(props, req, "target_type", null, true, null, "order", "position");
                schema.stringProp(props, req, "target_id", null, true);
                schema.objectProp(props, req, "modifications", null, true, (modProps, modReq) -> {
                    schema.numberProp(modProps, modReq, "limit_price", null, false);
                    schema.numberProp(modProps, modReq, "stop_price", null, false);
                    schema.numberProp(modProps, modReq, "quantity", null, false);
                });
            }),
            args -> {
                String targetType = argStr(args, "target_type", "");
                Map<String, Object> modifications = argMap(args, "modifications");
                if ("position".equals(targetType)
                    && (modifications.containsKey("limit_price")
                    || modifications.containsKey("stop_price")
                    || modifications.containsKey("quantity"))) {
                    return apexError("APEX_4011", "validation", "positions may only amend stop_loss, take_profit, or trailing_stop");
                }

                return new OrderModifyResponse(
                    targetType,
                    argStr(args, "target_id", ""),
                    "modified",
                    null,
                    now()
                );
            }
        );

        registerTool(
            tools,
            "apex.order.cancel",
            "Cancel a working or partially filled order.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.stringProp(props, req, "order_id", null, true);
                schema.stringProp(props, req, "reason", "Agent-provided reason for audit trail", false);
            }),
            args -> new OrderCancelResponse(argStr(args, "order_id", ""), "cancelled", null, now())
        );

        registerTool(
            tools,
            "apex.order.status",
            "Query the current state of a single order.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.stringProp(props, req, "order_id", null, true);
            }),
            args -> new OrderStatusResponse(argStr(args, "order_id", ""), "working", 0, now())
        );
    }

    private void registerMarketTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.market.quote",
            "Current bid/ask/mid for an instrument.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", false);
                schema.stringProp(props, req, "broker_symbol", "Alternative to instrument_id", false);
            }),
            args -> new MarketQuoteResponse(
                argStr(args, "instrument_id", "APEX:FX:EURUSD"),
                argStr(args, "broker_symbol", "EURUSD"),
                1.08740,
                1.08760,
                1.08750,
                0.00020,
                now(),
                true,
                "open"
            )
        );

        registerTool(
            tools,
            "apex.market.snapshot",
            "OHLCV candle data for an instrument.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", true);
                schema.enumProp(props, req, "timeframe", null, true, null, "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN");
                schema.stringProp(props, req, "from", "ISO8601 start time", true);
                schema.stringProp(props, req, "to", "ISO8601 end time (defaults to now)", false);
                schema.integerProp(props, req, "limit", null, false, 1, 1000, 200);
            }),
            args -> new MarketSnapshotResponse(argStr(args, "instrument_id", ""), argStr(args, "timeframe", ""), List.of())
        );

        registerTool(
            tools,
            "apex.market.search",
            "Discover instruments by keyword, asset class, or profile.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "query", null, true);
                schema.enumProp(props, req, "profile", null, false, null, "fx", "cfd", "crypto", "derivatives", "fixed_income");
                schema.integerProp(props, req, "limit", null, false, 1, 50, 20);
            }),
            args -> {
                String query = argStr(args, "query", "").toUpperCase();
                List<SearchInstrument> instruments = "EURUSD".contains(query)
                    ? List.of(new SearchInstrument("APEX:FX:EURUSD", "EURUSD", "Euro / US Dollar", "fx", true))
                    : List.of();
                return new MarketSearchResponse(instruments);
            }
        );

        registerTool(
            tools,
            "apex.market.details",
            "Full contract specification for an instrument.",
            schema.objectSchema((props, req) -> schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", true)),
            args -> new MarketDetailsResponse(
                argStr(args, "instrument_id", ""),
                "EURUSD",
                "Euro / US Dollar",
                "fx",
                "EUR",
                "USD",
                0.0001,
                100000,
                "base_units",
                "lots",
                1000,
                50000000,
                1000,
                0.5,
                0.0,
                "variable",
                0.8,
                List.of(new TradingHours("monday", "00:00", "23:59", "UTC")),
                Map.of()
            )
        );
    }

    private void registerRiskTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.risk.check",
            "Pre-trade margin and exposure check. Call before placing large orders.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.objectProp(props, req, "order", null, true, (orderProps, orderReq) -> {
                    schema.stringProp(orderProps, orderReq, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", true);
                    schema.enumProp(orderProps, orderReq, "side", null, true, null, "buy", "sell");
                    schema.enumProp(orderProps, orderReq, "order_type", null, true, null, "market", "limit", "stop", "stop_limit");
                    schema.numberProp(orderProps, orderReq, "quantity", null, true);
                });
            }),
            args -> {
                Map<String, Object> order = argMap(args, "order");
                double quantity = argDouble(order, "quantity", 0);
                double requiredMargin = (quantity / 100000.0) * 500.0;

                return new RiskCheckResponse(
                    true,
                    requiredMargin,
                    9750.00,
                    9750.00 - requiredMargin,
                    quantity,
                    List.of(),
                    null
                );
            }
        );

        registerTool(
            tools,
            "apex.risk.limits",
            "Current account-level risk limits and utilisation.",
            schema.objectSchema((props, req) -> schema.stringProp(props, req, "account_id", null, true)),
            args -> new RiskLimitsResponse(
                argStr(args, "account_id", ""),
                5000000,
                50,
                -1000.00,
                -150.00,
                100,
                50,
                List.of(),
                false
            )
        );
    }

    private void registerTool(
        Map<String, ToolDefinition> tools,
        String name,
        String description,
        ObjectNode inputSchema,
        java.util.function.Function<Map<String, Object>, Object> handler
    ) {
        tools.put(name, new ToolDefinition(name, description, inputSchema, annotationsForTool(name), handler));
    }

    private ObjectNode annotationsForTool(String name) {
        ObjectNode annotations = mapper.createObjectNode();
        boolean readOnly = name.startsWith("apex.account.")
            || name.startsWith("apex.market.")
            || name.startsWith("apex.risk.")
            || "apex.order.status".equals(name)
            || "apex.session.capabilities".equals(name)
            || "apex.session.heartbeat".equals(name);
        boolean destructive = "apex.order.place".equals(name)
            || "apex.order.modify".equals(name)
            || "apex.order.cancel".equals(name);
        boolean idempotent = readOnly
            || "apex.session.authenticate".equals(name)
            || "apex.order.cancel".equals(name);

        annotations.put("readOnlyHint", readOnly);
        annotations.put("destructiveHint", destructive);
        annotations.put("idempotentHint", idempotent);
        return annotations;
    }

    private static List<String> coreTools() {
        return List.of("apex.session.*", "apex.account.*", "apex.order.*", "apex.market.*", "apex.risk.*");
    }

    private static ApexErrorEnvelope apexError(String code, String category, String message) {
        Integer retryAfter = "rate_limit".equals(category) ? 1 : null;
        return new ApexErrorEnvelope(new ApexError(code, category, message, UUID.randomUUID().toString(), retryAfter));
    }

    private static String now() {
        return Instant.now().toString();
    }

    private static String nowPlusHours(int hours) {
        return Instant.now().plus(hours, ChronoUnit.HOURS).toString();
    }

    private static String nowMinusHours(int hours) {
        return Instant.now().minus(hours, ChronoUnit.HOURS).toString();
    }

    private static String argStr(Map<String, Object> args, String key, String defaultValue) {
        Object value = args.get(key);
        return value == null ? defaultValue : value.toString();
    }

    private static double argDouble(Map<String, Object> args, String key, double defaultValue) {
        Object value = args.get(key);
        if (value == null) {
            return defaultValue;
        }
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        return Double.parseDouble(value.toString());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> argMap(Map<String, Object> args, String key) {
        Object value = args.get(key);
        return value instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
    }
}
