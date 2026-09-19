const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildFrontendModel,
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
