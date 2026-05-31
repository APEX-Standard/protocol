package main

type sessionResponse struct {
	SessionID    string   `json:"session_id"`
	AccountID    string   `json:"account_id"`
	ExpiresAt    string   `json:"expires_at"`
	Capabilities []string `json:"capabilities"`
	Profiles     []string `json:"profiles"`
	BrokerID     string   `json:"broker_id"`
	BrokerName   string   `json:"broker_name"`
}

type capabilitiesResponse struct {
	ApexVersion         string            `json:"apex_version"`
	BrokerID            string            `json:"broker_id"`
	CoreTools           []string          `json:"core_tools"`
	Profiles            map[string]string `json:"profiles"`
	VendorExtensions    any               `json:"vendor_extensions"`
	RateLimits          map[string]int    `json:"rate_limits"`
	SupportedOrderTypes []string          `json:"supported_order_types"`
	SupportedTif        []string          `json:"supported_tif"`
	ProductionProfiles  map[string]bool   `json:"production_profiles"`
	RealtimeContract    map[string]any    `json:"realtime_contract,omitempty"`
}

type accountSummaryResponse struct {
	AccountID           string `json:"account_id"`
	AccountBaseCurrency string `json:"account_base_currency"`
	ResponseCurrency    string `json:"response_currency"`
	Balance             string `json:"balance"`
	Equity              string `json:"equity"`
	UsedMargin          string `json:"used_margin"`
	FreeMargin          string `json:"free_margin"`
	MarginLevelPct      string `json:"margin_level_pct"`
	UnrealisedPnL       string `json:"unrealised_pnl"`
	RealisedPnLToday    string `json:"realised_pnl_today"`
	AsOf                string `json:"as_of"`
}

type profileData struct {
	RolloverLongDaily  string `json:"rollover_long_daily"`
	RolloverShortDaily string `json:"rollover_short_daily"`
	AccruedRollover    string `json:"accrued_rollover"`
	PipValue           string `json:"pip_value"`
	PipValueCurrency   string `json:"pip_value_currency"`
}

type position struct {
	PositionID            string      `json:"position_id"`
	InstrumentID          string      `json:"instrument_id"`
	BrokerSymbol          string      `json:"broker_symbol"`
	Side                  string      `json:"side"`
	Quantity              string      `json:"quantity"`
	QuantityUnit          string      `json:"quantity_unit"`
	BrokerQuantity        string      `json:"broker_quantity"`
	BrokerQuantityUnit    string      `json:"broker_quantity_unit"`
	OpenPrice             string      `json:"open_price"`
	CurrentPrice          string      `json:"current_price"`
	UnrealisedPnL         string      `json:"unrealised_pnl"`
	UnrealisedPnLCurrency string      `json:"unrealised_pnl_currency"`
	UsedMargin            string      `json:"used_margin"`
	OpenTime              string      `json:"open_time"`
	StopLoss              string      `json:"stop_loss"`
	TakeProfit            string      `json:"take_profit"`
	ProfileData           profileData `json:"profile_data"`

	// qty holds the numeric quantity for internal arithmetic. The wire
	// Quantity field is the string-encoded decimal form of this value.
	// Unexported, so it is never marshalled to JSON.
	qty float64
}

type accountPositionsResponse struct {
	Positions          []position `json:"positions"`
	TotalUnrealisedPnL string     `json:"total_unrealised_pnl"`
	AsOf               string     `json:"as_of"`
}

type orderListResponse struct {
	Orders []any  `json:"orders"`
	AsOf   string `json:"as_of"`
}

type historyResponse struct {
	Events     []any `json:"events"`
	NextCursor any   `json:"next_cursor"`
	HasMore    bool  `json:"has_more"`
}

type orderPlacementResponse struct {
	OrderID           string `json:"order_id"`
	ClientOrderID     any    `json:"client_order_id"`
	Status            string `json:"status"`
	FillPrice         any    `json:"fill_price"`
	FillQuantity      any    `json:"fill_quantity"`
	RemainingQuantity string `json:"remaining_quantity"`
	PositionID        any    `json:"position_id"`
	RejectionReason   any    `json:"rejection_reason"`
	CreatedAt         string `json:"created_at"`
}

type orderModifyResponse struct {
	TargetType      string `json:"target_type"`
	TargetID        string `json:"target_id"`
	Status          string `json:"status"`
	RejectionReason any    `json:"rejection_reason"`
	UpdatedAt       string `json:"updated_at"`
}

type orderCancelResponse struct {
	OrderID         string `json:"order_id"`
	Status          string `json:"status"`
	RejectionReason any    `json:"rejection_reason"`
	CancelledAt     string `json:"cancelled_at"`
}

type positionCloseResponse struct {
	OrderID           string `json:"order_id"`
	PositionID        string `json:"position_id"`
	Status            string `json:"status"`
	FillPrice         string `json:"fill_price"`
	FillQuantity      string `json:"fill_quantity"`
	RemainingQuantity string `json:"remaining_quantity"`
	ClosedAt          string `json:"closed_at"`
}

type quoteResponse struct {
	InstrumentID string `json:"instrument_id"`
	BrokerSymbol string `json:"broker_symbol"`
	Bid          string `json:"bid"`
	Ask          string `json:"ask"`
	Mid          string `json:"mid"`
	Spread       string `json:"spread"`
	Timestamp    string `json:"timestamp"`
	IsTradeable  bool   `json:"is_tradeable"`
	MarketStatus string `json:"market_status"`
}

type snapshotResponse struct {
	InstrumentID string `json:"instrument_id"`
	Timeframe    string `json:"timeframe"`
	Candles      []any  `json:"candles"`
}

type instrumentSearchResult struct {
	InstrumentID string `json:"instrument_id"`
	BrokerSymbol string `json:"broker_symbol"`
	DisplayName  string `json:"display_name"`
	Profile      string `json:"profile"`
	IsTradeable  bool   `json:"is_tradeable"`
}

type marketSearchResponse struct {
	Instruments []instrumentSearchResult `json:"instruments"`
}

type tradingHours struct {
	Day      string `json:"day"`
	Open     string `json:"open"`
	Close    string `json:"close"`
	Timezone string `json:"timezone"`
}

type marketDetailsResponse struct {
	InstrumentID       string         `json:"instrument_id"`
	BrokerSymbol       string         `json:"broker_symbol"`
	DisplayName        string         `json:"display_name"`
	Profile            string         `json:"profile"`
	BaseCurrency       string         `json:"base_currency"`
	QuoteCurrency      string         `json:"quote_currency"`
	PipSize            string         `json:"pip_size"`
	LotSize            int            `json:"lot_size"`
	QuantityUnit       string         `json:"quantity_unit"`
	BrokerQuantityUnit string         `json:"broker_quantity_unit"`
	MinQuantity        string         `json:"min_quantity"`
	MaxQuantity        string         `json:"max_quantity"`
	QuantityStep       string         `json:"quantity_step"`
	MarginRatePct      string         `json:"margin_rate_pct"`
	CommissionPerLot   string         `json:"commission_per_lot"`
	SpreadType         string         `json:"spread_type"`
	TypicalSpreadPips  string         `json:"typical_spread_pips"`
	TradingHours       []tradingHours `json:"trading_hours"`
	ProfileData        map[string]any `json:"profile_data"`
}

type riskCheckResponse struct {
	Approved         bool   `json:"approved"`
	RequiredMargin   string `json:"required_margin"`
	AvailableMargin  string `json:"available_margin"`
	MarginAfterTrade string `json:"margin_after_trade"`
	ExposureIncrease string `json:"exposure_increase"`
	Warnings         []any  `json:"warnings"`
	RejectionReason  any    `json:"rejection_reason"`
}

type riskLimitsResponse struct {
	AccountID             string `json:"account_id"`
	MaxPositionSize       string `json:"max_position_size"`
	MaxOpenOrders         int    `json:"max_open_orders"`
	DailyLossLimit        string `json:"daily_loss_limit"`
	DailyLossUsed         string `json:"daily_loss_used"`
	MarginCallLevelPct    string `json:"margin_call_level_pct"`
	StopOutLevelPct       string `json:"stop_out_level_pct"`
	RestrictedInstruments []any  `json:"restricted_instruments"`
	KillSwitchActive      bool   `json:"kill_switch_active"`
}
