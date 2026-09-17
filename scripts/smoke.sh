#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_port="${LINKWATCH_SERVER_PORT:-8080}"
base="http://127.0.0.1:${server_port}"
queue_dir="$(mktemp -d)"
target_dir="$(mktemp -d)"
duplicate_payload="$target_dir/offline-event.json"
smoke_device_id="${LINKWATCH_DEVICE_ID:-device-42-primary}"
smoke_device_token="${LINKWATCH_DEVICE_TOKEN:-demo-device-42-primary-token}"
smoke_line_id="${LINKWATCH_LINE_ID:-line-42-primary}"
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

# Development bootstrap must provision the device used by the smoke agent;
# fail early if the server is healthy but the fixture is incomplete.
devices="$(curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/admin/devices")"
printf '%s' "$devices" | grep -Fq -- "$smoke_device_id" || { echo "bootstrap device is missing: $smoke_device_id" >&2; exit 1; }

# Verify the durable offline path before the online upload. A refused local
# port is intentional: the event must remain on disk until the server returns.
LINKWATCH_SERVER_URL="http://127.0.0.1:9" \
LINKWATCH_DEVICE_ID="$smoke_device_id" \
LINKWATCH_DEVICE_TOKEN="$smoke_device_token" \
LINKWATCH_LINE_ID="$smoke_line_id" \
LINKWATCH_QUEUE_DIR="$queue_dir" \
LINKWATCH_PROBE=demo \
CARGO_TARGET_DIR="$target_dir" cargo run --release --manifest-path agent/Cargo.toml -- once

queued_files="$(find "$queue_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"
[[ "$queued_files" == "1" ]] || { echo "offline event was not retained in the filesystem queue" >&2; exit 1; }
cp "$(find "$queue_dir" -maxdepth 1 -type f -name '*.json' -print -quit)" "$duplicate_payload"

LINKWATCH_SERVER_URL="$base" \
LINKWATCH_DEVICE_ID="$smoke_device_id" \
LINKWATCH_DEVICE_TOKEN="$smoke_device_token" \
LINKWATCH_LINE_ID="$smoke_line_id" \
LINKWATCH_QUEUE_DIR="$queue_dir" \
LINKWATCH_PROBE=demo \
CARGO_TARGET_DIR="$target_dir" cargo run --release --manifest-path agent/Cargo.toml -- once

queued_files="$(find "$queue_dir" -maxdepth 1 -type f -name '*.json' -print | wc -l | tr -d ' ')"
[[ "$queued_files" == "0" ]] || { echo "acknowledged queue items were not removed" >&2; exit 1; }

# The online run sends the automatic host name in heartbeat. Verify that the
# server persisted and exposes it through both device-facing API surfaces.
devices_after="$(curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/admin/devices")"
printf '%s' "$devices_after" | grep -Fq '"hostname":"' || {
  echo "heartbeat hostname was not persisted in admin device API" >&2
  exit 1
}
device_detail="$(curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/devices/$smoke_device_id")"
printf '%s' "$device_detail" | grep -Eq '"hostname":"[^"]+"' || {
  echo "heartbeat hostname was not exposed in device detail API" >&2
  exit 1
}

# Replay the acknowledged payload to prove server-side idempotency: the same
# device/event pair must be reported as a duplicate without a second row.
duplicate_body="$(printf '{"measurements":[%s]}' "$(<"$duplicate_payload")")"
duplicate_response="$(curl -fsS -X POST "$base/api/v1/agent/measurements:batch" -H "X-Device-ID: $smoke_device_id" -H "X-Device-Token: $smoke_device_token" -H 'Content-Type: application/json' -d "$duplicate_body")"
printf '%s' "$duplicate_response" | grep -Fq '"duplicates":1' || { echo "duplicate event was not identified" >&2; exit 1; }

lines="$(curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/lines")"
printf '%s' "$lines" | grep -Fq -- "$smoke_line_id" || { echo "seed line is missing: $smoke_line_id" >&2; exit 1; }
measurements="$(curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/lines/$smoke_line_id/measurements")"
printf '%s' "$measurements" | grep -Fq 'client_event_id' || { echo "agent measurement was not persisted" >&2; exit 1; }
printf 'LINKWATCH E2E smoke: PASS (%s)\n' "$base"
