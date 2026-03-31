package org.apexstandard.reference;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ReferenceTradingState {
    static final String ACCOUNT_ID = "ACC_12345";
    static final String INSTRUMENT_ID = "APEX:FX:EURUSD";
    static final String BROKER_SYMBOL = "EURUSD";

    static final String QUOTE_URI = "apex://market/quote/" + INSTRUMENT_ID;
    static final String CANDLES_M1_URI = "apex://market/candles/" + INSTRUMENT_ID + "?timeframe=M1&limit=200";
    static final String CANDLES_M5_URI = "apex://market/candles/" + INSTRUMENT_ID + "?timeframe=M5&limit=200";
    static final String CANDLES_H1_URI = "apex://market/candles/" + INSTRUMENT_ID + "?timeframe=H1&limit=200";
    static final String FEATURES_URI = "apex://market/features/" + INSTRUMENT_ID;
    static final String ACCOUNT_SUMMARY_URI = "apex://account/summary/" + ACCOUNT_ID;
    static final String POSITIONS_URI = "apex://account/positions/" + ACCOUNT_ID;
    static final String ORDERS_URI = "apex://account/orders/" + ACCOUNT_ID;
    static final String FILLS_URI = "apex://account/fills/" + ACCOUNT_ID;
    static final String RISK_URI = "apex://account/risk/" + ACCOUNT_ID;
    static final String DECISION_CONTEXT_URI = "apex://agent/decision-context/" + INSTRUMENT_ID;

    private final Map<String, Integer> sequences = new LinkedHashMap<>();
    private final List<Map<String, Object>> orders = new ArrayList<>();
    private final List<Map<String, Object>> fills = new ArrayList<>();
    private boolean quoteStale;
    private boolean riskStale;
    private boolean forceSequenceGap;
    private boolean killSwitchActive;
    private boolean partialFillNextOrder;

    /** Live quote state — updated by tick engine in HTTP mode. */
    private volatile double liveBid = 1.08740;
    private volatile double liveAsk = 1.08760;
    private volatile double liveMid = 1.08750;

    /** Callback for starting tick engine after authentication. */
    private volatile Runnable onAuthenticated;

    /** Callback for emitting resource update notifications after state mutations. */
    @FunctionalInterface
    interface ResourceUpdateCallback {
        void onResourceUpdated(String uri);
    }
    private volatile ResourceUpdateCallback resourceUpdateCallback;

    void setResourceUpdateCallback(ResourceUpdateCallback callback) {
        this.resourceUpdateCallback = callback;
    }

    private final List<ProtocolModels.Position> positions = List.of(
        new ProtocolModels.Position(
            "pos_001",
            INSTRUMENT_ID,
            BROKER_SYMBOL,
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
            Instant.now().minus(1, ChronoUnit.HOURS).toString(),
            1.0800,
            1.1000,
            new ProtocolModels.PositionProfileData(-2.50, 1.80, -7.50, 10.00, "USD")
        )
    );

    void setOnAuthenticated(Runnable callback) {
        this.onAuthenticated = callback;
    }

    void fireOnAuthenticated() {
        Runnable cb = onAuthenticated;
        if (cb != null) {
            cb.run();
            onAuthenticated = null; // Only fire once
        }
    }

    /** Update live quote prices (called by tick engine). */
    void updateQuote(double mid, double bid, double ask) {
        this.liveMid = mid;
        this.liveBid = bid;
        this.liveAsk = ask;
    }

    /** Bump sequences without adding to pendingUpdates (for tick engine). */
    synchronized void bumpResourcesNoTrack(String... uris) {
        for (String uri : uris) {
            sequences.merge(uri, 1, Integer::sum);
        }
    }

    /** Get current sequence for a resource URI. */
    synchronized int getSequence(String uri) {
        return sequences.getOrDefault(uri, 1);
    }

    List<Map<String, Object>> resources() {
        return List.of(
            resource("quote", QUOTE_URI, "Live top-of-book quote"),
            resource("candles-m1", CANDLES_M1_URI, "M1 candles"),
            resource("candles-m5", CANDLES_M5_URI, "M5 candles"),
            resource("candles-h1", CANDLES_H1_URI, "H1 candles"),
            resource("features", FEATURES_URI, "Derived market features"),
            resource("account-summary", ACCOUNT_SUMMARY_URI, "Realtime account summary"),
            resource("account-positions", POSITIONS_URI, "Realtime positions"),
            resource("account-orders", ORDERS_URI, "Realtime orders"),
            resource("account-fills", FILLS_URI, "Realtime fills"),
            resource("account-risk", RISK_URI, "Realtime risk state"),
            resource("decision-context", DECISION_CONTEXT_URI, "Model-ready decision context")
        );
    }

    synchronized ProtocolModels.AccountSummaryResponse accountSummary(String currency) {
        return new ProtocolModels.AccountSummaryResponse(
            ACCOUNT_ID,
            "USD",
            currency == null || currency.isBlank() ? "USD" : currency,
            10000.00,
            10250.00,
            500.00,
            9750.00,
            2050.00,
            250.00,
            0.00,
            (riskStale ? Instant.now().minusSeconds(5) : Instant.now()).toString()
        );
    }

    synchronized ProtocolModels.AccountPositionsResponse positionsResponse() {
        return new ProtocolModels.AccountPositionsResponse(positions, 250.00, Instant.now().toString());
    }

    synchronized ProtocolModels.OrderListResponse ordersResponse() {
        return new ProtocolModels.OrderListResponse(List.copyOf(orders), Instant.now().toString());
    }

    synchronized ProtocolModels.MarketQuoteResponse quoteResponse(String instrumentId, String brokerSymbol) {
        double bid = liveBid;
        double ask = liveAsk;
        double mid = liveMid;
        double spread = Math.round((ask - bid) * 100000.0) / 100000.0;
        return new ProtocolModels.MarketQuoteResponse(
            instrumentId == null || instrumentId.isBlank() ? INSTRUMENT_ID : instrumentId,
            brokerSymbol == null || brokerSymbol.isBlank() ? BROKER_SYMBOL : brokerSymbol,
            bid,
            ask,
            mid,
            spread,
            (quoteStale ? Instant.now().minusSeconds(5) : Instant.now()).toString(),
            true,
            "open"
        );
    }

    synchronized Object createOrder(Map<String, Object> args) {
        Map<String, Object> order = ToolRegistry.argMap(args, "order");
        String now = Instant.now().toString();
        String orderType = ToolRegistry.argStr(order, "order_type", "market");
        double quantity = ToolRegistry.argDouble(order, "quantity", 0);
        boolean market = "market".equals(orderType);
        boolean partialFill = market && partialFillNextOrder;
        String orderId = "ord_" + Long.toString(System.nanoTime(), 36);
        double fillQuantity = partialFill ? quantity / 2.0 : quantity;
        double remainingQuantity = quantity - fillQuantity;

        Map<String, Object> orderRecord = new LinkedHashMap<>();
        orderRecord.put("order_id", orderId);
        orderRecord.put("client_order_id", emptyToNull(ToolRegistry.argStr(order, "client_order_id", "")));
        orderRecord.put("account_id", ACCOUNT_ID);
        orderRecord.put("instrument_id", ToolRegistry.argStr(order, "instrument_id", INSTRUMENT_ID));
        orderRecord.put("broker_symbol", ToolRegistry.argStr(order, "broker_symbol", BROKER_SYMBOL));
        String side = ToolRegistry.argStr(order, "side", "");
        if (side.isEmpty() || (!side.equals("buy") && !side.equals("sell"))) {
            return ToolRegistry.apexError("APEX_4011", "validation", "side is required and must be 'buy' or 'sell'");
        }
        orderRecord.put("side", side);
        orderRecord.put("order_type", orderType);
        orderRecord.put("quantity", quantity);
        orderRecord.put("quantity_unit", ToolRegistry.argStr(order, "quantity_unit", "base_units"));
        orderRecord.put("limit_price", order.get("limit_price"));
        orderRecord.put("stop_price", order.get("stop_price"));
        orderRecord.put("time_in_force", ToolRegistry.argStr(order, "time_in_force", "GTC"));
        orderRecord.put("status", partialFill ? "partially_filled" : market ? "filled" : "working");
        orderRecord.put("filled_quantity", market ? fillQuantity : 0.0);
        orderRecord.put("remaining_quantity", market ? remainingQuantity : quantity);
        orderRecord.put("average_fill_price", market ? 1.08755 : null);
        orderRecord.put("reason", null);
        orderRecord.put("created_at", now);
        orderRecord.put("updated_at", now);
        orders.add(orderRecord);
        partialFillNextOrder = false;

        if (market) {
            Map<String, Object> fill = new LinkedHashMap<>();
            fill.put("fill_id", "fill_" + orderId);
            fill.put("order_id", orderId);
            fill.put("account_id", ACCOUNT_ID);
            fill.put("instrument_id", orderRecord.get("instrument_id"));
            fill.put("side", orderRecord.get("side"));
            fill.put("fill_quantity", fillQuantity);
            fill.put("fill_price", 1.08755);
            fill.put("commission", -0.5);
            fill.put("commission_currency", "USD");
            fill.put("liquidity_flag", "taker");
            fill.put("position_id", "pos_001");
            fill.put("timestamp", now);
            fills.add(0, fill);
        }

        bump(ORDERS_URI, POSITIONS_URI, FILLS_URI, RISK_URI, DECISION_CONTEXT_URI);

        return new ProtocolModels.OrderPlacementResponse(
            orderId,
            orderRecord.get("client_order_id"),
            partialFill ? "partially_filled" : market ? "filled" : "working",
            market ? 1.08755 : null,
            market ? fillQuantity : 0.0,
            market ? remainingQuantity : quantity,
            market ? "pos_001" : null,
            null,
            now
        );
    }

    /** Get the last created order record (for notification emission). */
    synchronized Map<String, Object> getLastOrder() {
        if (orders.isEmpty()) return null;
        return new LinkedHashMap<>(orders.get(orders.size() - 1));
    }

    synchronized Map<String, Object> setFaults(Boolean quoteStale, Boolean riskStale, Boolean forceSequenceGap, Boolean killSwitchActive, Boolean partialFillNextOrder) {
        if (quoteStale != null) {
            this.quoteStale = quoteStale;
        }
        if (riskStale != null) {
            this.riskStale = riskStale;
        }
        if (forceSequenceGap != null) {
            this.forceSequenceGap = forceSequenceGap;
        }
        if (killSwitchActive != null) {
            this.killSwitchActive = killSwitchActive;
        }
        if (partialFillNextOrder != null) {
            this.partialFillNextOrder = partialFillNextOrder;
        }
        return Map.of(
            "quote_stale", this.quoteStale,
            "risk_stale", this.riskStale,
            "force_sequence_gap", this.forceSequenceGap,
            "kill_switch_active", this.killSwitchActive,
            "partial_fill_next_order", this.partialFillNextOrder
        );
    }

    synchronized boolean isKillSwitchActive() {
        return killSwitchActive;
    }

    synchronized Map<String, Object> orderAcceptance() {
        if (quoteStale) {
            return Map.of("ok", false, "code", "APEX_4024", "category", "operational", "message", "Quote state is stale");
        }
        if (riskStale) {
            return Map.of("ok", false, "code", "APEX_4024", "category", "operational", "message", "Risk state is stale");
        }
        if (forceSequenceGap) {
            return Map.of("ok", false, "code", "APEX_4025", "category", "operational", "message", "Sequence continuity is broken");
        }
        if (killSwitchActive) {
            return Map.of("ok", false, "code", "APEX_4023", "category", "risk", "message", "Kill switch is active");
        }
        return Map.of("ok", true);
    }

    synchronized void modifyOrder(String targetId) {
        for (Map<String, Object> order : orders) {
            if (targetId.equals(order.get("order_id"))) {
                order.put("updated_at", Instant.now().toString());
            }
        }
        bump(ORDERS_URI, DECISION_CONTEXT_URI);
    }

    synchronized void cancelOrder(String orderId) {
        for (Map<String, Object> order : orders) {
            if (orderId.equals(order.get("order_id"))) {
                order.put("status", "cancelled");
                order.put("remaining_quantity", 0.0);
                order.put("updated_at", Instant.now().toString());
            }
        }
        bump(ORDERS_URI, DECISION_CONTEXT_URI);
    }

    synchronized ProtocolModels.Position findPosition(String positionId) {
        for (ProtocolModels.Position p : positions) {
            if (positionId.equals(p.position_id())) {
                return p;
            }
        }
        return null;
    }

    synchronized ProtocolModels.PositionCloseResponse closePosition(String positionId, Double requestedQuantity) {
        ProtocolModels.Position pos = findPosition(positionId);
        if (pos == null) {
            return null;
        }

        double closeQuantity = (requestedQuantity != null) ? requestedQuantity : pos.quantity();
        if (closeQuantity > pos.quantity()) {
            closeQuantity = pos.quantity();
        }
        double remainingQuantity = pos.quantity() - closeQuantity;
        boolean fullClose = remainingQuantity <= 0;

        // The closing order is in the opposite direction
        String closeSide = "buy".equals(pos.side()) ? "sell" : "buy";
        double fillPrice = "sell".equals(closeSide) ? liveBid : liveAsk;

        String now = Instant.now().toString();
        String orderId = "ord_" + Long.toString(System.nanoTime(), 36);

        // Record the closing order
        Map<String, Object> orderRecord = new LinkedHashMap<>();
        orderRecord.put("order_id", orderId);
        orderRecord.put("client_order_id", null);
        orderRecord.put("account_id", ACCOUNT_ID);
        orderRecord.put("instrument_id", pos.instrument_id());
        orderRecord.put("broker_symbol", pos.broker_symbol());
        orderRecord.put("side", closeSide);
        orderRecord.put("order_type", "market");
        orderRecord.put("quantity", closeQuantity);
        orderRecord.put("quantity_unit", pos.quantity_unit());
        orderRecord.put("limit_price", null);
        orderRecord.put("stop_price", null);
        orderRecord.put("time_in_force", "IOC");
        orderRecord.put("status", "filled");
        orderRecord.put("filled_quantity", closeQuantity);
        orderRecord.put("remaining_quantity", 0.0);
        orderRecord.put("average_fill_price", fillPrice);
        orderRecord.put("reason", "position_close");
        orderRecord.put("created_at", now);
        orderRecord.put("updated_at", now);
        orders.add(orderRecord);

        // Record the fill
        Map<String, Object> fill = new LinkedHashMap<>();
        fill.put("fill_id", "fill_" + orderId);
        fill.put("order_id", orderId);
        fill.put("account_id", ACCOUNT_ID);
        fill.put("instrument_id", pos.instrument_id());
        fill.put("side", closeSide);
        fill.put("fill_quantity", closeQuantity);
        fill.put("fill_price", fillPrice);
        fill.put("commission", -0.5);
        fill.put("commission_currency", "USD");
        fill.put("liquidity_flag", "taker");
        fill.put("position_id", positionId);
        fill.put("timestamp", now);
        fills.add(0, fill);

        bump(ORDERS_URI, POSITIONS_URI, FILLS_URI, RISK_URI, DECISION_CONTEXT_URI);

        return new ProtocolModels.PositionCloseResponse(
            orderId,
            positionId,
            fullClose ? "filled" : "partially_filled",
            fillPrice,
            closeQuantity,
            remainingQuantity,
            now
        );
    }

    synchronized Object orderStatus(String orderId) {
        for (Map<String, Object> order : orders) {
            if (orderId.equals(order.get("order_id"))) {
                var copy = new LinkedHashMap<>(order);
                copy.put("as_of", Instant.now().toString());
                return copy;
            }
        }
        return null;
    }

    synchronized Object readResource(String uri) {
        return switch (uri) {
            case QUOTE_URI -> {
                double bid = liveBid;
                double ask = liveAsk;
                double mid = liveMid;
                double spread = Math.round((ask - bid) * 100000.0) / 100000.0;
                yield envelope(uri, Map.of(
                    "instrument_id", INSTRUMENT_ID,
                    "broker_symbol", BROKER_SYMBOL,
                    "bid", bid,
                    "ask", ask,
                    "mid", mid,
                    "spread", spread,
                    "timestamp", (quoteStale ? Instant.now().minusSeconds(5) : Instant.now()).toString(),
                    "is_tradeable", true,
                    "market_status", "open"
                ), 1000);
            }
            case CANDLES_M1_URI -> candlesEnvelope(uri, "M1", 1.0875);
            case CANDLES_M5_URI -> candlesEnvelope(uri, "M5", 1.0868);
            case CANDLES_H1_URI -> candlesEnvelope(uri, "H1", 1.0842);
            case FEATURES_URI -> envelope(uri, Map.of(
                "instrument_id", INSTRUMENT_ID,
                "as_of", (riskStale ? Instant.now().minusSeconds(5) : Instant.now()).toString(),
                "quote", Map.of("bid", liveBid, "ask", liveAsk, "mid", liveMid, "spread", Math.round((liveAsk - liveBid) * 100000.0) / 100000.0),
                "returns", Map.of("r_1s", 0.00002, "r_5s", 0.00005, "r_1m", 0.0008),
                "volatility", Map.of("rv_1m", 0.12, "rv_5m", 0.37, "rv_30m", 0.55),
                "book", Map.of("top_level_imbalance", 0.21, "depth_imbalance", 0.18, "microprice", 1.08753),
                "flow", Map.of("trade_intensity_30s", 0.67, "aggressor_imbalance_30s", 0.44),
                "regime", Map.of("label", "trend_up", "confidence", 0.81),
                "execution", Map.of("liquidity_score", 0.79, "expected_slippage_bps", 0.6)
            ), 2000);
            case ACCOUNT_SUMMARY_URI -> envelope(uri, toMap(accountSummary("USD")), 2000);
            case POSITIONS_URI -> envelope(uri, Map.of(
                "account_id", ACCOUNT_ID,
                "as_of", (riskStale ? Instant.now().minusSeconds(5) : Instant.now()).toString(),
                "positions", positions,
                "total_unrealised_pnl", 250.00
            ), 2000);
            case ORDERS_URI -> envelope(uri, Map.of("account_id", ACCOUNT_ID, "as_of", Instant.now().toString(), "orders", List.copyOf(orders)), 2000);
            case FILLS_URI -> envelope(uri, Map.of("account_id", ACCOUNT_ID, "as_of", Instant.now().toString(), "fills", List.copyOf(fills)), 2000);
            case RISK_URI -> envelope(uri, new LinkedHashMap<>(Map.of(
                "account_id", ACCOUNT_ID,
                "as_of", Instant.now().toString(),
                "available_margin", 9750.0,
                "kill_switch_active", killSwitchActive,
                "max_position_size", 5000000,
                "max_open_orders", 50,
                "daily_loss_limit", -1000.0,
                "daily_loss_used", -150.0,
                "restricted_instruments", List.of()
            )) {{
                put("margin_call_level_pct", 100);
                put("stop_out_level_pct", 50);
            }}, 2000);
            case DECISION_CONTEXT_URI -> envelope(uri, new LinkedHashMap<>(Map.of(
                "instrument_id", INSTRUMENT_ID,
                "timestamp", Instant.now().toString(),
                "market", Map.of(
                    "quote_resource", QUOTE_URI,
                    "feature_resource", FEATURES_URI,
                    "candle_resources", List.of(CANDLES_M1_URI, CANDLES_M5_URI, CANDLES_H1_URI)
                ),
                "account", Map.of(
                    "summary_resource", ACCOUNT_SUMMARY_URI,
                    "positions_resource", POSITIONS_URI,
                    "orders_resource", ORDERS_URI,
                    "risk_resource", RISK_URI
                ),
                "constraints", Map.of("kill_switch_active", killSwitchActive, "max_position_size", 5000000, "max_open_orders", 50)
            )), 5000);
            default -> null;
        };
    }

    private void bump(String... uris) {
        for (String uri : uris) {
            sequences.merge(uri, forceSequenceGap ? 5 : 1, Integer::sum);
        }
        forceSequenceGap = false;
    }

    /**
     * Fire resource update notifications OUTSIDE the synchronized monitor.
     * Callers must invoke this after calling synchronized methods that mutate state.
     */
    void fireResourceUpdates(String... uris) {
        ResourceUpdateCallback cb = resourceUpdateCallback;
        if (cb != null) {
            for (String uri : uris) {
                try { cb.onResourceUpdated(uri); } catch (Exception ignored) {}
            }
        }
    }

    private Map<String, Object> candlesEnvelope(String uri, String timeframe, double close) {
        return envelope(uri, Map.of(
            "instrument_id", INSTRUMENT_ID,
            "timeframe", timeframe,
            "partial_candle_included", true,
            "as_of", Instant.now().toString(),
            "candles", List.of(Map.of(
                "time", Instant.now().minus(1, ChronoUnit.MINUTES).toString(),
                "open", close - 0.0006,
                "high", close + 0.0008,
                "low", close - 0.0010,
                "close", close,
                "volume", 125000,
                "complete", true
            ))
        ), 60000);
    }

    private Map<String, Object> envelope(String uri, Map<String, Object> payload, int staleAfterMs) {
        Map<String, Object> result = new LinkedHashMap<>(payload);
        result.put("sequence", sequences.getOrDefault(uri, 1));
        result.put("stale_after_ms", staleAfterMs);
        return result;
    }

    private static Map<String, Object> resource(String name, String uri, String description) {
        Map<String, Object> resource = new LinkedHashMap<>();
        resource.put("name", name);
        resource.put("uri", uri);
        resource.put("description", description);
        resource.put("mimeType", "application/json");
        return resource;
    }

    private static Object emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static Map<String, Object> toMap(Object value) {
        return new LinkedHashMap<>(Map.ofEntries(
            Map.entry("account_id", ((ProtocolModels.AccountSummaryResponse) value).account_id()),
            Map.entry("account_base_currency", ((ProtocolModels.AccountSummaryResponse) value).account_base_currency()),
            Map.entry("response_currency", ((ProtocolModels.AccountSummaryResponse) value).response_currency()),
            Map.entry("balance", ((ProtocolModels.AccountSummaryResponse) value).balance()),
            Map.entry("equity", ((ProtocolModels.AccountSummaryResponse) value).equity()),
            Map.entry("used_margin", ((ProtocolModels.AccountSummaryResponse) value).used_margin()),
            Map.entry("free_margin", ((ProtocolModels.AccountSummaryResponse) value).free_margin()),
            Map.entry("margin_level_pct", ((ProtocolModels.AccountSummaryResponse) value).margin_level_pct()),
            Map.entry("unrealised_pnl", ((ProtocolModels.AccountSummaryResponse) value).unrealised_pnl()),
            Map.entry("realised_pnl_today", ((ProtocolModels.AccountSummaryResponse) value).realised_pnl_today()),
            Map.entry("as_of", ((ProtocolModels.AccountSummaryResponse) value).as_of())
        ));
    }
}
