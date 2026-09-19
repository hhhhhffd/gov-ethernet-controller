.PHONY: server-test server-build agent-test agent-build agent-release web-test compose-up compose-down smoke \
	build-server test-server build-agent test-agent up down

server-test:
	cd server && GOPATH=$${GOPATH:-/tmp/linkwatch-gopath} GOCACHE=$${GOCACHE:-/tmp/linkwatch-go-cache} go test ./...

server-build:
	cd server && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' ./cmd/linkwatch-server

agent-test:
	cargo test --manifest-path agent/Cargo.toml

agent-build:
	cargo build --manifest-path agent/Cargo.toml

agent-release:
	cargo build --release --manifest-path agent/Cargo.toml

web-test:
	./scripts/web-foundation-check.sh

compose-up:
	docker compose up -d --build

compose-down:
	docker compose down

smoke:
	./scripts/smoke.sh

# Keep the command names from the migration brief alongside the descriptive
# names used by existing local scripts.
build-server: server-build
test-server: server-test
build-agent: agent-build
test-agent: agent-test
up: compose-up
down: compose-down
