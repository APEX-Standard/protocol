package org.apexstandard.reference;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.LinkedHashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

public final class Server {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private Server() {
    }

    /* ================================================================== */
    /*  Stdio mode (original)                                              */
    /* ================================================================== */

    private static final ReferenceTradingState STDIO_STATE = new ReferenceTradingState();
    private static final Map<String, ToolDefinition> STDIO_TOOLS = new ToolRegistry(MAPPER, STDIO_STATE, "stdio", null).createTools();
    private static final Set<String> SUBSCRIPTIONS = new LinkedHashSet<>();

    @SuppressWarnings("unchecked")
    private static ObjectNode handleRequest(JsonNode request) throws IOException {
        JsonNode idNode = request.get("id");
        if (idNode == null || idNode.isNull()) {
            return null;
        }

        ObjectNode response = MAPPER.createObjectNode();
        response.put("jsonrpc", "2.0");
        if (idNode.isIntegralNumber()) {
            response.put("id", idNode.asLong());
        } else {
            response.put("id", idNode.asText());
        }

        String method = request.path("method").asText("");
        JsonNode params = request.get("params");

        switch (method) {
            case "initialize" -> response.set("result", initializeResult());
            case "tools/list" -> response.set("result", listToolsResult());
            case "tools/call" -> handleToolCall(response, params);
            case "resources/list" -> response.set("result", listResourcesResult());
            case "resources/read" -> handleResourceRead(response, params);
            case "resources/subscribe" -> handleSubscribe(response, params);
            case "resources/unsubscribe" -> handleUnsubscribe(response, params);
            default -> response.set("error", jsonRpcError(-32601, "Method not found: " + method));
        }

        return response;
    }

    private static ObjectNode initializeResult() {
        ObjectNode result = MAPPER.createObjectNode();
        result.put("protocolVersion", "2024-11-05");
        ObjectNode capabilities = result.putObject("capabilities");
        capabilities.putObject("tools").put("listChanged", false);
        capabilities.putObject("resources").put("subscribe", true).put("listChanged", true);
        result.putObject("serverInfo")
            .put("name", ToolRegistry.SERVER_NAME)
            .put("version", ToolRegistry.SERVER_VERSION);
        return result;
    }

    private static ObjectNode listToolsResult() {
        ObjectNode result = MAPPER.createObjectNode();
        ArrayNode toolsArray = result.putArray("tools");

        for (ToolDefinition tool : STDIO_TOOLS.values()) {
            ObjectNode toolNode = toolsArray.addObject();
            toolNode.put("name", tool.name());
            toolNode.put("description", tool.description());
            toolNode.set("inputSchema", tool.inputSchema());
            toolNode.set("annotations", tool.annotations());
        }

        return result;
    }

    private static ObjectNode listResourcesResult() {
        ObjectNode result = MAPPER.createObjectNode();
        ArrayNode resources = result.putArray("resources");
        for (Map<String, Object> resource : STDIO_STATE.resources()) {
            ObjectNode node = resources.addObject();
            node.put("name", String.valueOf(resource.get("name")));
            node.put("uri", String.valueOf(resource.get("uri")));
            node.put("description", String.valueOf(resource.get("description")));
            node.put("mimeType", String.valueOf(resource.get("mimeType")));
        }
        return result;
    }

    private static void handleToolCall(ObjectNode response, JsonNode params) throws IOException {
        String toolName = params != null ? params.path("name").asText("") : "";
        ToolDefinition tool = STDIO_TOOLS.get(toolName);
        if (tool == null) {
            response.set("error", jsonRpcError(-32601, "Unknown tool: " + toolName));
            return;
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> arguments = params != null && params.has("arguments")
            ? MAPPER.convertValue(params.get("arguments"), LinkedHashMap.class)
            : Map.of();

        Object payload;
        try {
            payload = tool.handler().apply(arguments);
        } catch (Exception e) {
            payload = ToolRegistry.apexError("APEX_5000", "internal", e.getMessage() != null ? e.getMessage() : "Internal error");
        }
        boolean isError = payload instanceof ProtocolModels.ApexErrorEnvelope;
        ObjectNode result = MAPPER.createObjectNode();
        result.put("isError", isError);
        ArrayNode content = result.putArray("content");
        content.addObject()
            .put("type", "text")
            .put("text", MAPPER.writeValueAsString(payload));
        response.set("result", result);
    }

    private static void handleResourceRead(ObjectNode response, JsonNode params) throws IOException {
        String uri = params != null ? params.path("uri").asText("") : "";
        Object payload = STDIO_STATE.readResource(uri);
        if (payload == null) {
            response.set("error", jsonRpcError(-32002, "Unknown resource: " + uri));
            return;
        }

        ObjectNode result = MAPPER.createObjectNode();
        ArrayNode contents = result.putArray("contents");
        contents.addObject()
            .put("uri", uri)
            .put("mimeType", "application/json")
            .put("text", MAPPER.writeValueAsString(payload));
        response.set("result", result);
    }

    private static void handleSubscribe(ObjectNode response, JsonNode params) {
        String uri = params != null ? params.path("uri").asText("") : "";
        if (!uri.isBlank()) {
            SUBSCRIPTIONS.add(uri);
        }
        response.set("result", MAPPER.createObjectNode());
    }

    private static void handleUnsubscribe(ObjectNode response, JsonNode params) {
        String uri = params != null ? params.path("uri").asText("") : "";
        SUBSCRIPTIONS.remove(uri);
        response.set("result", MAPPER.createObjectNode());
    }

    private static ObjectNode jsonRpcError(int code, String message) {
        ObjectNode error = MAPPER.createObjectNode();
        error.put("code", code);
        error.put("message", message);
        return error;
    }

    private static void runStdio() throws IOException {
        System.err.println("APEX Protocol Reference Server v" + ToolRegistry.SERVER_VERSION + " (Java 21) running");

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }

                try {
                    JsonNode request = MAPPER.readTree(line);
                    ObjectNode response = handleRequest(request);
                    if (response != null) {
                        System.out.println(MAPPER.writeValueAsString(response));
                        System.out.flush();
                        if ("tools/call".equals(request.path("method").asText())) {
                            flushNotifications();
                        }
                    }
                } catch (Exception error) {
                    ObjectNode parseError = MAPPER.createObjectNode();
                    parseError.put("jsonrpc", "2.0");
                    parseError.putNull("id");
                    parseError.set("error", jsonRpcError(-32700, "Parse error: " + error.getMessage()));
                    System.out.println(MAPPER.writeValueAsString(parseError));
                    System.out.flush();
                }
            }
        }
    }

    private static void flushNotifications() throws IOException {
        for (String uri : STDIO_STATE.drainPendingUpdates()) {
            if (!SUBSCRIPTIONS.contains(uri)) {
                continue;
            }

            ObjectNode notification = MAPPER.createObjectNode();
            notification.put("jsonrpc", "2.0");
            notification.put("method", "notifications/resources/updated");
            notification.putObject("params").put("uri", uri);
            System.out.println(MAPPER.writeValueAsString(notification));
            System.out.flush();
        }
    }

    /* ================================================================== */
    /*  HTTP/SSE mode                                                      */
    /* ================================================================== */

    private static void runHttp(int port) throws IOException {
        ReferenceTradingState httpState = new ReferenceTradingState();
        NotificationDispatcher dispatcher = new NotificationDispatcher();

        Map<String, ToolDefinition> httpTools = new ToolRegistry(MAPPER, httpState, "streamable_http", dispatcher).createTools();

        HttpTransport transport = new HttpTransport(MAPPER, port, httpState, httpTools, dispatcher);

        // Set up tick engine
        TickEngine tickEngine = new TickEngine();
        transport.setTickEngine(tickEngine);

        // Configure tick engine callbacks
        tickEngine.setQuoteCallback((mid, bid, ask) -> {
            httpState.updateQuote(mid, bid, ask);
            httpState.bumpResourcesNoTrack(ReferenceTradingState.QUOTE_URI, ReferenceTradingState.FEATURES_URI);
            transport.emitResourceUpdatedToAll(ReferenceTradingState.QUOTE_URI);
            transport.emitResourceUpdatedToAll(ReferenceTradingState.FEATURES_URI);
        });

        tickEngine.setCandleCloseCallback((timeframe, candle) -> {
            String candleUri = switch (timeframe) {
                case "M1" -> ReferenceTradingState.CANDLES_M1_URI;
                case "M5" -> ReferenceTradingState.CANDLES_M5_URI;
                default -> ReferenceTradingState.CANDLES_H1_URI;
            };
            httpState.bumpResourcesNoTrack(candleUri);
            int seq = httpState.getSequence(candleUri);

            Map<String, Object> candleNotif = NotificationDispatcher.candleClosedNotification(
                ReferenceTradingState.INSTRUMENT_ID, timeframe,
                candle.open, candle.high, candle.low, candle.close, candle.volume,
                seq
            );
            transport.emitToAllSessions(candleNotif);
            transport.emitResourceUpdatedToAll(candleUri);
        });

        tickEngine.setCandleUpdateCallback(timeframe -> {
            String candleUri = switch (timeframe) {
                case "M1" -> ReferenceTradingState.CANDLES_M1_URI;
                case "M5" -> ReferenceTradingState.CANDLES_M5_URI;
                default -> ReferenceTradingState.CANDLES_H1_URI;
            };
            transport.emitResourceUpdatedToAll(candleUri);
        });

        tickEngine.setFeatureUpdateCallback(() ->
            transport.emitResourceUpdatedToAll(ReferenceTradingState.FEATURES_URI));

        // Set up notification dispatcher to emit APEX notifications via SSE
        dispatcher.setSink(notification -> transport.emitToAllSessions(notification));

        // Register force_candle_close tool
        httpTools.put("reference.test.force_candle_close", new ToolDefinition(
            "reference.test.force_candle_close",
            "Force-close the current partial candle for a given timeframe. Test-only.",
            new SchemaBuilder(MAPPER).objectSchema((props, req) ->
                new SchemaBuilder(MAPPER).enumProp(props, req, "timeframe", null, true, null, "M1", "M5", "H1")),
            MAPPER.createObjectNode()
                .put("readOnlyHint", false)
                .put("destructiveHint", false)
                .put("idempotentHint", false),
            args -> {
                String timeframe = ToolRegistry.argStr(args, "timeframe", "M1");
                tickEngine.forceCandleClose(timeframe);
                return Map.of("closed", true, "timeframe", timeframe);
            }
        ));

        // Set the tick engine start callback — the ToolRegistry will call it after auth
        httpState.setOnAuthenticated(() -> {
            tickEngine.start();
            System.err.println("Tick engine started after authentication");
        });

        transport.start();

        // Keep main thread alive
        try {
            Thread.currentThread().join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            tickEngine.shutdown();
            transport.stop();
        }
    }

    /* ================================================================== */
    /*  Entry point                                                        */
    /* ================================================================== */

    public static void main(String[] args) throws IOException {
        int httpIdx = -1;
        for (int i = 0; i < args.length; i++) {
            if ("--http".equals(args[i])) {
                httpIdx = i;
                break;
            }
        }

        if (httpIdx >= 0 && httpIdx + 1 < args.length) {
            int port;
            try {
                port = Integer.parseInt(args[httpIdx + 1]);
            } catch (NumberFormatException e) {
                System.err.println("Usage: java -jar apex-reference-java-0.1.0.jar --http <port>");
                System.exit(1);
                return;
            }
            runHttp(port);
        } else {
            runStdio();
        }
    }
}
