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
		),
		handleAccountSummary,
	)

	s.AddTool(
		mcp.NewTool("apex.account.positions",
			mcp.WithDescription("All open positions with live P&L."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("instrument_id", mcp.Description("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")),
			mcp.WithString("profile", mcp.Description("Asset class profile filter")),
		),
		handleAccountPositions,
	)

	s.AddTool(
		mcp.NewTool("apex.account.orders",
			mcp.WithDescription("Known orders and their current lifecycle state."),
			mcp.WithString("account_id", mcp.Required()),
			mcp.WithString("status", mcp.Description("Filter by order status"), mcp.Enum("working", "partially_filled", "filled", "cancelled", "rejected", "expired", "all")),
			mcp.WithString("instrument_id", mcp.Description("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")),
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
		),
		handleAccountHistory,
	)
}

func handleAccountSummary(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := request.GetArguments()

	return jsonResult(accountSummaryResponse{
		AccountID:           strParam(args, "account_id", ""),
		AccountBaseCurrency: "USD",
		ResponseCurrency:    strParam(args, "currency", "USD"),
		Balance:             10000,
		Equity:              10250,
		UsedMargin:          500,
		FreeMargin:          9750,
		MarginLevelPct:      2050,
		UnrealisedPnL:       250,
		RealisedPnLToday:    0,
		AsOf:                nowISO(),
	})
}

func handleAccountPositions(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	instrumentID := strParam(request.GetArguments(), "instrument_id", "APEX:FX:EURUSD")

	return jsonResult(accountPositionsResponse{
		Positions: []position{
			{
				PositionID:            "pos_001",
				InstrumentID:          instrumentID,
				BrokerSymbol:          "EURUSD",
				Side:                  "buy",
				Quantity:              100000,
				QuantityUnit:          "base_units",
				BrokerQuantity:        "1.0",
				BrokerQuantityUnit:    "lots",
				OpenPrice:             1.0850,
				CurrentPrice:          1.0875,
				UnrealisedPnL:         250,
				UnrealisedPnLCurrency: "USD",
				UsedMargin:            500,
				OpenTime:              hoursAgo(1),
				StopLoss:              1.0800,
				TakeProfit:            1.1000,
				ProfileData: profileData{
					RolloverLongDaily:  -2.5,
					RolloverShortDaily: 1.8,
					AccruedRollover:    -7.5,
					PipValue:           10,
					PipValueCurrency:   "USD",
				},
			},
		},
		TotalUnrealisedPnL: 250,
		AsOf:               nowISO(),
	})
}

func handleAccountOrders(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(orderListResponse{
		Orders: []any{},
		AsOf:   nowISO(),
	})
}

func handleAccountHistory(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(historyResponse{
		Events:     []any{},
		NextCursor: nil,
		HasMore:    false,
	})
}
