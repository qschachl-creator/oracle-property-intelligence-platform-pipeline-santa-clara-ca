/**
 * Capture-layer provenance for paginated Socrata GIS pages.
 * Records the exact GET at fetch time. Replay copies that stored request;
 * it does not reconstruct $offset / $limit / $select after the fact.
 * A stored page whose $select omits the_geom is not a resume hit.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  COUNTY_FIPS,
  COUNTY_NAME,
  SOCRATA_PAGE_LIMIT,
  SOCRATA_RESOURCE_URL,
  SOCRATA_SOURCE_DATASET_URL,
  STATE_CODE,
  buildBulkPageSourceHttpRequest,
  socrataPageUrl,
  toText,
} from "./seed.mjs";

export const PAGE_CAPTURE_KIND = "socrata_paged_json";
export const PAGE_JSON_NAME = "page.json";
export const PAGE_CAPTURE_META_NAME = "capture.json";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertExactPageRequest(sourceHttpRequest) {
  if (!sourceHttpRequest || typeof sourceHttpRequest !== "object") {
    throw new Error("page capture is missing source_http_request");
  }
  if (toText(sourceHttpRequest.method) !== "GET") {
    throw new Error(`page capture method must be GET, got ${sourceHttpRequest.method}`);
  }
  if (toText(sourceHttpRequest.url) !== SOCRATA_RESOURCE_URL) {
    throw new Error(`page capture url must be query-free ${SOCRATA_RESOURCE_URL}`);
  }
  const qs = sourceHttpRequest.multiValueQueryString;
  if (!qs || typeof qs !== "object" || Array.isArray(qs)) {
    throw new Error("page capture is missing multiValueQueryString");
  }
  if (qs.$where != null) {
    throw new Error("paginated GIS capture must not include $where");
  }
  const offset = Array.isArray(qs.$offset) ? qs.$offset[0] : null;
  const limit = Array.isArray(qs.$limit) ? qs.$limit[0] : null;
  const order = Array.isArray(qs.$order) ? qs.$order[0] : null;
  const select = Array.isArray(qs.$select) ? qs.$select[0] : null;
  if (offset == null || String(offset).trim() === "") {
    throw new Error("page capture source_http_request must include exact $offset");
  }
  if (limit == null || String(limit).trim() === "") {
    throw new Error("page capture source_http_request must include exact $limit");
  }
  if (order !== "objectid") {
    throw new Error("page capture $order must be objectid");
  }
  if (!select) {
    throw new Error("page capture $select is missing");
  }
  return {
    offset: String(offset),
    limit: String(limit),
  };
}

function assembleSitus(row) {
  const parts = [
    row.situs_house_number,
    row.situs_house_number_suffix,
    row.situs_street_direction,
    row.situs_street_name,
    row.situs_street_type,
    row.situs_unit_number ? `#${row.situs_unit_number}` : "",
    row.situs_city_name,
    row.situs_state_code,
    row.situs_zip_code,
  ]
    .map((part) => (part ?? "").trim())
    .filter(Boolean);
  return parts.join(" ");
}

export function pageCaptureDirName({ offset, limit }) {
  return `offset-${offset}-limit-${limit}`;
}

export function classifyGisApn(apn) {
  const text = toText(apn);
  if (!text) return "missing";
  if (!/^\d{8}$/.test(text)) return "invalid";
  return "valid";
}

export async function captureSocrataPage({
  offset,
  limit = SOCRATA_PAGE_LIMIT,
  outDir,
  fetchImpl = globalThis.fetch,
  sourceDatasetUrl = SOCRATA_SOURCE_DATASET_URL,
  resume = false,
}) {
  if (offset == null || offset === "") {
    throw new Error("captureSocrataPage requires exact $offset");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("captureSocrataPage requires fetchImpl");
  }
  if (resume) {
    try {
      const loaded = await loadPageCapture(outDir);
      const expected = buildBulkPageSourceHttpRequest({ offset, limit });
      const storedQs = loaded.sourceHttpRequest?.multiValueQueryString;
      const expectedQs = expected.multiValueQueryString;
      if (
        storedQs?.$offset?.[0] === expectedQs.$offset[0] &&
        storedQs?.$limit?.[0] === expectedQs.$limit[0] &&
        storedQs?.$order?.[0] === expectedQs.$order[0] &&
        storedQs?.$select?.[0] === expectedQs.$select[0]
      ) {
        return { ...loaded, resumed: true };
      }
    } catch {
      // Recapture.
    }
  }
  const sourceHttpRequest = buildBulkPageSourceHttpRequest({ offset, limit });
  assertExactPageRequest(sourceHttpRequest);
  const url = socrataPageUrl({ offset, limit });
  const httpStarted = process.hrtime.bigint();
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  const httpElapsedNs = process.hrtime.bigint() - httpStarted;
  if (!response.ok) {
    throw new Error(`Socrata GIS HTTP ${response.status} for page offset=${offset} limit=${limit}`);
  }
  const rawBytes = Buffer.from(await response.arrayBuffer());
  const sha256 = sha256Hex(rawBytes);
  const retrievedAt = new Date().toISOString();
  let records;
  try {
    records = JSON.parse(rawBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Socrata page is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(records)) {
    throw new Error("Socrata page JSON must be an array");
  }
  await mkdir(outDir, { recursive: true });
  const captureFile = PAGE_JSON_NAME;
  await writeFile(path.join(outDir, captureFile), rawBytes);
  const meta = {
    captureKind: PAGE_CAPTURE_KIND,
    sourceDatasetUrl,
    retrievedAt,
    sha256,
    byteLength: rawBytes.length,
    pageOffset: String(offset),
    pageLimit: String(limit),
    rowCount: records.length,
    captureFile,
    sourceHttpRequest,
    httpElapsedSeconds: Number(httpElapsedNs) / 1e9,
  };
  await writeFile(path.join(outDir, PAGE_CAPTURE_META_NAME), `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, records, rawBytes, outDir, resumed: false };
}

export async function loadPageCapture(outDir) {
  const meta = JSON.parse(await readFile(path.join(outDir, PAGE_CAPTURE_META_NAME), "utf8"));
  const captureFile = meta.captureFile || PAGE_JSON_NAME;
  const rawBytes = await readFile(path.join(outDir, captureFile));
  const digest = sha256Hex(rawBytes);
  if (digest !== meta.sha256) {
    throw new Error(`page capture digest mismatch: file ${digest} meta ${meta.sha256}`);
  }
  assertExactPageRequest(meta.sourceHttpRequest);
  const records = JSON.parse(rawBytes.toString("utf8"));
  if (!Array.isArray(records)) {
    throw new Error("Socrata page JSON must be an array");
  }
  return { ...meta, records, rawBytes, outDir, captureFile };
}

export function bulkEntryFromCapturedRecord(capture, gisRecord) {
  const { offset, limit } = assertExactPageRequest(capture.sourceHttpRequest);
  const sha256 = toText(capture.sha256);
  if (!sha256) throw new Error("page capture is missing sha256");
  const retrievedAt = toText(capture.retrievedAt);
  if (!retrievedAt) throw new Error("page capture is missing retrievedAt");
  const captureFile = toText(capture.captureFile) || PAGE_JSON_NAME;
  const sourceDatasetUrl = toText(capture.sourceDatasetUrl) || SOCRATA_SOURCE_DATASET_URL;
  const sourceHttpRequest = capture.sourceHttpRequest;
  const apn = toText(gisRecord?.apn);
  const row = {
    parcel_id: apn,
    source_identifier: apn,
    situs_address: assembleSitus(gisRecord),
    objectid: gisRecord.objectid ?? "",
    tax_rate_area: gisRecord.tax_rate_area ?? "",
    jurisdiction: gisRecord.jurisdiction ?? "",
    situs_house_number: gisRecord.situs_house_number ?? "",
    situs_house_number_suffix: gisRecord.situs_house_number_suffix ?? "",
    situs_street_direction: gisRecord.situs_street_direction ?? "",
    situs_street_name: gisRecord.situs_street_name ?? "",
    situs_street_type: gisRecord.situs_street_type ?? "",
    situs_unit_number: gisRecord.situs_unit_number ?? "",
    situs_city_name: gisRecord.situs_city_name ?? "",
    situs_state_code: gisRecord.situs_state_code ?? "",
    situs_zip_code: gisRecord.situs_zip_code ?? "",
    number_of_situs_address: gisRecord.number_of_situs_address ?? "",
    shape_length: gisRecord.shape_length ?? "",
    shape_area: gisRecord.shape_area ?? "",
    source_dataset_id: "ubcd-cewv",
    source_dataset_url: sourceDatasetUrl,
    source_retrieved_at: retrievedAt,
    geometry_join_key: gisRecord.objectid ?? "",
    method: sourceHttpRequest.method,
    url: sourceHttpRequest.url,
    multiValueQueryString: JSON.stringify(sourceHttpRequest.multiValueQueryString),
    capture_sha256: sha256,
    capture_file: captureFile,
    page_offset: offset,
    page_limit: limit,
    county: COUNTY_NAME,
    county_fips: COUNTY_FIPS,
    state: STATE_CODE,
  };
  return {
    row,
    gisRecord,
    sourceHttpRequest,
    captureSha256: sha256,
    captureFile,
    pageOffset: offset,
    pageLimit: limit,
    sourceRetrievedAt: retrievedAt,
    sourceDatasetUrl,
    captureKind: PAGE_CAPTURE_KIND,
  };
}

export function indexBulkGisFromPageCapture(capture) {
  /** @type {Map<string, object>} */
  const index = new Map();
  for (const gisRecord of capture.records) {
    const apn = toText(gisRecord?.apn);
    if (!apn) continue;
    if (index.has(apn)) {
      throw new Error(`Duplicate APN in captured GIS page: ${apn}`);
    }
    index.set(apn, bulkEntryFromCapturedRecord(capture, gisRecord));
  }
  return index;
}
