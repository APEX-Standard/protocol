package main

import (
	"github.com/mark3labs/mcp-go/server"
)

const (
	serverName    = "apex-reference"
	serverVersion = "0.1.0"
)

func newServer() *server.MCPServer {
	s := server.NewMCPServer(serverName, serverVersion)
	registerSessionTools(s)
	registerAccountTools(s)
	registerOrderTools(s)
	registerMarketTools(s)
	registerRiskTools(s)
	return s
}
