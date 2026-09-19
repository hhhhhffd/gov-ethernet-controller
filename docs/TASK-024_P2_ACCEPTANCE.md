# TASK-024 P2 acceptance

## Run

Date: 2026-09-19

Command:

```text
./scripts/p2-acceptance.sh
```

The local runtime was healthy at `http://127.0.0.1:8080`. The final run
returned exit code `2` because the two external gates below are unavailable;
there were no failed checks:

```text
P2 SUMMARY: pass=45 fail=0 blocked_external=2
```

The harness now uses named Go/Rust tests and parsed HTTP responses. It does not
use source-string grep as capability evidence, and it does not mutate the
operator's runtime by creating situations, rolling out configuration, or
queuing an update.

## Row-by-row evidence

| P2 capability | Status | Executable evidence | Current runtime result / limitation |
|---|---|---|---|
| `LIVE_VERIFY` | PASS | `TestLiveVerifySampleIsBounded`; live `/api/v1/situations` response is parsed and checked empty-safe | No open situation exists, so no live command was issued. |
| Situation comparison | PASS | `TestComparisonCompletenessPreservesNoDataAndSparseEvidence`, `TestComparisonWindowIsBoundedAndHistorical`, `TestComparisonRowsExposeEvidenceOnlyAndNoCausalClaim` | Situation list is `[]`; no mutating or fabricated comparison fixture was added. |
| Situation merge | PASS | `TestSituationActionIDsAreStableAndUnique`, `TestSituationManagementCapabilityMatchesRoleContract` | No live merge was issued against operator data. |
| Situation split | PASS | `TestSituationSplitRejectsNonMembersAndKeepsOriginalOrder` | No live split was issued against operator data. |
| Impact Preview | PASS | `TestImpactPreviewUsesHistoricalSnapshotsAndChangesOnlyProjection`, `TestImpactPreviewRetainsUnknownHistoricalEvidence`, `TestImpactPreviewRejectsEmptyOrInvalidProposal` | Regression proves immutable historical projection; no live proposal was submitted. |
| Configuration hierarchy | PASS | `TestConfigurationHierarchyIsDeterministicAndPreservesUnknowns`; live line context semantic check | `/api/v1/lines/line-42-primary/context` returned resolved version history. |
| Evidence report | PASS | `TestRenderEvidenceReport*`; live HTML semantic check | Live report returned `200`, `evidence-report-v1`, historical-only/current-config exclusion, and explicit state markers. |
| JSON export | PASS | `TestSelectedExportFieldsRejectsUnknownAndDeduplicates`, `TestJSONExportEnvelopeUsesSelectedAllowlistAndPreservesNull`; live preview/export checks | Preview and export returned `200`; JSON envelope/version/columns/rows were parsed. |
| Notification outbox | PASS | `TestNotificationOutboxAcceptance` with PostgreSQL, webhook success/retry/permanent-failure paths; live outbox GET | Durable local outbox behavior passed; current live outbox is empty and safely represented. |
| Provider workspace (BUG-005) | PASS | `TestProviderWorkspaceHTTPStateEvidenceAndRedaction`, `TestProviderCaseWorkspaceDetailTimeline`; live scope/human-gate check | Live queue is empty, with `scope_enforced=true` and `human_send_gate=true`; populated timeline/evidence is covered by regression tests. |
| Observed agent versions | PASS | `TestAuditReadCapabilityAndObservedVersionSurfaceAreReadOnly`; live versions semantic check | Live response identifies `observed_telemetry` and reports the observed agent version. |
| Remote config | PASS | `TestValidateRemoteConfigRejectsUnsupportedAndUnsafeValues`; Rust remote-config validation test; live forbidden-credentials request | Valid/unsafe validation paths passed; live invalid credentials request returned `422`; no rollout was created. |
| `AGENT_UPDATE` after activation (BUG-004) | BLOCKED_EXTERNAL | API transition tests plus Rust activation/install/rollback tests all passed; live authorization boundary returned `401` without credentials | EXT-002: real post-restart activation requires the native/runtime agent acceptance environment, unavailable here. |
| Additional notification delivery beyond WEB | BLOCKED_EXTERNAL | `TestNotificationOutboxAcceptance` proves local webhook transport persistence/retry/redaction | No authorized non-WEB external endpoint and credentials are configured; no external request was attempted. |

## Supporting checks

- Sequential Go package regression suite: PASS.
- Full Rust command/config/update regression suite: PASS (38 tests).
- All P2 targeted Go tests: PASS with `-race`.
- Targeted Rust activation tests: PASS.
- `node --check web/app.js`: PASS; no `web/*` file was modified.
- No updater source was modified.
- No `FAIL` row was observed.

`BLOCKED_EXTERNAL` is limited to the unavailable native post-restart update
environment and the missing authorized external notification destination; it
does not conceal a test failure.
