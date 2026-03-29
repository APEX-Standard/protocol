package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/google/uuid"
	"github.com/mark3labs/mcp-go/server"
)

// sseWriter manages a single SSE connection.
type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
	done    chan struct{}
	closed  bool
	mu      sync.Mutex
}

func newSSEWriter(w http.ResponseWriter) *sseWriter {
	flusher, _ := w.(http.Flusher)
	return &sseWriter{
		w:       w,
		flusher: flusher,
		done:    make(chan struct{}),
	}
}

func (sw *sseWriter) writeEvent(id string, data []byte) error {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	if sw.closed {
		return fmt.Errorf("SSE writer closed")
	}
	var err error
	if id != "" {
		_, err = fmt.Fprintf(sw.w, "id: %s\n", id)
		if err != nil {
			return err
		}
	}
	_, err = fmt.Fprintf(sw.w, "event: message\ndata: %s\n\n", data)
	if err != nil {
		return err
	}
	if sw.flusher != nil {
		sw.flusher.Flush()
	}
	return nil
}

func (sw *sseWriter) close() {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	if !sw.closed {
		sw.closed = true
		close(sw.done)
	}
}

// httpJSONError writes a JSON error response.
func httpJSONError(w http.ResponseWriter, message string, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"error": map[string]any{
			"code":    -32600,
			"message": message,
		},
	})
}

// HttpTransport implements the Streamable HTTP transport for APEX/MCP.
type HttpTransport struct {
	mu            sync.Mutex
	sessionID     string
	subscriptions map[string]struct{}
	replayBuffer  *ReplayBuffer
	sseWriter     *sseWriter
	tickEngine    *TickEngine
	state         *referenceState
}

// NewHttpTransport creates a new HTTP transport.
func NewHttpTransport(state *referenceState) *HttpTransport {
	return &HttpTransport{
		subscriptions: map[string]struct{}{},
		replayBuffer:  NewReplayBuffer(),
		state:         state,
	}
}

// emitNotification stores and sends an APEX notification through SSE.
func (ht *HttpTransport) emitNotification(notif map[string]any) {
	data, err := json.Marshal(notif)
	if err != nil {
		log.Printf("failed to marshal notification: %v", err)
		return
	}

	id := ht.replayBuffer.Store("default", notif)

	ht.mu.Lock()
	sw := ht.sseWriter
	ht.mu.Unlock()

	if sw != nil {
		if err := sw.writeEvent(id, data); err != nil {
			log.Printf("failed to write SSE event: %v", err)
		}
	}
}

// emitResourceUpdated sends a resource/updated notification.
// In HTTP mode, all resource updates are stored in the replay buffer and
// sent via SSE regardless of client subscriptions, matching the behavior
// of the MCP SDK's StreamableHTTPServerTransport.
func (ht *HttpTransport) emitResourceUpdated(uri string) {
	notif := map[string]any{
		"jsonrpc": "2.0",
		"method":  "notifications/resources/updated",
		"params": map[string]any{
			"uri": uri,
		},
	}
	ht.emitNotification(notif)
}

// StartHTTPServer starts the HTTP server on the given port.
func StartHTTPServer(port int) {
	httpState := newReferenceState()
	ht := NewHttpTransport(httpState)

	// Wire replay buffer into state so session tools can access it
	httpState.replayBuffer = ht.replayBuffer

	// Create the MCP server
	srv := newServerWithState(httpState, true)

	mux := http.NewServeMux()

	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			ht.handlePost(w, r, srv, httpState)
		case http.MethodGet:
			ht.handleGet(w, r)
		case http.MethodDelete:
			ht.handleDelete(w, r)
		default:
			httpJSONError(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Set up tick engine
	tickEngine := NewTickEngine(TickEngineCallbacks{
		OnQuoteUpdate: func(mid, bid, ask float64) {
			httpState.UpdateQuote(mid, bid, ask)
			httpState.mu.Lock()
			httpState.bumpLocked(referenceURIs.Quote, referenceURIs.Features)
			httpState.mu.Unlock()
			ht.emitResourceUpdated(referenceURIs.Quote)
			ht.emitResourceUpdated(referenceURIs.Features)
		},
		OnCandleClose: func(timeframe string, candle CandleState) {
			var candleURI string
			switch timeframe {
			case "M1":
				candleURI = referenceURIs.CandlesM1
			case "M5":
				candleURI = referenceURIs.CandlesM5
			default:
				candleURI = referenceURIs.CandlesH1
			}

			httpState.mu.Lock()
			httpState.bumpLocked(candleURI)
			seq := httpState.nextSequence(candleURI)
			httpState.mu.Unlock()

			notif := candleClosedNotification(referenceInstrumentID, timeframe, candle, seq)
			ht.emitNotification(notif)
			ht.emitResourceUpdated(candleURI)
		},
		OnCandleUpdate: func(timeframe string) {
			var candleURI string
			switch timeframe {
			case "M1":
				candleURI = referenceURIs.CandlesM1
			case "M5":
				candleURI = referenceURIs.CandlesM5
			default:
				candleURI = referenceURIs.CandlesH1
			}
			ht.emitResourceUpdated(candleURI)
		},
		OnFeatureUpdate: func() {
			ht.emitResourceUpdated(referenceURIs.Features)
		},
	})
	ht.tickEngine = tickEngine

	// Set notification callback on state for order notifications and kill switch
	httpState.notifyCallback = func(notif map[string]any) {
		ht.emitNotification(notif)
	}

	// Set resource update callback for order tool
	httpState.resourceUpdateCallback = func(uris []string) {
		for _, uri := range uris {
			ht.emitResourceUpdated(uri)
		}
	}

	// Set tick engine reference on state for force candle close
	httpState.tickEngine = tickEngine

	// Set onAuthenticated callback
	httpState.onAuthenticated = func() {
		tickEngine.Start()
		log.Println("Tick engine started after authentication")
	}

	log.Printf("listening on port %d", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), mux); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}

func (ht *HttpTransport) handlePost(w http.ResponseWriter, r *http.Request, srv *server.MCPServer, httpState *referenceState) {
	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		httpJSONError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Parse the message to check method
	var msg incomingMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		httpJSONError(w, "Invalid JSON-RPC", http.StatusBadRequest)
		return
	}

	// Handle initialize — don't require session ID
	if msg.Method == "initialize" {
		ht.mu.Lock()
		ht.sessionID = uuid.NewString()
		sessionID := ht.sessionID
		ht.mu.Unlock()

		response := srv.HandleMessage(context.Background(), raw)
		if response == nil {
			w.WriteHeader(http.StatusAccepted)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", sessionID)
		json.NewEncoder(w).Encode(response)
		return
	}

	// Handle notifications (no id field) — don't require response
	if msg.Method == "notifications/initialized" || (len(msg.ID) == 0 && msg.Method != "") {
		// Validate session
		reqSession := r.Header.Get("Mcp-Session-Id")
		ht.mu.Lock()
		validSession := ht.sessionID != "" && reqSession == ht.sessionID
		ht.mu.Unlock()

		if !validSession && reqSession != "" {
			httpJSONError(w, "Unknown session", http.StatusNotFound)
			return
		}

		w.WriteHeader(http.StatusAccepted)
		return
	}

	// Validate session ID for all other requests
	reqSession := r.Header.Get("Mcp-Session-Id")
	ht.mu.Lock()
	validSession := ht.sessionID != "" && reqSession == ht.sessionID
	ht.mu.Unlock()

	if !validSession {
		if reqSession == "" {
			httpJSONError(w, "Missing Mcp-Session-Id header", http.StatusBadRequest)
		} else {
			httpJSONError(w, "Unknown session", http.StatusNotFound)
		}
		return
	}

	// Handle resources/subscribe and resources/unsubscribe
	if msg.Method == "resources/subscribe" {
		var params struct {
			URI string `json:"uri"`
		}
		_ = json.Unmarshal(msg.Params, &params)
		ht.mu.Lock()
		ht.subscriptions[params.URI] = struct{}{}
		ht.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      rawID(msg.ID),
			"result":  map[string]any{},
		})
		return
	}
	if msg.Method == "resources/unsubscribe" {
		var params struct {
			URI string `json:"uri"`
		}
		_ = json.Unmarshal(msg.Params, &params)
		ht.mu.Lock()
		delete(ht.subscriptions, params.URI)
		ht.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      rawID(msg.ID),
			"result":  map[string]any{},
		})
		return
	}

	// Dispatch to MCP server
	response := srv.HandleMessage(context.Background(), raw)

	if response == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (ht *HttpTransport) handleGet(w http.ResponseWriter, r *http.Request) {
	// Validate session
	reqSession := r.Header.Get("Mcp-Session-Id")
	ht.mu.Lock()
	validSession := ht.sessionID != "" && reqSession == ht.sessionID
	ht.mu.Unlock()

	if !validSession {
		if reqSession == "" {
			httpJSONError(w, "Missing Mcp-Session-Id header", http.StatusBadRequest)
		} else {
			httpJSONError(w, "Unknown session", http.StatusNotFound)
		}
		return
	}

	// Close previous SSE stream if any
	ht.mu.Lock()
	if ht.sseWriter != nil {
		ht.sseWriter.close()
	}
	ht.mu.Unlock()

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	sw := newSSEWriter(w)

	// Handle Last-Event-ID for replay
	lastEventID := r.Header.Get("Last-Event-ID")
	if lastEventID != "" {
		events, ok := ht.replayBuffer.ReplayAfter(lastEventID)
		if !ok {
			// Buffer exhausted — send replay_failed notification directly
			// (not through buildApexNotification envelope, matching TS SDK behavior)
			oldestID := ht.replayBuffer.OldestID()
			notif := map[string]any{
				"jsonrpc": "2.0",
				"method":  "notifications/apex.session.replay_failed",
				"params": map[string]any{
					"reason":             "event_id_outside_log",
					"last_available_id":  fmt.Sprintf("%d", oldestID),
					"requested_event_id": lastEventID,
				},
			}
			data, _ := json.Marshal(notif)
			id := ht.replayBuffer.Store("default", notif)
			_ = sw.writeEvent(id, data)
		} else {
			// Replay buffered events
			for _, evt := range events {
				data, _ := json.Marshal(evt.Message)
				_ = sw.writeEvent(fmt.Sprintf("%d", evt.ID), data)
			}
		}
	}

	// Register as the active SSE writer
	ht.mu.Lock()
	ht.sseWriter = sw
	ht.mu.Unlock()

	// Flush to establish the connection
	if sw.flusher != nil {
		sw.flusher.Flush()
	}

	// Keep the connection open until closed
	select {
	case <-sw.done:
	case <-r.Context().Done():
	}

	ht.mu.Lock()
	if ht.sseWriter == sw {
		ht.sseWriter = nil
	}
	ht.mu.Unlock()
}

func (ht *HttpTransport) handleDelete(w http.ResponseWriter, r *http.Request) {
	reqSession := r.Header.Get("Mcp-Session-Id")
	if reqSession == "" {
		httpJSONError(w, "Missing Mcp-Session-Id header", http.StatusBadRequest)
		return
	}

	ht.mu.Lock()
	validSession := ht.sessionID != "" && reqSession == ht.sessionID
	ht.mu.Unlock()

	if !validSession {
		httpJSONError(w, "Unknown session", http.StatusNotFound)
		return
	}

	// Cleanup
	ht.mu.Lock()
	if ht.sseWriter != nil {
		ht.sseWriter.close()
		ht.sseWriter = nil
	}
	ht.sessionID = ""
	ht.mu.Unlock()

	if ht.tickEngine != nil {
		ht.tickEngine.Stop()
	}

	w.WriteHeader(http.StatusOK)
}
