package org.apexstandard.reference;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.json.jackson2.JacksonMcpJsonMapper;

import java.util.List;
import java.util.Map;

/**
 * MCP SDK-based entry point for the APEX reference server.
 * Replaces the hand-rolled JSON-RPC handling in {@link Server}.
 */
public final class McpApexServer {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int DEFAULT_HTTP_PORT = 8888;

    private McpApexServer() {
    }

    /* ================================================================== */
    /*  HTTP mode                                                          */
    /* ================================================================== */

    private static void runHttp(int port) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        ReferenceTradingState state = new ReferenceTradingState();
        NotificationDispatcher dispatcher = new NotificationDispatcher();
        ReplayBuffer replayBuffer = new ReplayBuffer();

        ToolRegistry registry = new ToolRegistry(mapper, state, "streamable_http", dispatcher, replayBuffer);
        List<McpServerFeatures.SyncToolSpecification> toolSpecs = registry.createToolSpecifications();

        List<McpServerFeatures.SyncResourceSpecification> resourceSpecs =
                state.resources().stream().map(r -> toResourceSpec(state, r)).toList();

        JdkHttpMcpTransportProvider transportProvider =
                new JdkHttpMcpTransportProvider(new JacksonMcpJsonMapper(mapper), port, replayBuffer);

        // Wire resource update notifications from state mutations to SSE streams
        state.setResourceUpdateCallback(uri -> transportProvider.emitResourceUpdatedToAll(uri));

        McpSyncServer server = McpServer.sync(transportProvider)
                .serverInfo(new McpSchema.Implementation(ToolRegistry.SERVER_NAME, null, ToolRegistry.SERVER_VERSION))
                .capabilities(new McpSchema.ServerCapabilities(
                        null, null, null, null,
                        new McpSchema.ServerCapabilities.ResourceCapabilities(true, true),
                        new McpSchema.ServerCapabilities.ToolCapabilities(false)
                ))
                .tools(toolSpecs)
                .resources(resourceSpecs)
                .build();

        // Set up tick engine
        TickEngine tickEngine = new TickEngine();

        tickEngine.setQuoteCallback((mid, bid, ask) -> {
            state.updateQuote(mid, bid, ask);
            state.bumpResourcesNoTrack(ReferenceTradingState.QUOTE_URI, ReferenceTradingState.FEATURES_URI);
            transportProvider.emitResourceUpdatedToAll(ReferenceTradingState.QUOTE_URI);
            transportProvider.emitResourceUpdatedToAll(ReferenceTradingState.FEATURES_URI);
        });

        tickEngine.setCandleCloseCallback((timeframe, candle) -> {
            String candleUri = switch (timeframe) {
                case "M1" -> ReferenceTradingState.CANDLES_M1_URI;
                case "M5" -> ReferenceTradingState.CANDLES_M5_URI;
                default -> ReferenceTradingState.CANDLES_H1_URI;
            };
            state.bumpResourcesNoTrack(candleUri);
            int seq = state.getSequence(candleUri);
            Map<String, Object> candleNotif = NotificationDispatcher.candleClosedNotification(
                    ReferenceTradingState.INSTRUMENT_ID, timeframe,
                    candle.open, candle.high, candle.low, candle.close, candle.volume, seq);
            transportProvider.emitToAllSessions(candleNotif);
            transportProvider.emitResourceUpdatedToAll(candleUri);
        });

        tickEngine.setCandleUpdateCallback(timeframe -> {
            String candleUri = switch (timeframe) {
                case "M1" -> ReferenceTradingState.CANDLES_M1_URI;
                case "M5" -> ReferenceTradingState.CANDLES_M5_URI;
                default -> ReferenceTradingState.CANDLES_H1_URI;
            };
            transportProvider.emitResourceUpdatedToAll(candleUri);
        });

        tickEngine.setFeatureUpdateCallback(() ->
                transportProvider.emitResourceUpdatedToAll(ReferenceTradingState.FEATURES_URI));

        // Wire dispatcher to emit APEX notifications via transport provider
        dispatcher.setSink(notification -> transportProvider.emitToAllSessions(notification));

        // Register test-only tools at runtime
        server.addTool(new McpServerFeatures.SyncToolSpecification(
                McpSchema.Tool.builder()
                        .name("reference.test.force_candle_close")
                        .description("Force-close the current partial candle for a given timeframe. Test-only.")
                        .inputSchema(new McpSchema.JsonSchema("object",
                                Map.of("timeframe", ToolRegistry.enumProp(null, "M1", "M1", "M5", "H1")),
                                List.of("timeframe"), false, null, null))
                        .annotations(new McpSchema.ToolAnnotations(null, false, false, false, null, null))
                        .build(),
                (exchange, request) -> {
                    try {
                        String tf = request.arguments() != null
                                ? String.valueOf(request.arguments().getOrDefault("timeframe", "M1")) : "M1";
                        tickEngine.forceCandleClose(tf);
                        String json = mapper.writeValueAsString(Map.of("closed", true, "timeframe", tf));
                        return McpSchema.CallToolResult.builder()
                                .content(List.of(new McpSchema.TextContent(json)))
                                .isError(false).build();
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }
        ));

        server.addTool(new McpServerFeatures.SyncToolSpecification(
                McpSchema.Tool.builder()
                        .name("reference.test.stop_ticks")
                        .description("Stop the tick engine. Test-only tool for deterministic event counts.")
                        .inputSchema(new McpSchema.JsonSchema("object", Map.of(), List.of(), false, null, null))
                        .annotations(new McpSchema.ToolAnnotations(null, false, false, true, null, null))
                        .build(),
                (exchange, request) -> {
                    try {
                        tickEngine.stop();
                        String json = mapper.writeValueAsString(Map.of("stopped", true));
                        return McpSchema.CallToolResult.builder()
                                .content(List.of(new McpSchema.TextContent(json)))
                                .isError(false).build();
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }
        ));

        // Start tick engine after authentication, stop on session delete
        state.setOnAuthenticated(() -> {
            tickEngine.start();
            System.err.println("Tick engine started after authentication");
        });
        transportProvider.setOnSessionDeleted(tickEngine::stop);

        // Start transport and block main thread
        transportProvider.start();

        try {
            Thread.currentThread().join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            tickEngine.shutdown();
            transportProvider.stop();
            server.close();
        }
    }

    /* ================================================================== */
    /*  Helpers                                                             */
    /* ================================================================== */

    private static McpServerFeatures.SyncResourceSpecification toResourceSpec(
            ReferenceTradingState state, Map<String, Object> r) {
        String uri = String.valueOf(r.get("uri"));
        String name = String.valueOf(r.get("name"));
        String description = String.valueOf(r.get("description"));
        String mimeType = String.valueOf(r.get("mimeType"));

        return new McpServerFeatures.SyncResourceSpecification(
                new McpSchema.Resource(uri, name, null, description, mimeType, null, null, null),
                (exchange, request) -> {
                    Object payload = state.readResource(request.uri());
                    if (payload == null) {
                        throw new RuntimeException("Unknown resource: " + request.uri());
                    }
                    try {
                        return new McpSchema.ReadResourceResult(List.of(
                                new McpSchema.TextResourceContents(
                                        request.uri(),
                                        "application/json",
                                        MAPPER.writeValueAsString(payload),
                                        null)
                        ), null);
                    } catch (Exception e) {
                        throw new RuntimeException("Failed to serialize resource: " + request.uri(), e);
                    }
                }
        );
    }

    /* ================================================================== */
    /*  Entry point                                                        */
    /* ================================================================== */

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            runHttp(DEFAULT_HTTP_PORT);
            return;
        }

        if (args.length > 2 || !"--http".equals(args[0])) {
            usage();
            return;
        }

        int port = DEFAULT_HTTP_PORT;
        if (args.length == 2) {
            try {
                port = Integer.parseInt(args[1]);
            } catch (NumberFormatException e) {
                usage();
                return;
            }
            if (port < 1 || port > 65535) {
                usage();
                return;
            }
        }
        runHttp(port);
    }

    private static void usage() {
        System.err.println("Usage: java -jar apex-reference-java-0.1.0.jar [--http <port>]");
        System.exit(1);
    }
}
