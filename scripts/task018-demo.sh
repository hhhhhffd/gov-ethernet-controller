#!/usr/bin/env bash
set -u -o pipefail

# TASK-018 deterministic demo acceptance. This script uses the development
# seed/reset API and the authenticated measurement ingest path. It never
# writes the database directly and never treats an AI outage as AI success.

base_url="${TASK018_BASE_URL:-http://127.0.0.1:8080}"
line_id="line-42-primary"
device_id="device-42-primary"
device_token="${TASK018_DEVICE_TOKEN:-demo-device-42-primary-token}"
admin_login="${TASK018_ADMIN_LOGIN:-admin}"
admin_password="${TASK018_ADMIN_PASSWORD:-demo}"
registry_school_id="18383"
registry_school_name="Коммунальное государственное учреждение «Средняя школа №32» отдела образования по городу Усть-Каменогорску управления образования Восточно-Казахстанской области"
registry_school_latitude="49.988825"
registry_school_longitude="82.575407"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pass_count=0
fail_count=0
blocked_count=0
run_count=0
runs_passed=0
run_start_epoch=0
run_tmp=""
call_status=""
call_body=""
call_headers=""

pass() {
  pass_count=$((pass_count + 1))
  printf 'PASS %s\n' "$1"
}

fail() {
  fail_count=$((fail_count + 1))
  printf 'FAIL %s%s\n' "$1" "${2:+: $2}" >&2
}

blocked() {
  blocked_count=$((blocked_count + 1))
  printf 'BLOCKED_EXTERNAL %s%s\n' "$1" "${2:+: $2}" >&2
}

json_path() {
  local file="$1"
  local path="$2"
  node - "$file" "$path" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const path = process.argv[3];
let value;
try {
  value = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const part of path.split(".")) {
    if (value === null || value === undefined) {
      value = undefined;
      break;
    }
    value = value[part];
  }
  if (value === null || value === undefined) {
    process.exit(0);
  }
  if (typeof value === "object") {
    process.stdout.write(JSON.stringify(value));
  } else {
    process.stdout.write(String(value));
  }
} catch (_) {
  process.exit(1);
}
NODE
}

api_call() {
  local name="$1"
  local method="$2"
  local path="$3"
  local payload="${4-}"
  call_body="$run_tmp/${name}.json"
  call_headers="$run_tmp/${name}.headers"
  if [[ -n "$payload" ]]; then
    call_status="$(curl -sS --max-time 15 -D "$call_headers" -o "$call_body" -w '%{http_code}' \
      -X "$method" "$base_url$path" \
      -H "Authorization: Bearer $admin_token" \
      -H 'Content-Type: application/json' \
      --data "$payload" 2>/dev/null || printf '000')"
  else
    call_status="$(curl -sS --max-time 15 -D "$call_headers" -o "$call_body" -w '%{http_code}' \
      -X "$method" "$base_url$path" \
      -H "Authorization: Bearer $admin_token" 2>/dev/null || printf '000')"
  fi
}

device_call() {
  local name="$1"
  local payload="$2"
  call_body="$run_tmp/${name}.json"
  call_status="$(curl -sS --max-time 15 -o "$call_body" -w '%{http_code}' \
    -X POST "$base_url/api/v1/agent/measurements:batch" \
    -H "X-Device-ID: $device_id" \
    -H "X-Device-Token: $device_token" \
    -H 'Content-Type: application/json' \
    --data "$payload" 2>/dev/null || printf '000')"
}

login() {
  local name="$1"
  local body="$run_tmp/${name}.json"
  local status
  status="$(curl -sS --max-time 15 -o "$body" -w '%{http_code}' \
    -X POST "$base_url/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    --data "{\"login\":\"$admin_login\",\"password\":\"$admin_password\"}" 2>/dev/null || printf '000')"
  if [[ "$status" != "200" ]]; then
    fail "run $run_count admin login" "HTTP $status"
    return 1
  fi
  admin_token="$(json_path "$body" token)"
  if [[ -z "$admin_token" ]]; then
    fail "run $run_count admin login" "token missing"
    return 1
  fi
  return 0
}

iso_at() {
  date -u -d "@$((run_start_epoch + $1))" '+%Y-%m-%dT%H:%M:%SZ'
}

measurement_payload() {
  local event_id="$1"
  local observed_at="$2"
  local download="$3"
  local upload="$4"
  local phase="$5"
  printf '{"measurements":[{"client_event_id":"%s","observed_at":"%s","mode":"PERFORMANCE","download":%s,"upload":%s,"ping":22,"jitter":7,"packet_loss":0.4,"availability":100,"connection_status":"OK","quality":"VALID","latency_method":"DEMO","raw":{"probe":"demo","scenario":"TASK-018","measurement_class":"DEMO_TEST_ONLY","provenance":"synthetic-development-fixture","registry_school_id":"%s","run":%s,"phase":"%s"}}]}' \
    "$event_id" "$observed_at" "$download" "$upload" "$registry_school_id" "$run_count" "$phase"
}

send_measurement() {
  local phase="$1"
  local offset="$2"
  local download="$3"
  local upload="$4"
  local event_id="task018-run-${run_count}-${phase}"
  device_call "$phase" "$(measurement_payload "$event_id" "$(iso_at "$offset")" "$download" "$upload" "$phase")"
  if [[ "$call_status" != "200" ]] || [[ "$(json_path "$call_body" accepted)" != "1" ]]; then
    fail "run $run_count $phase measurement" "HTTP $call_status $(head -c 300 "$call_body")"
    return 1
  fi
  pass "run $run_count $phase measurement accepted"
  return 0
}

assert_line_and_normal() {
  api_call "lines" GET "/api/v1/lines"
  if [[ "$call_status" != "200" ]] || ! node - "$call_body" "$line_id" "$registry_school_id" "$registry_school_name" "$registry_school_latitude" "$registry_school_longitude" <<'NODE'
const fs = require("fs");
const [file, lineID, registrySchoolID, schoolName, latitude, longitude] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(file, "utf8"));
const line = Array.isArray(rows) ? rows.find((item) => item && item.id === lineID) : null;
const valid = line
  && line.school_id === registrySchoolID
  && line.school_name === schoolName
  && Number(line.latitude) === Number(latitude)
  && Number(line.longitude) === Number(longitude);
if (!valid) {
  console.error(JSON.stringify({ expected: { lineID, registrySchoolID, schoolName, latitude, longitude }, line }, null, 2));
  process.exit(1);
}
NODE
  then
    fail "run $run_count registry School №32 / primary line" "HTTP $call_status or official identity mismatch"
    return 1
  fi
  pass "run $run_count registry School №32 / primary line"
  send_measurement normal -720 105 105 normal || return 1
  api_call "normal-measurements" GET "/api/v1/lines/$line_id/measurements"
  if [[ "$call_status" != "200" ]] || ! node - "$call_body" "$registry_school_id" <<'NODE'
const fs = require("fs");
const [file, registrySchoolID] = process.argv.slice(2);
const body = JSON.parse(fs.readFileSync(file, "utf8"));
const rows = Array.isArray(body) ? body : body?.items;
const valid = Array.isArray(rows) && rows.some((item) => item?.raw?.scenario === "TASK-018"
  && item.raw.measurement_class === "DEMO_TEST_ONLY"
  && item.raw.provenance === "synthetic-development-fixture"
  && item.raw.registry_school_id === registrySchoolID);
process.exit(valid ? 0 : 1);
NODE
  then
    fail "run $run_count demo measurement provenance" "HTTP $call_status or DEMO_TEST_ONLY label missing"
    return 1
  fi
  pass "run $run_count demo measurement provenance is explicit"
  api_call "normal-line" GET "/api/v1/lines/$line_id"
  if [[ "$call_status" != "200" ]] || [[ "$(json_path "$call_body" id)" != "$line_id" ]]; then
    fail "run $run_count normal line state" "HTTP $call_status"
    return 1
  fi
  pass "run $run_count normal measurement and line state"
  return 0
}

assert_no_open_incident() {
  local label="$1"
  api_call "incidents-${label}" GET "/api/v1/incidents?line_id=$line_id"
  if [[ "$call_status" != "200" ]]; then
    fail "run $run_count $label has no confirmed incident" "HTTP $call_status"
    return 1
  fi
  if ! node - "$call_body" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(body)) process.exit(2);
const active = new Set(["NEW", "SENT_TO_PROVIDER", "IN_PROGRESS", "WAITING_INFO", "RESOLVED"]);
process.exit(body.some((item) => active.has(item.status)) ? 1 : 0);
NODE
  then
    fail "run $run_count $label has no confirmed incident" "an incident was visible before confirmation"
    return 1
  fi
  pass "run $run_count $label has no confirmed incident"
  return 0
}

assert_contract_evidence() {
  if ! node - "$call_body" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(body)) process.exit(2);
const found = body.some((item) => item.baseline_state === "OK"
  && item.contract_state === "DEVIATES"
  && Array.isArray(item.violations)
  && item.violations.some((violation) => String(violation.code || "").startsWith("CONTRACT_")));
process.exit(found ? 0 : 1);
NODE
  then
    fail "run $run_count baseline-vs-contract evidence" "no measurement had baseline OK and contract DEVIATES"
    return 1
  fi
  pass "run $run_count baseline-vs-contract evidence"
  return 0
}

assert_provider_case_detail() {
  api_call "provider-case-detail" GET "/api/v1/provider-cases/$case_id"
  if [[ "$call_status" != "200" ]] || ! node - "$call_body" "$case_id" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedID = process.argv[3];
const valid = String(body.id) === expectedID
  && Array.isArray(body.evidence_chain)
  && body.evidence_chain.length > 0
  && Array.isArray(body.timeline)
  && body.timeline.length > 0;
process.exit(valid ? 0 : 1);
NODE
  then
    fail "run $run_count ProviderCase evidence/timeline" "HTTP $call_status"
    return 1
  fi
  pass "run $run_count ProviderCase evidence/timeline"
  return 0
}

assert_incident_detail() {
  if [[ "$call_status" != "200" ]] || ! node - "$call_body" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const chain = body.evidence_chain;
const confirmation = chain && typeof chain === "object" && !Array.isArray(chain)
  ? chain.confirmation
  : undefined;
const observationIds = confirmation?.observation_ids;
const valid = chain && typeof chain === "object" && !Array.isArray(chain)
  && chain.status === "AVAILABLE"
  && confirmation && typeof confirmation === "object" && !Array.isArray(confirmation)
  && Array.isArray(observationIds)
  && observationIds.length > 0
  && observationIds.every((id) => Number.isInteger(id) && id > 0)
  && Array.isArray(body.events)
  && body.events.length > 0
  && body.events.every((event) => event && typeof event === "object" && typeof event.event_type === "string" && event.event_type.length > 0);
process.exit(valid ? 0 : 1);
NODE
  then
    fail "run $run_count incident evidence/timeline" "HTTP $call_status or invalid evidence object/observation IDs or empty timeline"
    return 1
  fi
  pass "run $run_count incident evidence/timeline"
  return 0
}

find_open_incident() {
  api_call "incidents" GET "/api/v1/incidents?line_id=$line_id"
  incident_id="$(json_path "$call_body" 0.id)"
  incident_status="$(json_path "$call_body" 0.status)"
  incident_type="$(json_path "$call_body" 0.violation_type)"
  if [[ "$call_status" != "200" ]] || [[ -z "$incident_id" ]]; then
    fail "run $run_count automatic incident" "HTTP $call_status $(head -c 300 "$call_body")"
    return 1
  fi
  if [[ "$incident_status" != "NEW" && "$incident_status" != "SENT_TO_PROVIDER" && "$incident_status" != "IN_PROGRESS" ]]; then
    fail "run $run_count automatic incident" "unexpected status=$incident_status"
    return 1
  fi
  pass "run $run_count automatic incident ($incident_type, id=$incident_id)"
  return 0
}

run_once() {
  run_count="$1"
  run_tmp="$tmp_dir/run-$run_count"
  mkdir -p "$run_tmp"
  run_start_epoch="$(date -u +%s)"
  admin_token=""
  incident_id=""
  incident_status=""
  incident_type=""

  # Reset invalidates the current session because the supported reset path
  # recreates users/sessions along with the deterministic fixture.
  if ! login "pre-reset-login"; then return 1; fi
  api_call reset POST "/api/v1/admin/demo/reset" '{}'
  if [[ "$call_status" != "200" ]] || [[ "$(json_path "$call_body" reset)" != "true" ]]; then
    fail "run $run_count clean demo reset" "HTTP $call_status $(head -c 300 "$call_body")"
    return 1
  fi
  pass "run $run_count clean demo reset via supported API"
  if ! login "post-reset-login"; then return 1; fi

  if ! assert_line_and_normal; then return 1; fi

  # Three degradations use the real authenticated ingest/evaluation path. The
  # values remain above the baseline floor while violating the seeded contract.
  send_measurement degrade-1 -660 40 40 degrade-1 || return 1
  assert_no_open_incident "after first degradation" || return 1
  send_measurement degrade-2 -600 40 40 degrade-2 || return 1
  assert_no_open_incident "after second degradation" || return 1
  send_measurement degrade-3 -540 40 40 degrade-3 || return 1

  api_call "degraded-measurements" GET "/api/v1/lines/$line_id/measurements"
  if [[ "$call_status" != "200" ]]; then
    fail "run $run_count baseline-vs-contract evidence" "HTTP $call_status"
    return 1
  fi
  assert_contract_evidence || return 1
  find_open_incident || return 1

  api_call "incident-detail" GET "/api/v1/incidents/$incident_id"
  assert_incident_detail || return 1

  api_call "provider-case" POST "/api/v1/provider-cases" "{\"incident_id\":$incident_id,\"comment\":\"TASK-018 deterministic demo provider context\"}"
  case_id="$(json_path "$call_body" id)"
  if [[ "$call_status" != "201" ]] || [[ -z "$case_id" ]]; then
    fail "run $run_count create ProviderCase" "HTTP $call_status $(head -c 300 "$call_body")"
    return 1
  fi
  pass "run $run_count create ProviderCase"
  assert_provider_case_detail || return 1

  api_call "ai-draft" POST "/api/v1/provider-cases/$case_id/ai-draft" "{\"request_id\":\"task018-run-${run_count}-ai\"}"
  if [[ "$call_status" == "200" ]]; then
    if [[ "$(json_path "$call_body" status)" != "DRAFT" ]] || [[ -z "$(json_path "$call_body" draft_text)" ]]; then
      fail "run $run_count AI draft generated" "response did not contain an editable DRAFT"
      return 1
    fi
    ai_mode="LIVE_AI"
    pass "run $run_count AI draft generated (live local adapter)"
  elif [[ "$call_status" == "502" || "$call_status" == "503" ]]; then
    ai_mode="MANUAL_FALLBACK"
    pass "run $run_count AI unavailable recorded; manual fallback selected"
  else
    fail "run $run_count AI/manual fallback" "unexpected HTTP $call_status $(head -c 300 "$call_body")"
    return 1
  fi

  api_call "send-without-review" POST "/api/v1/provider-cases/$case_id/send" '{"reviewed":false}'
  if [[ "$call_status" != "409" ]]; then
    fail "run $run_count human review gate" "expected HTTP 409, got $call_status"
    return 1
  fi
  pass "run $run_count human review gate"

  api_call "send-reviewed" POST "/api/v1/provider-cases/$case_id/send" "{\"reviewed\":true,\"final_text\":\"TASK-018 reviewed manual provider message run ${run_count}\"}"
  if [[ "$call_status" == "200" ]] && [[ "$(json_path "$call_body" delivery_status)" == "SENT" ]]; then
    pass "run $run_count explicit human send"
  elif [[ "$call_status" == "502" || "$call_status" == "503" ]]; then
    blocked "run $run_count provider transport" "HTTP $call_status; delivery state persisted, no authorized working transport"
    return 1
  else
    fail "run $run_count explicit human send" "HTTP $call_status $(head -c 300 "$call_body")"
    return 1
  fi

  send_measurement recovery-observed -480 105 105 recovery-observed || return 1
  api_call "recovery-observed-line" GET "/api/v1/lines/$line_id"
  if [[ "$call_status" != "200" ]] || [[ "$(json_path "$call_body" state.recovery_state)" != "OBSERVED" ]]; then
    fail "run $run_count recovery observed" "HTTP $call_status recovery state missing"
    return 1
  fi
  pass "run $run_count recovery observed"

  send_measurement reopen-violation -420 40 40 reopen-violation || return 1
  api_call "reopened-incident" GET "/api/v1/incidents/$incident_id"
  if [[ "$call_status" != "200" ]] || [[ "$(json_path "$call_body" status)" != "IN_PROGRESS" ]]; then
    fail "run $run_count incident reopen" "HTTP $call_status status=$(json_path "$call_body" status)"
    return 1
  fi
  pass "run $run_count incident reopen after violation returned"

  send_measurement recovery-1 -360 105 105 recovery-1 || return 1
  send_measurement recovery-2 -300 105 105 recovery-2 || return 1
  send_measurement recovery-3 -240 105 105 recovery-3 || return 1
  api_call "closed-incident" GET "/api/v1/incidents/$incident_id"
  if [[ "$call_status" != "200" ]] || [[ "$(json_path "$call_body" status)" != "CLOSED" ]] || [[ "$(json_path "$call_body" recovery_state)" != "CONFIRMED" ]]; then
    fail "run $run_count confirmed recovery and CLOSED" "HTTP $call_status status=$(json_path "$call_body" status) recovery=$(json_path "$call_body" recovery_state)"
    return 1
  fi
  pass "run $run_count confirmed recovery and CLOSED"

  api_call "passport" GET "/api/v1/reports/quality-passport?line_id=$line_id&period=day"
  if [[ "$call_status" != "200" ]]; then
    fail "run $run_count quality passport" "HTTP $call_status"
    return 1
  fi
  pass "run $run_count quality passport"

  for format in csv xlsx; do
    api_call "export-$format" GET "/api/v1/exports?kind=raw&format=$format&line_id=$line_id&period=day"
    content_type="$(awk -F': ' 'tolower($1)=="content-type" {gsub("\r", "", $2); print tolower($2); exit}' "$call_headers")"
    if [[ "$call_status" != "200" ]] || [[ ! -s "$call_body" ]]; then
      fail "run $run_count $format export" "HTTP $call_status or empty body"
      return 1
    fi
    if [[ "$format" == "csv" ]] && [[ "$content_type" != text/csv* ]]; then
      fail "run $run_count $format export" "unexpected content type=$content_type"
      return 1
    fi
    if [[ "$format" == "xlsx" ]] && [[ "$content_type" != application/vnd.openxmlformats-officedocument.spreadsheetml.sheet* \
      || "$(od -An -tx1 -N2 "$call_body" | tr -d '[:space:]')" != "504b" ]]; then
      fail "run $run_count $format export" "invalid XLSX response content type=$content_type"
      return 1
    fi
    pass "run $run_count $format export"
  done
  return 0
}

if ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  blocked "TASK-018 demo prerequisites" "curl and node are required"
  exit 2
fi

for run in 1 2 3; do
  if run_once "$run"; then
    runs_passed=$((runs_passed + 1))
    printf 'RUN %s PASS (%s)\n' "$run" "${ai_mode:-unknown}"
  else
    printf 'RUN %s FAIL\n' "$run" >&2
  fi
done

printf 'TASK-018 SUMMARY: runs_passed=%s/3 pass=%s fail=%s blocked_external=%s\n' \
  "$runs_passed" "$pass_count" "$fail_count" "$blocked_count"

if [[ "$fail_count" -gt 0 || "$blocked_count" -gt 0 ]]; then
  exit 2
fi
exit 0
