package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
)

type apexErrorBody struct {
	Code       string         `json:"code"`
	Category   string         `json:"category"`
	Message    string         `json:"message"`
	Details    map[string]any `json:"details,omitempty"`
	RequestID  string         `json:"request_id"`
	RetryAfter *int           `json:"retry_after"`
}

type apexErrorResponse struct {
	Error apexErrorBody `json:"error"`
}

func apexError(code, category, message string) apexErrorResponse {
	var retryAfter *int
	if category == "rate_limit" {
		value := 1
		retryAfter = &value
	}

	return apexErrorResponse{
		Error: apexErrorBody{
			Code:       code,
			Category:   category,
			Message:    message,
			RequestID:  uuid.NewString(),
			RetryAfter: retryAfter,
		},
	}
}

func jsonResult(v any) (*mcp.CallToolResult, error) {
	payload, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("marshal result: %w", err)
	}
	return mcp.NewToolResultText(string(payload)), nil
}

func strParam(args map[string]any, key, fallback string) string {
	value, ok := args[key]
	if !ok {
		return fallback
	}

	s, ok := value.(string)
	if !ok || s == "" {
		return fallback
	}
	return s
}

func floatParam(args map[string]any, key string, fallback float64) float64 {
	value, ok := args[key]
	if !ok {
		return fallback
	}

	switch number := value.(type) {
	case float64:
		return number
	case int:
		return float64(number)
	case json.Number:
		parsed, _ := number.Float64()
		return parsed
	default:
		return fallback
	}
}

func mapParam(args map[string]any, key string) map[string]any {
	value, ok := args[key]
	if !ok {
		return nil
	}

	object, _ := value.(map[string]any)
	return object
}

func boolPointer(args map[string]any, key string) *bool {
	value, ok := args[key]
	if !ok {
		return nil
	}

	boolValue, ok := value.(bool)
	if !ok {
		return nil
	}

	return &boolValue
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func hoursAgo(hours int) string {
	return time.Now().UTC().Add(-time.Duration(hours) * time.Hour).Format(time.RFC3339)
}

func hoursFromNow(hours int) string {
	return time.Now().UTC().Add(time.Duration(hours) * time.Hour).Format(time.RFC3339)
}
