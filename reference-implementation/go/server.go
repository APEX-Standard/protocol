package main

import (
	"github.com/mark3labs/mcp-go/server"
)

const (
	serverName    = "apex-reference"
	serverVersion = "0.1.0"
)

var state = newReferenceState()

func newServer() *server.MCPServer {
	return newServerWithState(state, false)
}

func newServerWithState(s *referenceState, httpMode bool) *server.MCPServer {
	srv := server.NewMCPServer(
		serverName,
		serverVersion,
		server.WithResourceCapabilities(true, true),
		server.WithToolCapabilities(true),
	)
	registerResources(srv, s)
	registerSessionToolsWithMode(srv, s, httpMode)
	registerAccountTools(srv)
	registerOrderToolsWithState(srv, s)
	registerMarketTools(srv)
	registerRiskToolsWithState(srv, s)
	registerFxToolsWithState(srv, s)
	registerCfdToolsWithState(srv, s)
	registerCryptoToolsWithState(srv, s)
	if httpMode {
		registerForceCandeCloseToolWithState(srv, s)
		registerStopTicksToolWithState(srv, s)
	}
	return srv
}
