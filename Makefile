.PHONY: build test lint install clean

BIN_EXT := $(if $(filter windows,$(shell go env GOOS)),.exe,)

build:
	go build -o bin/sijilat-pp-cli$(BIN_EXT) ./cmd/sijilat-pp-cli

test:
	go test ./...

lint:
	golangci-lint run

install:
	go install ./cmd/sijilat-pp-cli

clean:
	rm -rf bin/

build-mcp:
	go build -o bin/sijilat-pp-mcp$(BIN_EXT) ./cmd/sijilat-pp-mcp

install-mcp:
	go install ./cmd/sijilat-pp-mcp

build-all: build build-mcp
