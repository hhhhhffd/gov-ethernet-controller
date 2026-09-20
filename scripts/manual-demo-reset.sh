#!/usr/bin/env bash
set -euo pipefail

base_url="${LINKWATCH_SERVER_URL:-http://127.0.0.1:${LINKWATCH_SERVER_PORT:-8080}}"
base_url="${base_url%/}"

for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 3 "$base_url/health/ready" >/dev/null; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo "LINKWATCH is not ready at $base_url/health/ready" >&2
    exit 1
  fi
  sleep 1
done

login_response="$(curl --fail --silent --show-error --max-time 10 \
  --request POST "$base_url/api/v1/auth/login" \
  --header 'Content-Type: application/json' \
  --data '{"login":"admin","password":"demo"}')"
token="$(printf '%s' "$login_response" | sed -nE 's/.*"token":"([^"]+)".*/\1/p')"

if [[ -z "$token" ]]; then
  echo "Admin login succeeded without a session token." >&2
  exit 1
fi

reset_response="$(curl --fail --silent --show-error --max-time 15 \
  --request POST "$base_url/api/v1/admin/demo/reset" \
  --header "Authorization: Bearer $token")"

if [[ "$reset_response" != *'"reset":true'* ]]; then
  echo "Demo reset returned an unexpected response." >&2
  exit 1
fi

printf '%s\n' \
  'Demo database reset.' \
  'School 32 ready.' \
  'line-42-primary ready.' \
  'device-42-primary ready.' \
  "Open $base_url"
