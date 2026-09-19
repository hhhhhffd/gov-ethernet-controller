import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import {
  ImportInputError,
  ImportSourceError,
  buildDeterministicMatches,
  buildImportArtifacts,
  createImportSnapshot,
  dedupeOsmSchools,
  fetchOverpassSnapshot,
  filterCurrentVkoRows,
  isCoordinateInCurrentVko,
  matchRegistryToOsm,
  main,
  loadImportSources,
  normalizeAddress,
  normalizeCurrentRegistryRows,
  normalizeName,
  normalizeStateSchoolRows,
  parseSourceText,
  resolveSchoolCoordinate,
  selectCurrentVkoRelation,
  validateCoordinate,
  writeImportArtifacts,
  checkImportArtifacts,
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

test("name and address normalization is stable across punctuation, number tokens, and transliteration", () => {
  assert.equal(normalizeName("  Школа № 1 — Мектеп  "), "школа number 1 мектеп");
  assert.equal(normalizeName("Shkola No 1 Mektep"), "shkola number 1 mektep");
  assert.equal(normalizeAddress("ул. Абая, 1"), "улица абая 1");
  assert.equal(normalizeAddress("улица Абая 1"), "улица абая 1");
});

test("matching uses exact compatible identifiers before names and preserves official display names", () => {
  const result = matchRegistryToOsm(
    [{ school_id: "vko-001", name: "Официальное имя № 1", region: "current-vko" }],
    [{ osm_id: "node/1", school_id: "vko-001", name: "Другое имя", region: "current-vko", latitude: 50, longitude: 82 }],
  );
  assert.equal(result.matches[0].match_status, "AUTO_MATCH");
  assert.equal(result.matches[0].confidence, 1);
  assert.equal(result.matches[0].match_method, "official_id");
  assert.equal(result.matches[0].registry.display_name, "Официальное имя № 1");
});

test("exact name and area auto-match, while fuzzy matches stay review-only", () => {
  const exact = matchRegistryToOsm(
    [{ school_id: "school-1", name: "Средняя школа № 1", district: "Уланский район", locality: "Таврическое", region: "current-vko" }],
    [{ osm_id: "node/1", name: "Школа N 1", district: "Уланский район", locality: "Таврическое", region: "current-vko", latitude: 50, longitude: 82 }],
  );
  assert.equal(exact.matches[0].match_status, "AUTO_MATCH");
  assert.equal(exact.matches[0].confidence, 0.95);

  const fuzzy = matchRegistryToOsm(
    [{ school_id: "school-1", name: "Средняя школа Центральная", district: "Уланский район", locality: "Таврическое", region: "current-vko" }],
    [{ osm_id: "node/1", name: "Средняя школа Централная", district: "Уланский район", locality: "Таврическое", region: "current-vko", latitude: 50, longitude: 82 }],
  );
  assert.equal(fuzzy.matches[0].match_status, "REVIEW_REQUIRED");
  assert.ok(fuzzy.matches[0].confidence >= 0.75 && fuzzy.matches[0].confidence < 0.9);

  const unmatched = matchRegistryToOsm(
    [{ school_id: "school-1", name: "Школа Северная", district: "Уланский район", locality: "Таврическое", region: "current-vko" }],
    [{ osm_id: "node/1", name: "Школа Южная", district: "Уланский район", locality: "Таврическое", region: "current-vko", latitude: 50, longitude: 82 }],
  );
  assert.equal(unmatched.matches[0].match_status, "UNMATCHED");
  assert.equal(unmatched.matches[0].candidate, null);
});

test("equal top candidates are explicit ambiguity and never auto-approved", () => {
  const result = matchRegistryToOsm(
    [{ school_id: "school-1", name: "Средняя школа № 1", district: "Уланский район", locality: "Таврическое", region: "current-vko" }],
    [
      { osm_id: "node/1", name: "Средняя школа № 1", district: "Уланский район", locality: "Таврическое", region: "current-vko", latitude: 50, longitude: 82 },
      { osm_id: "way/2", name: "Средняя школа № 1", district: "Уланский район", locality: "Таврическое", region: "current-vko", latitude: 50.001, longitude: 82.001 },
    ],
  );
  assert.equal(result.matches[0].candidate, null);
  assert.equal(result.matches[0].ambiguous, true);
  assert.equal(result.matches[0].match_status, "REVIEW_REQUIRED");
  assert.equal(result.matches[0].match_method, "ambiguous_tie");
});

test("coordinate precedence is official, confident OSM, reviewed override, then no coordinate", () => {
  const boundary = { minLatitude: 49, maxLatitude: 51, minLongitude: 81, maxLongitude: 83 };
  assert.deepEqual(
    resolveSchoolCoordinate({
      official: { latitude: 50, longitude: 82 },
      osm: { latitude: 50.1, longitude: 82.1 },
      osmMatchStatus: "AUTO_MATCH",
      reviewedOverride: { latitude: 50.2, longitude: 82.2 },
      boundary,
    }),
    { latitude: 50, longitude: 82, source: "official" },
  );
  assert.deepEqual(
    resolveSchoolCoordinate({
      official: { latitude: 50, longitude: 82 },
      osm: { latitude: 50.1, longitude: 82.1 },
      osmMatchStatus: "AUTO_MATCH",
      reviewedOverride: { latitude: 50.2, longitude: 82.2 },
      boundary: { minLatitude: 50.05, maxLatitude: 51, minLongitude: 81, maxLongitude: 83 },
    }),
    { latitude: 50.1, longitude: 82.1, source: "osm" },
  );
  assert.deepEqual(
    resolveSchoolCoordinate({
      official: { latitude: 50, longitude: 82 },
      osm: { latitude: 50.1, longitude: 82.1 },
      osmMatchStatus: "REVIEW_REQUIRED",
      reviewedOverride: { latitude: 50.2, longitude: 82.2 },
      boundary: { minLatitude: 50.05, maxLatitude: 51, minLongitude: 81, maxLongitude: 83 },
    }),
    { latitude: 50.2, longitude: 82.2, source: "reviewed_override" },
  );
  assert.equal(resolveSchoolCoordinate({}).latitude, null);
});

test("invalid and outside-VKO coordinates are rejected without fallback", () => {
  const boundary = { minLatitude: 50, maxLatitude: 51, minLongitude: 82, maxLongitude: 83 };
  assert.equal(validateCoordinate({ latitude: 91, longitude: 82 }, { boundary }).valid, false);
  assert.equal(validateCoordinate({ latitude: 49.9, longitude: 82 }, { boundary }).reason, "outside_current_vko");
  assert.equal(isCoordinateInCurrentVko({ latitude: 50.5, longitude: 82.5 }, boundary), true);
  assert.equal(isCoordinateInCurrentVko({ latitude: 49.5, longitude: 82.5 }, boundary), false);
  const resolved = resolveSchoolCoordinate({
    official: { latitude: 91, longitude: 82 },
    osm: { latitude: 49, longitude: 82 },
    osmMatchStatus: "AUTO_MATCH",
    boundary,
  });
  assert.equal(resolved.latitude, null);
  assert.deepEqual(resolved.invalid_sources, ["invalid", "outside_current_vko"]);
});

test("Abai records are excluded and OSM node/way/relation geometry duplicates collapse deterministically", () => {
  const result = dedupeOsmSchools([
    { osm_id: "way/2", name: "Школа № 1", region: "current-vko", latitude: 50, longitude: 82 },
    { osm_id: "node/1", name: "Школа № 1", region: "current-vko", latitude: 50.00001, longitude: 82.00001 },
    { osm_id: "relation/3", name: "Школа № 1", region: "current-vko", latitude: 50.00002, longitude: 82.00002 },
    { osm_id: "node/4", name: "Школа Абай", region: "Абайская область", latitude: 49, longitude: 79 },
  ]);
  assert.equal(result.schools.length, 1);
  assert.equal(result.duplicates.length, 2);
  assert.equal(result.schools[0].osm_id, "node/1");
});

test("matching output is deterministic and never invents coordinates", () => {
  const input = {
    registrySchools: [
      { school_id: "b", name: "Школа B", region: "current-vko" },
      { school_id: "a", name: "Школа A", region: "current-vko" },
    ],
    osmSchools: [],
  };
  const first = buildDeterministicMatches(input);
  const second = buildDeterministicMatches(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.matches.map((match) => match.registry.school_id), ["a", "b"]);
  assert.deepEqual(first.matches.map((match) => [match.coordinate.latitude, match.coordinate.longitude]), [[null, null], [null, null]]);
});

function artifactSnapshot() {
  return {
    current_schools: [
      {
        school_id: "vko-001",
        name: "Официальная школа № 1",
        district: "Уланский район",
        locality: "Таврическое",
        address: "ул. Абая, 1",
        region: "current-vko",
      },
      {
        school_id: "vko-002",
        name: "Школа без координат",
        district: "Уланский район",
        locality: "Таврическое",
        address: "ул. Центральная, 2",
        region: "current-vko",
      },
    ],
    state_school_coordinates: [
      {
        school_id: "vko-001",
        name: "Официальная школа № 1",
        district: "Уланский район",
        locality: "Таврическое",
        address: "ул. Абая, 1",
        region: "current-vko",
        latitude: 50,
        longitude: 82,
      },
    ],
    overpass: {
      relation: { id: 1, tags: { "ISO3166-2": "KZ-EK" } },
      schools: [
        {
          osm_id: "node/1",
          osm_type: "node",
          name: "Официальная школа № 1",
          school_id: "vko-001",
          region: "current-vko",
          latitude: 50,
          longitude: 82,
        },
        {
          osm_id: "node/orphan",
          osm_type: "node",
          name: "OSM only school",
          region: "current-vko",
          latitude: 50.1,
          longitude: 82.1,
        },
      ],
    },
  };
}

test("artifact builder emits registry provenance, consistent counters, and empty review queue", () => {
  const artifacts = buildImportArtifacts({ snapshot: artifactSnapshot() });
  assert.equal(artifacts.registry.schools.length, 2);
  assert.deepEqual(Object.keys(artifacts.registry.schools[0]).sort(), [
    "address", "confidence", "coordinate_source", "district", "identity_source", "latitude",
    "locality", "match_method", "name", "official_name", "osm_id", "osm_type", "registry_id", "longitude",
  ].sort());
  assert.equal(artifacts.registry.schools[0].official_name, "Официальная школа № 1");
  assert.equal(artifacts.registry.schools[1].latitude, null);
  assert.equal(artifacts.report.counters.official_schools_total, 2);
  assert.equal(artifacts.report.counters.official_coordinates, 1);
  assert.equal(artifacts.report.counters.matched_osm, 1);
  assert.equal(artifacts.report.counters.osm_only, 1);
  assert.equal(artifacts.report.counters.without_coordinates, 1);
  assert.equal(artifacts.report.counters.duplicates_removed, 0);
  assert.equal(artifacts.report.consistency.coordinate_partition, true);
  assert.match(artifacts.reviewCsv, /^registry_id,official_name,/);
  assert.equal(artifacts.reviewCsv.trimEnd().split("\n").length, 1);
});

function ambiguousSnapshot() {
  return {
    current_schools: [{
      school_id: "vko-review-001",
      name: "Школа для проверки",
      district: "Уланский район",
      locality: "Таврическое",
      region: "current-vko",
    }],
    state_school_coordinates: [],
    overpass: {
      relation: { id: 1, tags: {} },
      schools: [
        { osm_id: "node/1", osm_type: "node", name: "Школа для проверки", district: "Уланский район", locality: "Таврическое", region: "current-vko", latitude: 50, longitude: 82 },
        { osm_id: "way/2", osm_type: "way", name: "Школа для проверки", district: "Уланский район", locality: "Таврическое", region: "current-vko", latitude: 50.001, longitude: 82.001 },
      ],
    },
  };
}

test("reviewed overrides apply only to ambiguous cases and retain provenance", () => {
  const artifacts = buildImportArtifacts({
    snapshot: ambiguousSnapshot(),
    reviewedOverrides: [{
      registry_id: "vko-review-001",
      latitude: 50.2,
      longitude: 82.2,
      reviewed: true,
      provenance: "manual-review-fixture",
    }],
    boundary: { minLatitude: 50, maxLatitude: 51, minLongitude: 82, maxLongitude: 83 },
  });
  assert.equal(artifacts.registry.schools[0].coordinate_source, "reviewed_override");
  assert.equal(artifacts.registry.schools[0].coordinate_provenance, "manual-review-fixture");
  assert.equal(artifacts.report.counters.ambiguous, 1);
  assert.match(artifacts.reviewCsv, /vko-review-001/);
});

test("review queue consistency counts non-ambiguous REVIEW_REQUIRED rows", () => {
  const artifacts = buildImportArtifacts({
    snapshot: {
      current_schools: [{ school_id: "vko-outside-001", name: "Школа с плохой точкой", region: "current-vko" }],
      state_school_coordinates: [{
        school_id: "vko-outside-001",
        name: "Школа с плохой точкой",
        region: "current-vko",
        latitude: 49,
        longitude: 82,
      }],
      overpass: {
        relation: { id: 1, tags: {} },
        schools: [{
          osm_id: "node/outside-source",
          osm_type: "node",
          school_id: "vko-outside-001",
          name: "Школа с плохой точкой",
          region: "current-vko",
          latitude: 50.1,
          longitude: 82.1,
        }],
      },
    },
    boundary: { minLatitude: 50, maxLatitude: 51, minLongitude: 81, maxLongitude: 83 },
  });
  assert.equal(artifacts.report.counters.ambiguous, 0);
  assert.equal(artifacts.report.counters.review_required, 1);
  assert.equal(artifacts.report.consistency.review_queue_matches_review_required, true);
  assert.match(artifacts.reviewCsv, /vko-outside-001/);
});

test("overrides reject unknown, malformed, non-reviewed, and outside-VKO entries", () => {
  const cases = [
    [{ registry_id: "unknown", latitude: 50.2, longitude: 82.2, reviewed: true }, "unknown registry_id"],
    [{ registry_id: "vko-review-001", latitude: "not-a-number", longitude: 82.2, reviewed: true }, "invalid coordinates"],
    [{ registry_id: "vko-review-001", latitude: 50.2, longitude: 82.2 }, "must be explicitly reviewed"],
    [{ registry_id: "vko-review-001", latitude: 49, longitude: 82.2, reviewed: true }, "outside_current_vko"],
  ];
  for (const [override, message] of cases) {
    assert.throws(
      () => buildImportArtifacts({
        snapshot: ambiguousSnapshot(),
        reviewedOverrides: [override],
        boundary: { minLatitude: 50, maxLatitude: 51, minLongitude: 82, maxLongitude: 83 },
      }),
      (error) => error instanceof ImportInputError && error.message.includes(message),
    );
  }
  assert.throws(
    () => buildImportArtifacts({ snapshot: ambiguousSnapshot(), reviewedOverrides: { bad: true } }),
    (error) => error instanceof ImportInputError && error.message.includes("overrides array"),
  );
});

test("artifact files are deterministic, checkable, and reject malformed output paths", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "vko-import-"));
  try {
    const artifacts = buildImportArtifacts({ snapshot: artifactSnapshot() });
    const paths = {
      registryPath: path.join(temporaryDirectory, "registry.json"),
      reportPath: path.join(temporaryDirectory, "report.json"),
      reviewPath: path.join(temporaryDirectory, "review.csv"),
    };
    const first = await writeImportArtifacts(artifacts, paths);
    const second = await writeImportArtifacts(artifacts, paths);
    assert.deepEqual(first, second);
    await checkImportArtifacts(artifacts, paths);
    await assert.rejects(
      () => writeImportArtifacts(artifacts, { ...paths, registryPath: temporaryDirectory }),
      (error) => error instanceof ImportInputError && error.source === "output",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("main --check validates fixture inputs without writing artifacts", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "vko-import-check-"));
  try {
    const currentFile = path.join(fixtureDirectory, "current-registry.csv");
    const stateFile = path.join(fixtureDirectory, "state-schools.csv");
    const relationJson = await fixture("overpass-relations.json");
    const schoolsJson = await fixture("overpass-schools.json");
    let overpassCalls = 0;
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () => (overpassCalls++ === 0 ? relationJson : schoolsJson),
    });
    const env = {
      EGOV_CURRENT_SCHOOLS_FILE: currentFile,
      EGOV_STATE_SCHOOLS_FILE: stateFile,
      OVERPASS_ENDPOINT: "https://overpass.test/api/interpreter",
    };
    const paths = [
      "--registry-output", path.join(temporaryDirectory, "registry.json"),
      "--report-output", path.join(temporaryDirectory, "report.json"),
      "--review-output", path.join(temporaryDirectory, "review.csv"),
      "--overrides", path.join(temporaryDirectory, "missing-overrides.json"),
    ];
    await main(paths, env, fetchImpl);
    overpassCalls = 0;
    await main([...paths, "--check"], env, fetchImpl);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
