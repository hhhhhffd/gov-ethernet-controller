#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
server_url="${LINKWATCH_SERVER_URL:-${VKO_SERVER_URL:-http://127.0.0.1:8000}}"
device_id="${LINKWATCH_DEVICE_ID:-${VKO_DEVICE_ID:-device-42-primary}}"
device_token="${LINKWATCH_DEVICE_TOKEN:-${VKO_DEVICE_TOKEN:-}}"

if [[ -z "$device_token" ]]; then
  echo "LINKWATCH_DEVICE_TOKEN must be set (use the token returned by device registration)." >&2
  exit 2
fi

cd "$repo_dir"
LINKWATCH_SERVER_URL="$server_url" \
LINKWATCH_DEVICE_ID="$device_id" \
LINKWATCH_DEVICE_TOKEN="$device_token" \
cargo run --release --manifest-path agent/Cargo.toml -- once
