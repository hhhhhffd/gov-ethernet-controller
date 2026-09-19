const assert = require("node:assert/strict");
const test = require("node:test");

const school = {
  registryId: "registry-32",
  officialName: "Средняя школа №32",
  officialNameKk: "№32 орта мектеп",
  address: "ул. Школьная, 32",
  coordinate: { latitude: 49.988825, longitude: 82.575407 },
  coordinateSource: "official",
  provenance: { source: "official-registry" },
};
const lines = [
  { id: "line-no-data", registrySchool: school, linkwatchStatus: "NO_DATA", latest: {} },
  { id: "line-no-internet", registrySchool: school, linkwatchStatus: "NO_INTERNET", latest: { download: 0, upload: 0, loss: 100 } },
];

test("selected school retains official registry identity and requires explicit multi-line selection", async () => {
  const { createSelectedSchool, selectSchoolLine, selectedLine } = await import("./features/school-detail.mjs");
  const selection = createSelectedSchool({ kind: "monitoring", school, lines });
  assert.equal(selection.school.registryId, "registry-32");
  assert.equal(selection.school.address, "ул. Школьная, 32");
  assert.equal(selection.school.provenance.source, "official-registry");
  assert.equal(selection.selectedLineId, null, "multiple lines must not get a silent default");

  const selected = selectSchoolLine(selection, "line-no-internet");
  assert.equal(selectedLine(selected).id, "line-no-internet");
  assert.equal(selected.detail, null, "changing the selected line clears stale detail");
});

test("line detail keeps the registry join and exposes only actual metrics", async () => {
  const { availableMetrics, mergeLineDetail } = await import("./features/school-detail.mjs");
  const detail = mergeLineDetail(lines[1], {
    status: "NO_INTERNET",
    latest: { observed_at: "2026-09-20T10:00:00Z", download: 0, upload: 0, ping: null, packet_loss: 100 },
    contract: { contract_no: "CN-42" },
  });
  assert.equal(detail.registrySchool, school, "detail response must not replace the registry identity");
  assert.deepEqual(availableMetrics(detail), [["download", 0], ["upload", 0], ["loss", 100]]);
  assert.doesNotMatch(JSON.stringify(availableMetrics({ latest: {} })), /download|upload|ping/, "missing measurements must not produce placeholders");
});

test("NO_DATA and NO_INTERNET use different human RU and KK explanations", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  for (const locale of ["ru", "kk"]) {
    const i18n = createI18n({ locale, storage: null, root: { setAttribute() {} } });
    const presentation = createPresentation(i18n);
    assert.notEqual(presentation.status("NO_DATA").label, presentation.status("NO_INTERNET").label);
    assert.notEqual(presentation.statusDescription("NO_DATA"), presentation.statusDescription("NO_INTERNET"));
  }
});
