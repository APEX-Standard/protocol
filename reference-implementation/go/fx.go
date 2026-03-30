package main

import (
	"context"
	"math"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// nextRolloverTime computes the next 21:00 UTC rollover timestamp.
func nextRolloverTime() string {
	now := time.Now().UTC()
	next := time.Date(now.Year(), now.Month(), now.Day(), 21, 0, 0, 0, time.UTC)
	if !next.After(now) {
		next = next.AddDate(0, 0, 1)
	}
	return next.Format(time.RFC3339)
}

func registerFxTools(s *server.MCPServer) {
	registerFxToolsWithState(s, state)
}

func registerFxToolsWithState(s *server.MCPServer, st *referenceState) {
	// apex.fx.rollover
	s.AddTool(
		mcp.NewTool("apex.fx.rollover",
			mcp.WithDescription("Query swap/rollover rates for an FX instrument. Rates are expressed in account currency per lot per night."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("instrument_id", mcp.Required(), mcp.Description("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)")),
			mcp.WithString("as_of", mcp.Description("ISO8601 timestamp — defaults to now")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			instrumentID := strParam(request.GetArguments(), "instrument_id", "")
			if instrumentID != referenceInstrumentID {
				return jsonResult(apexError("APEX_4010", "validation", "Unknown instrument"))
			}

			return jsonResult(map[string]any{
				"instrument_id":      referenceInstrumentID,
				"broker_symbol":      referenceBrokerSymbol,
				"rollover_long":      -0.5,
				"rollover_short":     0.3,
				"rollover_currency":  "USD",
				"rollover_per":       "lot",
				"lot_size":           100000,
				"triple_rollover_day": "Wednesday",
				"next_rollover_time": nextRolloverTime(),
				"as_of":             nowISO(),
			})
		},
	)

	// apex.fx.exposure
	s.AddTool(
		mcp.NewTool("apex.fx.exposure",
			mcp.WithDescription("Net currency exposure across open FX positions. Critical for agents managing portfolio-level currency risk."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("account_id", mcp.Required(), mcp.Description("Trading account ID")),
			mcp.WithString("base_currency", mcp.Required(), mcp.Description("Denominate all exposures in this currency")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			accountID := strParam(args, "account_id", "")
			baseCurrency := strParam(args, "base_currency", "")

			if accountID == "" {
				return jsonResult(apexError("APEX_4011", "validation", "account_id is required"))
			}

			// Compute EUR exposure from current positions
			st.mu.Lock()
			positions := append([]position(nil), st.positions...)
			st.mu.Unlock()

			eurNetUnits := 0
			var contributingPositions []string

			for _, pos := range positions {
				if pos.InstrumentID == referenceInstrumentID {
					if pos.Side == "buy" {
						eurNetUnits += pos.Quantity
					} else {
						eurNetUnits -= pos.Quantity
					}
					contributingPositions = append(contributingPositions, pos.PositionID)
				}
			}

			if contributingPositions == nil {
				contributingPositions = []string{}
			}

			rate := 1.0875 // reference mid price
			var valueInBase float64
			if baseCurrency == "EUR" {
				valueInBase = float64(eurNetUnits)
			} else {
				valueInBase = float64(eurNetUnits) * rate
			}

			netDirection := "flat"
			if eurNetUnits > 0 {
				netDirection = "long"
			} else if eurNetUnits < 0 {
				netDirection = "short"
			}

			return jsonResult(map[string]any{
				"account_id":    accountID,
				"base_currency": baseCurrency,
				"exposures": []map[string]any{
					{
						"currency":                "EUR",
						"net_units":               eurNetUnits,
						"net_direction":            netDirection,
						"value_in_base":           valueInBase,
						"contributing_positions":  contributingPositions,
					},
				},
				"total_gross_exposure": math.Abs(valueInBase),
				"as_of":               nowISO(),
			})
		},
	)

	// apex.fx.conversion
	s.AddTool(
		mcp.NewTool("apex.fx.conversion",
			mcp.WithDescription("Real-time cross-currency conversion rate. Used by agents to calculate P&L in a target currency."),
			mcp.WithReadOnlyHintAnnotation(true),
			mcp.WithDestructiveHintAnnotation(false),
			mcp.WithIdempotentHintAnnotation(true),
			mcp.WithString("from_currency", mcp.Required(), mcp.Description("Source currency code (e.g. EUR)")),
			mcp.WithString("to_currency", mcp.Required(), mcp.Description("Target currency code (e.g. USD)")),
			mcp.WithNumber("amount", mcp.Required(), mcp.Description("Amount to convert")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := request.GetArguments()
			fromCurrency := strParam(args, "from_currency", "")
			toCurrency := strParam(args, "to_currency", "")
			amount := floatParam(args, "amount", 0)

			if fromCurrency == "" || toCurrency == "" {
				return jsonResult(apexError("APEX_4011", "validation", "from_currency, to_currency, and amount are all required"))
			}

			midRate := 1.0875
			var rate float64

			if fromCurrency == toCurrency {
				rate = 1.0
			} else if fromCurrency == "EUR" && toCurrency == "USD" {
				rate = midRate
			} else if fromCurrency == "USD" && toCurrency == "EUR" {
				rate = 1.0 / midRate
			} else {
				return jsonResult(apexError("APEX_4010", "validation", "Unsupported currency pair"))
			}

			return jsonResult(map[string]any{
				"from_currency":   fromCurrency,
				"to_currency":     toCurrency,
				"rate":            math.Round(rate*10000000) / 10000000,
				"converted_amount": math.Round(amount*rate*100) / 100,
				"timestamp":       nowISO(),
			})
		},
	)
}
