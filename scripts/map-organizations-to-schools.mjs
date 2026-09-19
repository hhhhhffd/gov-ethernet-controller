#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

export const DEFAULT_REGISTRY_PATH = "web/data/vko-schools.json";
export const DEFAULT_ORGANIZATIONS_PATH = "scripts/fixtures/organization-school-map/demo-organizations.json";
export const DEFAULT_OUTPUT_PATH = "web/data/organization-school-map.json";
export const MAPPING_SCHEMA_VERSION = 1;

const DEFAULT_DISCLOSURE = {
  geography_status: "registry-not-available",
  measurements_status: "synthetic-development-fixture",
  registry_coordinates_are_authoritative: true,
  synthetic_seed_coordinates_must_not_be_used_as_registry_coordinates: true,
  synthetic_measurements_must_not_be_presented_as_live_or_official: true,
};

export class MappingInputError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "MappingInputError";
    this.code = code;
  }
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function stringValue(value) {
  return hasValue(value) ? String(value).trim() : null;
}

/** Comparison-only normalization. It never creates or replaces an identifier. */
export function normalizeExactText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\b(?:n|no|num|номер)\b/g, " number ")
    .replace(/№/g, " number ")
    .replace(/[«»\"'`.,;:()[\]{}\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeExactIdentifier(value) {
  return normalizeExactText(value).replace(/\s+/g, "");
}

function normalizeRecord(record, kind, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new MappingInputError("MALFORMED_INPUT", `${kind} entry ${index + 1} must be an object`);
  }
  return record;
}

function recordsFromPayload(payload, key, source) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw new MappingInputError("MALFORMED_INPUT", `${source} must be a JSON array or object`);
  }
  if (Array.isArray(payload[key])) return payload[key];
  if (Array.isArray(payload.schools) && key === "organizations") return payload.schools;
  if (Array.isArray(payload.organizations) && key === "schools") return payload.organizations;
  throw new MappingInputError("MALFORMED_INPUT", `${source} does not contain ${key}`);
}

function registryId(record, index) {
  const id = stringValue(record.registry_id);
  if (!id) throw new MappingInputError("MALFORMED_INPUT", `registry entry ${index + 1} is missing registry_id`);
  return id;
}

function organizationId(record, index) {
  const id = stringValue(record.organization_id ?? record.id);
  if (!id) throw new MappingInputError("MALFORMED_INPUT", `organization entry ${index + 1} is missing organization_id`);
  return id;
}

function registryIdentifiers(record) {
  return [record.registry_id, record.school_id, record.bin]
    .filter(hasValue)
    .map(normalizeExactIdentifier);
}

function organizationIdentifiers(record) {
  return [record.registry_id, record.school_id, record.bin]
    .filter(hasValue)
    .map(normalizeExactIdentifier);
}

function exactField(record, field) {
  return normalizeExactText(record[field]);
}

function sameFields(left, right, fields) {
  return fields.every((field) => {
    const leftValue = exactField(left, field);
    const rightValue = exactField(right, field);
    return leftValue && rightValue && leftValue === rightValue;
  });
}

function candidateFor(organization, registry) {
  const organizationIds = organizationIdentifiers(organization);
  const registryIds = new Set(registryIdentifiers(registry));
  if (organizationIds.some((identifier) => registryIds.has(identifier))) {
    return { confidence: 1, match_method: "exact_identifier", evidence: ["identifier"] };
  }
  if (sameFields(organization, registry, ["name", "locality", "address"])) {
    return { confidence: 0.99, match_method: "exact_name_locality_address", evidence: ["name", "locality", "address"] };
  }
  if (sameFields(organization, registry, ["name", "locality"])) {
    return { confidence: 0.95, match_method: "exact_name_locality", evidence: ["name", "locality"] };
  }
  if (sameFields(organization, registry, ["name", "address"])) {
    return { confidence: 0.95, match_method: "exact_name_address", evidence: ["name", "address"] };
  }
  return null;
}

function sortById(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function normalizeDevices(devices, pointId, lineId) {
  if (!Array.isArray(devices)) return [];
  return [...new Set(devices.map((device) => stringValue(typeof device === "object" ? device.device_id ?? device.id : device)).filter(Boolean))]
    .sort(sortById)
    .map((deviceId) => ({ device_id: deviceId, monitoring_point_id: pointId, line_id: lineId }));
}

function preserveBackendChain(organization, id) {
  const lines = Array.isArray(organization.lines) ? organization.lines : [];
  return {
    organization_id: id,
    school_id: stringValue(organization.school_id),
    canonical_status_source: "backend",
    lines: lines
      .map((line, index) => normalizeRecord(line, `organization ${id} line`, index))
      .map((line, index) => {
        const lineId = stringValue(line.line_id ?? line.id);
        if (!lineId) throw new MappingInputError("MALFORMED_INPUT", `organization ${id} line ${index + 1} is missing line_id`);
        const points = Array.isArray(line.monitoring_points) ? line.monitoring_points : [];
        return {
          line_id: lineId,
          canonical_status_source: stringValue(line.canonical_status_source) ?? "backend.line_state",
          monitoring_points: points
            .map((point, pointIndex) => normalizeRecord(point, `line ${lineId} monitoring point`, pointIndex))
            .map((point, pointIndex) => {
              const pointId = stringValue(point.monitoring_point_id ?? point.id);
              if (!pointId) throw new MappingInputError("MALFORMED_INPUT", `line ${lineId} monitoring point ${pointIndex + 1} is missing monitoring_point_id`);
              return {
                monitoring_point_id: pointId,
                line_id: lineId,
                devices: normalizeDevices(point.devices, pointId, lineId),
              };
            })
            .sort((left, right) => sortById(left.monitoring_point_id, right.monitoring_point_id)),
        };
      })
      .sort((left, right) => sortById(left.line_id, right.line_id)),
  };
}

function syntheticCoordinates(record) {
  const value = record.synthetic_coordinates ?? record.seed_coordinates;
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value.lon ?? value.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new MappingInputError("MALFORMED_INPUT", `invalid synthetic coordinates for ${record.organization_id ?? record.id}`);
  }
  return { latitude, longitude, provenance: "server/internal/admin/seed.go", status: "synthetic-only" };
}

function buildEntry(organization, registryRecords, registryAvailable) {
  const id = organizationId(organization, 0);
  const explicitRegistryId = stringValue(organization.registry_id);
  if (explicitRegistryId && !registryRecords.some((record) => record.registry_id === explicitRegistryId)) {
    throw new MappingInputError("UNKNOWN_REGISTRY", `organization ${id} references unknown registry_id ${explicitRegistryId}`);
  }
  const candidates = registryRecords
    .map((registry) => {
      const score = candidateFor(organization, registry);
      return score ? { registry, ...score } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence || sortById(left.registry.registry_id, right.registry.registry_id));
  const top = candidates[0];
  const tied = top ? candidates.filter((candidate) => candidate.confidence === top.confidence) : [];
  const ambiguous = tied.length > 1;
  const matchStatus = !registryAvailable
    ? "UNMAPPED"
    : ambiguous
      ? "REVIEW_REQUIRED"
      : top
        ? "AUTO_MATCH"
        : "UNMAPPED";
  const matchMethod = !registryAvailable
    ? "registry_unavailable"
    : ambiguous
      ? "ambiguous_exact_match"
      : top?.match_method ?? "no_exact_match";
  const selectedRegistry = matchStatus === "AUTO_MATCH" ? top.registry.registry_id : null;
  return {
    organization_id: id,
    registry_id: selectedRegistry,
    confidence: top?.confidence ?? 0,
    match_method: matchMethod,
    match_status: matchStatus,
    review_required: matchStatus === "REVIEW_REQUIRED",
    evidence: top?.evidence ?? [],
    candidate_registry_ids: candidates.map((candidate) => candidate.registry.registry_id).sort(sortById),
    organization: {
      school_id: stringValue(organization.school_id),
      name: stringValue(organization.name),
      district: stringValue(organization.district),
      locality: stringValue(organization.locality),
      address: stringValue(organization.address),
    },
    coordinate: null,
    coordinate_provenance: "none_until_registry_mapping",
    backend_chain: preserveBackendChain(organization, id),
    synthetic_seed_coordinates: syntheticCoordinates(organization),
  };
}

export function validateMappingArtifact(artifact, registryRecords = []) {
  if (!artifact || artifact.schema_version !== MAPPING_SCHEMA_VERSION || !Array.isArray(artifact.entries)) {
    throw new MappingInputError("INVALID_ARTIFACT", "mapping artifact has an invalid schema");
  }
  const knownRegistryIds = new Set(registryRecords.map((record) => record.registry_id));
  const organizationIds = new Set();
  for (const entry of artifact.entries) {
    if (!entry.organization_id || organizationIds.has(entry.organization_id)) {
      throw new MappingInputError("INVALID_ARTIFACT", "mapping entries must have unique organization_id values");
    }
    organizationIds.add(entry.organization_id);
    if (entry.registry_id !== null && !knownRegistryIds.has(entry.registry_id)) {
      throw new MappingInputError("UNKNOWN_REGISTRY", `mapped registry_id ${entry.registry_id} is not present in vko-schools registry`);
    }
    if (entry.registry_id === null && entry.coordinate !== null) {
      throw new MappingInputError("INVALID_ARTIFACT", `unmapped organization ${entry.organization_id} has coordinates`);
    }
    for (const line of entry.backend_chain?.lines ?? []) {
      if (line.canonical_status_source !== "backend.line_state") {
        throw new MappingInputError("INVALID_ARTIFACT", `line ${line.line_id} must preserve backend.line_state as canonical source`);
      }
      for (const point of line.monitoring_points ?? []) {
        if (point.line_id !== line.line_id) throw new MappingInputError("INVALID_ARTIFACT", `monitoring point ${point.monitoring_point_id} has wrong line_id`);
        for (const device of point.devices ?? []) {
          if (device.monitoring_point_id !== point.monitoring_point_id) throw new MappingInputError("INVALID_ARTIFACT", `device ${device.device_id} has wrong monitoring_point_id`);
        }
      }
    }
  }
  return artifact;
}

export function buildOrganizationSchoolMap({ organizations, registry, provenance = {} } = {}) {
  const organizationRecords = recordsFromPayload(organizations, "organizations", "organizations input")
    .map((record, index) => normalizeRecord(record, "organization", index));
  const registryRecords = recordsFromPayload(registry ?? [], "schools", "registry input")
    .map((record, index) => normalizeRecord(record, "registry", index))
    .map((record, index) => ({ ...record, registry_id: registryId(record, index) }))
    .sort((left, right) => sortById(left.registry_id, right.registry_id));
  const registryIds = new Set();
  for (const record of registryRecords) {
    if (registryIds.has(record.registry_id)) throw new MappingInputError("DUPLICATE_REGISTRY", `duplicate registry_id ${record.registry_id}`);
    registryIds.add(record.registry_id);
  }
  const registryAvailable = provenance.registry_available ?? registryRecords.length > 0;
  const entries = organizationRecords
    .map((organization) => buildEntry(organization, registryRecords, registryAvailable))
    .sort((left, right) => sortById(left.organization_id, right.organization_id));
  const claims = new Map();
  for (const entry of entries.filter((item) => item.registry_id)) {
    claims.set(entry.registry_id, [...(claims.get(entry.registry_id) ?? []), entry.organization_id]);
  }
  for (const entry of entries) {
    const owners = claims.get(entry.registry_id) ?? [];
    if (entry.registry_id && owners.length > 1) {
      entry.registry_id = null;
      entry.match_status = "REVIEW_REQUIRED";
      entry.review_required = true;
      entry.match_method = "registry_claim_collision";
      entry.evidence = ["multiple_organizations_claim_registry_id"];
    }
  }
  const mappedRegistryIds = new Set(entries.map((entry) => entry.registry_id).filter(Boolean));
  const registryOnly = registryRecords
    .filter((record) => !mappedRegistryIds.has(record.registry_id))
    .map((record) => ({
      registry_id: record.registry_id,
      monitoring_status: "UNMONITORED",
      coordinate: null,
      coordinate_provenance: "registry_artifact_only",
    }));
  const counters = {
    organizations: entries.length,
    auto_mapped: entries.filter((entry) => entry.match_status === "AUTO_MATCH").length,
    review_required: entries.filter((entry) => entry.match_status === "REVIEW_REQUIRED").length,
    unmapped: entries.filter((entry) => entry.match_status === "UNMAPPED").length,
    registry_schools: registryRecords.length,
    registry_only_unmonitored: registryOnly.length,
  };
  const artifact = {
    schema_version: MAPPING_SCHEMA_VERSION,
    artifact: "organization-school-map",
    region: "current-vko",
    mapping_semantics: "import-time-only; browser rendering must not fuzzy-match",
    generated_by: "scripts/map-organizations-to-schools.mjs",
    provenance: {
      organizations_input: provenance.organizations_input ?? DEFAULT_ORGANIZATIONS_PATH,
      registry_input: provenance.registry_input ?? DEFAULT_REGISTRY_PATH,
      registry_available: registryAvailable,
      registry_schema_version: provenance.registry_schema_version ?? (registryAvailable ? 1 : null),
      registry_source: registryAvailable ? "vko-schools-import-artifact" : "unavailable; no official generated registry artifact",
      organization_source: provenance.organization_source ?? "backend organization/API payload",
      generated_at: "omitted to keep artifact deterministic",
    },
    match_policy: {
      allowed_methods: ["exact_identifier", "exact_name_locality_address", "exact_name_locality", "exact_name_address"],
      fuzzy_matching: false,
      ambiguity: "REVIEW_REQUIRED with registry_id null",
      unknown_registry: "reject",
    },
    disclosure: {
      ...DEFAULT_DISCLOSURE,
      geography_status: registryAvailable ? "registry-backed-or-review" : "registry-not-available",
      organizations_source: provenance.organization_source ?? "backend organization/API payload",
    },
    counters,
    entries,
    registry_only: registryOnly,
  };
  return validateMappingArtifact(artifact, registryRecords);
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new MappingInputError("READ_ERROR", `cannot read ${label} ${path}: ${error.message}`, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new MappingInputError("MALFORMED_INPUT", `invalid JSON in ${label} ${path}`, error);
  }
}

async function readOptionalRegistry(path) {
  try {
    return { payload: await readJson(path, "registry"), available: true };
  } catch (error) {
    if (error.code === "READ_ERROR" && error.cause?.code === "ENOENT") return { payload: [], available: false };
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function generateMappingArtifact({ organizationsPath = DEFAULT_ORGANIZATIONS_PATH, registryPath = DEFAULT_REGISTRY_PATH, outputPath = DEFAULT_OUTPUT_PATH } = {}) {
  const organizations = await readJson(organizationsPath, "organizations input");
  const registry = await readOptionalRegistry(registryPath);
  const artifact = buildOrganizationSchoolMap({
    organizations,
    registry: registry.payload,
    provenance: {
      organizations_input: organizationsPath,
      registry_input: registryPath,
      registry_available: registry.available,
      organization_source: organizations.source ?? "backend organization/API payload",
    },
  });
  await writeJson(outputPath, artifact);
  return artifact;
}

async function checkArtifact(path, expected) {
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch (error) {
    throw new MappingInputError("CHECK_FAILED", `mapping artifact ${path} is missing or unreadable: ${error.message}`, error);
  }
  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
  if (actual !== expectedText) throw new MappingInputError("CHECK_FAILED", `mapping artifact ${path} is stale`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = {
    organizationsPath: DEFAULT_ORGANIZATIONS_PATH,
    registryPath: DEFAULT_REGISTRY_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--organizations", "--registry", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new MappingInputError("ARGUMENT", `${argument} requires a path`);
      const key = { "--organizations": "organizationsPath", "--registry": "registryPath", "--output": "outputPath" }[argument];
      options[key] = value;
      index += 1;
    } else if (argument === "--check") {
      options.check = true;
    } else if (argument === "--help") {
      process.stdout.write("Usage: node scripts/map-organizations-to-schools.mjs [--organizations FILE] [--registry FILE] [--output FILE] [--check]\n");
      return;
    } else {
      throw new MappingInputError("ARGUMENT", `unknown argument ${argument}`);
    }
  }
  const organizations = await readJson(options.organizationsPath, "organizations input");
  const registry = await readOptionalRegistry(options.registryPath);
  const artifact = buildOrganizationSchoolMap({
    organizations,
    registry: registry.payload,
    provenance: {
      organizations_input: options.organizationsPath,
      registry_input: options.registryPath,
      registry_available: registry.available,
      organization_source: organizations.source ?? "backend organization/API payload",
    },
  });
  if (options.check) await checkArtifact(options.outputPath, artifact);
  else await writeJson(options.outputPath, artifact);
  process.stdout.write(`${JSON.stringify(artifact.counters)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`map-organizations-to-schools: ${error.message}\n`);
    process.exitCode = 1;
  });
}
