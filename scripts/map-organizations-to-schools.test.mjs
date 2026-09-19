import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildOrganizationSchoolMap,
  MappingInputError,
  normalizeExactText,
  validateMappingArtifact,
} from "./map-organizations-to-schools.mjs";

const demoOrganizations = {
  source: "server/internal/admin/seed.go",
  organizations: [
    {
      organization_id: "org-42",
      school_id: "school-42",
      name: "Школа №42",
      district: "Алтай",
      address: "ул. Центральная, 42",
      synthetic_coordinates: { latitude: 50.35, longitude: 82.62 },
      lines: [{ line_id: "line-42-primary", monitoring_points: [{ monitoring_point_id: "point-42-primary", devices: ["device-42-primary"] }] }],
    },
  ],
};

const exactRegistry = {
  schools: [
    { registry_id: "registry-42", name: "Школа №42", district: "Алтай", address: "ул. Центральная, 42", locality: "Алтай" },
  ],
};

test("normalization is comparison-only and deterministic", () => {
  assert.equal(normalizeExactText(" Школа № 42, "), "школа number 42");
  const first = buildOrganizationSchoolMap({ organizations: demoOrganizations, registry: exactRegistry, provenance: { registry_available: true } });
  const second = buildOrganizationSchoolMap({
    organizations: { organizations: [...demoOrganizations.organizations].reverse() },
    registry: { schools: [...exactRegistry.schools].reverse() },
    provenance: { registry_available: true },
  });
  assert.deepEqual(first, second);
  assert.equal(first.entries[0].registry_id, "registry-42");
  assert.equal(first.entries[0].match_method, "exact_name_address");
});

test("exact official match carries authoritative registry coordinates", () => {
  const result = buildOrganizationSchoolMap({
    organizations: {
      organizations: [{
        organization_id: "org-real",
        school_id: "school-07",
        name: "Коммунальное государственное учреждение «Средняя школа №7» отдела образования по городу Усть-Каменогорску управления образования Восточно-Казахстанской области",
        district: "Усть-Каменогорск Г.А.",
        address: "Восточно-Казахстанская область,город Усть-Каменогорск,Бульвар Гагарина,8",
        synthetic_coordinates: { latitude: 49.972508, longitude: 82.586298 },
      }],
    },
    registry: {
      schools: [{
        registry_id: "16856",
        name: "Коммунальное государственное учреждение «Средняя школа №7» отдела образования по городу Усть-Каменогорску управления образования Восточно-Казахстанской области",
        address: "Восточно-Казахстанская область,город Усть-Каменогорск,Бульвар Гагарина,8",
        latitude: 49.972508,
        longitude: 82.586298,
      }],
    },
    provenance: { registry_available: true },
  });
  const entry = result.entries[0];
  assert.equal(entry.registry_id, "16856");
  assert.equal(entry.match_method, "exact_name_address");
  assert.deepEqual(entry.coordinate, { latitude: 49.972508, longitude: 82.586298 });
  assert.equal(entry.coordinate_provenance, "official_registry");
  assert.equal(entry.synthetic_seed_coordinates.status, "synthetic-only");
});

test("exact identifier, name/locality/address and conservative ambiguity are supported", () => {
  const result = buildOrganizationSchoolMap({
    organizations: {
      organizations: [
        { organization_id: "org-id", school_id: "school-id", name: "Different", address: "Other" },
        { organization_id: "org-address", name: "Школа №2", locality: "Село", address: "ул. Абая, 2" },
        { organization_id: "org-ambiguous", name: "Школа №3", locality: "Село", address: "ул. Мира, 3" },
      ],
    },
    registry: {
      schools: [
        { registry_id: "school-id", name: "Official name" },
        { registry_id: "registry-2", name: "Школа №2", locality: "Село", address: "ул. Абая, 2" },
        { registry_id: "registry-3a", name: "Школа №3", locality: "Село", address: "ул. Мира, 3" },
        { registry_id: "registry-3b", name: "Школа №3", locality: "Село", address: "ул. Мира, 3" },
      ],
    },
    provenance: { registry_available: true },
  });
  const byOrg = Object.fromEntries(result.entries.map((entry) => [entry.organization_id, entry]));
  assert.equal(byOrg["org-id"].match_method, "exact_identifier");
  assert.equal(byOrg["org-address"].registry_id, "registry-2");
  assert.equal(byOrg["org-address"].match_method, "exact_name_locality_address");
  assert.equal(byOrg["org-ambiguous"].registry_id, null);
  assert.equal(byOrg["org-ambiguous"].match_status, "REVIEW_REQUIRED");
  assert.equal(byOrg["org-ambiguous"].match_method, "ambiguous_exact_match");
});

test("unknown explicit registry identifiers are rejected", () => {
  assert.throws(
    () => buildOrganizationSchoolMap({
      organizations: { organizations: [{ organization_id: "org-unknown", registry_id: "missing" }] },
      registry: { schools: [] },
      provenance: { registry_available: true },
    }),
    (error) => error instanceof MappingInputError && error.code === "UNKNOWN_REGISTRY",
  );
});

test("unavailable registry produces explicit unmapped output without coordinates", () => {
  const result = buildOrganizationSchoolMap({ organizations: demoOrganizations, registry: [], provenance: { registry_available: false } });
  const entry = result.entries[0];
  assert.equal(entry.registry_id, null);
  assert.equal(entry.match_status, "UNMAPPED");
  assert.equal(entry.match_method, "registry_unavailable");
  assert.equal(entry.coordinate, null);
  assert.equal(entry.synthetic_seed_coordinates.status, "synthetic-only");
  assert.equal(result.disclosure.synthetic_seed_coordinates_must_not_be_used_as_registry_coordinates, true);
  assert.equal(result.counters.registry_only_unmonitored, 0);
});

test("registry-only school remains explicitly unmonitored", () => {
  const result = buildOrganizationSchoolMap({ organizations: demoOrganizations, registry: { schools: [{ registry_id: "registry-only" }] }, provenance: { registry_available: true } });
  assert.deepEqual(result.registry_only, [{ registry_id: "registry-only", monitoring_status: "UNMONITORED", coordinate: null, coordinate_provenance: "registry_artifact_only" }]);
});

test("organization to line to point to device chain and backend status source are preserved", () => {
  const result = buildOrganizationSchoolMap({ organizations: demoOrganizations, registry: [], provenance: { registry_available: false } });
  const chain = result.entries[0].backend_chain;
  assert.equal(chain.organization_id, "org-42");
  assert.equal(chain.lines[0].line_id, "line-42-primary");
  assert.equal(chain.lines[0].monitoring_points[0].monitoring_point_id, "point-42-primary");
  assert.equal(chain.lines[0].monitoring_points[0].devices[0].device_id, "device-42-primary");
  assert.equal(chain.lines[0].canonical_status_source, "backend.line_state");
});

test("browser has no fuzzy mapping implementation", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /\b(?:fuzzy|levenshtein|jaro|matchCandidates|normalizeExactText)\b/i);
});

test("validator rejects a fabricated registry id or coordinate on an unmapped organization", () => {
  const artifact = buildOrganizationSchoolMap({ organizations: demoOrganizations, registry: [], provenance: { registry_available: false } });
  assert.throws(() => validateMappingArtifact({ ...artifact, entries: [{ ...artifact.entries[0], registry_id: "fabricated" }] }, []), /not present/);
  assert.throws(() => validateMappingArtifact({ ...artifact, entries: [{ ...artifact.entries[0], coordinate: { latitude: 50, longitude: 82 } }] }, []), /has coordinates/);
});
