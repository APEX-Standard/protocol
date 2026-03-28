package main

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
)

type incomingMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func main() {
	srv := newServer()
	subscriptions := map[string]struct{}{}
	scanner := bufio.NewScanner(os.Stdin)

	log.Println("APEX Protocol Reference Server v0.1.0 running")

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var message incomingMessage
		if err := json.Unmarshal(line, &message); err != nil {
			writeJSON(map[string]any{
				"jsonrpc": "2.0",
				"id":      nil,
				"error": map[string]any{
					"code":    -32700,
					"message": "Parse error: " + err.Error(),
				},
			})
			continue
		}

		switch message.Method {
		case "resources/subscribe":
			var params struct {
				URI string `json:"uri"`
			}
			_ = json.Unmarshal(message.Params, &params)
			subscriptions[params.URI] = struct{}{}
			writeJSON(map[string]any{"jsonrpc": "2.0", "id": rawID(message.ID), "result": map[string]any{}})
			continue
		case "resources/unsubscribe":
			var params struct {
				URI string `json:"uri"`
			}
			_ = json.Unmarshal(message.Params, &params)
			delete(subscriptions, params.URI)
			writeJSON(map[string]any{"jsonrpc": "2.0", "id": rawID(message.ID), "result": map[string]any{}})
			continue
		}

		response := srv.HandleMessage(context.Background(), append([]byte(nil), line...))
		if response != nil {
			writeJSON(response)
		}

		if message.Method == string(mcp.MethodToolsCall) {
			for _, uri := range state.drainPendingUpdates() {
				if _, ok := subscriptions[uri]; !ok {
					continue
				}
				writeJSON(map[string]any{
					"jsonrpc": "2.0",
					"method":  mcp.MethodNotificationResourceUpdated,
					"params": map[string]any{
						"uri": uri,
					},
				})
			}
		}
	}

	if err := scanner.Err(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func rawID(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		return nil
	}
	return decoded
}

func writeJSON(value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		log.Printf("marshal error: %v", err)
		return
	}
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}
