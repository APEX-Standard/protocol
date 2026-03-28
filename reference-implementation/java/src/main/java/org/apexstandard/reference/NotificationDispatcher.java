package org.apexstandard.reference;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * APEX Protocol notification builder and emitter.
 * Builds rich APEX-specific notification envelopes for the 6 core event types
 * and emits them to the active SSE stream via a callback.
 */
final class NotificationDispatcher {

    static final String ACCOUNT_ID = "ACC_12345";
    static final String INSTRUMENT_ID = "APEX:FX:EURUSD";

    @FunctionalInterface
    interface NotificationSink {
        void send(Map<String, Object> notification);
    }

    private volatile NotificationSink sink;

    void setSink(NotificationSink sink) {
        this.sink = sink;
    }

    /* ------------------------------------------------------------------ */
    /*  Envelope builder                                                   */
    /* ------------------------------------------------------------------ */

    static Map<String, Object> buildApexNotification(String method, Map<String, Object> opts) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("event_id", "evt_" + UUID.randomUUID().toString().substring(0, 8));
        params.put("event_type", method);
        params.put("account_id", opts.getOrDefault("account_id", ACCOUNT_ID));
        params.put("instrument_id", opts.getOrDefault("instrument_id", INSTRUMENT_ID));
        params.put("resource_uri", opts.get("resource_uri"));
        params.put("timestamp", Instant.now().toString());
        params.put("sequence", opts.getOrDefault("sequence", 1));
        params.put("payload", opts.get("payload"));

        Map<String, Object> notification = new LinkedHashMap<>();
        notification.put("jsonrpc", "2.0");
        notification.put("method", method);
        notification.put("params", params);
        return notification;
    }

    /* ------------------------------------------------------------------ */
    /*  Specific notification builders                                     */
    /* ------------------------------------------------------------------ */

    static Map<String, Object> orderFilledNotification(Map<String, Object> order, int fillSequence) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("order_id", order.get("order_id"));
        payload.put("side", order.get("side"));
        payload.put("fill_price", order.get("average_fill_price"));
        payload.put("fill_quantity", order.get("filled_quantity"));
        payload.put("commission", -0.5);
        payload.put("position_id", "pos_001");

        return buildApexNotification("notifications/apex.order.filled", Map.of(
            "account_id", order.getOrDefault("account_id", ACCOUNT_ID),
            "instrument_id", order.getOrDefault("instrument_id", INSTRUMENT_ID),
            "resource_uri", "apex://account/fills/" + order.getOrDefault("account_id", ACCOUNT_ID),
            "sequence", fillSequence,
            "payload", payload
        ));
    }

    static Map<String, Object> orderPartiallyFilledNotification(Map<String, Object> order, int fillSequence) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("order_id", order.get("order_id"));
        payload.put("side", order.get("side"));
        payload.put("fill_price", order.get("average_fill_price"));
        payload.put("fill_quantity", order.get("filled_quantity"));
        payload.put("remaining_quantity", order.get("remaining_quantity"));

        return buildApexNotification("notifications/apex.order.partially_filled", Map.of(
            "account_id", order.getOrDefault("account_id", ACCOUNT_ID),
            "instrument_id", order.getOrDefault("instrument_id", INSTRUMENT_ID),
            "resource_uri", "apex://account/fills/" + order.getOrDefault("account_id", ACCOUNT_ID),
            "sequence", fillSequence,
            "payload", payload
        ));
    }

    static Map<String, Object> orderRejectedNotification(String code, String reason, int riskSequence) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("code", code);
        payload.put("reason", reason);

        return buildApexNotification("notifications/apex.order.rejected", Map.of(
            "resource_uri", "apex://account/risk/" + ACCOUNT_ID,
            "sequence", riskSequence,
            "payload", payload
        ));
    }

    static Map<String, Object> candleClosedNotification(
        String instrumentId, String timeframe,
        double open, double high, double low, double close, int volume,
        int candleSequence
    ) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("instrument_id", instrumentId);
        payload.put("timeframe", timeframe);
        payload.put("open", open);
        payload.put("high", high);
        payload.put("low", low);
        payload.put("close", close);
        payload.put("volume", volume);
        payload.put("complete", true);

        return buildApexNotification("notifications/apex.market.candle_closed", Map.of(
            "instrument_id", instrumentId,
            "resource_uri", "apex://market/candles/" + instrumentId + "?timeframe=" + timeframe + "&limit=200",
            "sequence", candleSequence,
            "payload", payload
        ));
    }

    static Map<String, Object> killSwitchEngagedNotification(int riskSequence) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("account_id", ACCOUNT_ID);
        payload.put("reason", "Daily loss limit exceeded");

        return buildApexNotification("notifications/apex.risk.kill_switch_engaged", Map.of(
            "resource_uri", "apex://account/risk/" + ACCOUNT_ID,
            "sequence", riskSequence,
            "payload", payload
        ));
    }

    /* ------------------------------------------------------------------ */
    /*  Emit (send to SSE stream + store in replay buffer)                 */
    /* ------------------------------------------------------------------ */

    void emit(Map<String, Object> notification) {
        NotificationSink currentSink = sink;
        if (currentSink != null) {
            currentSink.send(notification);
        }
    }
}
