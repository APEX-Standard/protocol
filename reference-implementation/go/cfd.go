package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerCfdToolsWithState(s *server.MCPServer, st *referenceState) {
	// apex.cfd.corporate_actions
	s.AddTool(
		mcp.NewTool("apex.cfd.corporate_actions",
			mcp.WithDescription("Query upcoming corporate actions for CFD instruments. Reference implementation returns an empty array."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("account_id", mcp.Required(), mcp.Description("Trading account ID")),
			mcp.WithString("instrument_id", mcp.Description("Filter by APEX canonical instrument ID")),
			mcp.WithString("from", mcp.Description("ISO8601 start date")),
			mcp.WithString("to", mcp.Description("ISO8601 end date")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			accountID := strParam(args, "account_id", "")

			if accountID == "" {
				return jsonResult(apexError("APEX_4011", "validation", "account_id is required"))
			}

			return jsonResult(map[string]any{
				"corporate_actions": []any{},
			})
		},
	)

	// apex.cfd.dividend_adjustment
	s.AddTool(
		mcp.NewTool("apex.cfd.dividend_adjustment",
			mcp.WithDescription("Query dividend adjustments for CFD positions. Reference implementation returns an empty array."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("account_id", mcp.Required(), mcp.Description("Trading account ID")),
			mcp.WithString("status", mcp.Description("Filter by status (default: all)")),
			mcp.WithString("from", mcp.Description("ISO8601 start date")),
			mcp.WithString("to", mcp.Description("ISO8601 end date")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			accountID := strParam(args, "account_id", "")

			if accountID == "" {
				return jsonResult(apexError("APEX_4011", "validation", "account_id is required"))
			}

			return jsonResult(map[string]any{
				"adjustments": []any{},
			})
		},
	)
}
