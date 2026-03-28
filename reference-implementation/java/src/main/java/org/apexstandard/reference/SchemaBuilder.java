package org.apexstandard.reference;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

final class SchemaBuilder {

    @FunctionalInterface
    interface SchemaConsumer {
        void accept(ObjectNode properties, ArrayNode required);
    }

    private final ObjectMapper mapper;

    SchemaBuilder(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    ObjectNode objectSchema(SchemaConsumer consumer) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        ObjectNode properties = schema.putObject("properties");
        ArrayNode required = schema.putArray("required");
        consumer.accept(properties, required);
        return schema;
    }

    void stringProp(ObjectNode props, ArrayNode required, String name, String description, boolean isRequired) {
        ObjectNode property = props.putObject(name);
        property.put("type", "string");
        if (description != null) {
            property.put("description", description);
        }
        if (isRequired) {
            required.add(name);
        }
    }

    void numberProp(ObjectNode props, ArrayNode required, String name, String description, boolean isRequired) {
        ObjectNode property = props.putObject(name);
        property.put("type", "number");
        if (description != null) {
            property.put("description", description);
        }
        if (isRequired) {
            required.add(name);
        }
    }

    void booleanProp(ObjectNode props, ArrayNode required, String name, boolean defaultValue, boolean isRequired) {
        ObjectNode property = props.putObject(name);
        property.put("type", "boolean");
        property.put("default", defaultValue);
        if (isRequired) {
            required.add(name);
        }
    }

    void integerProp(
        ObjectNode props,
        ArrayNode required,
        String name,
        String description,
        boolean isRequired,
        Integer min,
        Integer max,
        Integer defaultValue
    ) {
        ObjectNode property = props.putObject(name);
        property.put("type", "integer");
        if (description != null) {
            property.put("description", description);
        }
        if (min != null) {
            property.put("minimum", min);
        }
        if (max != null) {
            property.put("maximum", max);
        }
        if (defaultValue != null) {
            property.put("default", defaultValue);
        }
        if (isRequired) {
            required.add(name);
        }
    }

    void enumProp(
        ObjectNode props,
        ArrayNode required,
        String name,
        String description,
        boolean isRequired,
        String defaultValue,
        String... values
    ) {
        ObjectNode property = props.putObject(name);
        property.put("type", "string");
        if (description != null) {
            property.put("description", description);
        }
        ArrayNode enumValues = property.putArray("enum");
        for (String value : values) {
            enumValues.add(value);
        }
        if (defaultValue != null) {
            property.put("default", defaultValue);
        }
        if (isRequired) {
            required.add(name);
        }
    }

    void objectProp(ObjectNode props, ArrayNode required, String name, String description, boolean isRequired, SchemaConsumer consumer) {
        ObjectNode property = props.putObject(name);
        property.put("type", "object");
        if (description != null) {
            property.put("description", description);
        }
        ObjectNode childProps = property.putObject("properties");
        ArrayNode childRequired = property.putArray("required");
        consumer.accept(childProps, childRequired);
        if (isRequired) {
            required.add(name);
        }
    }
}
