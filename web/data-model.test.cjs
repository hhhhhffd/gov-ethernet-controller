const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildFrontendModel,
  coverageRows,
  createDataLoader,
} = require("./data-model.js");

const registry = {
  schema_version: 1,
  provenance: { source: "official-fixture" },
  schools: [
    { registry_id: "registry-1", official_name: "Школа 1", district: "Уланский район", latitude: 50.1, longitude: 82.1 },
    { registry_id: "registry-2", official_name: "Школа 2", district: "Алтайский район", latitude: 50.2, longitude: 82.2 },
  ],
};

function line(id, organizationId, schoolId, status) {
  return { id, organization_id: organizationId, school_id: schoolId, status };
}

test("registry-only schools stay neutral and mapped lines retain backend status", () => {
  const model = buildFrontendModel({
    registryPayload: registry,
    mappingPayload: {
      entries: [{ organization_id: "org-1", registry_id: "registry-1", match_status: "AUTO_MATCH" }],
    },
    lines: [line("line-1", "org-1", "school-1", "DEGRADED")],
  });

  assert.equal(model.registry.total, 2);
  assert.equal(model.registryOnly.length, 1);
  assert.equal(model.registryOnly[0].registryId, "registry-2");
  assert.equal(model.registryOnly[0].monitoringStatus, "NOT_MONITORED");
  assert.equal(model.registryOnly[0].operationalStatus, null);
  assert.equal(model.linkwatch.lines[0].linkwatchStatus, "DEGRADED");
  assert.equal(model.linkwatch.lines[0].linkwatchStatusSource, "backend.line_state");
  assert.equal(model.linkwatch.monitoredSchoolCount, 1);
});

test("registry keeps supplied official RU and KK names for presentation", () => {
  const model = buildFrontendModel({
    registryPayload: {
      schools: [{
        registry_id: "registry-localized",
        official_name: "Available official name",
        official_name_ru: "Официальное русское наименование",
        official_name_kk: "Ресми қазақша атауы",
        latitude: 50.1,
        longitude: 82.1,
      }],
    },
  });

  assert.equal(model.registry.schools[0].officialNameRu, "Официальное русское наименование");
  assert.equal(model.registry.schools[0].officialNameKk, "Ресми қазақша атауы");
});

test("multiple lines remain separate while monitored-school KPI is deduplicated", () => {
  const model = buildFrontendModel({
    registryPayload: registry,
    mappingPayload: { entries: [{ organization_id: "org-1", registry_id: "registry-1" }] },
    lines: [
      line("line-primary", "org-1", "school-1", "OK"),
      line("line-reserve", "org-1", "school-1", "NO_DATA"),
    ],
  });

  assert.equal(model.linkwatch.lines.length, 2);
  assert.deepEqual(model.linkwatch.lines.map((item) => item.id), ["line-primary", "line-reserve"]);
  assert.equal(model.linkwatch.monitoredSchoolCount, 1);
});

test("invalid and missing mappings are explicit and never fuzzy-matched", () => {
  const model = buildFrontendModel({
    registryPayload: registry,
    mappingPayload: {
      entries: [
        { organization_id: "org-invalid", registry_id: "missing-registry", match_status: "AUTO_MATCH" },
      ],
    },
    lines: [
      line("line-invalid", "org-invalid", "school-x", "OK"),
      line("line-missing", "org-not-in-map", "school-1", "OK"),
    ],
  });

  assert.equal(model.linkwatch.lines[0].mappingStatus, "INVALID_MAPPING");
  assert.equal(model.linkwatch.lines[1].mappingStatus, "MISSING_MAPPING");
  assert.equal(model.linkwatch.lines[0].registrySchool, null);
  assert.equal(model.linkwatch.lines[1].registrySchool, null);
});

test("an exact backend school join uses registry identity and coordinates, even when the artifact is empty", () => {
  const model = buildFrontendModel({
    registryPayload: {
      schools: [{ registry_id: "registry-real", school_id: "backend-school-1", official_name: "Real school", latitude: 49.91, longitude: 82.51 }],
    },
    mappingPayload: {
      provenance: { operational_mapping_status: "NOT_PROVIDED", organizations_input: "not-provided" },
      entries: [],
    },
    lines: [{
      id: "line-real",
      organization_id: "org-real",
      school_id: "backend-school-1",
      latitude: 1,
      longitude: 2,
      status: "DEGRADED",
    }],
  });

  const mapped = model.linkwatch.lines[0];
  assert.equal(mapped.mappingStatus, "BACKEND_JOIN");
  assert.equal(mapped.mappingSource, "backend.line.school_id");
  assert.equal(mapped.registryId, "registry-real");
  assert.deepEqual(mapped.registryCoordinate, { latitude: 49.91, longitude: 82.51 });
  assert.deepEqual(mapped.mappingProvenance, {
    source: "backend.line.school_id",
    field: "school_id",
    value: "backend-school-1",
    coordinateSource: "registry.coordinate",
  });
  assert.equal(model.mapping.artifactEntryCount, 0);
  assert.equal(model.mapping.artifactStatus, "NOT_PROVIDED");
  assert.equal(model.mappingDiagnostics.backendJoinCount, 1);
  assert.equal(model.mappingDiagnostics.unmappedLineCount, 0);
  assert.equal(model.registryOnly.length, 0);
});

test("an authoritative line without an exact join is retained as MISSING_MAPPING and cannot use backend coordinates", () => {
  const model = buildFrontendModel({
    registryPayload: {
      schools: [{ registry_id: "registry-real", official_name: "Real school", latitude: 49.91, longitude: 82.51 }],
    },
    mappingPayload: {
      provenance: { operational_mapping_status: "NOT_PROVIDED" },
      entries: [],
    },
    lines: [{
      id: "line-unmapped",
      organization_id: "org-unmapped",
      school_id: "seed-school-42",
      latitude: 50.35,
      longitude: 82.62,
      status: "OK",
    }],
  });

  const unmapped = model.linkwatch.lines[0];
  assert.equal(model.linkwatch.lines.length, 1, "the backend line must not be discarded");
  assert.equal(unmapped.mappingStatus, "MISSING_MAPPING");
  assert.equal(unmapped.registrySchool, null);
  assert.equal(unmapped.registryCoordinate, null);
  assert.equal(unmapped.registryCoordinateSource, "none");
  assert.equal(model.linkwatch.monitoredSchoolCount, 0);
  assert.equal(model.mappingDiagnostics.unmappedLineCount, 1);
  assert.deepEqual(model.mappingDiagnostics.unmappedLines[0], {
    lineId: "line-unmapped",
    organizationId: "org-unmapped",
    schoolId: "seed-school-42",
    mappingStatus: "MISSING_MAPPING",
    diagnostics: [],
  });
  assert.equal(model.registryOnly.length, 1, "the registry school remains registry-only");
});

test("registry failure is explicit, cached once, and does not discard LINKWATCH lines", async () => {
  let calls = 0;
  const loader = createDataLoader({
    registryUrl: "/registry.json",
    mappingUrl: "/mapping.json",
    fetchImpl: async (url) => {
      calls += 1;
      if (url === "/registry.json") return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ entries: [] }) };
    },
  });

  const first = await loader.load();
  const second = await loader.load();
  assert.strictEqual(first, second);
  assert.equal(calls, 2);
  assert.equal(first.registryUnavailable, true);
  const model = buildFrontendModel({ ...first, lines: [line("line-1", "org-1", "school-1", "OK")] });
  assert.equal(model.registryUnavailable, true);
  assert.equal(model.linkwatch.lines.length, 1);
  assert.equal(model.linkwatch.lines[0].mappingStatus, "REGISTRY_UNAVAILABLE");
  assert.equal(model.registry.total, null);
});

test("coverage rows keep registry-only schools neutral and monitored mode keeps every line", () => {
  const model = buildFrontendModel({
    registryPayload: registry,
    mappingPayload: { entries: [{ organization_id: "org-1", registry_id: "registry-1" }] },
    lines: [line("line-1", "org-1", "school-1", "OK"), line("line-2", "org-1", "school-1", "NO_DATA")],
  });
  const all = coverageRows(model, "all");
  const monitored = coverageRows(model, "monitored");
  assert.equal(all.length, 3);
  assert.equal(all.filter((row) => row.registryOnly).length, 1);
  assert.equal(all.find((row) => row.registryOnly).status, "NOT_MONITORED");
  assert.deepEqual(monitored.map((row) => row.id), ["line-1", "line-2"]);
});
