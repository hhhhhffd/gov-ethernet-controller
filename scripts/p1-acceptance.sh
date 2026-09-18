#!/usr/bin/env bash
set -euo pipefail

# Repeatable P1 acceptance gate. Unit/static checks are always runnable; the
# HTTP section is executed only when a healthy compose/runtime endpoint exists.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="${P1_ACCEPTANCE_BASE_URL:-http://127.0.0.1:8080}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pass=0
fail=0
record_pass() { pass=$((pass + 1)); echo "PASS $1"; }
record_fail() { fail=$((fail + 1)); echo "FAIL $1${2:+: $2}"; }

cd "$repo_dir"
if (cd server && GOCACHE="${GOCACHE:-/tmp/linkwatch-go-cache}" go test ./...); then
  record_pass "backend P1/P0 unit and permission suites"
else
  record_fail "backend P1/P0 unit and permission suites"
fi
if node --check web/app.js; then
  record_pass "frontend syntax/static contract"
else
  record_fail "frontend syntax/static contract"
fi

for required in \
  'line_context_versions' \
  'line_context_snapshot_json' \
  'measurement_verifications' \
  'evidence_chain' \
  'dynamics' \
  'INCOMPARABLE' \
  'INSUFFICIENT_DATA' \
  'первопричину'; do
  if rg -Fq "$required" server web; then
    record_pass "source contract: $required"
  else
    record_fail "source contract: $required"
  fi
done

if ! curl -fsS --max-time 3 "$base_url/health/ready" >/dev/null 2>&1; then
  echo "P1_RUNTIME_INCOMPLETE: healthy runtime unavailable at $base_url" >&2
  echo "P1 SUMMARY: pass=$pass fail=$fail runtime=blocked"
  exit 2
fi

login_body="$tmp_dir/login.json"
login_status="$(curl -sS -o "$login_body" -w '%{http_code}' -X POST "$base_url/api/v1/auth/login" -H 'Content-Type: application/json' -d '{"login":"admin","password":"demo"}')"
token="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$login_body")"
if [[ "$login_status" != "200" || -z "$token" ]]; then
  record_fail "runtime admin authentication" "HTTP $login_status"
else
  record_pass "runtime admin authentication"
  auth=(-H "Authorization: Bearer $token")
  context_body="$tmp_dir/context.json"
  context_status="$(curl -sS -o "$context_body" -w '%{http_code}' "${auth[@]}" "$base_url/api/v1/lines/line-42-primary/context")"
  if [[ "$context_status" == "200" ]] && grep -Fq 'resolved_context' "$context_body" && grep -Fq 'versions' "$context_body"; then
    record_pass "line context historical resolution surface"
  else
    record_fail "line context historical resolution surface" "HTTP $context_status"
  fi

  line_body="$tmp_dir/line.json"
  line_status="$(curl -sS -o "$line_body" -w '%{http_code}' "${auth[@]}" "$base_url/api/v1/lines/line-42-primary")"
  if [[ "$line_status" == "200" ]] && grep -Fq 'evidence_chain' "$line_body" && grep -Fq 'line_context_snapshot' "$line_body"; then
    record_pass "cross-surface line evidence chain"
  else
    record_fail "cross-surface line evidence chain" "HTTP $line_status"
  fi

  passport_body="$tmp_dir/passport.json"
  passport_status="$(curl -sS -o "$passport_body" -w '%{http_code}' -G "${auth[@]}" "$base_url/api/v1/reports/quality-passport" --data-urlencode 'line_id=line-42-primary' --data-urlencode 'from=2020-01-01T00:00:00Z' --data-urlencode 'to=2020-01-02T00:00:00Z')"
  if [[ "$passport_status" == "200" ]] && grep -Eq '"dynamics".*("NO_DATA"|"INSUFFICIENT_DATA"|"INCOMPARABLE")' "$passport_body"; then
    record_pass "passport explicit insufficient/NO_DATA dynamics"
  else
    record_fail "passport explicit insufficient/NO_DATA dynamics" "HTTP $passport_status"
  fi

  situations_body="$tmp_dir/situations.json"
  situations_status="$(curl -sS -o "$situations_body" -w '%{http_code}' "${auth[@]}" "$base_url/api/v1/situations")"
  situation_id="$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' "$situations_body" | head -1)"
  if [[ "$situations_status" == "200" && -z "$situation_id" ]]; then
    record_pass "scoped situation list with empty-safe result"
  elif [[ "$situations_status" == "200" && -n "$situation_id" ]]; then
    situation_body="$tmp_dir/situation.json"
    detail_status="$(curl -sS -o "$situation_body" -w '%{http_code}' "${auth[@]}" "$base_url/api/v1/situations/$situation_id")"
    if [[ "$detail_status" == "200" ]] && grep -Fq 'evidence' "$situation_body" && grep -Fq 'projection' "$situation_body"; then
      record_pass "scoped situation evidence/correlation detail"
    else
      record_fail "scoped situation evidence/correlation detail" "HTTP $detail_status"
    fi
  else
    record_fail "scoped situation list" "HTTP $situations_status"
  fi
fi

echo "P1 SUMMARY: pass=$pass fail=$fail runtime=available"
if (( fail > 0 )); then exit 1; fi
