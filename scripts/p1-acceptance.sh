#!/usr/bin/env bash
set -euo pipefail

# Repeatable P1 acceptance gate. Every acceptance row below is backed by an
# executable test or parsed runtime response; source presence is not evidence.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="${P1_ACCEPTANCE_BASE_URL:-http://127.0.0.1:8080}"
test_database_url="${LINKWATCH_TEST_DATABASE_URL:-postgres://linkwatch:linkwatch-dev-password@127.0.0.1:5432/linkwatch?sslmode=disable}"
acceptance_env="${LINKWATCH_ENV:-test}"
go_path="${GOPATH:-/tmp/linkwatch-gopath}"
go_cache="${GOCACHE:-/tmp/linkwatch-go-cache}"
go_mod_cache="${GOMODCACHE:-$go_path/pkg/mod}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pass=0
fail=0
record_pass() { pass=$((pass + 1)); echo "PASS $1"; }
record_fail() { fail=$((fail + 1)); echo "FAIL $1${2:+: $2}"; }

run_go_test() {
  local label="$1"
  shift
  if (
    cd "$repo_dir/server"
    GOPATH="$go_path" \
    GOCACHE="$go_cache" \
    GOMODCACHE="$go_mod_cache" \
    LINKWATCH_TEST_DATABASE_URL="$test_database_url" \
    LINKWATCH_ENV="$acceptance_env" \
    go test "$@"
  ); then
    record_pass "$label"
  else
    record_fail "$label"
  fi
}

cd "$repo_dir"
mkdir -p "$go_path" "$go_cache" "$go_mod_cache"

run_go_test \
  "evaluation axes, snapshots, NO_DATA/NO_INTERNET and SUSPECT semantics" \
  -race -count=1 \
  -run '^(TestEvaluateSeparatesBaselineAndContractAxes|TestEvaluateMissingPolicyMetricDoesNotBecomeOK|TestEvaluateMissingContractMetricDoesNotBecomeMeets|TestEvaluateSuspectIsNotAuthoritative|TestEvaluateNoInternetAndInvalidMeasurement|TestSnapshotsRetainEffectiveConfiguration)$' \
  ./internal/evaluation

run_go_test \
  "measurement verification, recovery, reopen and recurrence lifecycle" \
  -race -count=1 \
  -run '^(TestIncidentLifecycleRegressionPreservesHistoryAndCurrentState|TestIncidentUsesConfirmedBaselineViolationForMixedEvaluation|TestIncidentUsesConfirmedContractViolationWithLateBaselineViolation|TestConfirmationPolicyKeepsCountIndependentFromDuration|TestConfirmationModes|TestDurationCandidateBreaksOnUnavailableObservation|TestZeroCountWithoutDurationDoesNotConfirm|TestDurationOnlyPolicyUsesCanonicalField|TestConfirmationEvidenceStopsAtSatisfiedCount|TestConnectionStateDoesNotTreatUnknownAsHealthy|TestEvidenceIsMetricAndModeSpecific|TestRecoveryIgnoresMissingMetric|TestValidateInputRejectsInvalidMeasurements|TestVerificationPersistenceKeepsTerminalEvidenceRelations|TestVerificationOutcomeUsesEvaluationEvidence|TestVerificationTransitionsAreTerminalAndExpireDeterministically|TestVerificationLateEvidenceCannotConfirmExpiredCandidate)$' \
  ./internal/measurements

run_go_test \
  "API history, situations, reports, governance and authorization unit suites" \
  -race -count=1 \
  -run 'Test(EvidenceChain|RenderEvidence|ImpactPreview|RecoveryLabel|LineContext|MeasurementMap|Situation|Audit|ScopedLinePredicate|RedactAudit|MarshalAudit|ManualIncidentAuthorization|SameScopes|ConfigurationHierarchy|Analytics|Report|Comparison|PassportDynamics|LineProviderObservation|ProviderCaseWorkspaceDetailTimeline)' \
  ./internal/api

# These integration tests each get their own process. Running several migration
# bootstraps concurrently can deadlock on PostgreSQL advisory locks and would
# obscure the acceptance result.
run_go_test \
  "API persisted verification relation across aliases" \
  -race -count=1 \
  -run '^TestLineMeasurementsProjectPersistedVerificationAcrossAPIAliases$' \
  ./internal/api

run_go_test \
  "provider workspace verification evidence and redaction" \
  -race -count=1 \
  -run '^TestProviderWorkspaceHTTPStateEvidenceAndRedaction$' \
  ./internal/api

if ! curl -fsS --max-time 3 "$base_url/health/ready" >/dev/null 2>&1; then
  echo "P1_RUNTIME_INCOMPLETE: healthy runtime unavailable at $base_url" >&2
  echo "P1 SUMMARY: pass=$pass fail=$fail runtime=blocked"
  exit 2
fi

login_body="$tmp_dir/login.json"
if login_status="$(curl -sS --max-time 8 -o "$login_body" -w '%{http_code}' -X POST "$base_url/api/v1/auth/login" -H 'Content-Type: application/json' -d '{"login":"admin","password":"demo"}')"; then
  :
else
  login_status=000
fi
if token="$(node - "$login_body" <<'NODE'
const fs = require('node:fs');

try {
  const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(typeof payload.token === 'string' ? payload.token : '');
} catch {
  process.stdout.write('');
}
NODE
)"; then
  :
else
  token=''
fi
if [[ "$login_status" != "200" || -z "$token" ]]; then
  record_fail "runtime admin authentication" "HTTP $login_status"
else
  record_pass "runtime admin authentication"
  auth=(-H "Authorization: Bearer $token")
  fetch_get() {
    local output="$1"
    local path="$2"
    local status
    if status="$(curl -sS --max-time 8 -o "$output" -w '%{http_code}' "${auth[@]}" "$base_url$path")"; then
      printf '%s\n' "$status"
    else
      printf '000\n'
    fi
  }

  fetch_query() {
    local output="$1"
    local path="$2"
    shift 2
    local status
    if status="$(curl -sS --max-time 8 -o "$output" -w '%{http_code}' -G "${auth[@]}" "$base_url$path" "$@")"; then
      printf '%s\n' "$status"
    else
      printf '000\n'
    fi
  }

  record_http() {
    local label="$1"
    local status="$2"
    if [[ "$status" == "200" ]]; then
      record_pass "$label"
    else
      record_fail "$label" "HTTP $status"
    fi
  }

  line_body="$tmp_dir/line.json"
  line_status="$(fetch_get "$line_body" "/api/v1/lines/line-42-primary")"
  reserve_body="$tmp_dir/reserve.json"
  reserve_status="$(fetch_get "$reserve_body" "/api/v1/lines/line-42-reserve")"
  context_body="$tmp_dir/context.json"
  context_status="$(fetch_get "$context_body" "/api/v1/lines/line-42-primary/context")"
  measurements_body="$tmp_dir/measurements.json"
  measurements_status="$(fetch_get "$measurements_body" "/api/v1/lines/line-42-primary/measurements")"
  passport_body="$tmp_dir/passport.json"
  passport_status="$(fetch_query "$passport_body" "/api/v1/reports/quality-passport" --data-urlencode 'line_id=line-42-primary' --data-urlencode 'from=2020-01-01T00:00:00Z' --data-urlencode 'to=2020-01-02T00:00:00Z')"
  analytics_body="$tmp_dir/analytics.json"
  analytics_status="$(fetch_query "$analytics_body" "/api/v1/reports/analytics" --data-urlencode 'line_id=line-42-primary' --data-urlencode 'period=month')"
  aggregate_body="$tmp_dir/aggregate.json"
  aggregate_status="$(fetch_query "$aggregate_body" "/api/v1/reports/aggregate" --data-urlencode 'line_id=line-42-primary' --data-urlencode 'period=month')"
  situations_body="$tmp_dir/situations.json"
  situations_status="$(fetch_get "$situations_body" "/api/v1/situations")"
  audit_body="$tmp_dir/audit.json"
  audit_status="$(fetch_query "$audit_body" "/api/v1/audit" --data-urlencode 'limit=50')"

  record_http "line-first current line response" "$line_status"
  record_http "line-first stale line response" "$reserve_status"
  record_http "temporal line context response" "$context_status"
  record_http "line historical measurements response" "$measurements_status"
  record_http "history quality passport response" "$passport_status"
  record_http "historical analytics response" "$analytics_status"
  record_http "historical aggregate response" "$aggregate_status"
  record_http "situations response" "$situations_status"
  record_http "audit/governance response" "$audit_status"

  situation_body="$tmp_dir/situation.json"
  printf '{}\n' > "$situation_body"
  if situation_id="$(node - "$situations_body" <<'NODE'
const fs = require('node:fs');

try {
  const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const first = Array.isArray(payload) ? payload[0] : payload?.items?.[0];
  process.stdout.write(first && first.id !== undefined ? String(first.id) : '');
} catch {
  process.stdout.write('');
}
NODE
)"; then
    :
  else
    situation_id=''
  fi
  if [[ "$situations_status" == "200" && -n "$situation_id" ]]; then
    situation_detail_status="$(fetch_get "$situation_body" "/api/v1/situations/$situation_id")"
    record_http "situation evidence/correlation detail" "$situation_detail_status"
  else
    situation_detail_status=204
    record_pass "situation list is empty-safe"
  fi

  runtime_checks="$tmp_dir/runtime-checks.txt"
  if [[ "$line_status" == "200" && "$reserve_status" == "200" && "$context_status" == "200" && "$measurements_status" == "200" && "$passport_status" == "200" && "$analytics_status" == "200" && "$aggregate_status" == "200" && "$situations_status" == "200" && "$audit_status" == "200" ]]; then
    if node - "$line_body" "$reserve_body" "$context_body" "$measurements_body" "$passport_body" "$analytics_body" "$aggregate_body" "$situations_body" "$situation_body" "$audit_body" "$situation_detail_status" <<'NODE' > "$runtime_checks"
const fs = require('node:fs');

const paths = process.argv.slice(2, 12);
const detailStatus = process.argv[12];
const [linePath, reservePath, contextPath, measurementsPath, passportPath, analyticsPath, aggregatePath, situationsPath, situationDetailPath, auditPath] = paths;

function read(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function check(label, condition) {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    console.log(`FAIL ${label}`);
    process.exitCode = 1;
  }
}

try {
  const line = read(linePath);
  const reserve = read(reservePath);
  const context = read(contextPath);
  const measurementsPayload = read(measurementsPath);
  const rows = Array.isArray(measurementsPayload) ? measurementsPayload : measurementsPayload.items ?? measurementsPayload.data ?? [];
  const passport = read(passportPath);
  const analytics = read(analyticsPath);
  const aggregate = read(aggregatePath);
  const situationsPayload = read(situationsPath);
  const situationDetail = read(situationDetailPath);
  const audit = read(auditPath);
  const firstAxisRow = rows.find((row) => row.baseline_state === 'OK' && row.contract_state === 'DEVIATES');
  const evidence = firstAxisRow?.evidence_chain;
  const provenance = evidence?.configuration_provenance;
  const dynamicsStatus = passport.dynamics?.status;

  check('line-first identity and latest evidence are line-scoped',
    line.line_id === 'line-42-primary' && line.id === 'line-42-primary' &&
    line.latest?.device_id === 'device-42-primary' && line.latest?.id !== undefined &&
    line.latest_semantics === 'latest measurement/state; not a historical period summary');
  check('stale device is NO_DATA rather than inferred NO_INTERNET',
    reserve.line_id === 'line-42-reserve' && reserve.data_state === 'NO_DATA' &&
    reserve.connection_state === 'UNKNOWN' && reserve.latest && Object.keys(reserve.latest).length === 0);
  check('temporal context exposes resolved versions',
    context.line_id === 'line-42-primary' && context.resolved_context &&
    Array.isArray(context.versions) && context.versions.length > 0);
  check('historical measurements retain policy, contract and line snapshots',
    rows.length > 0 && rows.every((row) => row.policy_snapshot && row.contract_snapshot && row.line_context_snapshot));
  check('historical evidence excludes current operational configuration',
    provenance?.current_operational?.status === 'NOT_INCLUDED' &&
    provenance?.historical?.policy?.source === 'stored_policy_snapshot' &&
    provenance?.historical?.contract?.source === 'stored_contract_snapshot' &&
    provenance?.historical?.line_context?.source === 'stored_line_context_snapshot');
  check('baseline and contract axes remain separate',
    Boolean(firstAxisRow) && evidence?.baseline?.state === 'OK' && evidence?.contract?.state === 'DEVIATES');
  check('history passport reports an explicit dynamics state',
    ['AVAILABLE', 'NO_DATA', 'INSUFFICIENT_DATA', 'INCOMPARABLE'].includes(dynamicsStatus));
  check('historical analytics does not use current operational state',
    analytics.historical_only === true && analytics.current_state_used === false &&
    analytics.comparison?.historical_only === true && analytics.comparison?.current_state_used === false);
  check('historical aggregate exposes numeric averages',
    Number.isFinite(aggregate.aggregate?.download?.average) &&
    Number.isFinite(aggregate.aggregate?.upload?.average) &&
    Number.isFinite(aggregate.aggregate?.ping?.average));
  check('situations are explicit and correlation-safe',
    Array.isArray(situationsPayload) &&
    (situationsPayload.length === 0 ||
      (situationDetail.evidence !== undefined && situationDetail.projection !== undefined)) &&
    (situationsPayload.length === 0 || detailStatus === '200'));
  check('audit history exposes typed before/after governance entries',
    Array.isArray(audit.items) && audit.items.length > 0 &&
    audit.items.every((item) => typeof item.action === 'string' && typeof item.object_type === 'string'));
} catch (error) {
  console.log(`FAIL runtime JSON semantic checks: ${error.message}`);
  process.exitCode = 1;
}
NODE
    then
      :
    else
      printf 'FAIL runtime JSON semantic checks: parser/assertion process failed\n' > "$runtime_checks"
    fi
  else
    printf 'FAIL runtime JSON semantic checks: one or more endpoint status checks failed\n' > "$runtime_checks"
  fi

  while IFS= read -r result; do
    case "$result" in
      PASS\ *) record_pass "${result#PASS }" ;;
      FAIL\ *) record_fail "${result#FAIL }" ;;
      '') ;;
      *) record_fail "runtime semantic check" "$result" ;;
    esac
  done < "$runtime_checks"
fi

echo "P1 SUMMARY: pass=$pass fail=$fail runtime=available"
if (( fail > 0 )); then exit 1; fi
