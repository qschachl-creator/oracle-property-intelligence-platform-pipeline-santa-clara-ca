/**
 * Build a queryable roof-age table from the frozen San Jose snapshot.
 * Uses the runtime parquet writer with a roof-age-only schema.
 * Does not read transformed parcel zips.
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ROOF_AGE_TABLE_SCHEMA_FIELDS,
  mapRoofAgeSnapshotParcelToQueryRow,
} from "./query-table.mjs";
import { defaultRuntimeRoot } from "./seed.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const ROOF_AGE_TABLE_DIR = "data/runs/santa-clara-roof-age";
export const ROOF_AGE_PARQUET_NAME = "roof-age.parquet";
export const ROOF_AGE_MANIFEST_NAME = "manifest.json";
export const ROOF_AGE_SNAPSHOT_RELATIVE_PATH =
  "fixtures/santa-clara-permits/san-jose-reroof-roof-age.json";

export const ROOF_AGE_PARQUET_RELATIVE_PATH = path.posix.join(
  ROOF_AGE_TABLE_DIR,
  ROOF_AGE_PARQUET_NAME,
);

export function olderThan15DuckDbCommand(
  parquetRelativePath = ROOF_AGE_PARQUET_RELATIVE_PATH,
) {
  const sql = [
    "SELECT parcel_identifier, \"builtYear\", roof_date, roof_age_years,",
    "roof_age_source, roof_age_confidence, roof_age_permit_id,",
    "roof_age_eligibility_reason, \"olderThan15Years\"",
    `FROM read_parquet('${parquetRelativePath}')`,
    "WHERE \"olderThan15Years\" = true",
    "ORDER BY parcel_identifier",
  ].join(" ");
  return `duckdb -c ${JSON.stringify(sql)}`;
}

export function roofAgeRowsFromSnapshot(snapshot) {
  const parcels = snapshot?.parcels;
  if (parcels == null || typeof parcels !== "object" || Array.isArray(parcels)) {
    throw new Error("roof-age snapshot is missing parcels");
  }
  const rows = [];
  for (const [key, parcel] of Object.entries(parcels)) {
    const row = mapRoofAgeSnapshotParcelToQueryRow(parcel);
    if (row.parcel_identifier !== key) {
      throw new Error(`snapshot key ${key} is not the undashed APN ${row.parcel_identifier}`);
    }
    rows.push(row);
  }
  rows.sort((left, right) => left.parcel_identifier.localeCompare(right.parcel_identifier));
  return rows;
}

export async function writeRoofAgeQueryTable({
  snapshot,
  outputDir,
  sourceSnapshotPath = ROOF_AGE_SNAPSHOT_RELATIVE_PATH,
}) {
  if (typeof snapshot?.asOfDate !== "string" || snapshot.asOfDate.length === 0) {
    throw new Error("roof-age snapshot is missing asOfDate");
  }
  const rows = roofAgeRowsFromSnapshot(snapshot);
  await mkdir(outputDir, { recursive: true });
  const parquetPath = path.join(outputDir, ROOF_AGE_PARQUET_NAME);
  const manifestPath = path.join(outputDir, ROOF_AGE_MANIFEST_NAME);
  const runtimeRoot = defaultRuntimeRoot();
  const { writeQueryTableParquet } = await import(
    pathToFileURL(path.join(runtimeRoot, "src/core/query-table.mjs")).href
  );
  const rowCount = await writeQueryTableParquet({
    parquetPath,
    schemaFields: ROOF_AGE_TABLE_SCHEMA_FIELDS,
    rows,
  });
  const manifest = {
    asOfDate: snapshot.asOfDate,
    sourceSnapshotPath,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { parquetPath, manifestPath, rowCount, manifest };
}

function asInteger(value) {
  if (value == null) return null;
  return typeof value === "bigint" ? Number(value) : value;
}

export async function readRoofAgeQueryRows(parquetPath) {
  const require = createRequire(path.join(defaultRuntimeRoot(), "package.json"));
  const { ParquetReader } = require("@dsnp/parquetjs");
  const reader = await ParquetReader.openFile(parquetPath);
  const rows = [];
  try {
    const cursor = reader.getCursor();
    for (let row = await cursor.next(); row; row = await cursor.next()) {
      rows.push({
        ...row,
        builtYear: asInteger(row.builtYear),
        roof_age_years: asInteger(row.roof_age_years),
      });
    }
  } finally {
    await reader.close();
  }
  return rows;
}

async function main() {
  const snapshotPath = path.join(REPO_ROOT, ROOF_AGE_SNAPSHOT_RELATIVE_PATH);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const result = await writeRoofAgeQueryTable({
    snapshot,
    outputDir: path.join(REPO_ROOT, ROOF_AGE_TABLE_DIR),
    sourceSnapshotPath: ROOF_AGE_SNAPSHOT_RELATIVE_PATH,
  });
  console.log(
    JSON.stringify({
      rowCount: result.rowCount,
      parquetPath: ROOF_AGE_PARQUET_RELATIVE_PATH,
      manifestPath: path.posix.join(ROOF_AGE_TABLE_DIR, ROOF_AGE_MANIFEST_NAME),
      asOfDate: result.manifest.asOfDate,
      sourceSnapshotPath: result.manifest.sourceSnapshotPath,
      olderThan15Query: olderThan15DuckDbCommand(),
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
