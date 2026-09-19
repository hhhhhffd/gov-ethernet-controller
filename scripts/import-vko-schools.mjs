#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import process from "node:process";

export const CURRENT_SCHOOLS_API_URL =
  "https://data.egov.kz/api/v4/onirler_oblystar_kalalar_boi4/v1";
export const STATE_SCHOOLS_API_URL =
  "https://data.egov.kz/api/v4/state_schools/v1";
export const DEFAULT_OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

const CURRENT_REGISTRY_SOURCE = "egov-current-registry";
const STATE_SCHOOLS_SOURCE = "egov-state-schools";
const OVERPASS_SOURCE = "overpass";
const SOURCE_TIMEOUT_MS = 30_000;

const VKO_REGION_ALIASES = new Set([
  "восточно казахстанская",
  "вко",
  "east kazakhstan",
  "шығыс қазақстан",
  "shygys kazakhstan",
]);

const VKO_REGION_CODES = new Set(["63", "630000000", "kz 63", "kz ek", "kz vko", "kz ekr"]);

const ABAI_REGION_ALIASES = new Set([
  "абайская",
  "абай",
  "abai",
]);

const ABAI_REGION_CODES = new Set(["10", "100000000", "kz 10", "kz ab"]);

const REGION_FIELDS = [
  "region",
  "region_name",
  "regionName",
  "oblast",
  "oblast_name",
  "oblastName",
  "region_code",
  "oblast_code",
  "area_name",
  "areaName",
  "admin_area",
];

const FIELD_ALIASES = {
  schoolId: [
    "school_id",
    "schoolId",
    "organization_id",
    "organizationId",
    "id",
    "ID",
    "код школы",
    "идентификатор",
  ],
  bin: ["bin", "BIN", "bin_iin", "БИН", "бину"],
  name: [
    "name",
    "name_full_ru",
    "name_full_kk",
    "name_ru",
    "name_kk",
    "organization_name",
    "Наименование",
    "наименование организации образования",
  ],
  nameKk: ["name_full_kk", "name_kk", "kk_fullName", "атауы"],
  address: [
    "address",
    "legal_address_ru",
    "address_ru",
    "legalAddress",
    "адрес",
    "адрес организации образования",
  ],
  district: [
    "district",
    "district_name",
    "район",
    "наименование района",
    "идентификатор района",
  ],
  locality: [
    "locality",
    "city",
    "city_name",
    "settlement",
    "населенный пункт",
    "наименование села или города",
  ],
  status: ["status", "status_of_org", "active", "статус", "состояние"],
  latitude: ["latitude", "lat", "широта"],
  longitude: ["longitude", "lon", "lng", "долгота"],
  coordinates: ["coordinates", "coordinate", "geo_coord", "координаты"],
};

export class ImportSourceError extends Error {
  constructor(source, message, cause) {
    super(`${source}: ${message}`, cause ? { cause } : undefined);
    this.name = "ImportSourceError";
    this.source = source;
    this.code = "SOURCE_UNAVAILABLE";
  }
}

export class ImportInputError extends Error {
  constructor(source, message, cause) {
    super(`${source}: ${message}`, cause ? { cause } : undefined);
    this.name = "ImportInputError";
    this.source = source;
    this.code = "MALFORMED_INPUT";
  }
}

function nonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function stringValue(value) {
  return nonEmpty(value) ? String(value).trim() : null;
}

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\ufeff/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./()[\]]+/g, " ")
    .trim();
}

function normalizedObject(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]),
  );
}

function firstField(row, aliases) {
  const normalized = normalizedObject(row);
  for (const alias of aliases) {
    const value = normalized[normalizeHeader(alias)];
    if (nonEmpty(value)) return value;
  }
  return null;
}

function canonicalValue(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[«»"'`.,;:()[\]{}\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalRegion(value) {
  return canonicalValue(value)
    .replace(/(?:^|\s)(область|облысы|обл|облыс|region|oblast)(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function regionValues(row) {
  const normalized = normalizedObject(row);
  return REGION_FIELDS.flatMap((field) => {
    const value = normalized[normalizeHeader(field)];
    return nonEmpty(value) ? [value] : [];
  });
}

export function isAbaiRegion(row) {
  return regionValues(row).some((value) => {
    const canonical = canonicalRegion(value);
    return ABAI_REGION_ALIASES.has(canonical) || ABAI_REGION_CODES.has(canonical);
  });
}

export function isCurrentVkoRegion(row) {
  if (isAbaiRegion(row)) return false;
  return regionValues(row).some((value) => {
    const canonical = canonicalRegion(value);
    return VKO_REGION_ALIASES.has(canonical) || VKO_REGION_CODES.has(canonical);
  });
}

function isCurrentStatus(row) {
  const value = firstField(row, FIELD_ALIASES.status);
  if (!nonEmpty(value) || value === true || value === 1) return true;
  const status = canonicalValue(value);
  return ![
    "закрыта",
    "закрыт",
    "ликвидирована",
    "ликвидирован",
    "реорганизована",
    "реорганизован",
    "не действует",
    "closed",
    "liquidated",
    "reorganized",
    "inactive",
  ].includes(status);
}

export function filterCurrentVkoRows(rows) {
  if (!Array.isArray(rows)) throw new ImportInputError("registry", "expected an array of rows");
  return rows.filter((row) => row && typeof row === "object" && isCurrentStatus(row) && isCurrentVkoRegion(row));
}

function parseCoordinatePair(value) {
  if (!nonEmpty(value)) return null;
  const parts = String(value)
    .trim()
    .split(/[;,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return null;
  const [latitude, longitude] = parts;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function coordinatesFromRow(row) {
  const latitudeValue = firstField(row, FIELD_ALIASES.latitude);
  const longitudeValue = firstField(row, FIELD_ALIASES.longitude);
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);
  if (nonEmpty(latitudeValue) && nonEmpty(longitudeValue) && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    return { latitude, longitude };
  }
  return parseCoordinatePair(firstField(row, FIELD_ALIASES.coordinates));
}

function normalizeSchoolRow(row, source) {
  const coordinates = coordinatesFromRow(row);
  return {
    school_id: stringValue(firstField(row, FIELD_ALIASES.schoolId)),
    bin: stringValue(firstField(row, FIELD_ALIASES.bin)),
    name: stringValue(firstField(row, FIELD_ALIASES.name)),
    name_kk: stringValue(firstField(row, FIELD_ALIASES.nameKk)),
    address: stringValue(firstField(row, FIELD_ALIASES.address)),
    district: stringValue(firstField(row, FIELD_ALIASES.district)),
    locality: stringValue(firstField(row, FIELD_ALIASES.locality)),
    region: "current-vko",
    status: stringValue(firstField(row, FIELD_ALIASES.status)),
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    source,
  };
}

export function normalizeCurrentRegistryRows(rows) {
  return filterCurrentVkoRows(rows).map((row) => normalizeSchoolRow(row, CURRENT_REGISTRY_SOURCE));
}

export function normalizeStateSchoolRows(rows) {
  return filterCurrentVkoRows(rows)
    .map((row) => normalizeSchoolRow(row, STATE_SCHOOLS_SOURCE))
    .filter((row) => row.latitude !== null && row.longitude !== null);
}

function splitCsvLine(line, delimiter) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("unterminated quoted field");
  values.push(value);
  return values;
}

export function parseCsv(text, source = "file") {
  const lines = String(text).replace(/^\ufeff/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) throw new ImportInputError(source, "CSV must contain a header and at least one row");
  const delimiter = [",", ";", "\t"].sort((left, right) => splitCsvLine(lines[0], right).length - splitCsvLine(lines[0], left).length)[0];
  const headers = splitCsvLine(lines[0], delimiter).map((header) => header.trim());
  if (headers.some((header) => header === "")) throw new ImportInputError(source, "CSV contains an empty header");
  return lines.slice(1).map((line, lineIndex) => {
    const values = splitCsvLine(line, delimiter);
    if (values.length !== headers.length) {
      throw new ImportInputError(source, `CSV row ${lineIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index].trim()]));
  });
}

function rowsFromPayload(payload, source) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") throw new ImportInputError(source, "expected a JSON array or object containing rows");
  const candidates = [payload.data, payload.items, payload.results, payload.records, payload.rows];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = Object.values(candidate).find((value) => Array.isArray(value));
      if (nested) return nested;
    }
  }
  const nested = Object.values(payload).find((value) => Array.isArray(value));
  if (nested) return nested;
  throw new ImportInputError(source, "JSON object does not contain rows");
}

export function parseSourceText(text, source) {
  const trimmed = String(text).replace(/^\ufeff/, "").trim();
  if (!trimmed) throw new ImportInputError(source, "source returned empty content");
  if (/^[\[{]/.test(trimmed)) {
    try {
      const rows = rowsFromPayload(JSON.parse(trimmed), source);
      if (rows.length === 0) throw new ImportInputError(source, "source returned zero rows");
      return rows;
    } catch (error) {
      if (error instanceof ImportInputError) throw error;
      throw new ImportInputError(source, "invalid JSON", error);
    }
  }
  let rows;
  try {
    rows = parseCsv(trimmed, source);
  } catch (error) {
    if (error instanceof ImportInputError) throw error;
    throw new ImportInputError(source, error.message, error);
  }
  if (rows.length === 0) throw new ImportInputError(source, "source returned zero rows");
  return rows;
}

async function readSourceFile(filePath, source) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new ImportSourceError(source, `cannot read ${filePath}`, error);
  }
  return parseSourceText(text, source);
}

async function fetchText(url, source, fetchImpl, headers = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ImportSourceError(source, `request failed for ${url}`, error);
  }
  if (!response.ok) throw new ImportSourceError(source, `HTTP ${response.status} from ${url}`);
  try {
    return await response.text();
  } catch (error) {
    throw new ImportSourceError(source, `response body could not be read from ${url}`, error);
  }
}

async function loadSource({ filePath, url, source, fetchImpl = fetch, headers }) {
  const rows = filePath
    ? await readSourceFile(filePath, source)
    : parseSourceText(await fetchText(url, source, fetchImpl, headers), source);
  if (rows.length === 0) throw new ImportSourceError(source, "source returned zero rows");
  return rows;
}

export function buildEgovUrl(baseUrl, apiKey) {
  if (!nonEmpty(apiKey)) throw new ImportSourceError("eGov", "EGOV_API_KEY is required when a local file is not configured");
  const url = new URL(baseUrl);
  url.searchParams.set("apiKey", apiKey);
  return url.toString();
}

export const OVERPASS_RELATION_QUERY = `[out:json][timeout:60];
relation["boundary"="administrative"]["admin_level"="4"];
out tags center;`;

export function buildOverpassSchoolQuery(relationId) {
  if (!Number.isInteger(Number(relationId)) || Number(relationId) <= 0) {
    throw new ImportInputError(OVERPASS_SOURCE, `invalid relation id: ${relationId}`);
  }
  const areaId = 3_600_000_000 + Number(relationId);
  return `[out:json][timeout:90];
area(${areaId})->.vko;
nwr["amenity"="school"](area.vko);
out center tags;`;
}

function overpassElements(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.elements)) {
    throw new ImportInputError(OVERPASS_SOURCE, "expected Overpass JSON with an elements array");
  }
  if (payload.elements.length === 0) throw new ImportInputError(OVERPASS_SOURCE, "Overpass returned zero elements");
  return payload.elements;
}

function relationName(tags) {
  return [tags?.name, tags?.name_ru, tags?.name_kk, tags?.official_name]
    .filter(nonEmpty)
    .map(canonicalRegion);
}

export function selectCurrentVkoRelation(payload) {
  const relations = overpassElements(payload).filter((element) => element.type === "relation");
  const selected = relations
    .filter((relation) => {
      const tags = relation.tags ?? {};
      const nameMatches = relationName(tags).some((name) => VKO_REGION_ALIASES.has(name));
      const codeMatches = [tags["ISO3166-2"], tags.ref, tags["ref:ru"]]
        .filter(nonEmpty)
        .map(canonicalRegion)
        .some((code) => VKO_REGION_CODES.has(code));
      const boundary = canonicalValue(tags.boundary) === "administrative";
      const adminLevel = String(tags.admin_level ?? "").trim() === "4";
      const excluded = [tags.name, tags.name_ru, tags.name_kk, tags["ISO3166-2"], tags.ref]
        .filter(nonEmpty)
        .some((value) => ABAI_REGION_ALIASES.has(canonicalRegion(value)) || ABAI_REGION_CODES.has(canonicalRegion(value)));
      return boundary && adminLevel && !excluded && (nameMatches || codeMatches);
    })
    .sort((left, right) => Number(Boolean(right.tags?.["ISO3166-2"] === "KZ-EK")) - Number(Boolean(left.tags?.["ISO3166-2"] === "KZ-EK")));
  if (selected.length === 0) throw new ImportInputError(OVERPASS_SOURCE, "current VKO relation was not found");
  return selected[0];
}

export function normalizeOverpassSchools(payload) {
  return overpassElements(payload)
    .filter((element) => element.type === "node" || element.type === "way" || element.type === "relation")
    .map((element) => {
      const latitude = Number(element.lat ?? element.center?.lat);
      const longitude = Number(element.lon ?? element.center?.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return {
        osm_id: `${element.type}/${element.id}`,
        name: stringValue(element.tags?.name ?? element.tags?.name_ru ?? element.tags?.name_kk),
        school_id: stringValue(element.tags?.ref ?? element.tags?.["operator:type"]),
        latitude,
        longitude,
        source: OVERPASS_SOURCE,
      };
    })
    .filter(Boolean);
}

async function loadJson(url, source, fetchImpl) {
  const text = await fetchText(url, source, fetchImpl, { accept: "application/json" });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ImportInputError(source, "invalid JSON response", error);
  }
}

export async function fetchOverpassSnapshot({ endpoint = DEFAULT_OVERPASS_ENDPOINT, fetchImpl = fetch } = {}) {
  const relationPayload = await loadJson(
    `${endpoint}?data=${encodeURIComponent(OVERPASS_RELATION_QUERY)}`,
    OVERPASS_SOURCE,
    fetchImpl,
  );
  const relation = selectCurrentVkoRelation(relationPayload);
  const schoolPayload = await loadJson(
    `${endpoint}?data=${encodeURIComponent(buildOverpassSchoolQuery(relation.id))}`,
    OVERPASS_SOURCE,
    fetchImpl,
  );
  return {
    relation: {
      id: relation.id,
      name: relation.tags?.name ?? relation.tags?.name_ru ?? relation.tags?.name_kk ?? null,
      tags: relation.tags ?? {},
    },
    schools: normalizeOverpassSchools(schoolPayload),
  };
}

export async function loadImportSources({
  env = process.env,
  fetchImpl = fetch,
  currentRegistryFile = env.EGOV_CURRENT_SCHOOLS_FILE,
  stateSchoolsFile = env.EGOV_STATE_SCHOOLS_FILE,
  overpassEndpoint = env.OVERPASS_ENDPOINT || DEFAULT_OVERPASS_ENDPOINT,
} = {}) {
  const apiKey = env.EGOV_API_KEY;
  const [currentRows, stateRows, overpass] = await Promise.all([
    loadSource({
      filePath: currentRegistryFile,
      url: currentRegistryFile ? null : buildEgovUrl(CURRENT_SCHOOLS_API_URL, apiKey),
      source: CURRENT_REGISTRY_SOURCE,
      fetchImpl,
      headers: { accept: "application/json" },
    }),
    loadSource({
      filePath: stateSchoolsFile,
      url: stateSchoolsFile ? null : buildEgovUrl(STATE_SCHOOLS_API_URL, apiKey),
      source: STATE_SCHOOLS_SOURCE,
      fetchImpl,
      headers: { accept: "application/json" },
    }),
    fetchOverpassSnapshot({ endpoint: overpassEndpoint, fetchImpl }),
  ]);
  return { currentRows, stateRows, overpass };
}

export function createImportSnapshot(sources) {
  const currentSchools = normalizeCurrentRegistryRows(sources.currentRows);
  const stateSchools = normalizeStateSchoolRows(sources.stateRows);
  if (currentSchools.length === 0) throw new ImportInputError(CURRENT_REGISTRY_SOURCE, "no current VKO schools after filtering");
  if (stateSchools.length === 0) throw new ImportInputError(STATE_SCHOOLS_SOURCE, "no current VKO coordinates after filtering");
  if (!sources.overpass?.relation || !Array.isArray(sources.overpass.schools)) {
    throw new ImportInputError(OVERPASS_SOURCE, "missing normalized Overpass snapshot");
  }
  return {
    schema_version: 1,
    region: "current-vko",
    current_schools: currentSchools,
    state_school_coordinates: stateSchools,
    overpass: sources.overpass,
  };
}

export async function runImport(options = {}) {
  return createImportSnapshot(await loadImportSources(options));
}

function printUsage() {
  process.stderr.write("Usage: node scripts/import-vko-schools.mjs [--output FILE]\n");
}

async function main(argv = process.argv.slice(2)) {
  let outputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      outputPath = argv[index + 1];
      index += 1;
      if (!outputPath) throw new Error("--output requires a file path");
    } else if (argv[index] === "--help") {
      printUsage();
      return;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  const snapshot = await runImport();
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`import-vko-schools: ${error.message}\n`);
    process.exitCode = 1;
  });
}
