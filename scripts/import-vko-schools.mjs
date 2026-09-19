#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

export const CURRENT_SCHOOLS_API_URL =
  "https://data.egov.kz/api/v4/onirler_oblystar_kalalar_boi4/v1";
export const STATE_SCHOOLS_API_URL =
  "https://data.egov.kz/api/v4/state_schools/v1";
export const DEFAULT_OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
export const DEFAULT_REGISTRY_OUTPUT = "web/data/vko-schools.json";
export const DEFAULT_REPORT_OUTPUT = "artifacts/vko-schools-import-report.json";
export const DEFAULT_REVIEW_OUTPUT = "artifacts/vko-schools-review.csv";
export const DEFAULT_OVERRIDES_FILE = "web/data/vko-school-overrides.json";

const CURRENT_REGISTRY_SOURCE = "egov-current-registry";
const STATE_SCHOOLS_SOURCE = "egov-state-schools";
const OVERPASS_SOURCE = "overpass";
const SOURCE_TIMEOUT_MS = 30_000;
export const MATCH_AUTO_THRESHOLD = 0.9;
export const MATCH_REVIEW_THRESHOLD = 0.75;
export const OSM_DUPLICATE_DISTANCE_METERS = 50;
export const OSM_EXACT_GEOMETRY_DISTANCE_METERS = 8;

const SCHOOL_GENERIC_TOKENS = new Set([
  "school",
  "shkola",
  "школа",
  "mektep",
  "mektebi",
  "мектеп",
  "орта",
  "orta",
  "средняя",
  "общеобразовательная",
  "лицей",
  "гимназия",
  "secondary",
]);

const CYRILLIC_TRANSLITERATION = new Map(Object.entries({
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ә: "a", ғ: "g", қ: "q", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i",
}));

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
  "region_nam",
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
  longitude: ["longitude", "lon", "lng", "long", "долгота"],
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

function transliterate(value) {
  return [...String(value ?? "")]
    .map((character) => CYRILLIC_TRANSLITERATION.get(character) ?? character)
    .join("");
}

function normalizeNumberToken(value) {
  return value
    .replace(/№/g, " number ")
    .replace(/\b(?:n|no|num|номер)\b/g, " number ");
}

/**
 * Produces comparison keys only. The official display value is never replaced by this key.
 */
export function normalizeMatchText(value) {
  return normalizeNumberToken(String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е"))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeName(value) {
  return normalizeMatchText(value);
}

export function normalizeAddress(value) {
  return normalizeMatchText(value)
    .replace(/(?<!\p{L})(?:ул|улица)(?!\p{L})/gu, "улица")
    .replace(/(?<!\p{L})(?:пр|просп|проспект)(?!\p{L})/gu, "проспект")
    .replace(/(?<!\p{L})(?:пер|переулок)(?!\p{L})/gu, "переулок")
    .replace(/(?<!\p{L})(?:д|дом)(?!\p{L})/gu, "дом")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLocality(value) {
  return normalizeMatchText(value)
    .replace(/(?<!\p{L})(?:с|село|г|город|ауыл)(?!\p{L})/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDistrict(value) {
  return normalizeMatchText(value)
    .replace(/(?<!\p{L})(?:район|аудан)(?!\p{L})/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeIdentifier(value) {
  return normalizeMatchText(value).replace(/\s+/g, "");
}

function transliterationKey(value) {
  return normalizeMatchText(transliterate(normalizeMatchText(value)));
}

function nameKeys(value) {
  const normalized = normalizeName(value);
  return new Set([normalized, transliterationKey(value)].filter(Boolean));
}

function coreNameKey(value) {
  return normalizeName(value)
    .split(" ")
    .filter((token) => !SCHOOL_GENERIC_TOKENS.has(token))
    .join(" ");
}

function coordinateFromValue(value) {
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value.lon ?? value.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function stableRecordKey(record, index = 0) {
  const identifiers = [record.school_id, record.bin, record.osm_id, record.osm_element_id]
    .map(normalizeIdentifier)
    .filter(Boolean);
  if (identifiers.length > 0) return identifiers.join("|");
  return [normalizeName(record.name), normalizeAddress(record.address), normalizeName(record.locality), String(index)]
    .join("|");
}

export function normalizeMatchRecord(record, source = record?.source ?? "unknown") {
  const names = [record?.name, record?.name_ru, record?.name_kk, record?.official_name]
    .filter(nonEmpty)
    .map(String);
  const name = names[0] ?? null;
  const allNameKeys = new Set(names.flatMap((value) => [...nameKeys(value)]));
  const address = stringValue(record?.address ?? record?.addr_street);
  const locality = stringValue(record?.locality ?? record?.city ?? record?.settlement ?? record?.addr_city);
  const district = stringValue(record?.district ?? record?.addr_district);
  const coordinate = coordinateFromValue(record);
  const ids = [record?.school_id, record?.bin, record?.schoolId, record?.ref]
    .filter(nonEmpty)
    .map(normalizeIdentifier)
    .filter(Boolean);
  return {
    ...record,
    source,
    display_name: name,
    name_key: normalizeName(name),
    name_keys: [...allNameKeys].sort(),
    core_name_key: coreNameKey(name),
    address_key: normalizeAddress(address),
    locality_key: normalizeLocality(locality),
    district_key: normalizeDistrict(district),
    identifiers: [...new Set(ids)].sort(),
    coordinate,
    stable_key: stableRecordKey(record),
  };
}

export function isValidCoordinate(value) {
  const coordinate = coordinateFromValue(value);
  return Boolean(coordinate
    && coordinate.latitude >= -90
    && coordinate.latitude <= 90
    && coordinate.longitude >= -180
    && coordinate.longitude <= 180);
}

function coordinateDistanceMeters(left, right) {
  if (!isValidCoordinate(left) || !isValidCoordinate(right)) return Number.POSITIVE_INFINITY;
  const first = coordinateFromValue(left);
  const second = coordinateFromValue(right);
  if (!first || !second) return Number.POSITIVE_INFINITY;
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const meanLatitude = ((first.latitude + second.latitude) / 2) * radians;
  const x = longitudeDelta * Math.cos(meanLatitude);
  const y = latitudeDelta;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = ((currentPoint[1] > point.latitude) !== (previousPoint[1] > point.latitude))
      && (point.longitude < ((previousPoint[0] - currentPoint[0])
        * (point.latitude - currentPoint[1]) / (previousPoint[1] - currentPoint[1])) + currentPoint[0]);
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Accepts an explicit bbox or GeoJSON-like polygon. Without a boundary, only the
 * source's already-verified current-VKO scope can be trusted; no geography is invented.
 */
export function isCoordinateInCurrentVko(value, boundary) {
  if (!isValidCoordinate(value)) return false;
  if (!boundary) return true;
  const coordinate = coordinateFromValue(value);
  const minLatitude = Number(boundary.minLatitude ?? boundary.minLat);
  const maxLatitude = Number(boundary.maxLatitude ?? boundary.maxLat);
  const minLongitude = Number(boundary.minLongitude ?? boundary.minLon);
  const maxLongitude = Number(boundary.maxLongitude ?? boundary.maxLon);
  if ([minLatitude, maxLatitude, minLongitude, maxLongitude].every(Number.isFinite)) {
    return coordinate.latitude >= minLatitude
      && coordinate.latitude <= maxLatitude
      && coordinate.longitude >= minLongitude
      && coordinate.longitude <= maxLongitude;
  }
  const polygon = boundary.type === "Polygon"
    ? boundary.coordinates?.[0]
    : boundary.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  return pointInPolygon(coordinate, polygon);
}

export function validateCoordinate(value, { boundary, sourceVerified = true } = {}) {
  if (!isValidCoordinate(value)) return { valid: false, reason: "invalid" };
  if (!sourceVerified) return { valid: false, reason: "outside_current_vko" };
  if (!isCoordinateInCurrentVko(value, boundary)) return { valid: false, reason: "outside_current_vko" };
  return { valid: true, reason: null, coordinate: coordinateFromValue(value) };
}

function hasExplicitRegion(record) {
  return [record?.region, record?.region_name, record?.oblast, record?.addr_state, record?.addr_province]
    .some(nonEmpty);
}

function isCurrentVkoMatchRecord(record) {
  if (!record || isAbaiRegion(record)) return false;
  if (record.region === "current-vko") return true;
  return !hasExplicitRegion(record) || isCurrentVkoRegion(record);
}

function sameNonEmpty(left, right) {
  return Boolean(left && right && left === right);
}

function sameComparableArea(left, right) {
  return sameNonEmpty(left, right) || (left && right && transliterationKey(left) === transliterationKey(right));
}

function compatibleIdentifier(left, right) {
  return left.identifiers.some((identifier) => right.identifiers.includes(identifier));
}

function compatibleName(left, right) {
  return Boolean(left.name_key && right.name_key && left.name_key === right.name_key);
}

function sameArea(left, right) {
  return sameComparableArea(left.locality_key, right.locality_key)
    && sameComparableArea(left.district_key, right.district_key);
}

function tokenSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function editSimilarity(left, right) {
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const saved = previous[column];
      previous[column] = left[row - 1] === right[column - 1]
        ? diagonal
        : Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + 1);
      diagonal = saved;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function nameSimilarity(left, right) {
  const exact = compatibleName(left, right);
  if (exact) return { score: 1, method: "exact_name" };
  const transliterated = Boolean(left.display_name
    && right.display_name
    && transliterationKey(left.display_name) === transliterationKey(right.display_name));
  const leftKey = left.name_key;
  const rightKey = right.name_key;
  const similarity = Math.max(editSimilarity(leftKey, rightKey), tokenSimilarity(leftKey, rightKey));
  return {
    score: similarity,
    method: transliterated ? "transliterated_name" : "fuzzy_name",
  };
}

function scoreCandidate(registry, candidate) {
  if (!isCurrentVkoMatchRecord(candidate)) return null;
  if (compatibleIdentifier(registry, candidate)) {
    return { score: 1, match_method: "official_id", evidence: ["compatible_id"] };
  }
  const areaMatch = sameArea(registry, candidate);
  const addressMatch = sameNonEmpty(registry.address_key, candidate.address_key);
  const name = nameSimilarity(registry, candidate);
  const coreNameMatch = Boolean(registry.core_name_key
    && candidate.core_name_key
    && registry.core_name_key === candidate.core_name_key);
  const nameMatch = name.score === 1 || coreNameMatch;
  const transliterationOnly = name.method === "transliterated_name" && !nameMatch;
  const coordinateClose = coordinateDistanceMeters(registry.coordinate, candidate.coordinate) <= OSM_DUPLICATE_DISTANCE_METERS;

  if (areaMatch && addressMatch && (nameMatch || transliterationOnly)) {
    return { score: 0.98, match_method: "address_and_name", evidence: ["same_area", "same_address", name.method] };
  }
  if (areaMatch && nameMatch) {
    return {
      score: 0.95,
      match_method: "name_locality_district",
      evidence: ["same_area", coreNameMatch && name.score !== 1 ? "same_name_core" : "exact_name"],
    };
  }
  if (areaMatch && transliterationOnly && (addressMatch || coordinateClose)) {
    return { score: 0.9, match_method: "transliterated_name_area", evidence: ["same_area", "transliterated_name"] };
  }
  if (areaMatch && name.score >= 0.75) {
    return {
      score: Math.min(0.89, Math.max(0.75, 0.75 + (name.score - 0.75) * 0.56)),
      match_method: "fuzzy_name_area",
      evidence: ["same_area", name.method],
    };
  }
  if (addressMatch && (nameMatch || transliterationOnly)) {
    return { score: 0.86, match_method: "address_and_name", evidence: ["same_address", name.method] };
  }
  if (nameMatch && (sameNonEmpty(registry.locality_key, candidate.locality_key)
    || sameNonEmpty(registry.district_key, candidate.district_key))) {
    return { score: 0.86, match_method: "name_partial_area", evidence: [name.method] };
  }
  if (nameMatch && coordinateClose) {
    return { score: 0.82, match_method: "name_and_coordinates", evidence: [name.method, "nearby_coordinates"] };
  }
  if (areaMatch && name.score >= 0.5) {
    return { score: 0.7, match_method: "weak_fuzzy_name", evidence: ["same_area", name.method] };
  }
  return null;
}

function classifyMatch(score, ambiguous = false) {
  if (ambiguous) return "REVIEW_REQUIRED";
  if (score >= MATCH_AUTO_THRESHOLD) return "AUTO_MATCH";
  if (score >= MATCH_REVIEW_THRESHOLD) return "REVIEW_REQUIRED";
  return "UNMATCHED";
}

function compareRecords(left, right) {
  return left.stable_key.localeCompare(right.stable_key, "en");
}

function dedupeGroupKey(record) {
  const identity = osmIdentity(record);
  if (identity) return `id:${identity}`;
  const name = record.name_key;
  const address = record.address_key;
  if (!name || !record.coordinate) return null;
  return `geo:${name}|${address}|${record.coordinate.latitude.toFixed(5)}|${record.coordinate.longitude.toFixed(5)}`;
}

function osmIdentity(record) {
  if (nonEmpty(record.osm_type) && nonEmpty(record.osm_element_id)) {
    return `${normalizeMatchText(record.osm_type)}/${normalizeIdentifier(record.osm_element_id)}`.replace(/[\/\s]/g, "");
  }
  if (nonEmpty(record.osm_id)) return normalizeMatchText(record.osm_id).replace(/\s+/g, "");
  return null;
}

function chooseOsmRecord(records) {
  return [...records].sort((left, right) => {
    const leftHasAddress = Number(Boolean(left.address_key));
    const rightHasAddress = Number(Boolean(right.address_key));
    return rightHasAddress - leftHasAddress || compareRecords(left, right);
  })[0];
}

export function dedupeOsmSchools(osmSchools = []) {
  const normalized = osmSchools
    .filter((record) => isCurrentVkoMatchRecord(record))
    .map((record) => normalizeMatchRecord(record, record.source ?? OVERPASS_SOURCE))
    .sort(compareRecords);
  const kept = [];
  const removed = [];
  for (const record of normalized) {
    const identityKey = dedupeGroupKey(record);
    const existingByIdentity = identityKey && kept.find((candidate) => dedupeGroupKey(candidate) === identityKey);
    const existingByGeometry = kept.find((candidate) => {
      if (!record.name_key || record.name_key !== candidate.name_key) return false;
      const sameAddress = record.address_key && candidate.address_key && record.address_key === candidate.address_key;
      const distance = coordinateDistanceMeters(record.coordinate, candidate.coordinate);
      return distance <= (sameAddress ? OSM_DUPLICATE_DISTANCE_METERS : OSM_EXACT_GEOMETRY_DISTANCE_METERS);
    });
    const existing = existingByIdentity ?? existingByGeometry;
    if (!existing) {
      kept.push(record);
      continue;
    }
    const preferred = chooseOsmRecord([existing, record]);
    const discarded = preferred === existing ? record : existing;
    if (preferred !== existing) {
      const index = kept.indexOf(existing);
      kept[index] = preferred;
    }
    removed.push({
      duplicate: discarded,
      kept: preferred,
      reason: existingByIdentity ? "same_osm_identity" : "same_name_geometry",
    });
  }
  kept.sort(compareRecords);
  removed.sort((left, right) => compareRecords(left.duplicate, right.duplicate));
  return { schools: kept, duplicates: removed };
}

function matchCandidates(registryRecord, candidateRecords) {
  const scored = candidateRecords
    .map((candidate) => {
      const score = scoreCandidate(registryRecord, candidate);
      return score ? { candidate, ...score } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || compareRecords(left.candidate, right.candidate));
  if (scored.length === 0) {
    return { candidate: null, candidates: [], confidence: 0, match_status: "UNMATCHED", ambiguous: false, match_method: "none" };
  }
  const top = scored[0];
  const tied = scored.filter((item) => Math.abs(item.score - top.score) < Number.EPSILON);
  const ambiguous = tied.length > 1;
  const matchStatus = classifyMatch(top.score, ambiguous);
  return {
    candidate: ambiguous || matchStatus === "UNMATCHED" ? null : top.candidate,
    candidates: scored,
    confidence: top.score,
    match_status: matchStatus,
    ambiguous,
    match_method: ambiguous ? "ambiguous_tie" : top.match_method,
    evidence: ambiguous ? ["equal_top_candidates"] : top.evidence,
  };
}

export function matchRegistryToOsm(registrySchools = [], osmSchools = []) {
  const registry = registrySchools
    .filter(isCurrentVkoMatchRecord)
    .map((record) => normalizeMatchRecord(record, record.source ?? CURRENT_REGISTRY_SOURCE))
    .sort(compareRecords);
  const osm = dedupeOsmSchools(osmSchools);
  const initialMatches = registry.map((registryRecord) => ({
    registry: registryRecord,
    ...matchCandidates(registryRecord, osm.schools),
  }));
  const candidateUse = new Map();
  for (const match of initialMatches) {
    if (match.candidate) {
      candidateUse.set(match.candidate.stable_key, (candidateUse.get(match.candidate.stable_key) ?? 0) + 1);
    }
  }
  const matches = initialMatches.map((match) => {
    if (!match.candidate || candidateUse.get(match.candidate.stable_key) === 1) return match;
    return {
      ...match,
      candidate: null,
      match_status: "REVIEW_REQUIRED",
      ambiguous: true,
      match_method: "ambiguous_registry_collision",
      evidence: ["one_osm_candidate_for_multiple_registry_rows"],
    };
  });
  const matchedKeys = new Set(matches.map((match) => match.candidate?.stable_key).filter(Boolean));
  return {
    matches,
    osm_only: osm.schools.filter((school) => !matchedKeys.has(school.stable_key)),
    duplicates: osm.duplicates,
  };
}

function reviewedOverrideFor(registryRecord, reviewedOverrides) {
  if (!reviewedOverrides) return null;
  if (reviewedOverrides instanceof Map) {
    return reviewedOverrides.get(normalizeIdentifier(registryIdFor(registryRecord))) ?? null;
  }
  if (Array.isArray(reviewedOverrides)) {
    return reviewedOverrides.find((override) => normalizeIdentifier(override.registry_id) === normalizeIdentifier(registryRecord.school_id));
  }
  return reviewedOverrides[registryRecord.school_id] ?? reviewedOverrides[registryRecord.bin] ?? null;
}

function coordinateCandidate(record, source, options) {
  const validation = validateCoordinate(record, options);
  return validation.valid ? { ...validation.coordinate, source } : { source, invalid_reason: validation.reason };
}

export function resolveSchoolCoordinate({
  official,
  osm,
  osmMatchStatus,
  reviewedOverride,
  boundary,
  officialSourceVerified = true,
} = {}) {
  const officialCoordinate = official && coordinateCandidate(official, "official", { boundary, sourceVerified: officialSourceVerified });
  if (officialCoordinate?.latitude !== undefined) return officialCoordinate;
  const osmCoordinate = osm && osmMatchStatus === "AUTO_MATCH"
    ? coordinateCandidate(osm, "osm", { boundary, sourceVerified: true })
    : null;
  if (osmCoordinate?.latitude !== undefined) return osmCoordinate;
  const overrideCoordinate = reviewedOverride && coordinateCandidate(
    reviewedOverride,
    "reviewed_override",
    { boundary, sourceVerified: true },
  );
  if (overrideCoordinate?.latitude !== undefined) return overrideCoordinate;
  return {
    latitude: null,
    longitude: null,
    source: null,
    invalid_sources: [officialCoordinate, osmCoordinate, overrideCoordinate]
      .filter(Boolean)
      .map((item) => item.invalid_reason)
      .filter(Boolean),
  };
}

export function buildDeterministicMatches({
  registrySchools = [],
  stateSchools = [],
  osmSchools = [],
  reviewedOverrides,
  boundary,
} = {}) {
  const registry = registrySchools
    .filter(isCurrentVkoMatchRecord)
    .map((record) => normalizeMatchRecord(record, record.source ?? CURRENT_REGISTRY_SOURCE));
  const state = stateSchools
    .filter(isCurrentVkoMatchRecord)
    .map((record) => normalizeMatchRecord(record, record.source ?? STATE_SCHOOLS_SOURCE));
  const osmMatches = matchRegistryToOsm(registry, osmSchools);
  const matches = osmMatches.matches.map((match) => {
    const stateMatch = matchCandidates(match.registry, state);
    const reviewedOverride = reviewedOverrideFor(match.registry, reviewedOverrides);
    const official = stateMatch.match_status === "AUTO_MATCH"
      ? stateMatch.candidate?.coordinate
      : match.registry.coordinate;
    const officialValidation = validateCoordinate(official, { boundary, sourceVerified: true });
    const coordinate = resolveSchoolCoordinate({
      official,
      osm: match.candidate,
      osmMatchStatus: match.match_status,
      reviewedOverride,
      boundary,
      officialSourceVerified: true,
    });
    const officialOutside = Boolean(official && !officialValidation.valid && officialValidation.reason === "outside_current_vko");
    return {
      ...match,
      official_match: stateMatch,
      coordinate,
      match_status: officialOutside && match.match_status === "AUTO_MATCH" ? "REVIEW_REQUIRED" : match.match_status,
      review_reasons: [
        ...(match.ambiguous ? ["ambiguous_match"] : []),
        ...(officialOutside ? ["official_coordinate_outside_vko"] : []),
        ...(coordinate.source === null ? ["missing_valid_coordinate"] : []),
      ],
    };
  });
  return {
    matches,
    osm_only: osmMatches.osm_only,
    duplicates: osmMatches.duplicates,
  };
}

function registryIdFor(record) {
  return stringValue(record.school_id) ?? stringValue(record.bin) ?? stableRecordKey(record);
}

function canonicalOverrideEntries(payload, source) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.overrides)) return payload.overrides;
  throw new ImportInputError(source, "expected a JSON array or an object with an overrides array");
}

export function validateReviewedOverrides(overrides, matches, { boundary } = {}) {
  if (overrides === undefined || overrides === null) return [];
  const entries = canonicalOverrideEntries(overrides, "overrides");
  const byId = new Map(matches.map((match) => [registryIdFor(match.registry), match]));
  const normalized = [];
  const seen = new Set();
  for (const [index, override] of entries.entries()) {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new ImportInputError("overrides", `entry ${index + 1} must be an object`);
    }
    const registryId = stringValue(override.registry_id);
    if (!registryId) throw new ImportInputError("overrides", `entry ${index + 1} is missing registry_id`);
    const normalizedId = normalizeIdentifier(registryId);
    if (seen.has(normalizedId)) throw new ImportInputError("overrides", `duplicate registry_id ${registryId}`);
    seen.add(normalizedId);
    const match = byId.get(registryId) ?? [...byId.entries()].find(([id]) => normalizeIdentifier(id) === normalizedId)?.[1];
    if (!match) throw new ImportInputError("overrides", `unknown registry_id ${registryId}`);
    if (!match.ambiguous) {
      throw new ImportInputError("overrides", `registry_id ${registryId} is not an ambiguous review case`);
    }
    const reviewed = override.reviewed === true
      || ["reviewed", "approved"].includes(canonicalValue(override.status));
    if (!reviewed) throw new ImportInputError("overrides", `registry_id ${registryId} must be explicitly reviewed`);
    const coordinate = coordinateFromValue(override);
    const validation = validateCoordinate(coordinate, { boundary, sourceVerified: true });
    if (!validation.valid) {
      throw new ImportInputError("overrides", `registry_id ${registryId} has ${validation.reason} coordinates`);
    }
    normalized.push({
      registry_id: registryId,
      latitude: validation.coordinate.latitude,
      longitude: validation.coordinate.longitude,
      reviewed: true,
      provenance: stringValue(override.provenance) ?? "reviewed_override",
      note: stringValue(override.note),
    });
  }
  return normalized.sort((left, right) => normalizeIdentifier(left.registry_id).localeCompare(normalizeIdentifier(right.registry_id), "en"));
}

function overridesByRegistryId(overrides) {
  return new Map(overrides.map((override) => [normalizeIdentifier(override.registry_id), override]));
}

function registryEntryFromMatch(match, overridesById) {
  const registry = match.registry;
  const registryId = registryIdFor(registry);
  const override = overridesById.get(normalizeIdentifier(registryId));
  const osm = match.candidate;
  const coordinate = match.coordinate;
  const entry = {
    registry_id: registryId,
    official_name: registry.display_name,
    name: registry.display_name,
    district: registry.district ?? null,
    locality: registry.locality ?? null,
    address: registry.address ?? null,
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    identity_source: registry.source ?? CURRENT_REGISTRY_SOURCE,
    coordinate_source: coordinate.source,
    match_method: match.match_method,
    confidence: match.confidence,
  };
  if (osm?.osm_type) entry.osm_type = osm.osm_type;
  if (osm?.osm_id) entry.osm_id = osm.osm_id;
  if (override && coordinate.source === "reviewed_override") entry.coordinate_provenance = override.provenance;
  return entry;
}

function reviewCsvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const REVIEW_CSV_HEADERS = [
  "registry_id", "official_name", "district", "locality", "address", "match_status",
  "confidence", "match_method", "review_reasons", "candidate_count", "candidate_osm_ids",
];

function isReviewQueueMatch(match) {
  return match.match_status === "REVIEW_REQUIRED"
    || match.ambiguous
    || (match.review_reasons ?? []).length > 0;
}

export function renderReviewCsv(matches) {
  const rows = matches
    .filter(isReviewQueueMatch)
    .sort((left, right) => registryIdFor(left.registry).localeCompare(registryIdFor(right.registry), "en"))
    .map((match) => [
      registryIdFor(match.registry),
      match.registry.display_name,
      match.registry.district,
      match.registry.locality,
      match.registry.address,
      match.match_status,
      match.confidence,
      match.match_method,
      [...new Set(match.review_reasons ?? [])].join(";"),
      match.candidates?.length ?? 0,
      (match.candidates ?? []).map((item) => item.candidate.osm_id).filter(Boolean).join(";"),
    ]);
  return `${[REVIEW_CSV_HEADERS, ...rows].map((row) => row.map(reviewCsvValue).join(",")).join("\n")}\n`;
}

function countInvalidCoordinates(matches) {
  return matches.filter((match) => {
    const reasons = [...(match.coordinate?.invalid_sources ?? []), ...(match.review_reasons ?? [])];
    return reasons.some((reason) => reason === "invalid" || reason === "outside_current_vko" || reason === "official_coordinate_outside_vko");
  }).length;
}

export function buildImportArtifacts({ snapshot, reviewedOverrides, boundary } = {}) {
  if (!snapshot || !Array.isArray(snapshot.current_schools)) {
    throw new ImportInputError("artifacts", "snapshot.current_schools is required");
  }
  const matches = buildDeterministicMatches({
    registrySchools: snapshot.current_schools,
    stateSchools: snapshot.state_school_coordinates ?? [],
    osmSchools: snapshot.overpass?.schools ?? [],
    boundary,
  });
  const validatedOverrides = validateReviewedOverrides(reviewedOverrides, matches.matches, { boundary });
  const resolvedMatches = buildDeterministicMatches({
    registrySchools: snapshot.current_schools,
    stateSchools: snapshot.state_school_coordinates ?? [],
    osmSchools: snapshot.overpass?.schools ?? [],
    reviewedOverrides: overridesByRegistryId(validatedOverrides),
    boundary,
  });
  const schools = resolvedMatches.matches
    .map((match) => registryEntryFromMatch(match, overridesByRegistryId(validatedOverrides)))
    .sort((left, right) => left.registry_id.localeCompare(right.registry_id, "en"));
  const counters = {
    official_schools_total: schools.length,
    vko_schools: schools.length,
    official_coordinates: schools.filter((school) => school.coordinate_source === "official").length,
    matched_osm: schools.filter((school) => Boolean(school.osm_id)).length,
    osm_only: resolvedMatches.osm_only.length,
    ambiguous: resolvedMatches.matches.filter((match) => match.ambiguous).length,
    review_required: resolvedMatches.matches.filter((match) => match.match_status === "REVIEW_REQUIRED").length,
    unmatched: resolvedMatches.matches.filter((match) => match.match_status === "UNMATCHED").length,
    without_coordinates: schools.filter((school) => school.latitude === null || school.longitude === null).length,
    duplicates_removed: resolvedMatches.duplicates.length,
    invalid_or_outside_coordinates: countInvalidCoordinates(resolvedMatches.matches),
    review_queue: resolvedMatches.matches.filter(isReviewQueueMatch).length,
  };
  const reviewQueueMatches = resolvedMatches.matches.filter(isReviewQueueMatch);
  const reviewRequiredMatches = resolvedMatches.matches.filter((match) => match.match_status === "REVIEW_REQUIRED");
  const consistency = {
    registry_count_matches_vko_schools: counters.vko_schools === schools.length,
    coordinate_partition: counters.official_coordinates
      + schools.filter((school) => school.coordinate_source === "osm").length
      + schools.filter((school) => school.coordinate_source === "reviewed_override").length
      + counters.without_coordinates === counters.vko_schools,
    review_queue_matches_review_required: reviewRequiredMatches.every((match) => reviewQueueMatches.includes(match)),
    review_queue_matches_rendered: renderReviewCsv(resolvedMatches.matches).trimEnd().split("\n").length - 1 === counters.review_queue,
  };
  if (!Object.values(consistency).every(Boolean)) {
    throw new ImportInputError("artifacts", "generated artifact counters are inconsistent");
  }
  return {
    registry: { schema_version: 1, region: "current-vko", schools },
    report: {
      schema_version: 1,
      region: "current-vko",
      counters,
      consistency,
      sources: {
        official_registry: CURRENT_REGISTRY_SOURCE,
        state_coordinates: STATE_SCHOOLS_SOURCE,
        osm: OVERPASS_SOURCE,
      },
    },
    reviewCsv: renderReviewCsv(resolvedMatches.matches),
    matches: resolvedMatches.matches,
    overrides: validatedOverrides,
  };
}

async function readOptionalJson(filePath) {
  if (!filePath) return undefined;
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new ImportSourceError("overrides", `cannot read ${filePath}`, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ImportInputError("overrides", `invalid JSON in ${filePath}`, error);
  }
}

async function writeArtifact(filePath, content) {
  try {
    await mkdir(dirname(resolve(filePath)), { recursive: true });
    await writeFile(filePath, content, "utf8");
  } catch (error) {
    throw new ImportInputError("output", `cannot write ${filePath}: ${error.message}`, error);
  }
}

function artifactSerialization(artifacts) {
  return {
    registry: `${JSON.stringify(artifacts.registry, null, 2)}\n`,
    report: `${JSON.stringify(artifacts.report, null, 2)}\n`,
    reviewCsv: artifacts.reviewCsv,
  };
}

export async function writeImportArtifacts(artifacts, {
  registryPath = DEFAULT_REGISTRY_OUTPUT,
  reportPath = DEFAULT_REPORT_OUTPUT,
  reviewPath = DEFAULT_REVIEW_OUTPUT,
} = {}) {
  const serialized = artifactSerialization(artifacts);
  await writeArtifact(registryPath, serialized.registry);
  await writeArtifact(reportPath, serialized.report);
  await writeArtifact(reviewPath, serialized.reviewCsv);
  return serialized;
}

async function validateExistingArtifact(path, expected, label) {
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch (error) {
    throw new ImportInputError("check", `${label} ${path} is missing or unreadable: ${error.message}`, error);
  }
  if (actual !== expected) throw new ImportInputError("check", `${label} ${path} is stale; run importer without --check`);
}

export async function checkImportArtifacts(artifacts, paths = {}) {
  const serialized = artifactSerialization(artifacts);
  await validateExistingArtifact(paths.registryPath ?? DEFAULT_REGISTRY_OUTPUT, serialized.registry, "registry artifact");
  await validateExistingArtifact(paths.reportPath ?? DEFAULT_REPORT_OUTPUT, serialized.report, "report artifact");
  await validateExistingArtifact(paths.reviewPath ?? DEFAULT_REVIEW_OUTPUT, serialized.reviewCsv, "review artifact");
  return artifacts.report;
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

async function fetchText(url, source, fetchImpl, headers = {}, requestOptions = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...requestOptions,
      headers,
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ImportSourceError(source, `request failed for ${url}`, error);
  }
  if (!response.ok) {
    const error = new ImportSourceError(source, `HTTP ${response.status} from ${url}`);
    error.status = response.status;
    throw error;
  }
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
      const tags = element.tags ?? {};
      return {
        osm_id: `${element.type}/${element.id}`,
        osm_type: element.type,
        osm_element_id: String(element.id),
        name: stringValue(tags.name ?? tags.name_ru ?? tags.name_kk),
        name_ru: stringValue(tags["name:ru"] ?? tags.name_ru),
        name_kk: stringValue(tags["name:kk"] ?? tags.name_kk),
        school_id: stringValue(tags.ref ?? tags["operator:type"]),
        address: stringValue(tags["addr:street"]
          ? `${tags["addr:street"]} ${tags["addr:housenumber"] ?? ""}`
          : null),
        district: stringValue(tags["addr:district"] ?? tags.district),
        locality: stringValue(tags["addr:city"] ?? tags.city ?? tags.place),
        region: stringValue(tags["addr:state"] ?? tags["addr:province"] ?? "current-vko"),
        latitude,
        longitude,
        source: OVERPASS_SOURCE,
      };
    })
    .filter(Boolean);
}

const OVERPASS_FALLBACK_STATUSES = new Set([405, 406]);

function overpassQueryUrl(endpoint, query) {
  return `${endpoint}?data=${encodeURIComponent(query)}`;
}

async function fetchOverpassQuery({ endpoint, query, fetchImpl }) {
  const postBody = `data=${encodeURIComponent(query)}`;
  try {
    return await fetchText(
      endpoint,
      OVERPASS_SOURCE,
      fetchImpl,
      {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      { method: "POST", body: postBody },
    );
  } catch (error) {
    if (!(error instanceof ImportSourceError) || !OVERPASS_FALLBACK_STATUSES.has(error.status)) {
      throw error;
    }
  }
  return fetchText(
    overpassQueryUrl(endpoint, query),
    OVERPASS_SOURCE,
    fetchImpl,
    { accept: "application/json" },
  );
}

async function loadOverpassJson(endpoint, query, fetchImpl) {
  const text = await fetchOverpassQuery({ endpoint, query, fetchImpl });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ImportInputError(OVERPASS_SOURCE, "invalid JSON response", error);
  }
}

export async function fetchOverpassSnapshot({ endpoint = DEFAULT_OVERPASS_ENDPOINT, fetchImpl = fetch } = {}) {
  const relationPayload = await loadOverpassJson(endpoint, OVERPASS_RELATION_QUERY, fetchImpl);
  const relation = selectCurrentVkoRelation(relationPayload);
  const schoolPayload = await loadOverpassJson(endpoint, buildOverpassSchoolQuery(relation.id), fetchImpl);
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
  process.stderr.write(`Usage: node scripts/import-vko-schools.mjs [options]

Options:
  --output FILE             Preserve legacy normalized snapshot output.
  --registry-output FILE    Registry JSON (default: ${DEFAULT_REGISTRY_OUTPUT}).
  --report-output FILE      Import report JSON (default: ${DEFAULT_REPORT_OUTPUT}).
  --review-output FILE      Review CSV (default: ${DEFAULT_REVIEW_OUTPUT}).
  --overrides FILE          Reviewed coordinate overrides (default: ${DEFAULT_OVERRIDES_FILE}).
  --boundary FILE           JSON current-VKO coordinate boundary.
  --check                   Validate inputs and existing artifacts without writing.
`);
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  let outputPath = null;
  let check = false;
  const paths = {
    registryPath: env.VKO_REGISTRY_OUTPUT || DEFAULT_REGISTRY_OUTPUT,
    reportPath: env.VKO_REPORT_OUTPUT || DEFAULT_REPORT_OUTPUT,
    reviewPath: env.VKO_REVIEW_OUTPUT || DEFAULT_REVIEW_OUTPUT,
    overridesPath: env.VKO_OVERRIDES_FILE || DEFAULT_OVERRIDES_FILE,
    boundaryPath: env.VKO_BOUNDARY_FILE || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      outputPath = argv[index + 1];
      index += 1;
      if (!outputPath) throw new Error("--output requires a file path");
    } else if (["--registry-output", "--report-output", "--review-output", "--overrides", "--boundary"].includes(argv[index])) {
      const option = argv[index];
      const value = argv[index + 1];
      index += 1;
      if (!value) throw new Error(`${option} requires a file path`);
      const key = {
        "--registry-output": "registryPath",
        "--report-output": "reportPath",
        "--review-output": "reviewPath",
        "--overrides": "overridesPath",
        "--boundary": "boundaryPath",
      }[option];
      paths[key] = value;
    } else if (argv[index] === "--check") {
      check = true;
    } else if (argv[index] === "--help") {
      printUsage();
      return;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  const sourceOptions = { env, fetchImpl };
  const snapshot = await runImport(sourceOptions);
  const overrides = await readOptionalJson(paths.overridesPath);
  const boundary = paths.boundaryPath ? await readOptionalJson(paths.boundaryPath) : undefined;
  const artifacts = buildImportArtifacts({ snapshot, reviewedOverrides: overrides, boundary });
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (check) {
    await checkImportArtifacts(artifacts, paths);
  } else {
    await writeImportArtifacts(artifacts, paths);
    if (outputPath) await writeArtifact(outputPath, serialized);
  }
  if (!outputPath) process.stdout.write(`${JSON.stringify(artifacts.report.counters)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`import-vko-schools: ${error.message}\n`);
    process.exitCode = 1;
  });
}
