#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
server_url="${VKO_SERVER_URL:-http://127.0.0.1:8000}"
device_id="${VKO_DEVICE_ID:-device-42-primary}"
device_token="${VKO_DEVICE_TOKEN:-}"

if [[ -z "$device_token" ]]; then
  echo "VKO_DEVICE_TOKEN must be set (use the token returned by device registration)." >&2
  exit 2
fi

cd "$repo_dir"
VKO_SERVER_URL="$server_url" \
VKO_DEVICE_ID="$device_id" \
VKO_DEVICE_TOKEN="$device_token" \
PYTHONPATH=agent .venv/bin/python -m vko_agent --server "$server_url" --once
