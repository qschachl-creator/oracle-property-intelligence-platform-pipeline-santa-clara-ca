/**
 * Build the Santa Clara candidate-run seed from the public FY2026 GIS layer.
 * Does not claim assessed-roll completeness. APNs are copied exactly as published.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOCRATA_PAGE_LIMIT,
  SOCRATA_RESOURCE_URL,
  SOCRATA_SELECT,
  SOCRATA_SOURCE_DATASET_URL,
  socrataPageUrl,
} from "../counties/santa-clara/seed.mjs";

const DATASET = "ubcd-cewv";
const BASE = SOCRATA_RESOURCE_URL;
const SOURCE_URL = SOCRATA_SOURCE_DATASET_URL;
const PAGE = SOCRATA_PAGE_LIMIT;
const SELECT = SOCRATA_SELECT;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "data", "seeds");

function csvCell(value) {
  const text = value ?? "";
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
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

async function fetchPage(offset) {
  const url = socrataPageUrl({ offset, limit: PAGE });
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Socrata ${response.status} at offset ${offset}: ${await response.text()}`);
  }
  return { page: await response.json(), pageOffset: offset, pageLimit: PAGE };
}

const retrievedAt = new Date().toISOString();
const rows = [];
for (let offset = 0; ; offset += PAGE) {
  const { page, pageOffset, pageLimit } = await fetchPage(offset);
  console.error(`fetched offset=${offset} n=${page.length}`);
  for (const row of page) {
    rows.push({ ...row, page_offset: String(pageOffset), page_limit: String(pageLimit) });
  }
  if (page.length < PAGE) break;
}

const emptyApn = [];
const valid = [];
for (const row of rows) {
  const apn = row.apn ?? "";
  if (apn.length === 0) emptyApn.push(row);
  else valid.push(row);
}

const seen = new Map();
const duplicateApns = [];
for (const row of valid) {
  const list = seen.get(row.apn);
  if (list) {
    list.push(row.objectid);
    if (list.length === 2) duplicateApns.push(row.apn);
  } else {
    seen.set(row.apn, [row.objectid]);
  }
}

const header = [
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
];

const csvLines = [header.join(",")];
for (const row of valid) {
  csvLines.push(
    [
      csvCell(row.apn),
      csvCell(row.apn),
      csvCell(assembleSitus(row)),
      csvCell(row.objectid ?? ""),
      csvCell(row.tax_rate_area ?? ""),
      csvCell(row.jurisdiction ?? ""),
      csvCell(row.situs_house_number ?? ""),
      csvCell(row.situs_house_number_suffix ?? ""),
      csvCell(row.situs_street_direction ?? ""),
      csvCell(row.situs_street_name ?? ""),
      csvCell(row.situs_street_type ?? ""),
      csvCell(row.situs_unit_number ?? ""),
      csvCell(row.situs_city_name ?? ""),
      csvCell(row.situs_state_code ?? ""),
      csvCell(row.situs_zip_code ?? ""),
      csvCell(row.number_of_situs_address ?? ""),
      csvCell(row.shape_length ?? ""),
      csvCell(row.shape_area ?? ""),
      csvCell(DATASET),
      csvCell(SOURCE_URL),
      csvCell(retrievedAt),
      csvCell(row.objectid ?? ""),
      csvCell(row.page_offset ?? ""),
      csvCell(row.page_limit ?? ""),
    ].join(","),
  );
}

await mkdir(outDir, { recursive: true });
const seedPath = path.join(outDir, "santa-clara.csv");
const csvText = `${csvLines.join("\n")}\n`;
await writeFile(seedPath, csvText, "utf8");
const seedSha256 = createHash("sha256").update(await readFile(seedPath)).digest("hex");

const apnLengths = {};
for (const row of valid) {
  const length = row.apn.length;
  apnLengths[length] = (apnLengths[length] ?? 0) + 1;
}

const manifest = {
  county: "santa-clara",
  coverage_claim: "GIS feature coverage for a public-data candidate run, not complete assessed-roll coverage",
  source_dataset_id: DATASET,
  source_dataset_url: SOURCE_URL,
  source_retrieved_at: retrievedAt,
  gis_feature_count_fetched: rows.length,
  invalid_missing_apn: emptyApn.length,
  duplicate_nonempty_apn_values: duplicateApns.length,
  duplicate_apn_sample: duplicateApns.slice(0, 20),
  seed_row_count: valid.length,
  apn_length_histogram: apnLengths,
  geometry_provenance:
    "Full MultiPolygon remains in the public GIS dataset. Seed stores objectid as geometry_join_key plus shape_area/shape_length, dataset URL, and retrieve timestamp. APNs are exact GIS text. This CSV is evidence of an earlier public-GIS run; it is not exact-request provenance for publication. A future full run must recapture pages with source_http_request and SHA-256 recorded at fetch time.",
  seed_csv: "data/seeds/santa-clara.csv",
  seed_csv_sha256: seedSha256,
  seed_csv_bytes: csvText.length,
  runtime_copy: "skills/use-oracle/runtime/data/seeds/santa-clara.csv",
  socrata: {
    domain: "data.sccgov.org",
    dataset: DATASET,
    format: "json",
    select: SELECT.split(","),
    order: "objectid",
    limit: PAGE,
    paging: "$offset increments of $limit until a short page",
    page_url_template: `${BASE}?$select=${encodeURIComponent(SELECT)}&$order=objectid&$limit=${PAGE}&$offset={offset}`,
    omitted_fields: ["the_geom"],
    omitted_fields_reason: "Full MultiPolygon remains in the GIS dataset; seed joins via objectid",
  },
  sample_parcel_ids: valid.slice(0, 8).map((row) => row.apn),
};
await writeFile(path.join(outDir, "santa-clara-seed-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
