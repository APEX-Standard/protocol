package main

import (
	"context"
	"log"
	"os"

	"github.com/mark3labs/mcp-go/server"
)

func main() {
	srv := server.NewStdioServer(newServer())
	log.Println("APEX Protocol Reference Server v0.1.0 running")
	if err := srv.Listen(context.Background(), os.Stdin, os.Stdout); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
