package main

import (
	"context"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

var coreTools = []string{
	"apex.session.*",
	"apex.account.*",
	"apex.order.*",
	"apex.market.*",
	"apex.risk.*",
}

func registerSessionTools(s *server.MCPServer) {
	s.AddTool(
		mcp.NewTool("apex.session.authenticate",
			mcp.WithDescription("Establish an authenticated trading session. The broker validates credentials directly and binds the result to the MCP session."),
			mcp.WithString("token", mcp.Required(), mcp.Description("Broker-issued JWT or OAuth token")),
			mcp.WithString("token_type", mcp.Description("Token type: jwt or oauth2"), mcp.Enum("jwt", "oauth2")),
			mcp.WithString("account_id", mcp.Description("Optional — broker may derive from token")),
			mcp.WithString("hub_session_id", mcp.Description("Optional session reference from caller")),
		),
		handleSessionAuthenticate,
	)

	s.AddTool(
		mcp.NewTool("apex.session.capabilities",
			mcp.WithDescription("Query the full capability manifest of this broker implementation."),
		),
		handleSessionCapabilities,
	)

	s.AddTool(
		mcp.NewTool("apex.session.heartbeat",
			mcp.WithDescription("Keep-alive ping. Hub marks session degraded if response exceeds 500ms."),
			mcp.WithString("timestamp", mcp.Required(), mcp.Description("ISO8601 timestamp")),
		),
		handleSessionHeartbeat,
	)

	s.AddTool(
		mcp.NewTool("reference.test.set_realtime_state",
			mcp.WithDescription("Reference-only fault injection for conformance and resilience testing."),
			mcp.WithBoolean("quote_stale"),
			mcp.WithBoolean("risk_stale"),
			mcp.WithBoolean("force_sequence_gap"),
			mcp.WithBoolean("kill_switch_active"),
			mcp.WithBoolean("partial_fill_next_order"),
		),
		handleSetRealtimeState,
	)
}

func handleSessionAuthenticate(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := request.GetArguments()
	token := strParam(args, "token", "")
	if len(token) < 10 {
		return jsonResult(apexError("APEX_4001", "auth", "Invalid or expired token"))
	}

	return jsonResult(sessionResponse{
		SessionID:    uuid.NewString(),
		AccountID:    strParam(args, "account_id", "ACC_12345"),
		ExpiresAt:    hoursFromNow(1),
		Capabilities: coreTools,
		Profiles:     []string{"fx"},
		BrokerID:     "reference-broker",
		BrokerName:   "APEX Reference Broker",
	})
}

func handleSessionCapabilities(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(capabilitiesResponse{
		ApexVersion:         serverVersion,
		BrokerID:            "reference-broker",
		CoreTools:           coreTools,
		Profiles:            map[string]string{"fx": serverVersion},
		VendorExtensions:    nil,
		RateLimits:          map[string]int{"orders_per_second": 10, "market_data_per_second": 100},
		SupportedOrderTypes: []string{"market", "limit", "stop", "stop_limit"},
		SupportedTif:        []string{"GTC", "IOC", "FOK", "DAY"},
		RealtimeContract: map[string]any{
			"reconnect_mode":       "no_replay",
			"quote_freshness_ms":   1000,
			"account_freshness_ms": 2000,
		},
	})
}

func handleSessionHeartbeat(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(struct {
		Timestamp string `json:"timestamp"`
		Status    string `json:"status"`
	}{
		Timestamp: nowISO(),
		Status:    "ok",
	})
}

func handleSetRealtimeState(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := request.GetArguments()
	quoteStale := boolPointer(args, "quote_stale")
	riskStale := boolPointer(args, "risk_stale")
	forceSequenceGap := boolPointer(args, "force_sequence_gap")
	killSwitchActive := boolPointer(args, "kill_switch_active")
	partialFillNext := boolPointer(args, "partial_fill_next_order")

	return jsonResult(map[string]any{
		"ok":     true,
		"faults": state.setRealtimeFaults(quoteStale, riskStale, forceSequenceGap, killSwitchActive, partialFillNext),
	})
}
