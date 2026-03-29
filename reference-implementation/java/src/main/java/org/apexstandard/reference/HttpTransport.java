package org.apexstandard.reference;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

/**
 * HTTP/SSE transport for the APEX Protocol reference server.
 * Uses JDK's built-in HttpServer to handle POST (JSON-RPC), GET (SSE streaming),
 * and DELETE (session cleanup) on /mcp.
 */
final class HttpTransport {

    private final ObjectMapper mapper;
    private final int port;
    private final ReferenceTradingState state;
    private final Map<String, ToolDefinition> tools;
    private final ReplayBuffer replayBuffer;
    private final ConcurrentHashMap<String, SessionState> sessions = new ConcurrentHashMap<>();
    private final NotificationDispatcher dispatcher;
    private TickEngine tickEngine;
    private HttpServer httpServer;

    static class SessionState {
        final String sessionId;
        final Set<String> subscriptions = new LinkedHashSet<>();
        volatile OutputStream sseStream;
        volatile boolean sseConnected;
        final Object sseLock = new Object();

        SessionState(String sessionId) {
            this.sessionId = sessionId;
        }
    }

    HttpTransport(ObjectMapper mapper, int port, ReferenceTradingState state,
                  Map<String, ToolDefinition> tools, NotificationDispatcher dispatcher,
                  ReplayBuffer replayBuffer) {
        this.mapper = mapper;
        this.port = port;
        this.state = state;
        this.tools = tools;
        this.dispatcher = dispatcher;
        this.replayBuffer = replayBuffer;
    }

    void setTickEngine(TickEngine tickEngine) {
        this.tickEngine = tickEngine;
    }

    void start() throws IOException {
        httpServer = HttpServer.create(new InetSocketAddress(port), 0);
        httpServer.setExecutor(Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "http-worker");
            t.setDaemon(true);
            return t;
        }));

        httpServer.createContext("/mcp", exchange -> {
            try {
                String method = exchange.getRequestMethod();
                switch (method) {
                    case "POST" -> handlePost(exchange);
                    case "GET" -> handleGet(exchange);
                    case "DELETE" -> handleDelete(exchange);
                    default -> {
                        exchange.sendResponseHeaders(405, -1);
                        exchange.close();
                    }
                }
            } catch (Exception e) {
                System.err.println("HTTP handler error: " + e.getMessage());
                try {
                    if (!exchange.getResponseHeaders().isEmpty()) {
                        // Headers already sent, just close
                        exchange.close();
                    } else {
                        exchange.sendResponseHeaders(500, -1);
                        exchange.close();
                    }
                } catch (Exception ignored) {
                }
            }
        });

        httpServer.start();
        System.err.println("APEX Protocol Reference Server v" + ToolRegistry.SERVER_VERSION
            + " (Java 21) listening on http://localhost:" + port + "/mcp");
    }

    void stop() {
        if (httpServer != null) {
            httpServer.stop(0);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  POST handler — JSON-RPC dispatch                                   */
    /* ------------------------------------------------------------------ */

    @SuppressWarnings("unchecked")
    private void handlePost(HttpExchange exchange) throws IOException {
        // Read body
        String body;
        try (InputStream is = exchange.getRequestBody()) {
            body = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }

        if (body.isBlank()) {
            // Notification with no body (e.g., notifications/initialized)
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
            return;
        }

        JsonNode request;
        try {
            request = mapper.readTree(body);
        } catch (Exception e) {
            sendJsonResponse(exchange, 400, jsonRpcError(null, -32700, "Parse error: " + e.getMessage()));
            return;
        }

        String rpcMethod = request.path("method").asText("");
        JsonNode idNode = request.get("id");
        JsonNode params = request.get("params");

        // Handle notifications (no id) — e.g., notifications/initialized
        if (idNode == null || idNode.isNull()) {
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
            return;
        }

        // For initialize, no session check — this creates the session
        if ("initialize".equals(rpcMethod)) {
            handleInitialize(exchange, request);
            return;
        }

        // Validate session
        String sessionId = exchange.getRequestHeaders().getFirst("Mcp-Session-Id");
        if (sessionId == null) {
            sendJsonResponse(exchange, 400, jsonRpcError(idNode, -32001, "Missing Mcp-Session-Id header"));
            return;
        }
        if (!sessions.containsKey(sessionId)) {
            sendJsonResponse(exchange, 404, jsonRpcError(idNode, -32001, "Unknown session"));
            return;
        }

        SessionState session = sessions.get(sessionId);

        // Dispatch
        ObjectNode response = mapper.createObjectNode();
        response.put("jsonrpc", "2.0");
        if (idNode.isIntegralNumber()) {
            response.put("id", idNode.asLong());
        } else {
            response.put("id", idNode.asText());
        }

        switch (rpcMethod) {
            case "tools/list" -> response.set("result", listToolsResult());
            case "tools/call" -> {
                handleToolCall(response, params, session);
            }
            case "resources/list" -> response.set("result", listResourcesResult());
            case "resources/read" -> handleResourceRead(response, params);
            case "resources/subscribe" -> handleSubscribe(response, params, session);
            case "resources/unsubscribe" -> handleUnsubscribe(response, params, session);
            default -> response.set("error", jsonRpcErrorNode(-32601, "Method not found: " + rpcMethod));
        }

        sendJsonResponse(exchange, 200, response);
    }

    private void handleInitialize(HttpExchange exchange, JsonNode request) throws IOException {
        String sessionId = UUID.randomUUID().toString();
        SessionState session = new SessionState(sessionId);
        sessions.put(sessionId, session);

        ObjectNode response = mapper.createObjectNode();
        response.put("jsonrpc", "2.0");
        JsonNode idNode = request.get("id");
        if (idNode != null) {
            if (idNode.isIntegralNumber()) {
                response.put("id", idNode.asLong());
            } else {
                response.put("id", idNode.asText());
            }
        }

        ObjectNode result = mapper.createObjectNode();
        result.put("protocolVersion", "2024-11-05");
        ObjectNode capabilities = result.putObject("capabilities");
        capabilities.putObject("tools").put("listChanged", false);
        capabilities.putObject("resources").put("subscribe", true).put("listChanged", true);
        result.putObject("serverInfo")
            .put("name", ToolRegistry.SERVER_NAME)
            .put("version", ToolRegistry.SERVER_VERSION);
        response.set("result", result);

        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Mcp-Session-Id", sessionId);
        byte[] responseBytes = mapper.writeValueAsBytes(response);
        exchange.sendResponseHeaders(200, responseBytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(responseBytes);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  GET handler — SSE streaming                                        */
    /* ------------------------------------------------------------------ */

    private void handleGet(HttpExchange exchange) throws IOException {
        String sessionId = exchange.getRequestHeaders().getFirst("Mcp-Session-Id");
        if (sessionId == null) {
            exchange.sendResponseHeaders(400, -1);
            exchange.close();
            return;
        }
        if (!sessions.containsKey(sessionId)) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        SessionState session = sessions.get(sessionId);

        // Set SSE headers before sending response headers
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        exchange.getResponseHeaders().set("Connection", "keep-alive");
        exchange.sendResponseHeaders(200, 0); // chunked

        OutputStream os = exchange.getResponseBody();

        // Close any existing SSE stream for this session
        synchronized (session.sseLock) {
            if (session.sseStream != null) {
                try {
                    session.sseStream.close();
                } catch (Exception ignored) {
                }
            }
            session.sseStream = os;
            session.sseConnected = true;
        }

        // Handle replay (Last-Event-ID)
        String lastEventId = exchange.getRequestHeaders().getFirst("Last-Event-ID");
        if (lastEventId != null && !lastEventId.isBlank()) {
            ReplayBuffer.ReplayResult result = replayBuffer.replayAfter(lastEventId);
            if (!result.success()) {
                // Send replay_failed notification with simple params format
                // (reason directly in params, not wrapped in APEX envelope)
                Map<String, Object> replayParams = new LinkedHashMap<>();
                replayParams.put("reason", result.reason());
                replayParams.put("requested_event_id", lastEventId);
                if (result.lastAvailableId() != null) {
                    replayParams.put("last_available_id", String.valueOf(result.lastAvailableId()));
                }
                Map<String, Object> replayFailed = new LinkedHashMap<>();
                replayFailed.put("jsonrpc", "2.0");
                replayFailed.put("method", "notifications/apex.session.replay_failed");
                replayFailed.put("params", replayParams);
                writeSseEvent(session, replayFailed);
            } else {
                // Replay events (with gap_fill classification)
                for (ReplayBuffer.ReplayItem item : result.items()) {
                    writeSseEventWithId(session, item.id(), item.message());
                }
            }
        }

        // Keep the connection open — events are written by emitToSession
        // The thread just blocks until the client disconnects
        try {
            // Block until connection is closed
            while (session.sseConnected && session.sseStream == os) {
                Thread.sleep(500);
            }
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } finally {
            synchronized (session.sseLock) {
                if (session.sseStream == os) {
                    session.sseConnected = false;
                    session.sseStream = null;
                }
            }
            try {
                os.close();
            } catch (Exception ignored) {
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /*  DELETE handler — session cleanup                                    */
    /* ------------------------------------------------------------------ */

    private void handleDelete(HttpExchange exchange) throws IOException {
        String sessionId = exchange.getRequestHeaders().getFirst("Mcp-Session-Id");
        if (sessionId == null) {
            exchange.sendResponseHeaders(400, -1);
            exchange.close();
            return;
        }

        SessionState session = sessions.remove(sessionId);
        if (session == null) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        synchronized (session.sseLock) {
            session.sseConnected = false;
            if (session.sseStream != null) {
                try {
                    session.sseStream.close();
                } catch (Exception ignored) {
                }
            }
        }

        if (tickEngine != null) {
            tickEngine.stop();
        }
        exchange.sendResponseHeaders(200, -1);
        exchange.close();
    }

    /* ------------------------------------------------------------------ */
    /*  SSE event writing                                                   */
    /* ------------------------------------------------------------------ */

    void emitToAllSessions(Map<String, Object> notification) {
        // Store in replay buffer
        String eventId = replayBuffer.store("default", notification);

        for (SessionState session : sessions.values()) {
            int id = Integer.parseInt(eventId);
            writeSseEventWithId(session, id, notification);
        }
    }

    private void writeSseEvent(SessionState session, Object data) {
        // Store and get new ID
        String eventId = replayBuffer.store("default", data);
        int id = Integer.parseInt(eventId);
        writeSseEventWithId(session, id, data);
    }

    private void writeSseEventWithId(SessionState session, int id, Object data) {
        synchronized (session.sseLock) {
            if (!session.sseConnected || session.sseStream == null) {
                return;
            }
            try {
                String json = mapper.writeValueAsString(data);
                String sseFrame = "id: " + id + "\nevent: message\ndata: " + json + "\n\n";
                session.sseStream.write(sseFrame.getBytes(StandardCharsets.UTF_8));
                session.sseStream.flush();
            } catch (IOException e) {
                // Client disconnected
                session.sseConnected = false;
                session.sseStream = null;
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Resource notifications via SSE                                      */
    /* ------------------------------------------------------------------ */

    void emitResourceUpdated(String sessionId, String uri) {
        SessionState session = sessionId != null ? sessions.get(sessionId) : null;

        Map<String, Object> notification = new LinkedHashMap<>();
        notification.put("jsonrpc", "2.0");
        notification.put("method", "notifications/resources/updated");
        notification.put("params", Map.of("uri", uri));

        // Store in replay buffer
        String eventId = replayBuffer.store("default", notification);
        int id = Integer.parseInt(eventId);

        if (session != null) {
            writeSseEventWithId(session, id, notification);
        } else {
            // Emit to all sessions
            for (SessionState s : sessions.values()) {
                writeSseEventWithId(s, id, notification);
            }
        }
    }

    void emitResourceUpdatedToAll(String uri) {
        Map<String, Object> notification = new LinkedHashMap<>();
        notification.put("jsonrpc", "2.0");
        notification.put("method", "notifications/resources/updated");
        notification.put("params", Map.of("uri", uri));

        String eventId = replayBuffer.store("default", notification);
        int id = Integer.parseInt(eventId);

        for (SessionState s : sessions.values()) {
            writeSseEventWithId(s, id, notification);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  JSON-RPC helpers (mirroring Server.java)                            */
    /* ------------------------------------------------------------------ */

    private ObjectNode listToolsResult() {
        ObjectNode result = mapper.createObjectNode();
        ArrayNode toolsArray = result.putArray("tools");
        for (ToolDefinition tool : tools.values()) {
            ObjectNode toolNode = toolsArray.addObject();
            toolNode.put("name", tool.name());
            toolNode.put("description", tool.description());
            toolNode.set("inputSchema", tool.inputSchema());
            toolNode.set("annotations", tool.annotations());
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private void handleToolCall(ObjectNode response, JsonNode params, SessionState session) throws IOException {
        String toolName = params != null ? params.path("name").asText("") : "";
        ToolDefinition tool = tools.get(toolName);
        if (tool == null) {
            response.set("error", jsonRpcErrorNode(-32601, "Unknown tool: " + toolName));
            return;
        }

        Map<String, Object> arguments = params != null && params.has("arguments")
            ? mapper.convertValue(params.get("arguments"), LinkedHashMap.class)
            : Map.of();

        Object payload;
        try {
            payload = tool.handler().apply(arguments);
        } catch (Exception e) {
            payload = ToolRegistry.apexError("APEX_5000", "internal",
                e.getMessage() != null ? e.getMessage() : "Internal error");
        }

        boolean isError = payload instanceof ProtocolModels.ApexErrorEnvelope;
        ObjectNode result = mapper.createObjectNode();
        result.put("isError", isError);
        ArrayNode content = result.putArray("content");
        content.addObject()
            .put("type", "text")
            .put("text", mapper.writeValueAsString(payload));
        response.set("result", result);

        // After tool call, flush resource notifications
        // Always flush resource notifications after a tool call
        flushNotifications(session);
    }

    private void flushNotifications(SessionState session) throws IOException {
        for (String uri : state.drainPendingUpdates()) {
            // Store and send ALL resource update notifications to the SSE stream
            // (not just subscribed ones) so they appear in the replay buffer.
            // This matches the behavior of the MCP SDK's EventStore which sees
            // all messages sent through the transport.
            Map<String, Object> notification = new LinkedHashMap<>();
            notification.put("jsonrpc", "2.0");
            notification.put("method", "notifications/resources/updated");
            notification.put("params", Map.of("uri", uri));

            String eventId = replayBuffer.store("default", notification);
            int id = Integer.parseInt(eventId);
            writeSseEventWithId(session, id, notification);
        }
    }

    private ObjectNode listResourcesResult() {
        ObjectNode result = mapper.createObjectNode();
        ArrayNode resources = result.putArray("resources");
        for (Map<String, Object> resource : state.resources()) {
            ObjectNode node = resources.addObject();
            node.put("name", String.valueOf(resource.get("name")));
            node.put("uri", String.valueOf(resource.get("uri")));
            node.put("description", String.valueOf(resource.get("description")));
            node.put("mimeType", String.valueOf(resource.get("mimeType")));
        }
        return result;
    }

    private void handleResourceRead(ObjectNode response, JsonNode params) throws IOException {
        String uri = params != null ? params.path("uri").asText("") : "";
        Object payload = state.readResource(uri);
        if (payload == null) {
            response.set("error", jsonRpcErrorNode(-32002, "Unknown resource: " + uri));
            return;
        }
        ObjectNode result = mapper.createObjectNode();
        ArrayNode contents = result.putArray("contents");
        contents.addObject()
            .put("uri", uri)
            .put("mimeType", "application/json")
            .put("text", mapper.writeValueAsString(payload));
        response.set("result", result);
    }

    private void handleSubscribe(ObjectNode response, JsonNode params, SessionState session) {
        String uri = params != null ? params.path("uri").asText("") : "";
        if (!uri.isBlank()) {
            session.subscriptions.add(uri);
        }
        response.set("result", mapper.createObjectNode());
    }

    private void handleUnsubscribe(ObjectNode response, JsonNode params, SessionState session) {
        String uri = params != null ? params.path("uri").asText("") : "";
        session.subscriptions.remove(uri);
        response.set("result", mapper.createObjectNode());
    }

    private ObjectNode jsonRpcErrorNode(int code, String message) {
        ObjectNode error = mapper.createObjectNode();
        error.put("code", code);
        error.put("message", message);
        return error;
    }

    private ObjectNode jsonRpcError(JsonNode idNode, int code, String message) {
        ObjectNode response = mapper.createObjectNode();
        response.put("jsonrpc", "2.0");
        if (idNode != null && idNode.isIntegralNumber()) {
            response.put("id", idNode.asLong());
        } else if (idNode != null) {
            response.put("id", idNode.asText());
        } else {
            response.putNull("id");
        }
        response.set("error", jsonRpcErrorNode(code, message));
        return response;
    }

    private void sendJsonResponse(HttpExchange exchange, int statusCode, ObjectNode response) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        byte[] bytes = mapper.writeValueAsBytes(response);
        exchange.sendResponseHeaders(statusCode, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}
