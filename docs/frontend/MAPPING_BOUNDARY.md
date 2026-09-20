# Mapping boundary

This document records the production boundary between the official school
registry and LINKWATCH operational rows. It is intentionally fail-closed: an
empty `organization-school-map.json` is not permission to invent a join or a
coordinate.

## Backend contract

`GET /api/lines` and `GET /api/v1/lines` are the operational source used by the
map integration. The server joins each line to its organization and returns,
among other fields:

- `id`, `organization_id`, `school_id`;
- organization name, district, address, and provider fields;
- current line state and latest measurement fields;
- organization `latitude`/`longitude` fields.

The database relationship is `lines.organization_id → organizations.id` and
`organizations.school_id` is the backend school identifier. Monitoring points
are children of a line (`monitoring_points.line_id`) and identify the
observation/device chain; they do not identify a registry coordinate.

The contract is implemented in
`server/internal/api/line_handlers.go` and the relations are defined in
`server/internal/database/migrations/001_initial.sql`.

## Coordinate and identity policy

The map uses only `web/data/vko-schools.json` for school identity and
coordinates. Backend organization coordinates are never copied into
`registryCoordinate`; this prevents demo/seed coordinates from becoming map
truth. A line with no registry join remains an authoritative operational row,
but it cannot receive a map marker or a fabricated school identity.

The mapping artifact currently has:

```text
provenance.operational_mapping_status = NOT_PROVIDED
entries = []
```

That state remains valid until an explicit real organization export is
available. No populated mapping is bundled or generated from
`server/internal/admin/seed.go`.

## Resolution order

For each backend line, the browser resolves identity in this order:

1. an exact backend `registry_id`/`school_id` identifier against the official
   registry (`BACKEND_JOIN`), with the source field and value recorded as
   provenance;
2. an explicit import-time organization mapping entry keyed by
   `organization_id`, with its input source, match method, and evidence;
3. no join: retain the line with `MISSING_MAPPING` (or an explicit unavailable,
   invalid, ambiguous, or conflict state).

An exact backend join and an imported mapping that identify different schools
produce `MAPPING_CONFLICT` and no coordinate. Ambiguous identifiers likewise
remain unmapped. Fuzzy name/address matching is not performed in the browser.

## Preservation guarantees

`buildFrontendModel` and `createMapIntegration` preserve every valid row
returned by `/lines` in `model.linkwatch.lines` and `state.lines`. Unmapped rows
are also available through `state.view.unmappedLines`,
`state.view.authoritativeLines`, and `mappingDiagnostics().unmappedLines`.

The Leaflet map receives those rows in its render context, but its frozen map
core intentionally renders monitoring markers only for rows with an official
registry join and coordinate. Thus “not visible as a marker” is an explicit
`MISSING_MAPPING` diagnostic, not silent data loss. Registry schools without a
joined line remain `NOT_MONITORED`/registry-only.

## Coverage

The mapping boundary tests prove:

- an exact backend school identifier can join to an official registry row even
  when the artifact has zero entries;
- registry coordinates win over backend organization coordinates;
- an unmapped operational line is retained and marked `MISSING_MAPPING`;
- registry-only schools receive no operational status;
- malformed rows do not receive synthetic line identifiers.

Targeted verification:

```text
node --test web/data-model.test.cjs web/session.test.cjs
```
