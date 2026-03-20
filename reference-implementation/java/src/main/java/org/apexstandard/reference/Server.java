package org.apexstandard.reference;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.LinkedHashMap;
import java.util.Map;

public final class Server {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Map<String, ToolDefinition> TOOLS = new ToolRegistry(MAPPER).createTools();

    private Server() {
    }

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
            default -> response.set("error", jsonRpcError(-32601, "Method not found: " + method));
        }

        return response;
    }

    private static ObjectNode initializeResult() {
        ObjectNode result = MAPPER.createObjectNode();
        result.put("protocolVersion", "2024-11-05");
        result.putObject("capabilities").putObject("tools").put("listChanged", false);
        result.putObject("serverInfo")
            .put("name", ToolRegistry.SERVER_NAME)
            .put("version", ToolRegistry.SERVER_VERSION);
        return result;
    }

    private static ObjectNode listToolsResult() {
        ObjectNode result = MAPPER.createObjectNode();
        ArrayNode toolsArray = result.putArray("tools");

        for (ToolDefinition tool : TOOLS.values()) {
            ObjectNode toolNode = toolsArray.addObject();
            toolNode.put("name", tool.name());
            toolNode.put("description", tool.description());
            toolNode.set("inputSchema", tool.inputSchema());
            toolNode.set("annotations", tool.annotations());
        }

        return result;
    }

    private static void handleToolCall(ObjectNode response, JsonNode params) throws IOException {
        String toolName = params != null ? params.path("name").asText("") : "";
        ToolDefinition tool = TOOLS.get(toolName);
        if (tool == null) {
            response.set("error", jsonRpcError(-32601, "Unknown tool: " + toolName));
            return;
        }

        Map<String, Object> arguments = params != null && params.has("arguments")
            ? MAPPER.convertValue(params.get("arguments"), LinkedHashMap.class)
            : Map.of();

        Object payload = tool.handler().apply(arguments);
        ObjectNode result = MAPPER.createObjectNode();
        result.put("isError", false);
        ArrayNode content = result.putArray("content");
        content.addObject()
            .put("type", "text")
            .put("text", MAPPER.writeValueAsString(payload));
        response.set("result", result);
    }

    private static ObjectNode jsonRpcError(int code, String message) {
        ObjectNode error = MAPPER.createObjectNode();
        error.put("code", code);
        error.put("message", message);
        return error;
    }

    public static void main(String[] args) throws IOException {
        System.err.println("APEX Protocol Reference Server v" + ToolRegistry.SERVER_VERSION + " (Java 21) running");

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }

                try {
                    ObjectNode response = handleRequest(MAPPER.readTree(line));
                    if (response != null) {
                        System.out.println(MAPPER.writeValueAsString(response));
                        System.out.flush();
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
}
