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
	s := server.NewMCPServer(
		serverName,
		serverVersion,
		server.WithResourceCapabilities(true, true),
		server.WithToolCapabilities(true),
	)
	registerResources(s, state)
	registerSessionTools(s)
	registerAccountTools(s)
	registerOrderTools(s)
	registerMarketTools(s)
	registerRiskTools(s)
	return s
}
