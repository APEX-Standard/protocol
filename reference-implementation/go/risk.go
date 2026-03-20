package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerRiskTools(s *server.MCPServer) {
	s.AddTool(
		mcp.NewTool("apex.risk.check",
			mcp.WithDescription("Pre-trade margin and exposure check. Call before placing large orders."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithObject("order", mcp.Required(), mcp.Description("Order to check"),
				mcp.Properties(map[string]any{
					"instrument_id": map[string]any{"type": "string", "description": "APEX canonical instrument ID"},
					"side":          map[string]any{"type": "string", "description": "Order side: buy or sell", "enum": []string{"buy", "sell"}},
					"order_type":    map[string]any{"type": "string", "description": "Order type: market, limit, stop, stop_limit", "enum": []string{"market", "limit", "stop", "stop_limit"}},
					"quantity":      map[string]any{"type": "number", "description": "Order quantity"},
				}),
			),
		),
		handleRiskCheck,
	)

	s.AddTool(
		mcp.NewTool("apex.risk.limits",
			mcp.WithDescription("Current account-level risk limits and utilisation."),
			mcp.WithString("account_id", mcp.Required()),
		),
		handleRiskLimits,
	)
}

func handleRiskCheck(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	order := mapParam(request.GetArguments(), "order")
	if order == nil {
		return jsonResult(apexError("APEX_4011", "validation", "order is required"))
	}

	requiredMargin := (floatParam(order, "quantity", 0) / 100000) * 500
	availableMargin := 9750.0

	return jsonResult(riskCheckResponse{
		Approved:         true,
		RequiredMargin:   requiredMargin,
		AvailableMargin:  availableMargin,
		MarginAfterTrade: availableMargin - requiredMargin,
		ExposureIncrease: floatParam(order, "quantity", 0),
		Warnings:         []any{},
		RejectionReason:  nil,
	})
}

func handleRiskLimits(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(riskLimitsResponse{
		AccountID:             strParam(request.GetArguments(), "account_id", ""),
		MaxPositionSize:       5000000,
		MaxOpenOrders:         50,
		DailyLossLimit:        -1000,
		DailyLossUsed:         -150,
		MarginCallLevelPct:    100,
		StopOutLevelPct:       50,
		RestrictedInstruments: []any{},
		KillSwitchActive:      false,
	})
}
