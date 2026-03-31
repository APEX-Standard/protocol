package org.apexstandard.reference;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.TypeRef;
import io.modelcontextprotocol.spec.HttpHeaders;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.spec.ProtocolVersions;
import io.modelcontextprotocol.spec.McpStreamableServerSession;
import io.modelcontextprotocol.spec.McpStreamableServerTransport;
import io.modelcontextprotocol.spec.McpStreamableServerTransportProvider;
import reactor.core.publisher.Mono;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;

/**
 * MCP Streamable HTTP transport provider using JDK's built-in {@link HttpServer}.
 * Integrates the APEX {@link ReplayBuffer} for SSE event IDs and Last-Event-ID
 * replay with gap-fill classification.
 */
public final class JdkHttpMcpTransportProvider implements McpStreamableServerTransportProvider {

    private final McpJsonMapper jsonMapper;
    private final int requestedPort;
    private final ReplayBuffer replayBuffer;

    private volatile McpStreamableServerSession.Factory sessionFactory;
    private volatile boolean isClosing = false;
    private HttpServer httpServer;

    /** Active SDK sessions keyed by Mcp-Session-Id. */
    private final ConcurrentHashMap<String, McpStreamableServerSession> sessions = new ConcurrentHashMap<>();

    /** Active SSE streams for each session (one session may have multiple GET streams). */
    private final ConcurrentHashMap<String, CopyOnWriteArrayList<SseTransport>> sessionStreams = new ConcurrentHashMap<>();

    /** Per-session resource subscriptions (session ID → set of subscribed URIs). */
    private final ConcurrentHashMap<String, Set<String>> sessionSubscriptions = new ConcurrentHashMap<>();

    /** Callback fired when a session is deleted (e.g., to stop the tick engine). */
    private volatile Runnable onSessionDeleted;

    public JdkHttpMcpTransportProvider(McpJsonMapper jsonMapper, int port, ReplayBuffer replayBuffer) {
        this.jsonMapper = jsonMapper;
        this.requestedPort = port;
        this.replayBuffer = replayBuffer;
    }

    public void setOnSessionDeleted(Runnable callback) {
        this.onSessionDeleted = callback;
    }

    /* ------------------------------------------------------------------ */
    /*  McpStreamableServerTransportProvider interface                      */
    /* ------------------------------------------------------------------ */

    @Override
    public void setSessionFactory(McpStreamableServerSession.Factory sessionFactory) {
        this.sessionFactory = sessionFactory;
    }

    @Override
    public List<String> protocolVersions() {
        return List.of(ProtocolVersions.MCP_2024_11_05);
    }

    @Override
    public Mono<Void> notifyClients(String method, Object params) {
        return Mono.fromRunnable(() -> {
            McpSchema.JSONRPCNotification notification = new McpSchema.JSONRPCNotification(
                McpSchema.JSONRPC_VERSION, method, params);
            Map<String, Object> notifMap = toMap(notification);
            String eventId = replayBuffer.store("default", notifMap);
            int id = Integer.parseInt(eventId);
            for (var list : sessionStreams.values()) {
                for (SseTransport transport : list) {
                    writeSseToStream(transport, id, notifMap);
                }
            }
        });
    }

    @Override
    public Mono<Void> notifyClient(String sessionId, String method, Object params) {
        return Mono.fromRunnable(() -> {
            McpSchema.JSONRPCNotification notification = new McpSchema.JSONRPCNotification(
                McpSchema.JSONRPC_VERSION, method, params);
            Map<String, Object> notifMap = toMap(notification);
            String eventId = replayBuffer.store("default", notifMap);
            int id = Integer.parseInt(eventId);
            CopyOnWriteArrayList<SseTransport> streams = sessionStreams.get(sessionId);
            if (streams != null) {
                for (SseTransport transport : streams) {
                    writeSseToStream(transport, id, notifMap);
                }
            }
        });
    }

    @Override
    public Mono<Void> closeGracefully() {
        return Mono.fromRunnable(() -> {
            this.isClosing = true;
            // Close all SSE streams first
            for (CopyOnWriteArrayList<SseTransport> streams : sessionStreams.values()) {
                for (SseTransport transport : streams) {
                    transport.doClose();
                }
            }
            for (McpStreamableServerSession session : sessions.values()) {
                try {
                    session.closeGracefully().block();
                } catch (Exception ignored) {
                }
            }
            sessions.clear();
            sessionStreams.clear();
            sessionSubscriptions.clear();
            if (httpServer != null) {
                httpServer.stop(1);
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /*  APEX-specific helpers called by the server wiring                   */
    /* ------------------------------------------------------------------ */

    /**
     * Sends a {@code notifications/resources/updated} notification to sessions
     * that have subscribed to the given URI via {@code resources/subscribe}.
     */
    public void emitResourceUpdatedToAll(String uri) {
        Map<String, Object> notification = new LinkedHashMap<>();
        notification.put("jsonrpc", "2.0");
        notification.put("method", "notifications/resources/updated");
        notification.put("params", Map.of("uri", uri));

        String eventId = replayBuffer.store("default", notification);
        int id = Integer.parseInt(eventId);
        for (var entry : sessionStreams.entrySet()) {
            String sid = entry.getKey();
            Set<String> subs = sessionSubscriptions.get(sid);
            if (subs != null && subs.contains(uri)) {
                for (SseTransport transport : entry.getValue()) {
                    writeSseToStream(transport, id, notification);
                }
            }
        }
    }

    /**
     * Sends an already-constructed APEX notification (as a Map) to all SSE streams.
     */
    public void emitToAllSessions(Map<String, Object> notification) {
        String eventId = replayBuffer.store("default", notification);
        int id = Integer.parseInt(eventId);
        for (var list : sessionStreams.values()) {
            for (SseTransport transport : list) {
                writeSseToStream(transport, id, notification);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /*  HTTP server lifecycle                                               */
    /* ------------------------------------------------------------------ */

    public void start() throws IOException {
        httpServer = HttpServer.create(new InetSocketAddress(requestedPort), 0);
        httpServer.setExecutor(Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "mcp-http-worker");
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
                    exchange.sendResponseHeaders(500, -1);
                } catch (Exception ignored) {
                }
                try {
                    exchange.close();
                } catch (Exception ignored) {
                }
            }
        });

        httpServer.start();
        int actualPort = httpServer.getAddress().getPort();
        System.err.println("APEX Protocol Reference Server v" + ToolRegistry.SERVER_VERSION
                + " (Java 21, MCP SDK) listening on http://localhost:" + actualPort + "/mcp");
    }

    public void stop() {
        if (httpServer != null) {
            httpServer.stop(0);
        }
    }

    public int getPort() {
        return httpServer != null ? httpServer.getAddress().getPort() : requestedPort;
    }

    /* ------------------------------------------------------------------ */
    /*  POST handler                                                        */
    /* ------------------------------------------------------------------ */

    private void handlePost(HttpExchange exchange) throws IOException {
        if (isClosing) {
            exchange.sendResponseHeaders(503, -1);
            exchange.close();
            return;
        }

        String body;
        try (InputStream is = exchange.getRequestBody()) {
            body = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }

        if (body.isBlank()) {
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
            return;
        }

        McpSchema.JSONRPCMessage message;
        try {
            message = McpSchema.deserializeJsonRpcMessage(jsonMapper, body);
        } catch (Exception e) {
            sendJsonError(exchange, 400, null, -32700, "Parse error: " + e.getMessage());
            return;
        }

        // --- Initialize ---
        if (message instanceof McpSchema.JSONRPCRequest jsonrpcRequest
                && McpSchema.METHOD_INITIALIZE.equals(jsonrpcRequest.method())) {
            handleInitialize(exchange, jsonrpcRequest);
            return;
        }

        // --- Validate session ---
        String sessionId = exchange.getRequestHeaders().getFirst(HttpHeaders.MCP_SESSION_ID);
        if (sessionId == null || sessionId.isBlank()) {
            if (message instanceof McpSchema.JSONRPCRequest req) {
                sendJsonError(exchange, 400, req.id(), -32001, "Missing Mcp-Session-Id header");
            } else {
                exchange.sendResponseHeaders(400, -1);
                exchange.close();
            }
            return;
        }

        McpStreamableServerSession session = sessions.get(sessionId);
        if (session == null) {
            if (message instanceof McpSchema.JSONRPCRequest req) {
                sendJsonError(exchange, 404, req.id(), -32001, "Unknown session");
            } else {
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
            }
            return;
        }

        // --- Dispatch by message type ---
        if (message instanceof McpSchema.JSONRPCResponse jsonrpcResponse) {
            session.accept(jsonrpcResponse).block();
            exchange.sendResponseHeaders(202, -1);
            exchange.close();

        } else if (message instanceof McpSchema.JSONRPCNotification jsonrpcNotification) {
            session.accept(jsonrpcNotification).block();
            exchange.sendResponseHeaders(202, -1);
            exchange.close();

        } else if (message instanceof McpSchema.JSONRPCRequest jsonrpcRequest) {
            // Track resource subscriptions for filtered notifications
            if ("resources/subscribe".equals(jsonrpcRequest.method())) {
                @SuppressWarnings("unchecked")
                Map<String, Object> params = jsonMapper.convertValue(jsonrpcRequest.params(), Map.class);
                String uri = String.valueOf(params.get("uri"));
                sessionSubscriptions.computeIfAbsent(sessionId, k -> ConcurrentHashMap.newKeySet()).add(uri);
            } else if ("resources/unsubscribe".equals(jsonrpcRequest.method())) {
                @SuppressWarnings("unchecked")
                Map<String, Object> params = jsonMapper.convertValue(jsonrpcRequest.params(), Map.class);
                String uri = String.valueOf(params.get("uri"));
                Set<String> subs = sessionSubscriptions.get(sessionId);
                if (subs != null) subs.remove(uri);
            }

            // Streaming response via SSE
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.getResponseHeaders().set("Cache-Control", "no-cache");
            exchange.getResponseHeaders().set("Connection", "keep-alive");
            exchange.sendResponseHeaders(200, 0);

            OutputStream os = exchange.getResponseBody();
            SseTransport transport = new SseTransport(sessionId, os);

            try {
                session.responseStream(jsonrpcRequest, transport).block();
            } catch (Exception e) {
                System.err.println("Failed to handle request stream: " + e.getMessage());
            } finally {
                transport.doClose();
                try {
                    os.close();
                } catch (Exception ignored) {
                }
            }

        } else {
            exchange.sendResponseHeaders(400, -1);
            exchange.close();
        }
    }

    private void handleInitialize(HttpExchange exchange, McpSchema.JSONRPCRequest jsonrpcRequest) throws IOException {
        McpSchema.InitializeRequest initializeRequest = jsonMapper.convertValue(
            jsonrpcRequest.params(), new TypeRef<McpSchema.InitializeRequest>() {});

        McpStreamableServerSession.McpStreamableServerSessionInit init =
            sessionFactory.startSession(initializeRequest);

        String sessionId = init.session().getId();
        sessions.put(sessionId, init.session());
        sessionStreams.put(sessionId, new CopyOnWriteArrayList<>());

        try {
            McpSchema.InitializeResult initResult = init.initResult().block();

            // Build response manually to include apex_version extension in serverInfo.
            // The MCP SDK's Implementation record does not support extension fields,
            // so we construct the entire response explicitly rather than relying on
            // SDK serialization internals.
            Map<String, Object> serverInfo = new LinkedHashMap<>();
            serverInfo.put("name", ToolRegistry.SERVER_NAME);
            serverInfo.put("version", ToolRegistry.SERVER_VERSION);
            serverInfo.put("apex_version", "0.1.0-alpha");

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("protocolVersion", initResult.protocolVersion());
            result.put("capabilities", jsonMapper.convertValue(initResult.capabilities(), Map.class));
            result.put("serverInfo", serverInfo);
            if (initResult.instructions() != null) {
                result.put("instructions", initResult.instructions());
            }

            Map<String, Object> response = new LinkedHashMap<>();
            response.put("jsonrpc", "2.0");
            response.put("id", jsonrpcRequest.id());
            response.put("result", result);

            String json = jsonMapper.writeValueAsString(response);
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);

            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.getResponseHeaders().set(HttpHeaders.MCP_SESSION_ID, sessionId);
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        } catch (Exception e) {
            sessions.remove(sessionId);
            sessionStreams.remove(sessionId);
            sendJsonError(exchange, 500, jsonrpcRequest.id(), -32603,
                "Failed to initialize session: " + e.getMessage());
        }
    }

    /* ------------------------------------------------------------------ */
    /*  GET handler — SSE streaming                                        */
    /* ------------------------------------------------------------------ */

    private void handleGet(HttpExchange exchange) throws IOException {
        if (isClosing) {
            exchange.sendResponseHeaders(503, -1);
            exchange.close();
            return;
        }

        String sessionId = exchange.getRequestHeaders().getFirst(HttpHeaders.MCP_SESSION_ID);
        if (sessionId == null || sessionId.isBlank()) {
            exchange.sendResponseHeaders(400, -1);
            exchange.close();
            return;
        }

        McpStreamableServerSession session = sessions.get(sessionId);
        if (session == null) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        exchange.getResponseHeaders().set("Connection", "keep-alive");
        exchange.sendResponseHeaders(200, 0);

        OutputStream os = exchange.getResponseBody();
        SseTransport transport = new SseTransport(sessionId, os);

        // Register this stream
        sessionStreams.computeIfAbsent(sessionId, k -> new CopyOnWriteArrayList<>()).add(transport);

        // Handle replay via Last-Event-ID
        String lastEventId = exchange.getRequestHeaders().getFirst(HttpHeaders.LAST_EVENT_ID);
        if (lastEventId != null && !lastEventId.isBlank()) {
            ReplayBuffer.ReplayResult result = replayBuffer.replayAfter(lastEventId);
            if (!result.success()) {
                // Send replay_failed notification
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
                // Store and send
                String eventId = replayBuffer.store("default", replayFailed);
                int id = Integer.parseInt(eventId);
                writeSseToStream(transport, id, replayFailed);
            } else {
                for (ReplayBuffer.ReplayItem item : result.items()) {
                    writeSseToStream(transport, item.id(), item.message());
                }
            }
        }

        // Establish listening stream (both for fresh connections and after replay)
        McpStreamableServerSession.McpStreamableServerSessionStream listeningStream =
            session.listeningStream(transport);

        // Block until client disconnects
        try {
            transport.awaitClose();
        } finally {
            listeningStream.close();
        }

        // Cleanup
        CopyOnWriteArrayList<SseTransport> s = sessionStreams.get(sessionId);
        if (s != null) {
            s.remove(transport);
        }
        transport.doClose();
        try {
            os.close();
        } catch (Exception ignored) {
        }
    }

    /* ------------------------------------------------------------------ */
    /*  DELETE handler                                                      */
    /* ------------------------------------------------------------------ */

    private void handleDelete(HttpExchange exchange) throws IOException {
        String sessionId = exchange.getRequestHeaders().getFirst(HttpHeaders.MCP_SESSION_ID);
        if (sessionId == null || sessionId.isBlank()) {
            exchange.sendResponseHeaders(400, -1);
            exchange.close();
            return;
        }

        McpStreamableServerSession session = sessions.remove(sessionId);
        if (session == null) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        // Close all SSE streams for this session and clean up subscriptions
        sessionSubscriptions.remove(sessionId);
        CopyOnWriteArrayList<SseTransport> streams = sessionStreams.remove(sessionId);
        if (streams != null) {
            for (SseTransport t : streams) {
                t.doClose();
            }
        }

        try {
            session.delete().block();
        } catch (Exception ignored) {
        }

        // Fire session-deleted callback (e.g., stop tick engine)
        Runnable cb = onSessionDeleted;
        if (cb != null) {
            try { cb.run(); } catch (Exception ignored) {}
        }

        exchange.sendResponseHeaders(200, -1);
        exchange.close();
    }

    /* ------------------------------------------------------------------ */
    /*  SSE writing helpers                                                 */
    /* ------------------------------------------------------------------ */

    private void writeSseToStream(SseTransport transport, int id, Object data) {
        synchronized (transport.lock) {
            if (transport.closed) return;
            try {
                String json = jsonMapper.writeValueAsString(data);
                String sseFrame = "id: " + id + "\nevent: message\ndata: " + json + "\n\n";
                transport.stream.write(sseFrame.getBytes(StandardCharsets.UTF_8));
                transport.stream.flush();
            } catch (Exception e) {
                transport.closed = true;
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /*  JSON-RPC error helper                                               */
    /* ------------------------------------------------------------------ */

    private void sendJsonError(HttpExchange exchange, int httpStatus, Object id,
                               int code, String message) throws IOException {
        try {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("code", code);
            error.put("message", message);

            Map<String, Object> response = new LinkedHashMap<>();
            response.put("jsonrpc", "2.0");
            response.put("id", id);
            response.put("error", error);

            byte[] bytes = jsonMapper.writeValueAsBytes(response);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(httpStatus, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        } catch (Exception e) {
            exchange.sendResponseHeaders(httpStatus, -1);
            exchange.close();
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Map conversion helper                                               */
    /* ------------------------------------------------------------------ */

    @SuppressWarnings("unchecked")
    private Map<String, Object> toMap(Object value) {
        return jsonMapper.convertValue(value, (Class<Map<String, Object>>) (Class<?>) Map.class);
    }

    /* ------------------------------------------------------------------ */
    /*  Inner transport: SSE stream per HTTP connection                     */
    /* ------------------------------------------------------------------ */

    private class SseTransport implements McpStreamableServerTransport {

        private final String sessionId;
        private final OutputStream stream;
        private final Object lock = new Object();
        private final CountDownLatch closeLatch = new CountDownLatch(1);
        private volatile boolean closed = false;

        SseTransport(String sessionId, OutputStream stream) {
            this.sessionId = sessionId;
            this.stream = stream;
        }

        @Override
        public Mono<Void> sendMessage(McpSchema.JSONRPCMessage message) {
            return sendMessage(message, null);
        }

        @Override
        public Mono<Void> sendMessage(McpSchema.JSONRPCMessage message, String messageId) {
            return Mono.fromRunnable(() -> {
                if (closed) return;
                synchronized (lock) {
                    if (closed) return;
                    try {
                        // Only store notifications in replay buffer — responses are ephemeral
                        Map<String, Object> messageMap = toMap(message);
                        boolean isNotification = message instanceof McpSchema.JSONRPCNotification;
                        String sseFrame;
                        if (isNotification) {
                            String eventId = replayBuffer.store("default", messageMap);
                            int id = Integer.parseInt(eventId);
                            String json = jsonMapper.writeValueAsString(messageMap);
                            sseFrame = "id: " + id + "\nevent: message\ndata: " + json + "\n\n";
                        } else {
                            String json = jsonMapper.writeValueAsString(messageMap);
                            sseFrame = "event: message\ndata: " + json + "\n\n";
                        }
                        stream.write(sseFrame.getBytes(StandardCharsets.UTF_8));
                        stream.flush();
                    } catch (Exception e) {
                        closed = true;
                    }
                }
            });
        }

        @Override
        public <T> T unmarshalFrom(Object data, TypeRef<T> typeRef) {
            return jsonMapper.convertValue(data, typeRef);
        }

        @Override
        public Mono<Void> closeGracefully() {
            return Mono.fromRunnable(this::doClose);
        }

        @Override
        public void close() {
            doClose();
        }

        void awaitClose() {
            try { closeLatch.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }

        private void doClose() {
            synchronized (lock) {
                if (closed) return;
                closed = true;
                closeLatch.countDown();
                try {
                    stream.close();
                } catch (Exception ignored) {
                }
            }
        }
    }
}
