# TASK-013 — Real current VKO school import

Status: `BLOCKED_EXTERNAL`

Run date: 2026-09-19

## Result

The real import was attempted with `node scripts/import-vko-schools.mjs`.
It stopped before artifact generation because no `EGOV_API_KEY` was configured
and no local official current-registry export was available:

```text
eGov: EGOV_API_KEY is required when a local file is not configured
```

No production registry, import report, or review CSV was created or updated.
The fixture and `testdata/importer-vko` inputs remain test-only and are not
reported as current VKO data.

## Safe source checks

Only source metadata and HTTP outcomes were recorded; credentials and response
bodies were not printed or stored.

| Source | Safe identifier | Outcome |
| --- | --- | --- |
| eGov current registry | `https://data.egov.kz/api/v4/onirler_oblystar_kalalar_boi4/v1` | `403` without configured API key |
| eGov state schools | `https://data.egov.kz/api/v4/state_schools/v1` | `403` without configured API key |
| Overpass | `https://overpass-api.de/api/interpreter` | reachable; importer-compatible GET relation request returned `406` |

No `EGOV_API_KEY`, `EGOV_CURRENT_SCHOOLS_FILE`,
`EGOV_STATE_SCHOOLS_FILE`, or `OVERPASS_ENDPOINT` value was available in the
runtime environment. The default Overpass endpoint was therefore checked.

## Required unblock

Provide one of the following through the runtime environment, without
committing it:

1. `EGOV_API_KEY`, plus a reachable Overpass endpoint compatible with the
   importer; or
2. official current VKO and state-school exports via
   `EGOV_CURRENT_SCHOOLS_FILE` and `EGOV_STATE_SCHOOLS_FILE`, plus a reachable
   Overpass endpoint.

After that, rerun the importer, verify the generated provenance/counters,
confirm Abai exclusion and district coverage, run `node scripts/import-vko-schools.mjs --check`,
and only then commit real runtime artifacts.

## Verification performed

- `node scripts/import-vko-schools.mjs` — expected `BLOCKED_EXTERNAL`; no output artifacts written.
- `node --check scripts/import-vko-schools.mjs` — pass.
- Importer fixture suite — previously completed by TASK-012; fixtures remain separate from this blocked run.
