package org.apexstandard.reference;

import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;
import java.util.function.Function;

record ToolDefinition(
    String name,
    String description,
    ObjectNode inputSchema,
    ObjectNode annotations,
    Function<Map<String, Object>, Object> handler
) {
}
