package org.apexstandard.reference;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Market data simulation engine.
 * Runs a 2-second fixed-rate tick that performs a random walk on mid price,
 * aggregates candles, and detects wall-clock candle close boundaries.
 */
final class TickEngine {

    private static final double HALF_SPREAD = 0.0001;
    private static final double MAX_PIP_STEP = 0.0002;
    private static final int TICK_INTERVAL_MS = 2000;

    @FunctionalInterface
    interface QuoteCallback {
        void onQuoteUpdate(double mid, double bid, double ask);
    }

    @FunctionalInterface
    interface CandleCloseCallback {
        void onCandleClose(String timeframe, CandleState candle);
    }

    @FunctionalInterface
    interface CandleUpdateCallback {
        void onCandleUpdate(String timeframe);
    }

    @FunctionalInterface
    interface FeatureUpdateCallback {
        void onFeatureUpdate();
    }

    static class CandleState {
        double open;
        double high;
        double low;
        double close;
        int volume;
        String openTime;
        boolean complete;

        CandleState(double price) {
            this.open = price;
            this.high = price;
            this.low = price;
            this.close = price;
            this.volume = 0;
            this.openTime = Instant.now().toString();
            this.complete = false;
        }

        CandleState copy() {
            CandleState copy = new CandleState(open);
            copy.high = high;
            copy.low = low;
            copy.close = close;
            copy.volume = volume;
            copy.openTime = openTime;
            copy.complete = complete;
            return copy;
        }
    }

    private double mid = 1.0875;
    private final Map<String, CandleState> candles = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "tick-engine");
        t.setDaemon(true);
        return t;
    });
    private ScheduledFuture<?> tickFuture;

    private QuoteCallback quoteCallback;
    private CandleCloseCallback candleCloseCallback;
    private CandleUpdateCallback candleUpdateCallback;
    private FeatureUpdateCallback featureUpdateCallback;

    TickEngine() {
        for (String tf : new String[]{"M1", "M5", "H1"}) {
            candles.put(tf, new CandleState(mid));
        }
    }

    void setQuoteCallback(QuoteCallback cb) {
        this.quoteCallback = cb;
    }

    void setCandleCloseCallback(CandleCloseCallback cb) {
        this.candleCloseCallback = cb;
    }

    void setCandleUpdateCallback(CandleUpdateCallback cb) {
        this.candleUpdateCallback = cb;
    }

    void setFeatureUpdateCallback(FeatureUpdateCallback cb) {
        this.featureUpdateCallback = cb;
    }

    synchronized void start() {
        if (tickFuture != null) return;
        tickFuture = scheduler.scheduleAtFixedRate(this::tick, 0, TICK_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    synchronized void stop() {
        if (tickFuture != null) {
            tickFuture.cancel(false);
            tickFuture = null;
        }
    }

    void shutdown() {
        stop();
        scheduler.shutdownNow();
    }

    void forceCandleClose(String timeframe) {
        CandleState candle = candles.get(timeframe);
        if (candle == null) return;
        synchronized (candle) {
            candle.complete = true;
            CandleState snapshot = candle.copy();
            if (candleCloseCallback != null) {
                candleCloseCallback.onCandleClose(timeframe, snapshot);
            }
        }
        candles.put(timeframe, new CandleState(mid));
    }

    double getMid() {
        return mid;
    }

    private static double roundTo5(double value) {
        return Math.round(value * 100_000.0) / 100_000.0;
    }

    private void tick() {
        try {
            // Random walk
            double delta = (Math.random() - 0.5) * 2 * MAX_PIP_STEP;
            mid = roundTo5(mid + delta);

            double bid = roundTo5(mid - HALF_SPREAD);
            double ask = roundTo5(mid + HALF_SPREAD);

            // Update all candle states
            for (String tf : new String[]{"M1", "M5", "H1"}) {
                CandleState candle = candles.get(tf);
                if (candle != null) {
                    synchronized (candle) {
                        candle.high = Math.max(candle.high, mid);
                        candle.low = Math.min(candle.low, mid);
                        candle.close = mid;
                        candle.volume += 1;
                    }
                }
            }

            // Check wall-clock boundaries for candle closes
            java.time.ZonedDateTime now = java.time.ZonedDateTime.now(java.time.ZoneOffset.UTC);
            int seconds = now.getSecond();
            int minutes = now.getMinute();

            if (seconds < 2) {
                CandleState m1 = candles.get("M1");
                if (m1 != null && m1.volume > 0) {
                    forceCandleClose("M1");
                }
                if (minutes % 5 == 0) {
                    CandleState m5 = candles.get("M5");
                    if (m5 != null && m5.volume > 0) {
                        forceCandleClose("M5");
                    }
                }
                if (minutes == 0) {
                    CandleState h1 = candles.get("H1");
                    if (h1 != null && h1.volume > 0) {
                        forceCandleClose("H1");
                    }
                }
            }

            // Fire callbacks
            if (quoteCallback != null) {
                quoteCallback.onQuoteUpdate(mid, bid, ask);
            }
            if (candleUpdateCallback != null) {
                candleUpdateCallback.onCandleUpdate("M1");
            }
            if (featureUpdateCallback != null) {
                featureUpdateCallback.onFeatureUpdate();
            }
        } catch (Exception e) {
            System.err.println("Tick engine error: " + e.getMessage());
        }
    }
}
