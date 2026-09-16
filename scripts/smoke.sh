#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_port="${LINKWATCH_SERVER_PORT:-8080}"
base="http://127.0.0.1:${server_port}"
queue_dir="$(mktemp -d)"
target_dir="$(mktemp -d)"
trap 'rm -rf "$queue_dir" "$target_dir"' EXIT

cd "$repo_dir"
LINKWATCH_SERVER_PORT="$server_port" docker compose up -d --build >/dev/null
for attempt in $(seq 1 40); do
  if curl -fsS "$base/health/ready" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 40 ]]; then
    echo "LINKWATCH server did not become ready" >&2
    docker compose logs --no-color --tail=80 linkwatch-server >&2 || true
    exit 1
  fi
  sleep 1
done

login_response="$(curl -fsS -X POST "$base/api/v1/auth/login" -H 'Content-Type: application/json' -d '{"login":"admin","password":"demo"}')"
token="$(printf '%s' "$login_response" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[[ -n "$token" ]] || { echo "login did not return a bearer token" >&2; exit 1; }

LINKWATCH_SERVER_URL="$base" \
LINKWATCH_DEVICE_ID="${LINKWATCH_DEVICE_ID:-device-42-primary}" \
LINKWATCH_DEVICE_TOKEN="${LINKWATCH_DEVICE_TOKEN:-demo-device-42-primary-token}" \
LINKWATCH_QUEUE_DIR="$queue_dir" \
LINKWATCH_PROBE=demo \
CARGO_TARGET_DIR="$target_dir" cargo run --release --manifest-path agent/Cargo.toml -- once

lines="$(curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/lines")"
printf '%s' "$lines" | grep -q 'line-42-primary' || { echo "seed line is missing" >&2; exit 1; }
measurements="$(curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/lines/line-42-primary/measurements")"
printf '%s' "$measurements" | grep -q 'client_event_id' || { echo "agent measurement was not persisted" >&2; exit 1; }
printf 'LINKWATCH E2E smoke: PASS (%s)\n' "$base"
