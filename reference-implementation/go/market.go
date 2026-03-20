package main

import (
	"context"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerMarketTools(s *server.MCPServer) {
	s.AddTool(
		mcp.NewTool("apex.market.quote",
			mcp.WithDescription("Current bid/ask/mid for an instrument."),
			mcp.WithString("instrument_id", mcp.Description("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")),
			mcp.WithString("broker_symbol", mcp.Description("Alternative to instrument_id")),
		),
		handleMarketQuote,
	)

	s.AddTool(
		mcp.NewTool("apex.market.snapshot",
			mcp.WithDescription("OHLCV candle data for an instrument."),
			mcp.WithString("instrument_id", mcp.Required(), mcp.Description("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")),
			mcp.WithString("timeframe", mcp.Required(), mcp.Description("Candle timeframe"), mcp.Enum("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN")),
			mcp.WithString("from", mcp.Required(), mcp.Description("ISO8601 start time")),
			mcp.WithString("to", mcp.Description("ISO8601 end time (defaults to now)")),
			mcp.WithNumber("limit", mcp.Description("Maximum number of candles (1-1000, default 200)")),
		),
		handleMarketSnapshot,
	)

	s.AddTool(
		mcp.NewTool("apex.market.search",
			mcp.WithDescription("Discover instruments by keyword, asset class, or profile."),
			mcp.WithString("query", mcp.Required(), mcp.Description("Search query")),
			mcp.WithString("profile", mcp.Description("Asset class profile filter"), mcp.Enum("fx", "cfd", "crypto", "derivatives", "fixed_income")),
			mcp.WithNumber("limit", mcp.Description("Maximum results (1-50, default 20)")),
		),
		handleMarketSearch,
	)

	s.AddTool(
		mcp.NewTool("apex.market.details",
			mcp.WithDescription("Full contract specification for an instrument."),
			mcp.WithString("instrument_id", mcp.Required(), mcp.Description("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")),
		),
		handleMarketDetails,
	)
}

func handleMarketQuote(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := request.GetArguments()

	return jsonResult(quoteResponse{
		InstrumentID: strParam(args, "instrument_id", "APEX:FX:EURUSD"),
		BrokerSymbol: strParam(args, "broker_symbol", "EURUSD"),
		Bid:          1.08740,
		Ask:          1.08760,
		Mid:          1.08750,
		Spread:       0.00020,
		Timestamp:    nowISO(),
		IsTradeable:  true,
		MarketStatus: "open",
	})
}

func handleMarketSnapshot(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := request.GetArguments()

	return jsonResult(snapshotResponse{
		InstrumentID: strParam(args, "instrument_id", ""),
		Timeframe:    strParam(args, "timeframe", ""),
		Candles:      []any{},
	})
}

func handleMarketSearch(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	query := strings.ToUpper(strParam(request.GetArguments(), "query", ""))
	response := marketSearchResponse{Instruments: []instrumentSearchResult{}}

	if strings.Contains("EURUSD", query) {
		response.Instruments = append(response.Instruments, instrumentSearchResult{
			InstrumentID: "APEX:FX:EURUSD",
			BrokerSymbol: "EURUSD",
			DisplayName:  "Euro / US Dollar",
			Profile:      "fx",
			IsTradeable:  true,
		})
	}

	return jsonResult(response)
}

func handleMarketDetails(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return jsonResult(marketDetailsResponse{
		InstrumentID:       strParam(request.GetArguments(), "instrument_id", ""),
		BrokerSymbol:       "EURUSD",
		DisplayName:        "Euro / US Dollar",
		Profile:            "fx",
		BaseCurrency:       "EUR",
		QuoteCurrency:      "USD",
		PipSize:            0.0001,
		LotSize:            100000,
		QuantityUnit:       "base_units",
		BrokerQuantityUnit: "lots",
		MinQuantity:        1000,
		MaxQuantity:        50000000,
		QuantityStep:       1000,
		MarginRatePct:      0.5,
		CommissionPerLot:   0,
		SpreadType:         "variable",
		TypicalSpreadPips:  0.8,
		TradingHours: []tradingHours{
			{Day: "monday", Open: "00:00", Close: "23:59", Timezone: "UTC"},
		},
		ProfileData: map[string]any{},
	})
}
