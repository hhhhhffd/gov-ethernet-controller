const assert = require("node:assert/strict");
const test = require("node:test");

const schools = [
  {
    registryId: "school-32", officialName: "Средняя школа №32", officialNameKk: "№32 орта мектеп",
    district: "Усть-Каменогорск", address: "ул. Школьная, 32", coordinate: { latitude: 49.98, longitude: 82.57 },
  },
  {
    registryId: "school-east", officialName: "Школа Восток", officialNameRu: "Восточная школа", officialNameKk: "Шығыс мектебі",
    district: "Глубоковский район", address: "с. Глубокое, ул. Абая, 7", coordinate: { latitude: 50.2, longitude: 82.4 },
  },
  {
    registryId: "school-registry-only", officialName: "Школа реестра", district: "Уланский район", address: "с. Примерное, 1", coordinate: { latitude: 50.3, longitude: 82.5 },
  },
];
const lines = [
  { id: "line-no-internet", registryId: "school-32", provider: "Altel", linkwatchStatus: "NO_INTERNET", registrySchool: schools[0] },
  { id: "line-ok", registryId: "school-32", provider: "Kazakhtelecom", linkwatchStatus: "OK", registrySchool: schools[0] },
  { id: "line-degraded", registryId: "school-east", provider: "Altel", linkwatchStatus: "DEGRADED", registrySchool: schools[1] },
];

test("SEARCH finds official, localized, district, address, and school number fields only", async () => {
  const { filterMapSchools } = await import("./features/school-search.mjs");
  const find = (query) => filterMapSchools({ schools, lines, filters: { query } }).schools.map((school) => school.registryId);
  assert.deepEqual(find("№32"), ["school-32"]);
  assert.deepEqual(find("Шығыс"), ["school-east"]);
  assert.deepEqual(find("Глубоковский"), ["school-east"]);
  assert.deepEqual(find("Абая, 7"), ["school-east"]);
  assert.deepEqual(find("line-no-internet"), [], "line identifiers must not become unsupported school-search fields");
});

test("SEARCH ranks exact school number before address substring matches", async () => {
  const { filterMapSchools } = await import("./features/school-search.mjs");
  const registry = require("./data/vko-schools.json");
  const { normalizeRegistryEntry } = require("./data-model.js");
  const normalizedSchools = registry.schools.map(normalizeRegistryEntry);
  const result = filterMapSchools({ schools: normalizedSchools, filters: { query: "32" } });

  assert.equal(result.schools[0].registryId, "18383");
  assert.match(result.schools[0].officialName, /№32/u);
});

test("SEARCH ranks an exact official name before a name substring", async () => {
  const { filterMapSchools } = await import("./features/school-search.mjs");
  const candidates = [
    { registryId: "school-east-substring", officialName: "Школа Востокская" },
    { registryId: "school-east-exact", officialName: "Школа Восток" },
  ];

  const result = filterMapSchools({ schools: candidates, filters: { query: "Школа Восток" } });
  assert.deepEqual(result.schools.map((school) => school.registryId), ["school-east-exact", "school-east-substring"]);
});

test("SEARCH preserves substring matches with deterministic name ordering", async () => {
  const { filterMapSchools } = await import("./features/school-search.mjs");
  const candidates = [
    { registryId: "school-zeta", officialName: "Западная Востокская школа" },
    { registryId: "school-alpha", officialName: "Востокский лицей" },
  ];

  const result = filterMapSchools({ schools: candidates, filters: { query: "восток" } });
  assert.deepEqual(result.schools.map((school) => school.registryId), ["school-alpha", "school-zeta"]);
});

test("SEARCH returns an honest no-result state", async () => {
  const { filterMapSchools } = await import("./features/school-search.mjs");
  const result = filterMapSchools({ schools, lines, filters: { query: "несуществующая школа" } });

  assert.deepEqual(result.schools, []);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.counts, { visibleSchoolCount: 0, monitoredSchoolCount: 0, attentionSchoolCount: 0 });
});

test("FILTER applies real district, provider, status, and coverage to map rows and counts", async () => {
  const { availableMapFilterOptions, filterMapSchools } = await import("./features/school-search.mjs");
  const options = availableMapFilterOptions({ schools, lines });
  assert.deepEqual(options.districts, ["Глубоковский район", "Уланский район", "Усть-Каменогорск"]);
  assert.deepEqual(options.providers, ["Altel", "Kazakhtelecom"]);
  assert.deepEqual(options.statuses, ["DEGRADED", "NO_INTERNET", "NOT_MONITORED"]);

  const filtered = filterMapSchools({
    schools,
    lines,
    filters: { district: "Усть-Каменогорск", provider: "Altel", status: "NO_INTERNET", coverage: "monitored" },
  });
  assert.deepEqual(filtered.schools.map((school) => school.registryId), ["school-32"]);
  assert.deepEqual(filtered.lines.map((line) => line.id), ["line-no-internet"]);
  assert.deepEqual(filtered.counts, { visibleSchoolCount: 1, monitoredSchoolCount: 1, attentionSchoolCount: 1 });

  const registryOnly = filterMapSchools({ schools, lines, filters: { status: "NOT_MONITORED" } });
  assert.deepEqual(registryOnly.schools.map((school) => school.registryId), ["school-registry-only"]);
  assert.equal(registryOnly.lines.length, 0, "registry-only schools must not receive operational rows");
  assert.equal(registryOnly.counts.attentionSchoolCount, 0);
});

test("FILTER returns an honest zero-result view", async () => {
  const { filterMapSchools } = await import("./features/school-search.mjs");
  const result = filterMapSchools({ schools, lines, filters: { provider: "Missing provider" } });
  assert.deepEqual(result.schools, []);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.counts, { visibleSchoolCount: 0, monitoredSchoolCount: 0, attentionSchoolCount: 0 });
});

test("SEARCH selection focuses the rendered real-school marker", async () => {
  const { createMapIntegration } = await import("./integration/map-integration.mjs");
  let rendered = null;
  let focused = null;
  let markerLayers = { monitoringMarkers: [], registryMarkers: [] };
  const mapApi = {
    setMapPresentation() {}, setPresentation() {}, init() {},
    render(context) {
      rendered = context;
      markerLayers = {
        monitoringMarkers: context.lines.map((line) => ({ context: { kind: "monitoring", registryId: line.registryId, school: line.registrySchool, lines: [line] } })),
        registryMarkers: context.registry.schools.map((school) => ({ context: { kind: "registry", registryId: school.registryId, school, lines: [] } })),
      };
      return true;
    },
    getLayers() { return markerLayers; },
    getMarkerContext(marker) { return marker.context; },
    fitToCoordinates(coordinates) { focused = coordinates; return true; },
  };
  const model = { registry: { schools, total: schools.length }, linkwatch: { lines }, registryUnavailable: false, mappingUnavailable: false };
  const integration = createMapIntegration({
    mapApi,
    api: { tryRequest: async () => lines },
    reports: {},
    presentation: { t: (key) => key, empty: () => "—" },
    dataModel: { createDataLoader: () => ({ load: async () => ({ registryPayload: {}, mappingPayload: {} }) }), buildFrontendModel: () => model },
  });
  await integration.loadCurrent();
  integration.setFilters({ query: "№32" });
  assert.deepEqual(rendered.registry.schools.map((school) => school.registryId), ["school-32"]);
  const selection = integration.focusSchool("school-32");
  assert.equal(selection.ok, true);
  assert.equal(selection.context.registryId, "school-32");
  assert.deepEqual(focused, [schools[0].coordinate]);
});
