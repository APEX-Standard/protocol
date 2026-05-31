package main

import (
	"math"
	"math/rand"
	"sync"
	"time"
)

const (
	halfSpread   = 0.0001
	maxPipStep   = 0.0002
	historyLimit = 300
	tickInterval = 2 * time.Second
)

// CandleState holds the OHLCV data for a partial or completed candle.
type CandleState struct {
	Open     float64
	High     float64
	Low      float64
	Close    float64
	Volume   int
	OpenTime string
	Complete bool
}

// TickEngineCallbacks defines the callbacks fired by the tick engine.
type TickEngineCallbacks struct {
	OnQuoteUpdate   func(mid, bid, ask float64)
	OnCandleUpdate  func(timeframe string)
	OnCandleClose   func(timeframe string, candle CandleState)
	OnFeatureUpdate func()
}

// TickEngine simulates market data by random-walking a mid price.
type TickEngine struct {
	mu           sync.Mutex
	mid          float64
	priceHistory []float64
	candles      map[string]*CandleState
	callbacks    TickEngineCallbacks
	ticker       *time.Ticker
	stopCh       chan struct{}
	running      bool
}

// NewTickEngine creates a new tick engine with the given callbacks.
func NewTickEngine(callbacks TickEngineCallbacks) *TickEngine {
	te := &TickEngine{
		mid:          1.0875,
		priceHistory: []float64{},
		candles:      map[string]*CandleState{},
		callbacks:    callbacks,
		stopCh:       make(chan struct{}),
	}
	for _, tf := range []string{"M1", "M5", "H1"} {
		te.candles[tf] = te.freshCandle(te.mid)
	}
	return te
}

// Start begins the tick engine's periodic price updates.
func (te *TickEngine) Start() {
	te.mu.Lock()
	if te.running {
		te.mu.Unlock()
		return
	}
	te.running = true
	te.ticker = time.NewTicker(tickInterval)
	te.mu.Unlock()

	go func() {
		for {
			select {
			case <-te.ticker.C:
				te.tick()
			case <-te.stopCh:
				return
			}
		}
	}()
}

// Stop halts the tick engine.
func (te *TickEngine) Stop() {
	te.mu.Lock()
	defer te.mu.Unlock()
	if !te.running {
		return
	}
	te.running = false
	te.ticker.Stop()
	close(te.stopCh)
}

// ForceCandleClose closes the current partial candle for the given timeframe.
func (te *TickEngine) ForceCandleClose(timeframe string) {
	te.mu.Lock()
	candle, ok := te.candles[timeframe]
	if !ok {
		te.mu.Unlock()
		return
	}
	candle.Complete = true
	closed := *candle
	te.candles[timeframe] = te.freshCandle(te.mid)
	te.mu.Unlock()

	if te.callbacks.OnCandleClose != nil {
		te.callbacks.OnCandleClose(timeframe, closed)
	}
}

// GetMid returns the current mid price.
func (te *TickEngine) GetMid() float64 {
	te.mu.Lock()
	defer te.mu.Unlock()
	return te.mid
}

// GetReturns computes simple returns over recent price history.
func (te *TickEngine) GetReturns() map[string]float64 {
	te.mu.Lock()
	defer te.mu.Unlock()

	l := len(te.priceHistory)
	if l < 2 {
		return map[string]float64{"r_1s": 0, "r_5s": 0, "r_1m": 0}
	}

	current := te.priceHistory[l-1]

	r1s := 0.0
	if l >= 2 {
		r1s = (current - te.priceHistory[l-2]) / te.priceHistory[l-2]
	}

	idx5s := l - 3
	if idx5s < 0 {
		idx5s = 0
	}
	r5s := (current - te.priceHistory[idx5s]) / te.priceHistory[idx5s]

	idx1m := l - 30
	if idx1m < 0 {
		idx1m = 0
	}
	r1m := (current - te.priceHistory[idx1m]) / te.priceHistory[idx1m]

	return map[string]float64{
		"r_1s": roundTo5(r1s),
		"r_5s": roundTo5(r5s),
		"r_1m": roundTo5(r1m),
	}
}

// GetVolatility computes annualized realized volatility.
func (te *TickEngine) GetVolatility() map[string]float64 {
	te.mu.Lock()
	defer te.mu.Unlock()

	l := len(te.priceHistory)
	if l < 3 {
		return map[string]float64{"rv_1m": 0, "rv_5m": 0}
	}

	logReturns := make([]float64, 0, l-1)
	for i := 1; i < l; i++ {
		logReturns = append(logReturns, math.Log(te.priceHistory[i]/te.priceHistory[i-1]))
	}

	rv1m := annualizedVol(lastN(logReturns, 30))
	rv5m := annualizedVol(lastN(logReturns, 150))

	return map[string]float64{
		"rv_1m": roundTo5(rv1m),
		"rv_5m": roundTo5(rv5m),
	}
}

// GetCandle returns the current candle state for a timeframe.
func (te *TickEngine) GetCandle(timeframe string) *CandleState {
	te.mu.Lock()
	defer te.mu.Unlock()
	c, ok := te.candles[timeframe]
	if !ok {
		return nil
	}
	copy := *c
	return &copy
}

func (te *TickEngine) tick() {
	te.mu.Lock()

	// Random walk
	delta := (rand.Float64() - 0.5) * 2 * maxPipStep
	te.mid = roundTo5(te.mid + delta)

	bid := roundTo5(te.mid - halfSpread)
	ask := roundTo5(te.mid + halfSpread)

	te.priceHistory = append(te.priceHistory, te.mid)
	if len(te.priceHistory) > historyLimit {
		te.priceHistory = te.priceHistory[1:]
	}

	// Update all candle states
	for _, tf := range []string{"M1", "M5", "H1"} {
		candle := te.candles[tf]
		if te.mid > candle.High {
			candle.High = te.mid
		}
		if te.mid < candle.Low {
			candle.Low = te.mid
		}
		candle.Close = te.mid
		candle.Volume++
	}

	// Check wall-clock boundaries for candle closes
	now := time.Now()
	seconds := now.Second()
	minutes := now.Minute()

	var candlesToClose []string

	if seconds < 2 {
		m1Candle := te.candles["M1"]
		if m1Candle.Volume > 0 {
			candlesToClose = append(candlesToClose, "M1")
		}

		if minutes%5 == 0 {
			m5Candle := te.candles["M5"]
			if m5Candle.Volume > 0 {
				candlesToClose = append(candlesToClose, "M5")
			}
		}

		if minutes == 0 {
			h1Candle := te.candles["H1"]
			if h1Candle.Volume > 0 {
				candlesToClose = append(candlesToClose, "H1")
			}
		}
	}

	mid := te.mid
	te.mu.Unlock()

	// Fire callbacks outside the lock
	for _, tf := range candlesToClose {
		te.ForceCandleClose(tf)
	}

	if te.callbacks.OnQuoteUpdate != nil {
		te.callbacks.OnQuoteUpdate(mid, bid, ask)
	}
	if te.callbacks.OnCandleUpdate != nil {
		te.callbacks.OnCandleUpdate("M1")
	}
	if te.callbacks.OnFeatureUpdate != nil {
		te.callbacks.OnFeatureUpdate()
	}
}

func (te *TickEngine) freshCandle(price float64) *CandleState {
	return &CandleState{
		Open:     price,
		High:     price,
		Low:      price,
		Close:    price,
		Volume:   0,
		OpenTime: nowISO(),
		Complete: false,
	}
}

func roundTo5(v float64) float64 {
	return math.Round(v*100000) / 100000
}

func annualizedVol(returns []float64) float64 {
	if len(returns) < 2 {
		return 0
	}
	sum := 0.0
	for _, r := range returns {
		sum += r
	}
	mean := sum / float64(len(returns))
	variance := 0.0
	for _, r := range returns {
		variance += (r - mean) * (r - mean)
	}
	variance /= float64(len(returns) - 1)
	// Each observation is 2 seconds apart.
	// Observations per year = 252 days * 24h * 3600s / 2s = 10,886,400
	obsPerYear := float64(252 * 24 * 3600 / 2)
	return math.Sqrt(variance * obsPerYear)
}

func lastN(slice []float64, n int) []float64 {
	if len(slice) <= n {
		return slice
	}
	return slice[len(slice)-n:]
}
