package main

import (
	"fmt"
	"os"
	"strconv"
)

const defaultHTTPPort = 8888

func main() {
	port := defaultHTTPPort

	if len(os.Args) > 1 {
		if os.Args[1] != "--http" || len(os.Args) > 3 {
			usage()
		}

		if len(os.Args) == 3 {
			parsed, err := strconv.Atoi(os.Args[2])
			if err != nil || parsed < 1 || parsed > 65535 {
				usage()
			}
			port = parsed
		}
	}

	StartHTTPServer(port)
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: apex-reference [--http <port>]")
	os.Exit(1)
}
