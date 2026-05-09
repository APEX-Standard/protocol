package main

import (
	"github.com/mark3labs/mcp-go/server"
)

const (
	serverName    = "apex-reference"
	serverVersion = "0.1.0"
)

var state = newReferenceState()

func newServerWithState(s *referenceState) *server.MCPServer {
	srv := server.NewMCPServer(
		serverName,
		serverVersion,
		server.WithResourceCapabilities(true, true),
		server.WithToolCapabilities(true),
	)
	registerResources(srv, s)
	registerSessionToolsWithMode(srv, s)
	registerAccountToolsWithState(srv, s)
	registerOrderToolsWithState(srv, s)
	registerMarketTools(srv)
	registerRiskToolsWithState(srv, s)
	registerFxToolsWithState(srv, s)
	registerCfdToolsWithState(srv, s)
	registerCryptoToolsWithState(srv, s)
	registerForceCandeCloseToolWithState(srv, s)
	registerStopTicksToolWithState(srv, s)
	return srv
}
