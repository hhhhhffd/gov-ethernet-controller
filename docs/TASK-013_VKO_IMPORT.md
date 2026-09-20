# TASK-013 — Real current VKO school import

Status: `PASS`

Run date: 2026-09-19

## Result

The real import completed with official keyless exports and public Overpass
snapshots. No API key or credential was used:

```text
{"official_schools_total":370,"vko_schools":370,"official_coordinates":370,"matched_osm":0,"osm_only":189,"ambiguous":0,"review_required":0,"unmatched":370,"without_coordinates":0,"duplicates_removed":2,"invalid_or_outside_coordinates":0,"review_queue":0}
```

The production registry, import report, and review CSV were generated from
those sources. The organization mapping is deliberately not bundled as an
operational production mapping until an explicit real backend organization
export is supplied. The fixture and `testdata/importer-vko` inputs remain
test-only and were not used for production registry artifacts.

## Safe source checks

Only source metadata and HTTP outcomes were recorded; credentials and response
bodies were not printed or stored.

| Source | Safe identifier | Outcome |
| --- | --- | --- |
| Official current registry | [Ashyq Data school registry](https://ashyq.data.gov.kz/dataset/magda-ds-6a9e960b-dbf2-45ce-8fd6-c25b31023501/details?lang=ru) and its published CSV | 8,053 rows; 370 current VKO rows |
| Official state coordinates | `https://data.egov.kz/datasets/exportjson?index=state_schools&version=v1&from={1..7100}&count=100` | 7,094 rows; 355 current VKO rows with coordinates |
| Overpass | `https://gall.openstreetmap.de/api/interpreter` | public OSM snapshots downloaded with an identifying User-Agent; VKO relation and school queries succeeded |

The importer was run with `EGOV_CURRENT_SCHOOLS_FILE` and
`EGOV_STATE_SCHOOLS_FILE` pointing to temporary files under `/tmp`. A
temporary local relay was used only to add the identifying Overpass User-Agent
and keep the successful public snapshots available to the importer; no relay
or raw source dump was committed.

## Verification

- `node --check scripts/import-vko-schools.mjs` — pass.
- Importer suite — 28/28 pass.
- Real import — 370 current VKO schools, 370 official coordinates.
- Abai exclusion — 0 rows after current-VKO filtering.
- Artifact `--check` — pass with the same official inputs and Overpass snapshot.
- Byte identity — temporary and repository artifacts match exactly.
- Mapping boundary — the committed production artifact contains no
  organization entries and 370 registry-only schools remain unmonitored;
  synthetic demo organizations are accepted only by explicit fixture tests.
