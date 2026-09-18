#!/usr/bin/env bash
set -euo pipefail

# Repeatable, read-mostly P2 integration gate. Mutating rollout/merge/update
# endpoints are covered by unit tests so this harness cannot alter production
# truth while checking cross-surface contracts.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="${P2_ACCEPTANCE_BASE_URL:-http://127.0.0.1:8080}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
pass=0; fail=0; skip=0
pass_check() { pass=$((pass + 1)); echo "PASS $1"; }
fail_check() { fail=$((fail + 1)); echo "FAIL $1${2:+: $2}"; }
skip_check() { skip=$((skip + 1)); echo "SKIP $1${2:+: $2}"; }

cd "$repo_dir"
if (cd server && GOCACHE="${GOCACHE:-/tmp/linkwatch-go-cache}" go test ./...); then
  pass_check "Go P2/P0/P1 regression suites"
else
  fail_check "Go P2/P0/P1 regression suites"
fi
if cargo test --manifest-path agent/Cargo.toml; then
  pass_check "Rust command/config/update regression suites"
else
  fail_check "Rust command/config/update regression suites"
fi
if node --check web/app.js; then
  pass_check "frontend syntax"
else
  fail_check "frontend syntax"
fi

for contract in \
  'agent_commands' 'AGENT_UPDATE' 'LIVE_VERIFY' 'REMOTE_CONFIG' \
  'agent_update_attempts' 'impact-preview' 'configurationHierarchy' \
  'comparison' 'merge' 'split' 'evidence-report' \
  'provider workspace' 'json export' 'notification outbox' 'notifications'; do
  if rg -Fqi "$contract" server agent web; then pass_check "source contract: $contract"; else fail_check "source contract: $contract"; fi
done

if ! curl -fsS --max-time 3 "$base_url/health/ready" >/dev/null 2>&1; then
  skip_check "HTTP P2 cross-surface checks" "healthy runtime unavailable at $base_url"
else
  login_body="$tmp_dir/login.json"
  login_status="$(curl -sS -o "$login_body" -w '%{http_code}' -X POST "$base_url/api/v1/auth/login" -H 'Content-Type: application/json' -d '{"login":"admin","password":"demo"}')"
  token="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$login_body")"
  if [[ "$login_status" != 200 || -z "$token" ]]; then
    fail_check "runtime admin authentication" "HTTP $login_status"
  else
    pass_check "runtime admin authentication"
    auth=(-H "Authorization: Bearer $token")
    check_get() {
      local label="$1" path="$2" body="$tmp_dir/body-$RANDOM" status
      status="$(curl -sS -o "$body" -w '%{http_code}' "${auth[@]}" "$base_url$path")"
      if [[ "$status" == 200 ]]; then pass_check "$label"; else fail_check "$label" "HTTP $status"; fi
    }
    check_get "canonical line/evidence surface" "/api/v1/lines/line-42-primary"
    check_get "historical passport dynamics" "/api/v1/reports/quality-passport?line_id=line-42-primary&from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z"
    check_get "JSON export preview" "/api/v1/exports/preview?kind=raw&format=json&preview=1"
    check_get "notifications outbox" "/api/v1/notifications?limit=5"
    check_get "provider workspace scope" "/api/v1/provider-cases"
    check_get "situation canonical list" "/api/v1/situations"
    check_get "observed agent versions" "/api/v1/agent-versions"
    check_get "audit journal" "/api/v1/audit?limit=5"
    unauthorized="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/v1/admin/agent-updates")"
    if [[ "$unauthorized" == 401 ]]; then pass_check "unauthenticated update protection"; else fail_check "unauthenticated update protection" "HTTP $unauthorized"; fi
  fi
fi

skip_check "Windows/service/reboot matrix" "requires native Windows host"
skip_check "public TLS/ACME" "requires DNS, public host and ACME credentials"
skip_check "live email/Telegram/provider delivery" "requires authorized external endpoints"

echo "P2 SUMMARY: pass=$pass fail=$fail skip=$skip"
if (( fail > 0 )); then exit 1; fi
if (( skip > 0 )); then exit 2; fi
