package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const (
	referenceAccountID    = "ACC_12345"
	referenceInstrumentID = "APEX:FX:EURUSD"
	referenceBrokerSymbol = "EURUSD"
)

var referenceURIs = struct {
	Quote           string
	CandlesM1       string
	CandlesM5       string
	CandlesH1       string
	Features        string
	AccountSummary  string
	Positions       string
	Orders          string
	Fills           string
	Risk            string
	DecisionContext string
}{
	Quote:           resourceQuoteURI(referenceInstrumentID),
	CandlesM1:       resourceCandlesURI(referenceInstrumentID, "M1"),
	CandlesM5:       resourceCandlesURI(referenceInstrumentID, "M5"),
	CandlesH1:       resourceCandlesURI(referenceInstrumentID, "H1"),
	Features:        resourceFeaturesURI(referenceInstrumentID),
	AccountSummary:  resourceAccountSummaryURI(referenceAccountID),
	Positions:       resourcePositionsURI(referenceAccountID),
	Orders:          resourceOrdersURI(referenceAccountID),
	Fills:           resourceFillsURI(referenceAccountID),
	Risk:            resourceRiskURI(referenceAccountID),
	DecisionContext: resourceDecisionContextURI(referenceInstrumentID),
}

type referenceOrder struct {
	OrderID           string `json:"order_id"`
	ClientOrderID     any    `json:"client_order_id"`
	AccountID         string `json:"account_id"`
	InstrumentID      string `json:"instrument_id"`
	BrokerSymbol      string `json:"broker_symbol"`
	Side              string `json:"side"`
	OrderType         string `json:"order_type"`
	Quantity          string `json:"quantity"`
	QuantityUnit      string `json:"quantity_unit"`
	LimitPrice        any    `json:"limit_price"`
	StopPrice         any    `json:"stop_price"`
	TimeInForce       string `json:"time_in_force"`
	Status            string `json:"status"`
	FilledQuantity    string `json:"filled_quantity"`
	RemainingQuantity string `json:"remaining_quantity"`
	AverageFillPrice  any    `json:"average_fill_price"`
	Reason            any    `json:"reason"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
}

type referenceState struct {
	mu                sync.Mutex
	resourceSequences map[string]int
	orders            []referenceOrder
	positions         []position
	fills             []map[string]any
	pendingUpdates    []string
	quoteStale        bool
	riskStale         bool
	forceSequenceGap  bool
	killSwitchActive  bool
	partialFillNext   bool

	// Live quote state — updated by tick engine in HTTP mode
	liveBid float64
	liveAsk float64
	liveMid float64

	// Callbacks for HTTP mode
	notifyCallback         func(notif map[string]any)
	resourceUpdateCallback func(uris []string)
	onAuthenticated        func()
	tickEngine             *TickEngine
	replayBuffer           *ReplayBuffer
}

func newReferenceState() *referenceState {
	return &referenceState{
		resourceSequences: map[string]int{},
		orders:            []referenceOrder{},
		positions: []position{
			{
				PositionID:            "pos_001",
				InstrumentID:          referenceInstrumentID,
				BrokerSymbol:          referenceBrokerSymbol,
				Side:                  "buy",
				Quantity:              dec(100000),
				qty:                   100000,
				QuantityUnit:          "base_units",
				BrokerQuantity:        "1.0",
				BrokerQuantityUnit:    "lots",
				OpenPrice:             dec(1.0850),
				CurrentPrice:          dec(1.0875),
				UnrealisedPnL:         dec(250),
				UnrealisedPnLCurrency: "USD",
				UsedMargin:            dec(500),
				OpenTime:              hoursAgo(1),
				StopLoss:              dec(1.0800),
				TakeProfit:            dec(1.1000),
				ProfileData: profileData{
					RolloverLongDaily:  dec(-2.5),
					RolloverShortDaily: dec(1.8),
					AccruedRollover:    dec(-7.5),
					PipValue:           dec(10),
					PipValueCurrency:   "USD",
				},
			},
		},
		fills:   []map[string]any{},
		liveBid: 1.08740,
		liveAsk: 1.08760,
		liveMid: 1.08750,
	}
}

// UpdateQuote updates the live quote prices (called by tick engine).
func (s *referenceState) UpdateQuote(mid, bid, ask float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.liveMid = mid
	s.liveBid = bid
	s.liveAsk = ask
}

func resourceQuoteURI(instrumentID string) string {
	return fmt.Sprintf("apex://market/quote/%s", instrumentID)
}

func resourceCandlesURI(instrumentID, timeframe string) string {
	return fmt.Sprintf("apex://market/candles/%s?timeframe=%s&limit=200", instrumentID, timeframe)
}

func resourceFeaturesURI(instrumentID string) string {
	return fmt.Sprintf("apex://market/features/%s", instrumentID)
}

func resourceAccountSummaryURI(accountID string) string {
	return fmt.Sprintf("apex://account/summary/%s", accountID)
}

func resourcePositionsURI(accountID string) string {
	return fmt.Sprintf("apex://account/positions/%s", accountID)
}

func resourceOrdersURI(accountID string) string {
	return fmt.Sprintf("apex://account/orders/%s", accountID)
}

func resourceFillsURI(accountID string) string {
	return fmt.Sprintf("apex://account/fills/%s", accountID)
}

func resourceRiskURI(accountID string) string {
	return fmt.Sprintf("apex://account/risk/%s", accountID)
}

func resourceDecisionContextURI(instrumentID string) string {
	return fmt.Sprintf("apex://agent/decision-context/%s", instrumentID)
}

func (s *referenceState) nextSequence(uri string) int {
	sequence := s.resourceSequences[uri]
	if sequence == 0 {
		return 1
	}
	return sequence
}

func (s *referenceState) bumpLocked(uris ...string) {
	for _, uri := range uris {
		increment := 1
		if s.forceSequenceGap {
			increment = 5
		}
		next := s.resourceSequences[uri] + increment
		if next == 1 {
			next = 2
		}
		s.resourceSequences[uri] = next
		s.pendingUpdates = append(s.pendingUpdates, uri)
	}
	s.forceSequenceGap = false
}

func (s *referenceState) drainPendingUpdates() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.pendingUpdates) == 0 {
		return nil
	}

	seen := make(map[string]struct{}, len(s.pendingUpdates))
	updates := make([]string, 0, len(s.pendingUpdates))
	for _, uri := range s.pendingUpdates {
		if _, ok := seen[uri]; ok {
			continue
		}
		seen[uri] = struct{}{}
		updates = append(updates, uri)
	}
	s.pendingUpdates = nil
	return updates
}

func (s *referenceState) resourceJSON(uri string) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	var payload any
	switch uri {
	case referenceURIs.Quote:
		spread := s.liveAsk - s.liveBid
		if spread < 0 {
			spread = -spread
		}
		spread = float64(int(spread*100000+0.5)) / 100000
		payload = map[string]any{
			"instrument_id":  referenceInstrumentID,
			"broker_symbol":  referenceBrokerSymbol,
			"bid":            dec(s.liveBid),
			"ask":            dec(s.liveAsk),
			"mid":            dec(s.liveMid),
			"spread":         dec(spread),
			"timestamp":      map[bool]string{true: time.Now().UTC().Add(-5 * time.Second).Format(time.RFC3339), false: nowISO()}[s.quoteStale],
			"is_tradeable":   true,
			"market_status":  "open",
			"sequence":       s.nextSequence(uri),
			"stale_after_ms": 1000,
		}
	case referenceURIs.CandlesM1:
		payload = s.candlesEnvelopeLocked(uri, "M1", 1.0875)
	case referenceURIs.CandlesM5:
		payload = s.candlesEnvelopeLocked(uri, "M5", 1.0868)
	case referenceURIs.CandlesH1:
		payload = s.candlesEnvelopeLocked(uri, "H1", 1.0842)
	case referenceURIs.Features:
		payload = map[string]any{
			"instrument_id": referenceInstrumentID,
			"as_of":         nowISO(),
			"quote": map[string]any{
				"bid": dec(s.liveBid), "ask": dec(s.liveAsk), "mid": dec(s.liveMid), "spread": dec(0.00020),
			},
			"returns":    map[string]any{"r_1s": 0.00002, "r_5s": 0.00005, "r_1m": 0.0008},
			"volatility": map[string]any{"rv_1m": 0.12, "rv_5m": 0.37, "rv_30m": 0.55},
			"book":       map[string]any{"top_level_imbalance": 0.21, "depth_imbalance": 0.18, "microprice": 1.08753},
			"flow":       map[string]any{"trade_intensity_30s": 0.67, "aggressor_imbalance_30s": 0.44},
			"regime":     map[string]any{"label": "trend_up", "confidence": 0.81},
			"execution":  map[string]any{"liquidity_score": 0.79, "expected_slippage_bps": 0.6},
			"sequence":   s.nextSequence(uri), "stale_after_ms": 2000,
		}
	case referenceURIs.AccountSummary:
		payload = map[string]any{
			"account_id":            referenceAccountID,
			"account_base_currency": "USD",
			"response_currency":     "USD",
			"balance":               dec(10000.0),
			"equity":                dec(10250.0),
			"used_margin":           dec(500.0),
			"free_margin":           dec(9750.0),
			"margin_level_pct":      dec(2050.0),
			"unrealised_pnl":        dec(250.0),
			"realised_pnl_today":    dec(0.0),
			"as_of":                 map[bool]string{true: time.Now().UTC().Add(-5 * time.Second).Format(time.RFC3339), false: nowISO()}[s.riskStale],
			"sequence":              s.nextSequence(uri),
			"stale_after_ms":        2000,
		}
	case referenceURIs.Positions:
		payload = map[string]any{
			"account_id":           referenceAccountID,
			"as_of":                nowISO(),
			"positions":            s.positions,
			"total_unrealised_pnl": dec(250.0),
			"sequence":             s.nextSequence(uri),
			"stale_after_ms":       2000,
		}
	case referenceURIs.Orders:
		payload = map[string]any{
			"account_id":     referenceAccountID,
			"as_of":          nowISO(),
			"orders":         s.orders,
			"sequence":       s.nextSequence(uri),
			"stale_after_ms": 2000,
		}
	case referenceURIs.Fills:
		payload = map[string]any{
			"account_id":     referenceAccountID,
			"as_of":          nowISO(),
			"fills":          s.fills,
			"sequence":       s.nextSequence(uri),
			"stale_after_ms": 2000,
		}
	case referenceURIs.Risk:
		payload = map[string]any{
			"account_id":             referenceAccountID,
			"as_of":                  map[bool]string{true: time.Now().UTC().Add(-5 * time.Second).Format(time.RFC3339), false: nowISO()}[s.riskStale],
			"available_margin":       dec(9750.0),
			"kill_switch_active":     s.killSwitchActive,
			"max_position_size":      dec(5000000),
			"max_open_orders":        50,
			"daily_loss_limit":       dec(-1000.0),
			"daily_loss_used":        dec(-150.0),
			"restricted_instruments": []any{},
			"margin_call_level_pct":  dec(100),
			"stop_out_level_pct":     dec(50),
			"sequence":               s.nextSequence(uri),
			"stale_after_ms":         2000,
		}
	case referenceURIs.DecisionContext:
		payload = map[string]any{
			"instrument_id": referenceInstrumentID,
			"timestamp":     nowISO(),
			"market": map[string]any{
				"quote_resource":   referenceURIs.Quote,
				"feature_resource": referenceURIs.Features,
				"candle_resources": []string{referenceURIs.CandlesM1, referenceURIs.CandlesM5, referenceURIs.CandlesH1},
			},
			"account": map[string]any{
				"summary_resource":   referenceURIs.AccountSummary,
				"positions_resource": referenceURIs.Positions,
				"orders_resource":    referenceURIs.Orders,
				"risk_resource":      referenceURIs.Risk,
			},
			"constraints": map[string]any{
				"kill_switch_active": s.killSwitchActive,
				"max_position_size":  dec(5000000),
				"max_open_orders":    50,
			},
			"sequence":       s.nextSequence(uri),
			"stale_after_ms": 5000,
		}
	default:
		payload = map[string]any{"error": "resource not found"}
	}

	encoded, _ := json.Marshal(payload)
	return string(encoded)
}

func (s *referenceState) candlesEnvelopeLocked(uri, timeframe string, close float64) map[string]any {
	candleTime := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)
	return map[string]any{
		"instrument_id":           referenceInstrumentID,
		"timeframe":               timeframe,
		"partial_candle_included": true,
		"as_of":                   nowISO(),
		"candles": []map[string]any{{
			"time": candleTime, "open": dec(close - 0.0006), "high": dec(close + 0.0008), "low": dec(close - 0.0010), "close": dec(close), "volume": 125000, "complete": true,
		}},
		"sequence":       s.nextSequence(uri),
		"stale_after_ms": 60000,
	}
}

func (s *referenceState) accountSummary(currency string) accountSummaryResponse {
	if currency == "" {
		currency = "USD"
	}
	return accountSummaryResponse{
		AccountID:           referenceAccountID,
		AccountBaseCurrency: "USD",
		ResponseCurrency:    currency,
		Balance:             dec(10000),
		Equity:              dec(10250),
		UsedMargin:          dec(500),
		FreeMargin:          dec(9750),
		MarginLevelPct:      dec(2050),
		UnrealisedPnL:       dec(250),
		RealisedPnLToday:    dec(0),
		AsOf:                nowISO(),
	}
}

func (s *referenceState) positionsResponse() accountPositionsResponse {
	s.mu.Lock()
	defer s.mu.Unlock()

	return accountPositionsResponse{
		Positions:          append([]position(nil), s.positions...),
		TotalUnrealisedPnL: dec(250),
		AsOf:               nowISO(),
	}
}

func (s *referenceState) ordersResponse() orderListResponse {
	s.mu.Lock()
	defer s.mu.Unlock()

	orders := make([]any, 0, len(s.orders))
	for _, order := range s.orders {
		orders = append(orders, order)
	}

	return orderListResponse{Orders: orders, AsOf: nowISO()}
}

func (s *referenceState) quoteResponse(instrumentID, brokerSymbol string) quoteResponse {
	if instrumentID == "" {
		instrumentID = referenceInstrumentID
	}
	if brokerSymbol == "" {
		brokerSymbol = referenceBrokerSymbol
	}
	s.mu.Lock()
	bid := s.liveBid
	ask := s.liveAsk
	mid := s.liveMid
	s.mu.Unlock()

	return quoteResponse{
		InstrumentID: instrumentID,
		BrokerSymbol: brokerSymbol,
		Bid:          dec(bid),
		Ask:          dec(ask),
		Mid:          dec(mid),
		Spread:       dec(0.00020),
		Timestamp:    nowISO(),
		IsTradeable:  true,
		MarketStatus: "open",
	}
}

func (s *referenceState) createOrder(args map[string]any) any {
	s.mu.Lock()
	defer s.mu.Unlock()

	order := mapParam(args, "order")

	// Validate required order fields
	side := strParam(order, "side", "")
	if side == "" {
		return apexError("APEX_4011", "validation", "side is required")
	}
	if side != "buy" && side != "sell" {
		return apexError("APEX_4011", "validation", "side must be 'buy' or 'sell'")
	}

	orderType := strParam(order, "order_type", "market")
	quantity := floatParam(order, "quantity", 0)
	if quantity <= 0 {
		return apexError("APEX_4011", "validation", "quantity must be positive")
	}
	isMarketOrder := orderType == "market"
	now := nowISO()
	orderID := fmt.Sprintf("ord_%s", time.Now().UTC().Format("150405.000"))
	var limitPriceValue any
	if value, ok := order["limit_price"]; ok {
		parsed := floatParam(map[string]any{"limit_price": value}, "limit_price", 0)
		limitPriceValue = dec(parsed)
	}
	var stopPriceValue any
	if value, ok := order["stop_price"]; ok {
		parsed := floatParam(map[string]any{"stop_price": value}, "stop_price", 0)
		stopPriceValue = dec(parsed)
	}

	var clientOrderValue any
	if clientOrderID := strParam(order, "client_order_id", ""); clientOrderID != "" {
		clientOrderValue = clientOrderID
	}

	fillQuantity := quantity
	remainingQuantity := 0.0
	status := "filled"

	if !isMarketOrder {
		fillQuantity = 0
		remainingQuantity = quantity
		status = "working"
	} else if s.partialFillNext {
		fillQuantity = quantity / 2
		remainingQuantity = quantity / 2
		status = "partially_filled"
		s.partialFillNext = false
	}

	record := referenceOrder{
		OrderID:           orderID,
		ClientOrderID:     clientOrderValue,
		AccountID:         referenceAccountID,
		InstrumentID:      strParam(order, "instrument_id", referenceInstrumentID),
		BrokerSymbol:      strParam(order, "broker_symbol", referenceBrokerSymbol),
		Side:              side,
		OrderType:         orderType,
		Quantity:          dec(quantity),
		QuantityUnit:      strParam(order, "quantity_unit", "base_units"),
		LimitPrice:        limitPriceValue,
		StopPrice:         stopPriceValue,
		TimeInForce:       strParam(order, "time_in_force", "GTC"),
		Status:            status,
		FilledQuantity:    dec(fillQuantity),
		RemainingQuantity: dec(remainingQuantity),
		AverageFillPrice:  map[bool]any{true: dec(1.08755), false: nil}[isMarketOrder],
		Reason:            nil,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	s.orders = append(s.orders, record)

	if isMarketOrder {
		s.fills = append([]map[string]any{{
			"fill_id":             fmt.Sprintf("fill_%s", orderID),
			"order_id":            orderID,
			"account_id":          referenceAccountID,
			"instrument_id":       record.InstrumentID,
			"side":                record.Side,
			"fill_quantity":       dec(fillQuantity),
			"fill_price":          dec(1.08755),
			"commission":          dec(-0.5),
			"commission_currency": "USD",
			"liquidity_flag":      "taker",
			"position_id":         "pos_001",
			"timestamp":           now,
		}}, s.fills...)
	}

	s.bumpLocked(referenceURIs.Orders, referenceURIs.Positions, referenceURIs.Fills, referenceURIs.Risk, referenceURIs.DecisionContext)

	// Emit APEX notifications in HTTP mode
	if isMarketOrder && s.notifyCallback != nil {
		fillSeq := s.nextSequence(referenceURIs.Fills)
		if status == "filled" {
			s.notifyCallback(orderFilledNotification(record, fillSeq))
		} else if status == "partially_filled" {
			s.notifyCallback(orderPartiallyFilledNotification(record, fillSeq))
		}
	}

	// Notify resource updates in HTTP mode
	if s.resourceUpdateCallback != nil {
		uris := []string{referenceURIs.Orders, referenceURIs.Positions, referenceURIs.Fills, referenceURIs.Risk, referenceURIs.DecisionContext}
		// Clear pending updates since we handle them directly
		s.pendingUpdates = nil
		// Must call outside lock, so save the callback
		cb := s.resourceUpdateCallback
		// We need to call outside the lock but we're inside it. Use a goroutine.
		go cb(uris)
	}

	return orderPlacementResponse{
		OrderID:           orderID,
		ClientOrderID:     clientOrderValue,
		Status:            record.Status,
		FillPrice:         map[bool]any{true: dec(1.08755), false: nil}[isMarketOrder],
		FillQuantity:      map[bool]any{true: dec(fillQuantity), false: nil}[isMarketOrder],
		RemainingQuantity: dec(remainingQuantity),
		PositionID:        map[bool]any{true: "pos_001", false: nil}[isMarketOrder],
		RejectionReason:   nil,
		CreatedAt:         now,
	}
}

func (s *referenceState) setRealtimeFaults(quoteStale, riskStale, forceSequenceGap, killSwitchActive, partialFillNext *bool) map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if quoteStale != nil {
		s.quoteStale = *quoteStale
	}
	if riskStale != nil {
		s.riskStale = *riskStale
	}
	if forceSequenceGap != nil {
		s.forceSequenceGap = *forceSequenceGap
	}
	if killSwitchActive != nil {
		wasActive := s.killSwitchActive
		s.killSwitchActive = *killSwitchActive
		if !wasActive && *killSwitchActive && s.notifyCallback != nil {
			seq := s.nextSequence(referenceURIs.Risk)
			notif := killSwitchEngagedNotification(seq)
			cb := s.notifyCallback
			go cb(notif)
		}
	}
	if partialFillNext != nil {
		s.partialFillNext = *partialFillNext
	}

	return map[string]bool{
		"quote_stale":             s.quoteStale,
		"risk_stale":              s.riskStale,
		"force_sequence_gap":      s.forceSequenceGap,
		"kill_switch_active":      s.killSwitchActive,
		"partial_fill_next_order": s.partialFillNext,
	}
}

func (s *referenceState) currentFaults() map[string]bool {
	return s.setRealtimeFaults(nil, nil, nil, nil, nil)
}

func (s *referenceState) orderAcceptance() (bool, string, string, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.quoteStale {
		return false, "APEX_4024", "operational", "Quote state is stale"
	}
	if s.riskStale {
		return false, "APEX_4024", "operational", "Risk state is stale"
	}
	if s.forceSequenceGap {
		return false, "APEX_4025", "operational", "Sequence continuity is broken"
	}
	if s.killSwitchActive {
		return false, "APEX_4023", "risk", "Kill switch active"
	}
	return true, "", "", ""
}

func (s *referenceState) modifyOrder(targetID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index := range s.orders {
		if s.orders[index].OrderID == targetID {
			s.orders[index].UpdatedAt = nowISO()
			break
		}
	}
	s.bumpLocked(referenceURIs.Orders, referenceURIs.DecisionContext)
}

func (s *referenceState) cancelOrder(orderID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for index := range s.orders {
		if s.orders[index].OrderID == orderID {
			s.orders[index].Status = "cancelled"
			s.orders[index].RemainingQuantity = dec(0)
			s.orders[index].UpdatedAt = nowISO()
			break
		}
	}
	s.bumpLocked(referenceURIs.Orders, referenceURIs.DecisionContext)
}

func (s *referenceState) closePosition(positionID string, closeQuantity *float64) (*positionCloseResponse, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Find position
	var pos *position
	var posIdx int
	for i := range s.positions {
		if s.positions[i].PositionID == positionID {
			pos = &s.positions[i]
			posIdx = i
			break
		}
	}
	if pos == nil {
		return nil, "position not found"
	}

	// Determine close quantity
	qty := pos.qty
	if closeQuantity != nil {
		qty = *closeQuantity
	}
	if qty > pos.qty {
		qty = pos.qty
	}

	// Determine opposite side for closing order
	closeSide := "sell"
	if pos.Side == "sell" {
		closeSide = "buy"
	}

	// Use current market price for fill
	fillPrice := s.liveBid
	if closeSide == "buy" {
		fillPrice = s.liveAsk
	}

	now := nowISO()
	orderID := fmt.Sprintf("ord_%s", time.Now().UTC().Format("150405.000"))

	// Create the closing order record
	record := referenceOrder{
		OrderID:           orderID,
		ClientOrderID:     nil,
		AccountID:         referenceAccountID,
		InstrumentID:      pos.InstrumentID,
		BrokerSymbol:      pos.BrokerSymbol,
		Side:              closeSide,
		OrderType:         "market",
		Quantity:          dec(qty),
		QuantityUnit:      pos.QuantityUnit,
		LimitPrice:        nil,
		StopPrice:         nil,
		TimeInForce:       "GTC",
		Status:            "filled",
		FilledQuantity:    dec(qty),
		RemainingQuantity: dec(0),
		AverageFillPrice:  dec(fillPrice),
		Reason:            nil,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	s.orders = append(s.orders, record)

	// Add fill record
	s.fills = append([]map[string]any{{
		"fill_id":             fmt.Sprintf("fill_%s", orderID),
		"order_id":            orderID,
		"account_id":          referenceAccountID,
		"instrument_id":       pos.InstrumentID,
		"side":                closeSide,
		"fill_quantity":       dec(qty),
		"fill_price":          dec(fillPrice),
		"commission":          dec(-0.5),
		"commission_currency": "USD",
		"liquidity_flag":      "taker",
		"position_id":         positionID,
		"timestamp":           now,
	}}, s.fills...)

	// Update position state
	remainingQty := pos.qty - qty
	if remainingQty <= 0 {
		// Full close: remove position
		s.positions = append(s.positions[:posIdx], s.positions[posIdx+1:]...)
		remainingQty = 0
	} else {
		// Partial close: reduce quantity
		s.positions[posIdx].qty = remainingQty
		s.positions[posIdx].Quantity = dec(remainingQty)
	}

	// Bump resource sequences
	s.bumpLocked(referenceURIs.Orders, referenceURIs.Positions, referenceURIs.Fills, referenceURIs.Risk, referenceURIs.DecisionContext)

	// Emit notifications in HTTP mode
	if s.notifyCallback != nil {
		fillSeq := s.nextSequence(referenceURIs.Fills)
		s.notifyCallback(orderFilledNotification(record, fillSeq))
	}

	// Notify resource updates in HTTP mode
	if s.resourceUpdateCallback != nil {
		uris := []string{referenceURIs.Orders, referenceURIs.Positions, referenceURIs.Fills, referenceURIs.Risk, referenceURIs.DecisionContext}
		s.pendingUpdates = nil
		cb := s.resourceUpdateCallback
		go cb(uris)
	}

	closeStatus := "filled"
	if remainingQty > 0 {
		closeStatus = "partially_filled"
	}

	return &positionCloseResponse{
		OrderID:           orderID,
		PositionID:        positionID,
		Status:            closeStatus,
		FillPrice:         dec(fillPrice),
		FillQuantity:      dec(qty),
		RemainingQuantity: dec(remainingQty),
		ClosedAt:          now,
	}, ""
}

func (s *referenceState) isKillSwitchActive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.killSwitchActive
}

func (s *referenceState) orderStatus(orderID string) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, order := range s.orders {
		if order.OrderID == orderID {
			return order, true
		}
	}
	return nil, false
}

func registerResources(s *server.MCPServer, state *referenceState) {
	for _, resource := range []mcp.Resource{
		{URI: referenceURIs.Quote, Name: "quote", Description: "Live top-of-book quote", MIMEType: "application/json"},
		{URI: referenceURIs.CandlesM1, Name: "candles-m1", Description: "M1 candles", MIMEType: "application/json"},
		{URI: referenceURIs.CandlesM5, Name: "candles-m5", Description: "M5 candles", MIMEType: "application/json"},
		{URI: referenceURIs.CandlesH1, Name: "candles-h1", Description: "H1 candles", MIMEType: "application/json"},
		{URI: referenceURIs.Features, Name: "features", Description: "Derived market features", MIMEType: "application/json"},
		{URI: referenceURIs.AccountSummary, Name: "account-summary", Description: "Realtime account summary", MIMEType: "application/json"},
		{URI: referenceURIs.Positions, Name: "account-positions", Description: "Realtime positions", MIMEType: "application/json"},
		{URI: referenceURIs.Orders, Name: "account-orders", Description: "Realtime orders", MIMEType: "application/json"},
		{URI: referenceURIs.Fills, Name: "account-fills", Description: "Realtime fills", MIMEType: "application/json"},
		{URI: referenceURIs.Risk, Name: "account-risk", Description: "Realtime risk state", MIMEType: "application/json"},
		{URI: referenceURIs.DecisionContext, Name: "decision-context", Description: "Model-ready decision context", MIMEType: "application/json"},
	} {
		resourceURI := resource.URI
		resourceMime := resource.MIMEType
		s.AddResource(resource, func(ctx context.Context, request mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
			_ = ctx
			_ = request
			return []mcp.ResourceContents{
				mcp.TextResourceContents{
					URI:      resourceURI,
					MIMEType: resourceMime,
					Text:     state.resourceJSON(resourceURI),
				},
			}, nil
		})
	}
}

// registerForceCandeCloseToolWithState registers the test-only force candle close tool.
func registerForceCandeCloseToolWithState(s *server.MCPServer, st *referenceState) {
	s.AddTool(
		mcp.NewTool("reference.test.force_candle_close",
			mcp.WithDescription("Force-close the current partial candle for a given timeframe. Test-only."),
			mcp.WithString("timeframe", mcp.Required(), mcp.Description("Candle timeframe"), mcp.Enum("M1", "M5", "H1")),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			timeframe := strParam(request.GetArguments(), "timeframe", "M1")
			if st.tickEngine != nil {
				st.tickEngine.ForceCandleClose(timeframe)
			}
			return jsonResult(map[string]any{
				"closed":    true,
				"timeframe": timeframe,
			})
		},
	)
}

// registerStopTicksToolWithState registers the test-only stop ticks tool.
func registerStopTicksToolWithState(s *server.MCPServer, st *referenceState) {
	s.AddTool(
		mcp.NewTool("reference.test.stop_ticks",
			mcp.WithDescription("Stop the tick engine. Test-only tool for deterministic event counts."),
		),
		func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if st.tickEngine != nil {
				st.tickEngine.Stop()
			}
			return jsonResult(map[string]any{
				"stopped": true,
			})
		},
	)
}
