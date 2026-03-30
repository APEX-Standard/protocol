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
        this.schema = new SchemaBuilder(mapper);
        this.state = state;
        this.transportMode = transportMode != null ? transportMode : "stdio";
        this.dispatcher = dispatcher;
        this.replayBuffer = replayBuffer;
    }

    Map<String, ToolDefinition> createTools() {
        Map<String, ToolDefinition> tools = new LinkedHashMap<>();

        registerSessionTools(tools);
        registerAccountTools(tools);
        registerOrderTools(tools);
        registerPositionTools(tools);
        registerMarketTools(tools);
        registerRiskTools(tools);
        registerFxTools(tools);
        registerCfdTools(tools);
        registerCryptoTools(tools);

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

                // Fire authenticated callback (starts tick engine in HTTP mode)
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

        registerTool(
            tools,
            "apex.session.capabilities",
            "Query the full capability manifest of this broker implementation.",
            schema.objectSchema((props, req) -> {
            }),
            args -> {
                Object realtimeContract;
                if ("streamable_http".equals(transportMode)) {
                    realtimeContract = Map.ofEntries(
                        Map.entry("transport_mode", "streamable_http"),
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
                } else {
                    realtimeContract = Map.of(
                        "transport_mode", "stdio",
                        "reconnect_mode", "no_replay",
                        "quote_freshness_ms", 1000,
                        "account_freshness_ms", 2000
                    );
                }

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

        registerTool(
            tools,
            "apex.session.heartbeat",
            "Keep-alive ping. Hub marks session degraded if response exceeds 500ms.",
            schema.objectSchema((props, req) -> schema.stringProp(props, req, "timestamp", "ISO8601 timestamp", true)),
            args -> new HeartbeatResponse(now(), "ok")
        );

        registerTool(
            tools,
            "apex.session.acknowledge",
            "Acknowledge receipt of SSE events through a given event ID. Acknowledged events may be pruned from the replay buffer.",
            schema.objectSchema((props, req) -> schema.stringProp(props, req, "last_event_id", "The SSE event ID through which all events have been processed", true)),
            args -> {
                if (replayBuffer == null) {
                    return Map.of("acknowledged_through", "0", "buffer_depth", 0);
                }
                return replayBuffer.acknowledge(argStr(args, "last_event_id", "0"));
            }
        );

        registerTool(
            tools,
            "reference.test.set_realtime_state",
            "Reference-only fault injection for conformance and resilience testing.",
            schema.objectSchema((props, req) -> {
                schema.booleanProp(props, req, "quote_stale", false, false);
                schema.booleanProp(props, req, "risk_stale", false, false);
                schema.booleanProp(props, req, "force_sequence_gap", false, false);
                schema.booleanProp(props, req, "kill_switch_active", false, false);
                schema.booleanProp(props, req, "partial_fill_next_order", false, false);
            }),
            args -> {
                boolean wasKillSwitchActive = state.isKillSwitchActive();

                Map<String, Object> faults = state.setFaults(
                    argBool(args, "quote_stale"),
                    argBool(args, "risk_stale"),
                    argBool(args, "force_sequence_gap"),
                    argBool(args, "kill_switch_active"),
                    argBool(args, "partial_fill_next_order")
                );

                // Emit kill_switch_engaged notification when transitioning to active
                if (!wasKillSwitchActive && Boolean.TRUE.equals(argBool(args, "kill_switch_active")) && dispatcher != null) {
                    int riskSeq = state.getSequence(ReferenceTradingState.RISK_URI);
                    dispatcher.emit(NotificationDispatcher.killSwitchEngagedNotification(riskSeq));
                }

                return Map.of("ok", true, "faults", faults);
            }
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
            args -> {
                String accountId = argStr(args, "account_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                return state.accountSummary(argStr(args, "currency", "USD"));
            }
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
            args -> state.positionsResponse()
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
            args -> state.ordersResponse()
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
                    schema.objectProp(orderProps, orderReq, "stop_loss", "Stop loss protection", false, (slProps, slReq) -> {
                        schema.enumProp(slProps, slReq, "type", null, true, null, "price", "pips", "percent");
                        schema.numberProp(slProps, slReq, "value", null, true);
                    });
                    schema.objectProp(orderProps, orderReq, "take_profit", "Take profit protection", false, (tpProps, tpReq) -> {
                        schema.enumProp(tpProps, tpReq, "type", null, true, null, "price", "pips", "percent");
                        schema.numberProp(tpProps, tpReq, "value", null, true);
                    });
                    schema.objectProp(orderProps, orderReq, "trailing_stop", "Trailing stop protection", false, (tsProps, tsReq) -> {
                        schema.enumProp(tsProps, tsReq, "type", null, true, null, "pips", "percent");
                        schema.numberProp(tsProps, tsReq, "value", null, true);
                    });
                    schema.objectProp(orderProps, orderReq, "profile_data", "Profile-specific fields", false, (pdProps, pdReq) -> {});
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

                Map<String, Object> acceptance = state.orderAcceptance();
                if (!Boolean.TRUE.equals(acceptance.get("ok"))) {
                    // Emit order rejected notification in HTTP mode
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
                if (result instanceof ProtocolModels.ApexErrorEnvelope) {
                    return result;
                }

                // Emit order filled/partially filled notification in HTTP mode
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
                    schema.objectProp(modProps, modReq, "stop_loss", "Stop loss protection", false, (slProps, slReq) -> {
                        schema.enumProp(slProps, slReq, "type", null, true, null, "price", "pips", "percent");
                        schema.numberProp(slProps, slReq, "value", null, true);
                    });
                    schema.objectProp(modProps, modReq, "take_profit", "Take profit protection", false, (tpProps, tpReq) -> {
                        schema.enumProp(tpProps, tpReq, "type", null, true, null, "price", "pips", "percent");
                        schema.numberProp(tpProps, tpReq, "value", null, true);
                    });
                    schema.objectProp(modProps, modReq, "trailing_stop", "Trailing stop protection", false, (tsProps, tsReq) -> {
                        schema.enumProp(tsProps, tsReq, "type", null, true, null, "pips", "percent");
                        schema.numberProp(tsProps, tsReq, "value", null, true);
                    });
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

                state.modifyOrder(argStr(args, "target_id", ""));
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
            args -> {
                String orderId = argStr(args, "order_id", "");
                state.cancelOrder(orderId);
                return new OrderCancelResponse(orderId, "cancelled", null, now());
            }
        );

        registerTool(
            tools,
            "apex.order.status",
            "Query the current state of a single order.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.stringProp(props, req, "order_id", null, true);
            }),
            args -> {
                Object result = state.orderStatus(argStr(args, "order_id", ""));
                if (result == null) {
                    return apexError("APEX_4011", "validation", "Unknown order");
                }
                return result;
            }
        );
    }

    private void registerPositionTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.position.close",
            "Close an open position fully or partially. Executes as an opposite-direction market order.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", null, true);
                schema.stringProp(props, req, "position_id", null, true);
                schema.numberProp(props, req, "quantity", "Quantity to close. Omit for full close.", false);
            }),
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
                if (result == null) {
                    return apexError("APEX_4011", "validation", "Position not found: " + positionId);
                }

                // Emit order filled notification in HTTP mode
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

    private void registerMarketTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.market.quote",
            "Current bid/ask/mid for an instrument.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", false);
                schema.stringProp(props, req, "broker_symbol", "Alternative to instrument_id", false);
            }),
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
                List<SearchInstrument> instruments = !query.isEmpty() && "EURUSD".contains(query)
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
                );
            }
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
                Boolean.TRUE.equals(((Map<?, ?>) state.readResource(ReferenceTradingState.RISK_URI)).get("kill_switch_active"))
            )
        );
    }

    private void registerFxTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.fx.rollover",
            "Query swap/rollover rates for an FX instrument. Rates are expressed in account currency per lot per night.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:FX:EURUSD)", true);
                schema.stringProp(props, req, "as_of", "ISO8601 timestamp — defaults to now", false);
            }),
            args -> {
                String instrumentId = argStr(args, "instrument_id", "");
                if (!ReferenceTradingState.INSTRUMENT_ID.equals(instrumentId)) {
                    return apexError("APEX_4010", "validation", "Unknown instrument");
                }

                return new FxRolloverResponse(
                    ReferenceTradingState.INSTRUMENT_ID,
                    ReferenceTradingState.BROKER_SYMBOL,
                    -0.5,
                    0.3,
                    "USD",
                    "lot",
                    100000,
                    "Wednesday",
                    nextRolloverTime(),
                    now()
                );
            }
        );

        registerTool(
            tools,
            "apex.fx.exposure",
            "Net currency exposure across open FX positions. Critical for agents managing portfolio-level currency risk.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", "Trading account ID", true);
                schema.stringProp(props, req, "base_currency", "Denominate all exposures in this currency", true);
            }),
            args -> {
                String accountId = argStr(args, "account_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                String baseCurrency = argStr(args, "base_currency", "USD");

                // Compute EUR exposure from current positions
                var positionsResponse = state.positionsResponse();
                var positions = positionsResponse.positions();

                long eurNetUnits = 0;
                List<String> contributingPositions = new java.util.ArrayList<>();

                for (var pos : positions) {
                    if (ReferenceTradingState.INSTRUMENT_ID.equals(pos.instrument_id())) {
                        int qty = pos.quantity();
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
                        eurNetUnits,
                        netDirection,
                        valueInBase,
                        List.copyOf(contributingPositions)
                    )),
                    Math.abs(valueInBase),
                    now()
                );
            }
        );

        registerTool(
            tools,
            "apex.fx.conversion",
            "Real-time cross-currency conversion rate. Used by agents to calculate P&L in a target currency.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "from_currency", "Source currency code (e.g. EUR)", true);
                schema.stringProp(props, req, "to_currency", "Target currency code (e.g. USD)", true);
                schema.numberProp(props, req, "amount", "Amount to convert", true);
            }),
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
                    Math.round(rate * 10000000.0) / 10000000.0,
                    Math.round(amount * rate * 100.0) / 100.0,
                    now()
                );
            }
        );
    }

    private void registerCfdTools(Map<String, ToolDefinition> tools) {
        registerTool(
            tools,
            "apex.cfd.corporate_actions",
            "Query upcoming corporate actions for CFD instruments. Reference implementation returns an empty array.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", "Trading account ID", true);
                schema.stringProp(props, req, "instrument_id", "Filter by APEX canonical instrument ID", false);
                schema.stringProp(props, req, "from", "ISO8601 start date", false);
                schema.stringProp(props, req, "to", "ISO8601 end date", false);
            }),
            args -> {
                String accountId = argStr(args, "account_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                return new CfdCorporateActionsResponse(List.of());
            }
        );

        registerTool(
            tools,
            "apex.cfd.dividend_adjustment",
            "Query dividend adjustments for CFD positions. Reference implementation returns an empty array.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", "Trading account ID", true);
                schema.stringProp(props, req, "status", "Filter by status (default: all)", false);
                schema.stringProp(props, req, "from", "ISO8601 start date", false);
                schema.stringProp(props, req, "to", "ISO8601 end date", false);
            }),
            args -> {
                String accountId = argStr(args, "account_id", "");
                if (accountId.isEmpty()) {
                    return apexError("APEX_4011", "validation", "account_id is required");
                }
                return new CfdDividendAdjustmentResponse(List.of());
            }
        );
    }

    private void registerCryptoTools(Map<String, ToolDefinition> tools) {
        final String PERP_INSTRUMENT_ID = "APEX:CRYPTO:PERP:BTCUSDT";
        final String PERP_BROKER_SYMBOL = "BTCUSDT";

        registerTool(
            tools,
            "apex.crypto.funding_rate",
            "Query funding rate for a perpetual instrument. Returns simulated data for BTCUSDT.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)", true);
            }),
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
                    0.0001,
                    0.1095,
                    0.00012,
                    8,
                    fundingTimeStr,
                    countdown,
                    50000.00,
                    50050.00,
                    now()
                );
            }
        );

        registerTool(
            tools,
            "apex.crypto.liquidation_estimate",
            "Estimate liquidation price for a perpetual position based on leverage and margin mode.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", "Trading account ID", true);
                schema.stringProp(props, req, "instrument_id", "APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)", true);
                schema.stringProp(props, req, "side", "Position side: buy or sell", true);
                schema.numberProp(props, req, "quantity", "Position quantity", true);
                schema.numberProp(props, req, "leverage", "Leverage multiplier", true);
                schema.stringProp(props, req, "margin_mode", "Margin mode: cross or isolated", true);
                schema.numberProp(props, req, "entry_price", "Entry price", true);
            }),
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
                    entryPrice,
                    liquidationPrice,
                    Math.round(marginRequired * 100.0) / 100.0,
                    Math.round(maintenanceMargin * 100.0) / 100.0,
                    "USDT",
                    distancePct,
                    List.of()
                );
            }
        );

        registerTool(
            tools,
            "apex.crypto.transfer",
            "Transfer funds between wallets (spot, futures, funding). Reference implementation simulates instant completion.",
            schema.objectSchema((props, req) -> {
                schema.stringProp(props, req, "account_id", "Trading account ID", true);
                schema.enumProp(props, req, "from_wallet", "Source wallet", true, null, "spot", "futures", "funding");
                schema.enumProp(props, req, "to_wallet", "Destination wallet", true, null, "spot", "futures", "funding");
                schema.stringProp(props, req, "currency", "Currency to transfer (e.g. USDT)", true);
                schema.numberProp(props, req, "amount", "Amount to transfer", true);
            }),
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
                    amount,
                    "completed",
                    null,
                    now()
                );
            }
        );
    }

    /**
     * Compute the next 8-hour funding boundary (00:00, 08:00, 16:00 UTC).
     * Returns [epochMillis, countdownSeconds].
     */
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
            || name.startsWith("apex.fx.")
            || name.startsWith("apex.cfd.")
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

        annotations.put("readOnlyHint", readOnly);
        annotations.put("destructiveHint", destructive);
        annotations.put("idempotentHint", idempotent);
        return annotations;
    }

    private static List<String> coreTools() {
        return List.of("apex.session.*", "apex.account.*", "apex.order.*", "apex.position.*", "apex.market.*", "apex.risk.*");
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
