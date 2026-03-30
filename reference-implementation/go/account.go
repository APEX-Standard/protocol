package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerAccountTools(s *server.MCPServer) {
	s.AddTool(
		mcp.NewTool("apex.account.summary",
			mcp.WithDescription("Current account state — balances, margin utilisation, equity."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("currency", mcp.Description("Response currency. Defaults to account base currency.")),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
		),
		handleAccountSummary,
	)

	s.AddTool(
		mcp.NewTool("apex.account.positions",
			mcp.WithDescription("All open positions with live P&L."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("instrument_id", mcp.Description("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")),
			mcp.WithString("profile", mcp.Description("Asset class profile filter")),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
		),
		handleAccountPositions,
	)

	s.AddTool(
		mcp.NewTool("apex.account.orders",
			mcp.WithDescription("Known orders and their current lifecycle state."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("status", mcp.Description("Filter by order status"), mcp.Enum("working", "partially_filled", "filled", "cancelled", "rejected", "expired", "all")),
			mcp.WithString("instrument_id", mcp.Description("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
		),
		handleAccountOrders,
	)

	s.AddTool(
		mcp.NewTool("apex.account.history",
			mcp.WithDescription("Closed trades and funding events."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("from", mcp.Required(), mcp.Description("ISO8601 start date")),
			mcp.WithString("to", mcp.Required(), mcp.Description("ISO8601 end date")),
			mcp.WithString("event_type", mcp.Description("Event type filter"), mcp.Enum("trade", "funding", "cash", "corporate_action", "all")),
			mcp.WithNumber("limit", mcp.Description("Maximum number of events to return (1-500, default 100)")),
			mcp.WithString("cursor", mcp.Description("Pagination cursor")),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
		),
		handleAccountHistory,
	)
}

func handleAccountSummary(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := request.GetArguments()
	accountID := strParam(args, "account_id", "")
	if accountID == "" {
		return jsonResult(apexError("APEX_4011", "validation", "account_id is required"))
	}
	return jsonResult(state.accountSummary(strParam(args, "currency", "USD")))
}

func handleAccountPositions(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(state.positionsResponse())
}

func handleAccountOrders(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(state.ordersResponse())
}

func handleAccountHistory(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(historyResponse{
		Events:     []any{},
		NextCursor: nil,
		HasMore:    false,
	})
}
