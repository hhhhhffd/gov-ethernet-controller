#!/usr/bin/env bash
set -euo pipefail

# Read-only HTTP contract gate for TASK-020. The canonical Compose/Rust path is
# still scripts/smoke.sh; this harness verifies the integrated protected API
# surface after a deployment-equivalent runtime is available. It deliberately
# does not create incidents, provider cases, or exports with side effects.

base_url="${P0_ACCEPTANCE_BASE_URL:-http://127.0.0.1:8080}"
admin_login="${P0_ADMIN_LOGIN:-admin}"
admin_password="${P0_ADMIN_PASSWORD:-demo}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pass=0
fail=0
skip=0
last_body=""
last_status=""

record_pass() { pass=$((pass + 1)); echo "PASS $1"; }
record_fail() { fail=$((fail + 1)); echo "FAIL $1${2:+: $2}"; }
record_skip() { skip=$((skip + 1)); echo "SKIP $1${2:+: $2}"; }

request() {
  local method="$1" path="$2" token="${3:-}" body_file="$tmp_dir/response-$RANDOM"
  local -a args=(-sS -o "$body_file" -w '%{http_code}' -X "$method" "$base_url$path" -H 'Accept: application/json')
  [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
  last_status="$(curl "${args[@]}" 2>"$tmp_dir/curl.err" || true)"
  last_body="$body_file"
}

login() {
  local username="$1" password="$2" body_file="$tmp_dir/login-$RANDOM"
  last_status="$(curl -sS -o "$body_file" -w '%{http_code}' -X POST "$base_url/api/v1/auth/login" -H 'Accept: application/json' -H 'Content-Type: application/json' -d "{\"login\":\"$username\",\"password\":\"$password\"}" 2>"$tmp_dir/curl.err" || true)"
  last_body="$body_file"
}

expect_status() {
  local label="$1" method="$2" path="$3" expected="$4" token="${5:-}"
  request "$method" "$path" "$token"
  if [[ "$last_status" == "$expected" ]]; then
    record_pass "$label ($last_status)"
  else
    record_fail "$label" "expected $expected, got ${last_status:-curl failure} $(tr '\n' ' ' <"$tmp_dir/curl.err")"
  fi
}

echo "TASK-020 P0 API acceptance: $base_url"
if ! curl -fsS --max-time "${P0_ACCEPTANCE_TIMEOUT:-5}" "$base_url/health/ready" >/dev/null 2>"$tmp_dir/curl.err"; then
  echo "P0_ACCEPTANCE_INCOMPLETE: runtime is unavailable (${base_url}/health/ready)" >&2
  cat "$tmp_dir/curl.err" >&2
  exit 2
fi

if [[ "${P0_RUN_LOCAL_SCENARIOS:-1}" == "1" && "$base_url" == http://127.0.0.1:* ]]; then
  if scripts/p0-local-acceptance.sh; then
    record_pass "local reproducible P0 scenarios"
  else
    record_fail "local reproducible P0 scenarios"
  fi
else
  record_skip "local reproducible P0 scenarios" "set P0_RUN_LOCAL_SCENARIOS=1 against local Compose runtime"
fi

login_token=""
login "$admin_login" "$admin_password"
login_token="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$last_body")"
if [[ -z "$login_token" ]]; then
  record_fail "admin login" "expected token, got HTTP $last_status"
else
  record_pass "admin login ($last_status)"
fi

expect_status "unauthenticated lines" GET /api/v1/lines 401
expect_status "authenticated lines" GET /api/v1/lines 200 "$login_token"
expect_status "legacy API lines alias" GET /api/lines 200 "$login_token"
expect_status "authenticated overview" GET /api/v1/overview 200 "$login_token"
expect_status "legacy API overview alias" GET /api/overview 200 "$login_token"
expect_status "authenticated organizations" GET /api/v1/organizations 200 "$login_token"
expect_status "authenticated providers" GET /api/v1/providers 200 "$login_token"
expect_status "authenticated incidents" GET /api/v1/incidents 200 "$login_token"
expect_status "authenticated situations" GET /api/v1/situations 200 "$login_token"
expect_status "authenticated quality passport" GET /api/v1/reports/quality-passport 200 "$login_token"
expect_status "authenticated notifications" GET /api/v1/notifications?limit=5 200 "$login_token"
expect_status "authenticated audit" GET /api/v1/audit?limit=5 200 "$login_token"
expect_status "authenticated export preview" GET "/api/v1/exports/preview?kind=raw&format=csv" 200 "$login_token"
expect_status "missing line is scoped 404" GET /api/v1/lines/task-020-missing 404 "$login_token"
expect_status "missing device is scoped 404" GET /api/v1/devices/task-020-missing 404 "$login_token"

if [[ -n "$login_token" ]]; then
  expect_status "admin devices" GET /api/v1/admin/devices 200 "$login_token"
  expect_status "admin users" GET /api/v1/admin/users 200 "$login_token"
  expect_status "admin policies" GET /api/v1/admin/policies 200 "$login_token"
fi

for role in provider-a district school-42; do
  login "$role" "${P0_ROLE_PASSWORD:-demo}"
  role_token="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$last_body")"
  if [[ -z "$role_token" ]]; then
    record_fail "$role login ($role)" "HTTP $last_status"
    continue
  fi
  record_pass "role login ($role)"
  expect_status "$role scoped lines ($role)" GET /api/v1/lines 200 "$role_token"
  expect_status "$role admin denial ($role)" GET /api/v1/admin/devices 403 "$role_token"
  expect_status "$role export scope ($role)" GET "/api/v1/exports/preview?kind=raw&format=csv" 200 "$role_token"
done

record_skip "Windows remaining matrix" "TASK-018 report verifies SCM/runtime and local offline queue; admin/reboot/tray/authenticated-resend/reinstall still require native Windows evidence"
record_skip "live TLS/ACME" "requires DNS, public host and ACME email"
record_skip "live provider delivery" "requires authorized test webhook endpoint and credentials"

echo "TASK-020 SUMMARY: pass=$pass fail=$fail skip=$skip"
if (( fail > 0 )); then
  echo "P0_ACCEPTANCE_INCOMPLETE: API contract failures present" >&2
  exit 1
fi
if (( skip > 0 )); then
  echo "P0_ACCEPTANCE_INCOMPLETE: external/integration evidence remains unavailable" >&2
  exit 2
fi
echo "P0_ACCEPTANCE_PASS: all configured checks passed"
