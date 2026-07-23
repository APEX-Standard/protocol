package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Mock chain is a fixed snapshot as of 2026-11-06 (42 days before ESZ26 expiry):
// ESU26 has expired, ESZ26 is front month, ESH27 is next out.
const (
	futuresRootID       = "APEX:FUT:ES"
	futuresExpiredID    = "APEX:FUT:ESU26"
	futuresFrontMonthID = "APEX:FUT:ESZ26"
	futuresNextMonthID  = "APEX:FUT:ESH27"
)

func registerFuturesToolsWithState(s *server.MCPServer, st *referenceState) {
	// apex.futures.contract_chain
	s.AddTool(
		mcp.NewTool("apex.futures.contract_chain",
			mcp.WithDescription("List dated contracts for a futures contract root with expirations and liquidity. Reference implementation serves the E-mini S&P 500 chain."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("root", mcp.Required(), mcp.Description("APEX contract root ID (e.g. APEX:FUT:ES)")),
			mcp.WithBoolean("include_expired", mcp.Description("Include expired contracts (default: false)")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			root := strParam(args, "root", "")
			includeExpired, _ := args["include_expired"].(bool)
			if root == "" {
				return jsonResult(apexError("APEX_4011", "validation", "root is required"))
			}
			if root != futuresRootID {
				return jsonResult(apexError("APEX_4010", "validation", "Unknown instrument"))
			}

			contracts := []map[string]any{}
			if includeExpired {
				contracts = append(contracts, map[string]any{
					"instrument_id":     futuresExpiredID,
					"contract_month":    "2026-09",
					"expiration_date":   "2026-09-18",
					"first_notice_date": nil,
					"settlement_type":   "cash",
					"is_front_month":    false,
					"volume":            0,
					"open_interest":     0,
					"status":            "inactive",
				})
			}
			contracts = append(contracts,
				map[string]any{
					"instrument_id":     futuresFrontMonthID,
					"contract_month":    "2026-12",
					"expiration_date":   "2026-12-18",
					"first_notice_date": nil,
					"settlement_type":   "cash",
					"is_front_month":    true,
					"volume":            1250000,
					"open_interest":     2100000,
					"status":            "active",
				},
				map[string]any{
					"instrument_id":     futuresNextMonthID,
					"contract_month":    "2027-03",
					"expiration_date":   "2027-03-19",
					"first_notice_date": nil,
					"settlement_type":   "cash",
					"is_front_month":    false,
					"volume":            41000,
					"open_interest":     98000,
					"status":            "active",
				},
			)

			return jsonResult(map[string]any{
				"root":      futuresRootID,
				"contracts": contracts,
			})
		},
	)

	// apex.futures.margin_schedule
	s.AddTool(
		mcp.NewTool("apex.futures.margin_schedule",
			mcp.WithDescription("Per-contract margin requirements: exchange overnight margins and broker intraday margins. Reference implementation serves the ESZ26 schedule."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("account_id", mcp.Required(), mcp.Description("Trading account ID")),
			mcp.WithString("instrument_id", mcp.Description("Filter by APEX canonical instrument ID (e.g. APEX:FUT:ESZ26)")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			accountID := strParam(args, "account_id", "")
			instrumentID := strParam(args, "instrument_id", "")

			if accountID == "" {
				return jsonResult(apexError("APEX_4011", "validation", "account_id is required"))
			}
			if instrumentID != "" && instrumentID != futuresFrontMonthID {
				return jsonResult(apexError("APEX_4010", "validation", "Unknown instrument"))
			}

			return jsonResult(map[string]any{
				"margins": []map[string]any{
					{
						"instrument_id":      futuresFrontMonthID,
						"currency":           "USD",
						"initial_margin":     "15500.00",
						"maintenance_margin": "14000.00",
						"day_trading_margin": "500.00",
						"day_trading_hours": []map[string]any{
							{"day": "monday", "from": "08:30", "to": "15:45", "timezone": "America/Chicago"},
						},
						"as_of": nowISO(),
					},
				},
			})
		},
	)
}
