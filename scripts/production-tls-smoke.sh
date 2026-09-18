#!/usr/bin/env bash
set -euo pipefail

public_url="${LINKWATCH_PUBLIC_URL:?set LINKWATCH_PUBLIC_URL (for example https://monitoring.example)}"
case "$public_url" in
  https://*) ;;
  *) echo "LINKWATCH_PUBLIC_URL must use https://" >&2; exit 2 ;;
esac
public_url="${public_url%/}"
http_url="${LINKWATCH_HTTP_URL:-http://${public_url#https://}}"

redirect_headers="$(curl --silent --show-error --location-trusted --max-redirs 0 -D - -o /dev/null "$http_url/health/ready" || true)"
status="$(printf '%s\n' "$redirect_headers" | awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}' | tr -d '\r')"
location="$(printf '%s\n' "$redirect_headers" | awk 'tolower($1) == "location:" {sub(/^[^:]*:[[:space:]]*/, ""); print; exit}' | tr -d '\r')"
[[ "$status" == "301" || "$status" == "308" ]] || { echo "HTTP endpoint did not redirect (status=${status:-unknown})" >&2; exit 1; }
[[ "$location" == https://* ]] || { echo "HTTP redirect is not HTTPS: ${location:-missing}" >&2; exit 1; }

curl --fail --silent --show-error "$public_url/health/ready" >/dev/null
protected_status="$(curl --silent --show-error -o /dev/null -w '%{http_code}' "$public_url/api/v1/lines")"
[[ "$protected_status" == "401" || "$protected_status" == "403" ]] || {
  echo "Protected endpoint accepted unauthenticated request (status=$protected_status)" >&2
  exit 1
}
printf 'LINKWATCH production TLS smoke: PASS (%s)\n' "$public_url"
