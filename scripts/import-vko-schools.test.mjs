import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ImportInputError,
  ImportSourceError,
  createImportSnapshot,
  fetchOverpassSnapshot,
  filterCurrentVkoRows,
  loadImportSources,
  normalizeCurrentRegistryRows,
  normalizeStateSchoolRows,
  parseSourceText,
  selectCurrentVkoRelation,
} from "./import-vko-schools.mjs";

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "import-vko");

async function fixture(name) {
  return readFile(path.join(fixtureDirectory, name), "utf8");
}

test("JSON API and local CSV inputs normalize equivalently", async () => {
  const currentFromApi = normalizeCurrentRegistryRows(
    parseSourceText(await fixture("current-registry.json"), "api fixture"),
  );
  const currentFromFile = normalizeCurrentRegistryRows(
    parseSourceText(await fixture("current-registry.csv"), "file fixture"),
  );
  const coordinatesFromApi = normalizeStateSchoolRows(
    parseSourceText(await fixture("state-schools.json"), "api fixture"),
  );
  const coordinatesFromFile = normalizeStateSchoolRows(
    parseSourceText(await fixture("state-schools.csv"), "file fixture"),
  );

  assert.deepEqual(currentFromApi, currentFromFile);
  assert.deepEqual(coordinatesFromApi, coordinatesFromFile);
  assert.equal(currentFromApi.length, 2);
  assert.equal(coordinatesFromApi.length, 2);
  assert.deepEqual(coordinatesFromApi[1].latitude, 50.223456);
});

test("environment-selected API and local source adapters produce the same source rows", async () => {
  const currentJson = await fixture("current-registry.json");
  const stateJson = await fixture("state-schools.json");
  const relationJson = await fixture("overpass-relations.json");
  const schoolsJson = await fixture("overpass-schools.json");

  const createFetch = () => {
    let overpassCall = 0;
    return async (url) => {
      let body;
      if (url.includes("onirler_oblystar_kalalar_boi4")) body = currentJson;
      else if (url.includes("state_schools")) body = stateJson;
      else body = overpassCall++ === 0 ? relationJson : schoolsJson;
      return { ok: true, status: 200, text: async () => body };
    };
  };

  const apiSources = await loadImportSources({
    env: { EGOV_API_KEY: "fixture-key", OVERPASS_ENDPOINT: "https://overpass.test/api/interpreter" },
    fetchImpl: createFetch(),
  });
  const fileSources = await loadImportSources({
    env: {
      EGOV_CURRENT_SCHOOLS_FILE: path.join(fixtureDirectory, "current-registry.csv"),
      EGOV_STATE_SCHOOLS_FILE: path.join(fixtureDirectory, "state-schools.csv"),
      OVERPASS_ENDPOINT: "https://overpass.test/api/interpreter",
    },
    fetchImpl: createFetch(),
  });

  assert.deepEqual(normalizeCurrentRegistryRows(apiSources.currentRows), normalizeCurrentRegistryRows(fileSources.currentRows));
  assert.deepEqual(normalizeStateSchoolRows(apiSources.stateRows), normalizeStateSchoolRows(fileSources.stateRows));
  assert.deepEqual(apiSources.overpass, fileSources.overpass);
});

test("malformed source input is rejected explicitly", async () => {
  const malformed = await fixture("malformed.json");
  assert.throws(
    () => parseSourceText(malformed, "malformed fixture"),
    (error) => error instanceof ImportInputError && error.code === "MALFORMED_INPUT",
  );
  assert.throws(
    () => parseSourceText("id,name\n1,\"unterminated", "malformed CSV"),
    (error) => error instanceof ImportInputError && error.code === "MALFORMED_INPUT",
  );
  assert.throws(
    () => parseSourceText("[]", "empty JSON"),
    (error) => error instanceof ImportInputError && error.code === "MALFORMED_INPUT",
  );
});

test("current VKO filter excludes Abai and non-current schools", () => {
  const rows = [
    { id: "vko", region: "Восточно-Казахстанская область", status: "active" },
    { id: "abai", region: "Абайская область", status: "active" },
    { id: "closed", region: "East Kazakhstan Region", status: "closed" },
    { id: "code", region_code: "63", status: "Действует" },
    { id: "abai-code", region_code: "KZ-10", status: "Действует" },
  ];
  assert.deepEqual(filterCurrentVkoRows(rows).map((row) => row.id), ["vko", "code"]);
});

test("Overpass selects the current VKO level-4 relation and excludes Abai", async () => {
  const relations = JSON.parse(await fixture("overpass-relations.json"));
  const relation = selectCurrentVkoRelation(relations);
  assert.equal(relation.id, 123456);
  assert.equal(relation.tags["ISO3166-2"], "KZ-EK");

  const schools = JSON.parse(await fixture("overpass-schools.json"));
  const calls = [];
  const snapshot = await fetchOverpassSnapshot({
    endpoint: "https://overpass.test/api/interpreter",
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(calls.length === 1 ? relations : schools),
      };
    },
  });
  assert.equal(snapshot.relation.id, 123456);
  assert.equal(snapshot.schools.length, 2);
  assert.match(calls[1], /area\(3600123456\)/);
});

test("HTTP and unavailable sources never become successful empty imports", async () => {
  await assert.rejects(
    () => fetchOverpassSnapshot({
      endpoint: "https://overpass.test/api/interpreter",
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    }),
    (error) => error instanceof ImportSourceError && error.code === "SOURCE_UNAVAILABLE" && error.source === "overpass",
  );

  assert.throws(
    () => createImportSnapshot({
      currentRows: [],
      stateRows: [],
      overpass: { relation: { id: 1 }, schools: [] },
    }),
    (error) => error instanceof ImportInputError && error.code === "MALFORMED_INPUT",
  );
});
