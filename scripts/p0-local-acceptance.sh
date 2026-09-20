#!/usr/bin/env bash
set -euo pipefail

# Reproducible local-only P0 fixtures. This script deliberately exercises the
# real agent, HTTP ingest, PostgreSQL state/evidence, AI adapter failure path,
# and row-lock invariant. It does not pretend to cover Windows, public TLS,
# or a live provider transport.

base_url="${P0_ACCEPTANCE_BASE_URL:-http://127.0.0.1:8080}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pass=0
fail=0
record_pass() { pass=$((pass + 1)); echo "PASS $1"; }
record_fail() { fail=$((fail + 1)); echo "FAIL $1${2:+: $2}"; }

login_body="$tmp_dir/login.json"
login_status="$(curl -sS -o "$login_body" -w '%{http_code}' -X POST "$base_url/api/v1/auth/login" -H 'Content-Type: application/json' -d '{"login":"admin","password":"demo"}')"
token="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$login_body")"
if [[ "$login_status" != "200" || -z "$token" ]]; then
  echo "P0_LOCAL_INCOMPLETE: admin login failed (HTTP $login_status)" >&2
  exit 2
fi

# scripts/smoke.sh is the canonical real offline spool/resend fixture. It
# refuses a local endpoint, verifies one durable queue file, then uploads and
# verifies the acknowledged queue is empty and idempotency is preserved.
if smoke_output="$(LINKWATCH_SERVER_PORT="${base_url##*:}" scripts/smoke.sh 2>&1)" && grep -Fq 'LINKWATCH E2E smoke: PASS' <<<"$smoke_output"; then
  record_pass "agent offline spool/resend via canonical smoke"
else
  record_fail "agent offline spool/resend via canonical smoke" "$(tail -n 8 <<<"$smoke_output")"
fi

run_psql() {
  docker compose exec -T postgres psql -U linkwatch -d linkwatch -Atc "$1"
}

stamp="$(date -u +%s)"
device_id="p0-t020-${stamp}"
fixture_line_id="line-99-primary"
register_body="$tmp_dir/register.json"
register_status="$(curl -sS -o "$register_body" -w '%{http_code}' -X POST "$base_url/api/v1/admin/devices/register" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "{\"device_id\":\"$device_id\",\"monitoring_point_id\":\"point-99-primary\",\"display_name\":\"P0 T020 fixture $stamp\",\"agent_version\":\"p0-test\"}")"
device_token="$(sed -n 's/.*"device_token":"\([^"]*\)".*/\1/p' "$register_body")"
if [[ "$register_status" != "201" || -z "$device_token" ]]; then
  record_fail "register isolated ingest fixture" "HTTP $register_status"
else
  record_pass "register isolated ingest fixture"
fi

if [[ -n "$device_token" ]]; then
  t0="$(date -u -d '3 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
  t1="$(date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
  t2="$(date -u -d '1 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
  ingest_body="$tmp_dir/ingest.json"
  cat >"$ingest_body" <<EOF
{"measurements":[
 {"client_event_id":"p0-t020-${stamp}-1","observed_at":"$t0","mode":"PERFORMANCE","download":0,"upload":0,"ping":999,"jitter":999,"packet_loss":100,"availability":0,"connection_status":"OK"},
 {"client_event_id":"p0-t020-${stamp}-2","observed_at":"$t1","mode":"PERFORMANCE","download":0,"upload":0,"ping":999,"jitter":999,"packet_loss":100,"availability":0,"connection_status":"OK"},
 {"client_event_id":"p0-t020-${stamp}-3","observed_at":"$t2","mode":"PERFORMANCE","download":0,"upload":0,"ping":999,"jitter":999,"packet_loss":100,"availability":0,"connection_status":"OK"}
]}
EOF
  ingest_response="$tmp_dir/ingest-response.json"
  ingest_status="$(curl -sS -o "$ingest_response" -w '%{http_code}' -X POST "$base_url/api/v1/agent/measurements:batch" -H "X-Device-ID: $device_id" -H "X-Device-Token: $device_token" -H 'Content-Type: application/json' --data-binary "@$ingest_body")"
  if [[ "$ingest_status" == "200" ]] && grep -Fq '"accepted":3' "$ingest_response"; then
    record_pass "three measurement ingest accepted"
  else
    record_fail "three measurement ingest accepted" "HTTP $ingest_status $(tr '\n' ' ' <"$ingest_response")"
  fi
  measured="$(run_psql "SELECT COUNT(*) FROM measurements WHERE device_id='$device_id' AND client_event_id LIKE 'p0-t020-${stamp}-%';")"
  incident="$(run_psql "SELECT COUNT(*) FROM incidents WHERE line_id='$fixture_line_id' AND violation_type IN ('BASELINE_DOWNLOAD','CONTRACT_DOWNLOAD','BASELINE_UPLOAD','CONTRACT_UPLOAD','BASELINE_PING','BASELINE_PACKET_LOSS');")"
  incident_id="$(run_psql "SELECT id FROM incidents WHERE line_id='$fixture_line_id' AND status IN ('NEW','SENT_TO_PROVIDER','IN_PROGRESS','WAITING_INFO','RESOLVED') ORDER BY id DESC LIMIT 1;")"
  state="$(run_psql "SELECT data_state || '|' || contract_state FROM line_states WHERE line_id='$fixture_line_id';")"
  if [[ "$measured" == "3" && "$incident" -ge 1 && "$state" == "FRESH|DEVIATES" ]]; then
    record_pass "ingest to confirmed state/incident evidence (count=3)"
  else
    record_fail "ingest to confirmed state/incident evidence" "measurements=$measured incidents=$incident state=$state"
  fi

  # A confirmed incident is not historical/closed until the real recovery
  # policy has been satisfied. Drive that transition through authenticated
  # ingest so this check proves persistence rather than counting an unrelated
  # row left by another fixture.
  recovery_0="$(date -u -d '45 seconds ago' +%Y-%m-%dT%H:%M:%SZ)"
  recovery_1="$(date -u -d '30 seconds ago' +%Y-%m-%dT%H:%M:%SZ)"
  recovery_2="$(date -u -d '15 seconds ago' +%Y-%m-%dT%H:%M:%SZ)"
  recovery_body="$tmp_dir/recovery.json"
  cat >"$recovery_body" <<EOF
{"measurements":[
 {"client_event_id":"p0-t020-${stamp}-recovery-1","observed_at":"$recovery_0","mode":"PERFORMANCE","download":100,"upload":100,"ping":20,"jitter":1,"packet_loss":0,"availability":100,"connection_status":"OK"},
 {"client_event_id":"p0-t020-${stamp}-recovery-2","observed_at":"$recovery_1","mode":"PERFORMANCE","download":100,"upload":100,"ping":20,"jitter":1,"packet_loss":0,"availability":100,"connection_status":"OK"},
 {"client_event_id":"p0-t020-${stamp}-recovery-3","observed_at":"$recovery_2","mode":"PERFORMANCE","download":100,"upload":100,"ping":20,"jitter":1,"packet_loss":0,"availability":100,"connection_status":"OK"}
]}
EOF
  recovery_response="$tmp_dir/recovery-response.json"
  recovery_status="$(curl -sS -o "$recovery_response" -w '%{http_code}' -X POST "$base_url/api/v1/agent/measurements:batch" -H "X-Device-ID: $device_id" -H "X-Device-Token: $device_token" -H 'Content-Type: application/json' --data-binary "@$recovery_body")"
  if [[ "$recovery_status" == "200" ]] && grep -Fq '"accepted":3' "$recovery_response"; then
    record_pass "three recovery measurements accepted"
  else
    record_fail "three recovery measurements accepted" "HTTP $recovery_status $(tr '\n' ' ' <"$recovery_response")"
  fi

  closed_duration=0
  incident_state="missing"
  if [[ "$incident_id" =~ ^[0-9]+$ ]]; then
    incident_state="$(run_psql "SELECT status || '|' || recovery_state || '|' || COALESCE(duration_minutes::text,'NULL') FROM incidents WHERE id=$incident_id;")"
    closed_duration="$(run_psql "SELECT COUNT(*) FROM incidents WHERE id=$incident_id AND status='CLOSED' AND recovery_state='CONFIRMED' AND closed_at IS NOT NULL AND duration_minutes IS NOT NULL AND duration_minutes > 0 AND duration_minutes = EXTRACT(EPOCH FROM (closed_at-started_at))/60;")"
  fi
  if [[ "$closed_duration" == "1" ]]; then
    record_pass "historical confirmed incident duration persisted"
  else
    record_fail "historical confirmed incident duration persisted" "incident_id=$incident_id state=$incident_state"
  fi
fi

# Create a real editable line-rooted ProviderCase, then use the production
# Ollama adapter with its unavailable local endpoint. The failure must be
# durable and must not bypass human review/send gating.
case_body="$tmp_dir/case.json"
case_status="$(curl -sS -o "$case_body" -w '%{http_code}' -X POST "$base_url/api/v1/provider-cases" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "{\"line_id\":\"$fixture_line_id\",\"comment\":\"P0 unavailable Ollama fixture\"}")"
case_id="$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' "$case_body")"
if [[ "$case_status" != "201" || -z "$case_id" ]]; then
  record_fail "create editable ProviderCase fixture" "HTTP $case_status"
else
  record_pass "create editable ProviderCase fixture"
  ai_body="$tmp_dir/ai.json"
  ai_status="$(curl -sS -o "$ai_body" -w '%{http_code}' -X POST "$base_url/api/v1/provider-cases/$case_id/ai-draft" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"request_id":"p0-t020-unavailable"}')"
  generation="$(run_psql "SELECT COUNT(*) FROM provider_case_draft_generations WHERE provider_case_id=$case_id AND status='FAILED';")"
  case_state="$(run_psql "SELECT status || '|' || delivery_status FROM provider_cases WHERE id=$case_id;")"
  if [[ "$ai_status" == "502" && "$generation" == "1" && "$case_state" == "DRAFT|PENDING" ]]; then
    record_pass "Ollama unavailable path persisted failed generation and editable case"
  else
    record_fail "Ollama unavailable path persisted failed generation and editable case" "HTTP $ai_status generations=$generation state=$case_state"
  fi
  gate_body="$tmp_dir/gate.json"
  gate_status="$(curl -sS -o "$gate_body" -w '%{http_code}' -X POST "$base_url/api/v1/provider-cases/$case_id/send" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"reviewed":false}')"
  if [[ "$gate_status" == "409" ]]; then
    record_pass "ProviderCase human review/send gate preserved"
  else
    record_fail "ProviderCase human review/send gate preserved" "HTTP $gate_status"
  fi
fi

# Two concurrent attempts to deactivate the last active point are serialized
# by the canonical line lock; both attempts must return the invariant's 409.
point_payload='{"id":"point-42-primary","line_id":"line-42-primary","location":"Primary","is_primary":true,"active":false}'
status_one="$tmp_dir/point-one.status"
status_two="$tmp_dir/point-two.status"
curl -sS -o /dev/null -w '%{http_code}' -X PUT "$base_url/api/v1/admin/monitoring-points/point-42-primary" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$point_payload" >"$status_one" &
pid_one=$!
curl -sS -o /dev/null -w '%{http_code}' -X PUT "$base_url/api/v1/admin/monitoring-points/point-42-primary" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$point_payload" >"$status_two" &
pid_two=$!
wait "$pid_one" || true
wait "$pid_two" || true
if [[ "$(<"$status_one")" == "409" && "$(<"$status_two")" == "409" ]]; then
  record_pass "concurrent last active PRIMARY point conflict (both 409)"
else
  record_fail "concurrent last active PRIMARY point conflict" "statuses=$(<"$status_one"),$(<"$status_two")"
fi
active_points="$(run_psql "SELECT COUNT(*) FROM monitoring_points WHERE line_id='line-42-primary' AND active;")"
if [[ "$active_points" == "1" ]]; then
  record_pass "PRIMARY last-point invariant preserved"
else
  record_fail "PRIMARY last-point invariant preserved" "active_points=$active_points"
fi

# A period with no evidence must stay explicitly NO_DATA in historical output.
nodata_body="$tmp_dir/nodata.json"
nodata_status="$(curl -sS -o "$nodata_body" -w '%{http_code}' -G "$base_url/api/v1/reports/quality-passport" -H "Authorization: Bearer $token" --data-urlencode 'line_id=line-99-primary' --data-urlencode 'from=2020-01-01T00:00:00Z' --data-urlencode 'to=2020-01-02T00:00:00Z')"
if [[ "$nodata_status" == "200" ]] && grep -Eq '"no_data_duration_minutes":([1-9][0-9]*|[0-9]+\.[0-9]+)' "$nodata_body"; then
  record_pass "historical NO_DATA period contract"
else
  record_fail "historical NO_DATA period contract" "HTTP $nodata_status $(tr '\n' ' ' <"$nodata_body")"
fi

# Browser static contract gate: verify the deployed shell and canonical client
# vocabulary are served by the same runtime as the API. This remains a static
# smoke check when Playwright is not installed in the environment.
index_body="$tmp_dir/index.html"
app_body="$tmp_dir/app.js"
styles_body="$tmp_dir/styles.css"
i18n_body="$tmp_dir/i18n.mjs"
presentation_body="$tmp_dir/presentation.mjs"
notifications_body="$tmp_dir/notifications.mjs"
index_status="$(curl -sS -o "$index_body" -w '%{http_code}' "$base_url/")"
app_status="$(curl -sS -o "$app_body" -w '%{http_code}' "$base_url/static/app.js")"
styles_status="$(curl -sS -o "$styles_body" -w '%{http_code}' "$base_url/static/styles.css")"
i18n_status="$(curl -sS -o "$i18n_body" -w '%{http_code}' "$base_url/static/core/i18n.mjs")"
presentation_status="$(curl -sS -o "$presentation_body" -w '%{http_code}' "$base_url/static/core/presentation.mjs")"
notifications_status="$(curl -sS -o "$notifications_body" -w '%{http_code}' "$base_url/static/features/notifications.mjs")"
if [[ "$index_status" == "200" && "$app_status" == "200" && "$styles_status" == "200" && "$i18n_status" == "200" && "$presentation_status" == "200" && "$notifications_status" == "200" ]] \
  && grep -Fq '/static/app.js' "$index_body" \
  && grep -Fq 'from "./core/i18n.mjs"' "$app_body" \
  && grep -Fq 'from "./core/presentation.mjs"' "$app_body" \
  && grep -Fq 'from "./features/notifications.mjs"' "$app_body" \
  && grep -Fq '"status.NO_DATA"' "$i18n_body" \
  && grep -Fq '"statusDetail.NO_DATA"' "$i18n_body" \
  && grep -Fq 'export function createPresentation' "$presentation_body"; then
  record_pass "browser shell/static canonical contract"
else
  record_fail "browser shell/static canonical contract" "statuses=$index_status,$app_status,$styles_status,$i18n_status,$presentation_status,$notifications_status"
fi

echo "P0 LOCAL SUMMARY: pass=$pass fail=$fail"
if (( fail > 0 )); then
  exit 1
fi
