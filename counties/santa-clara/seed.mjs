/**
 * Santa Clara seed-row helpers for the public GIS candidate run.
 *
 * County-wide GIS CSV construction stays in `scripts/build-santa-clara-gis-seed.mjs`.
 * This module filters that seed to the bounded appraisal sample and attaches
 * the Socrata GET capture URL (query-free `url` + `multiValueQueryString`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

export const COUNTY_KEY = "santa-clara";
export const COUNTY_NAME = "Santa Clara";
export const COUNTY_FIPS = "06085";
export const STATE_CODE = "CA";
export const SOCRATA_RESOURCE_URL = "https://data.sccgov.org/resource/ubcd-cewv.json";
export const SOCRATA_SELECT_FIELDS = Object.freeze([
  "apn",
  "objectid",
  "tax_rate_area",
  "situs_house_number",
  "situs_house_number_suffix",
  "situs_street_direction",
  "situs_street_name",
  "situs_street_type",
  "situs_unit_number",
  "situs_city_name",
  "situs_state_code",
  "situs_zip_code",
  "number_of_situs_address",
  "jurisdiction",
  "shape_length",
  "shape_area",
]);
export const SOCRATA_SELECT = SOCRATA_SELECT_FIELDS.join(",");
// Capture requests include the_geom. The seed CSV select stays SOCRATA_SELECT
// and still does not store polygons; objectid remains geometry_join_key.
export const SOCRATA_CAPTURE_SELECT_FIELDS = Object.freeze([...SOCRATA_SELECT_FIELDS, "the_geom"]);
export const SOCRATA_CAPTURE_SELECT = SOCRATA_CAPTURE_SELECT_FIELDS.join(",");
export const SOCRATA_PAGE_LIMIT = 50000;
export const SOCRATA_SOURCE_DATASET_URL = "https://data.sccgov.org/Government/Parcels/ubcd-cewv";

export const SAMPLE_PARCEL_IDS = Object.freeze([
  "09201021",
  "14810022",
  "09234015",
  "10417087",
  "09206033",
]);

export const SEED_COLUMNS = Object.freeze([
  "parcel_id",
  "source_identifier",
  "situs_address",
  "objectid",
  "tax_rate_area",
  "jurisdiction",
  "situs_house_number",
  "situs_house_number_suffix",
  "situs_street_direction",
  "situs_street_name",
  "situs_street_type",
  "situs_unit_number",
  "situs_city_name",
  "situs_state_code",
  "situs_zip_code",
  "number_of_situs_address",
  "shape_length",
  "shape_area",
  "source_dataset_id",
  "source_dataset_url",
  "source_retrieved_at",
  "geometry_join_key",
  "page_offset",
  "page_limit",
  "capture_sha256",
  "capture_file",
  "method",
  "url",
  "multiValueQueryString",
  "county",
  "county_fips",
  "state",
]);

export function defaultRuntimeRoot() {
  return (
    process.env.SOOFI_ORACLE_RUNTIME ??
    path.join(homedir(), ".cursor/plugins/local/soofi-xyz-team-kit/skills/use-oracle/runtime")
  );
}

export function toText(value) {
  if (value == null) return "";
  return String(value).trim();
}

export function socrataQueryForApn(parcelId) {
  return {
    $select: [SOCRATA_CAPTURE_SELECT],
    $where: [`apn='${parcelId}'`],
    $limit: ["1"],
  };
}

/** Query string for a paginated Socrata page GET recorded at capture time. */
export function socrataQueryForPage({ offset, limit = SOCRATA_PAGE_LIMIT } = {}) {
  if (offset == null || offset === "") {
    throw new Error("paginated Socrata request requires exact $offset recorded at capture time");
  }
  if (limit == null || limit === "") {
    throw new Error("paginated Socrata request requires exact $limit recorded at capture time");
  }
  return {
    $select: [SOCRATA_CAPTURE_SELECT],
    $order: ["objectid"],
    $limit: [String(limit)],
    $offset: [String(offset)],
  };
}

export function buildBulkPageSourceHttpRequest({ offset, limit = SOCRATA_PAGE_LIMIT } = {}) {
  return {
    method: "GET",
    url: SOCRATA_RESOURCE_URL,
    multiValueQueryString: socrataQueryForPage({ offset, limit }),
  };
}

export function socrataPageUrl({ offset = 0, limit = SOCRATA_PAGE_LIMIT } = {}) {
  const url = new URL(SOCRATA_RESOURCE_URL);
  for (const [key, values] of Object.entries(socrataQueryForPage({ offset, limit }))) {
    url.searchParams.set(key, values[0]);
  }
  return url.toString();
}

export function toSocrataCaptureUrl(row) {
  const parcelId = toText(row.parcel_id || row.source_identifier);
  if (!parcelId) throw new Error("missing parcel_id");
  const url = new URL(toText(row.url) || SOCRATA_RESOURCE_URL);
  const rawQs = toText(row.multiValueQueryString);
  if (rawQs) {
    try {
      const parsed = JSON.parse(rawQs);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          const first = Array.isArray(value) ? value[0] : value;
          if (first != null && String(first).trim() !== "") {
            url.searchParams.set(key, String(first));
          }
        }
        return url.toString();
      }
    } catch {
      // Fall through.
    }
  }
  for (const [key, values] of Object.entries(socrataQueryForApn(parcelId))) {
    url.searchParams.set(key, values[0]);
  }
  return url.toString();
}

export function toSeedRow(gisRow) {
  const parcelId = toText(gisRow.parcel_id);
  return {
    ...gisRow,
    parcel_id: parcelId,
    source_identifier: toText(gisRow.source_identifier) || parcelId,
    method: "GET",
    url: SOCRATA_RESOURCE_URL,
    multiValueQueryString: JSON.stringify(socrataQueryForApn(parcelId)),
    county: COUNTY_NAME,
    county_fips: COUNTY_FIPS,
    state: STATE_CODE,
  };
}

export async function buildSeed({
  gisSeedPath,
  outputPath,
  parcelIds = SAMPLE_PARCEL_IDS,
  runtimeRoot = defaultRuntimeRoot(),
}) {
  const { parseCsvRecords, renderCsv } = await import(pathToFileURL(path.join(runtimeRoot, "src/core/csv.mjs")).href);
  const wanted = new Set(parcelIds.map((id) => toText(id)));
  const rows = parseCsvRecords(await readFile(gisSeedPath, "utf8"))
    .filter((row) => wanted.has(toText(row.parcel_id)))
    .map(toSeedRow);
  if (rows.length !== wanted.size) {
    const found = new Set(rows.map((row) => row.parcel_id));
    const missing = [...wanted].filter((id) => !found.has(id));
    throw new Error(`GIS seed is missing sample APNs: ${missing.join(", ")}`);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderCsv([...SEED_COLUMNS], rows), "utf8");
  return { outputPath, rowCount: rows.length, parcelIds: rows.map((row) => row.parcel_id) };
}
