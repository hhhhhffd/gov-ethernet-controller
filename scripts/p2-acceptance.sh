#!/usr/bin/env bash
set -euo pipefail

# P2 acceptance is deliberately split between executable regression tests and
# read-only checks against the running HTTP surface. Source-string presence is
# not evidence, and this harness does not create situations, roll out config,
# or queue an update in the operator's database.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="${P2_ACCEPTANCE_BASE_URL:-http://127.0.0.1:8080}"
test_database_url="${LINKWATCH_TEST_DATABASE_URL:-postgres://linkwatch:linkwatch-dev-password@127.0.0.1:5432/linkwatch?sslmode=disable}"
acceptance_env="${LINKWATCH_ACCEPTANCE_ENV:-test}"
go_path="${GOPATH:-/tmp/linkwatch-gopath}"
go_cache="${GOCACHE:-/tmp/linkwatch-go-cache}"
go_mod_cache="${GOMODCACHE:-$go_path/pkg/mod}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pass=0
fail=0
blocked_external=0

pass_check() { pass=$((pass + 1)); echo "PASS $1"; }
fail_check() { fail=$((fail + 1)); echo "FAIL $1${2:+: $2}"; }
blocked_check() {
  blocked_external=$((blocked_external + 1))
  echo "BLOCKED_EXTERNAL $1${2:+: $2}"
}

run_go_test() {
  local label="$1"
  local package="$2"
  local pattern="$3"
  if (
    cd "$repo_dir/server"
    GOPATH="$go_path" \
    GOCACHE="$go_cache" \
    GOMODCACHE="$go_mod_cache" \
    LINKWATCH_TEST_DATABASE_URL="$test_database_url" \
    LINKWATCH_ENV="$acceptance_env" \
    go test -race -count=1 -run "$pattern" "$package"
  ); then
    pass_check "$label"
  else
    fail_check "$label" "targeted Go test failed"
  fi
}

run_go_suite() {
  local label="$1"
  local packages
  if ! packages="$(
    cd "$repo_dir/server"
    GOPATH="$go_path" GOCACHE="$go_cache" GOMODCACHE="$go_mod_cache" go list ./...
  )"; then
    fail_check "$label" "could not enumerate Go packages"
    return
  fi
  local package
  local suite_ok=1
  while IFS= read -r package; do
    [[ -z "$package" ]] && continue
    if ! (
      cd "$repo_dir/server"
      GOPATH="$go_path" \
      GOCACHE="$go_cache" \
      GOMODCACHE="$go_mod_cache" \
      LINKWATCH_TEST_DATABASE_URL="$test_database_url" \
      LINKWATCH_ENV="$acceptance_env" \
      go test "$package"
    ); then
      suite_ok=0
    fi
  done <<< "$packages"
  if (( suite_ok )); then
    pass_check "$label"
  else
    fail_check "$label" "repository Go suite failed"
  fi
}

run_cargo_test() {
  local label="$1"
  shift
  if (cd "$repo_dir" && cargo test --manifest-path agent/Cargo.toml "$@" --); then
    pass_check "$label"
  else
    fail_check "$label" "targeted Rust test failed"
  fi
}

cd "$repo_dir"
mkdir -p "$go_path" "$go_cache" "$go_mod_cache"

# Keep the repository-wide regression gate in this task, then give every P2
# row its own executable evidence label below.
run_go_suite "Go server regression suites"
if cargo test --manifest-path agent/Cargo.toml; then
  pass_check "Rust command/config/update regression suites"
else
  fail_check "Rust command/config/update regression suites"
fi
if node --check web/app.js; then
  pass_check "frontend syntax (read-only check)"
else
  fail_check "frontend syntax (read-only check)"
fi

run_go_test "LIVE_VERIFY bounded command regression" ./internal/api '^TestLiveVerifySampleIsBounded$'
run_go_test "situation comparison evidence regression" ./internal/api '^TestComparison(CompletenessPreservesNoDataAndSparseEvidence|WindowIsBoundedAndHistorical|RowsExposeEvidenceOnlyAndNoCausalClaim)$'
run_go_test "situation merge authorization/idempotent ID regression" ./internal/api '^TestSituation(ActionIDsAreStableAndUnique|ManagementCapabilityMatchesRoleContract)$'
run_go_test "situation split membership regression" ./internal/api '^TestSituationSplitRejectsNonMembersAndKeepsOriginalOrder$'
run_go_test "Impact Preview immutable historical projection regression" ./internal/api '^TestImpactPreview(UsesHistoricalSnapshotsAndChangesOnlyProjection|RetainsUnknownHistoricalEvidence|RejectsEmptyOrInvalidProposal)$'
run_go_test "configuration hierarchy regression" ./internal/api '^TestConfigurationHierarchyIsDeterministicAndPreservesUnknowns$'
run_go_test "evidence report rendering and no-data regression" ./internal/api '^TestRenderEvidenceReport(EscapesAndUsesHistoricalSnapshots|ExplicitNoData|RejectsInvalidRenderMetadata|EscapesMetadataRole)$'
run_go_test "JSON export allowlist/envelope regression" ./internal/api '^(TestSelectedExportFieldsRejectsUnknownAndDeduplicates|TestJSONExportEnvelopeUsesSelectedAllowlistAndPreservesNull)$'
run_go_test "notification outbox durable delivery/retry regression" ./internal/measurements '^TestNotificationOutboxAcceptance$'
run_go_test "provider workspace timeline/evidence/redaction regression" ./internal/api '^(TestProviderWorkspaceHTTPStateEvidenceAndRedaction|TestProviderCaseWorkspaceDetailTimeline)$'
run_go_test "observed agent version read-only surface regression" ./internal/api '^TestAuditReadCapabilityAndObservedVersionSurfaceAreReadOnly$'
run_go_test "remote config validation regression" ./internal/api '^TestValidateRemoteConfigRejectsUnsupportedAndUnsafeValues$'
run_go_test "AGENT_UPDATE activation transition regression" ./internal/api '^(TestUpdateAckStatusPreservesRollback|TestUpdateHeartbeatTransitionRequiresNewBootAndExactVersion)$'
run_cargo_test "AGENT_UPDATE native activation confirmation regression" update::tests::heartbeat_success_finalizes_only_after_matching_running_version
run_cargo_test "AGENT_UPDATE native install/rollback regression" update::tests::install_success_stays_installing_until_activation_confirmation
run_cargo_test "AGENT_UPDATE native rollback recovery regression" update::tests::failed_activation_restores_the_known_good_binary

if ! curl -fsS --max-time 3 "$base_url/health/ready" > /dev/null 2>&1; then
  blocked_check "live HTTP P2 surfaces" "healthy runtime unavailable at $base_url"
else
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
  if [[ "$login_status" != 200 || -z "$token" ]]; then
    fail_check "runtime admin authentication" "HTTP $login_status"
  else
    pass_check "runtime admin authentication"
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

    record_http() {
      local label="$1"
      local status="$2"
      if [[ "$status" == 200 ]]; then
        pass_check "$label"
      else
        fail_check "$label" "HTTP $status"
      fi
    }

    line_body="$tmp_dir/line.json"
    context_body="$tmp_dir/context.json"
    evidence_body="$tmp_dir/evidence.html"
    export_preview_body="$tmp_dir/export-preview.json"
    export_json_body="$tmp_dir/export.json"
    notifications_body="$tmp_dir/notifications.json"
    provider_body="$tmp_dir/provider-cases.json"
    situations_body="$tmp_dir/situations.json"
    versions_body="$tmp_dir/agent-versions.json"
    audit_body="$tmp_dir/audit.json"
    contracts_body="$tmp_dir/contracts.json"
    invalid_config_body="$tmp_dir/invalid-config.json"

    line_status="$(fetch_get "$line_body" "/api/v1/lines/line-42-primary")"
    context_status="$(fetch_get "$context_body" "/api/v1/lines/line-42-primary/context")"
    evidence_status="$(fetch_get "$evidence_body" "/api/v1/reports/evidence-report?line_id=line-42-primary&period=day")"
    export_preview_status="$(fetch_get "$export_preview_body" "/api/v1/exports/preview?kind=raw&format=json&line_id=line-42-primary&period=day")"
    export_json_status="$(fetch_get "$export_json_body" "/api/v1/exports?kind=raw&format=json&line_id=line-42-primary&period=day")"
    notifications_status="$(fetch_get "$notifications_body" "/api/v1/notifications?limit=5")"
    provider_status="$(fetch_get "$provider_body" "/api/v1/provider-cases?limit=5")"
    situations_status="$(fetch_get "$situations_body" "/api/v1/situations")"
    versions_status="$(fetch_get "$versions_body" "/api/v1/agent-versions?limit=50")"
    audit_status="$(fetch_get "$audit_body" "/api/v1/audit?limit=5")"
    contracts_status="$(fetch_get "$contracts_body" "/api/v1/admin/contracts")"

    record_http "runtime canonical line/evidence surface" "$line_status"
    record_http "runtime configuration context surface" "$context_status"
    record_http "runtime historical evidence report" "$evidence_status"
    record_http "runtime JSON export preview" "$export_preview_status"
    record_http "runtime JSON export" "$export_json_status"
    record_http "runtime notification outbox surface" "$notifications_status"
    record_http "runtime provider workspace scope surface" "$provider_status"
    record_http "runtime situation canonical list" "$situations_status"
    record_http "runtime observed agent versions" "$versions_status"
    record_http "runtime audit journal" "$audit_status"
    record_http "runtime contract/configuration surface" "$contracts_status"

    if node - "$line_body" "$context_body" "$evidence_body" "$export_preview_body" "$export_json_body" "$notifications_body" "$provider_body" "$situations_body" "$versions_body" "$audit_body" "$contracts_body" "$line_status" "$context_status" "$evidence_status" "$export_preview_status" "$export_json_status" "$notifications_status" "$provider_status" "$situations_status" "$versions_status" "$audit_status" "$contracts_status" <<'NODE' > "$tmp_dir/runtime-semantic-checks.txt"
const fs = require('node:fs');
const args = process.argv.slice(2);
const paths = args.slice(0, 11);
const statuses = args.slice(11);
const [linePath, contextPath, evidencePath, previewPath, exportPath, notificationsPath, providerPath, situationsPath, versionsPath, auditPath, contractsPath] = paths;
const [lineStatus, contextStatus, evidenceStatus, previewStatus, exportStatus, notificationsStatus, providerStatus, situationsStatus, versionsStatus, auditStatus, contractsStatus] = statuses;
function read(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }
function check(label, condition) { console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`); }
try {
  const line = read(linePath);
  const context = read(contextPath);
  const evidence = fs.readFileSync(evidencePath, 'utf8');
  const preview = read(previewPath);
  const exported = read(exportPath);
  const notifications = read(notificationsPath);
  const provider = read(providerPath);
  const situations = read(situationsPath);
  const versions = read(versionsPath);
  const audit = read(auditPath);
  const contracts = read(contractsPath);
  check('runtime line is canonical and line-scoped', lineStatus === '200' && line.line_id === 'line-42-primary' && line.latest_semantics === 'latest measurement/state; not a historical period summary');
  check('runtime configuration hierarchy has resolved historical context', contextStatus === '200' && context.line_id === 'line-42-primary' && context.resolved_context?.version !== undefined && Array.isArray(context.versions) && context.versions.length > 0);
  check('runtime evidence report is historical and explicit', evidenceStatus === '200' && evidence.includes('evidence-report-v1') && evidence.includes('historical_only') && evidence.includes('current configuration is not used') && evidence.includes('data-state='));
  check('runtime JSON preview honors requested format and allowlist', previewStatus === '200' && preview.format === 'json' && Array.isArray(preview.columns) && preview.columns.length > 0 && Array.isArray(preview.available_columns));
  check('runtime JSON export has versioned envelope and rows', exportStatus === '200' && exported.schema_version === 1 && exported.format === 'json' && Array.isArray(exported.columns) && Array.isArray(exported.rows) && exported.measurement_count >= exported.rows.length);
  check('runtime notification outbox is empty-safe and shaped', notificationsStatus === '200' && (Array.isArray(notifications) || Array.isArray(notifications.items)));
  check('runtime provider workspace preserves human gate and scope', providerStatus === '200' && provider.human_send_gate === true && provider.scope_enforced === true && Array.isArray(provider.items));
  check('runtime situations are canonical and empty-safe', situationsStatus === '200' && Array.isArray(situations));
  check('runtime observed versions identify telemetry source', versionsStatus === '200' && versions.source === 'observed_telemetry' && Array.isArray(versions.items));
  check('runtime audit surface is paged and typed', auditStatus === '200' && Array.isArray(audit.items) && audit.items.every((item) => typeof item.action === 'string' && typeof item.object_type === 'string'));
  check('runtime contracts are versioned records', contractsStatus === '200' && Array.isArray(contracts) && contracts.every((item) => item.id !== undefined && item.line_id && item.valid_from));
} catch (error) {
  console.log(`FAIL runtime semantic JSON checks: ${error.message}`);
}
NODE
    then
      while IFS= read -r result; do
        case "$result" in
          PASS\ *) pass_check "${result#PASS }" ;;
          FAIL\ *) fail_check "${result#FAIL }" ;;
          '') ;;
          *) fail_check "runtime semantic check" "$result" ;;
        esac
      done < "$tmp_dir/runtime-semantic-checks.txt"
    else
      fail_check "runtime semantic JSON checks" "parser failed"
    fi

    # Validation-only: forbidden credentials must be rejected before the
    # remote-config transaction starts.
    if remote_config_status="$(curl -sS --max-time 8 -o "$invalid_config_body" -w '%{http_code}' -X POST "$base_url/api/v1/admin/devices/device-42-primary/config" "${auth[@]}" -H 'Content-Type: application/json' -d '{"config":{"credentials":{}}}')"; then
      :
    else
      remote_config_status=000
    fi
    if [[ "$remote_config_status" == 422 ]]; then
      pass_check "runtime remote-config rejects forbidden credentials"
    else
      fail_check "runtime remote-config rejects forbidden credentials" "HTTP $remote_config_status"
    fi

    if unauthenticated_update="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' -X POST "$base_url/api/v1/admin/agent-updates" -H 'Content-Type: application/json' -d '{}')"; then
      :
    else
      unauthenticated_update=000
    fi
    if [[ "$unauthenticated_update" == 401 ]]; then
      pass_check "runtime AGENT_UPDATE authorization boundary"
    else
      fail_check "runtime AGENT_UPDATE authorization boundary" "HTTP $unauthenticated_update"
    fi

    situation_count="$(node - "$situations_body" <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(String(Array.isArray(value) ? value.length : 0));
} catch {
  process.stdout.write('0');
}
NODE
)"
    if [[ "$situation_count" == 0 ]]; then
      pass_check "runtime situation list is empty-safe; no mutation issued"
    else
      blocked_check "live mutation verification for situation actions" "existing runtime contains situations; harness intentionally does not merge/split/live-verify operator data"
    fi
  fi
fi

# These two rows require infrastructure outside this repository/runtime. The
# local webhook transport is covered by the executable outbox test above, but
# no authorized public notification destination is available here.
blocked_check "AGENT_UPDATE real post-restart activation" "native Windows/runtime agent acceptance is not available in this environment"
blocked_check "additional external notification delivery" "no authorized non-WEB endpoint and credentials are configured"

echo "P2 SUMMARY: pass=$pass fail=$fail blocked_external=$blocked_external"
if (( fail > 0 )); then
  exit 1
fi
if (( blocked_external > 0 )); then
  exit 2
fi
