#!/usr/bin/env node
/**
 * Build the Santa Clara county query table from existing transformed zips.
 * Streams one parcel at a time so the full seed and row set are not held in memory.
 * Does not recapture, rewrite zips, publish, or load DuckDB.
 */
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  loadQueryTableSchemaFields,
  mapTransformedFilesToQueryTableRow,
} from "../counties/santa-clara/query-table.mjs";
import { COUNTY_KEY, defaultRuntimeRoot, toText } from "../counties/santa-clara/seed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ROOT = path.join(ROOT, "data", "runs", "santa-clara-full");
const SEED_PATH = path.join(RUN_ROOT, "publication-seed.csv");
const OUTPUT_DIR = path.join(RUN_ROOT, "parcels");
const WORKING_DIR = path.join(RUN_ROOT, "query-table");
const KEEP = new Set([
  "parcel_id",
  "situs_address",
  "situs_city_name",
  "situs_zip_code",
  "latitude",
  "longitude",
]);

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      cells.push(current);
      current = "";
    } else current += ch;
  }
  cells.push(current);
  return cells;
}

const runtimeRoot = defaultRuntimeRoot();
const { ParquetSchema, ParquetWriter } = createRequire(path.join(runtimeRoot, "package.json"))("@dsnp/parquetjs");
const runtimeQuery = await import(pathToFileURL(path.join(runtimeRoot, "src/core/query-table.mjs")).href);
const schemaFields = await loadQueryTableSchemaFields(runtimeRoot);
await mkdir(WORKING_DIR, { recursive: true });
const parquetPath = path.join(WORKING_DIR, "query-table.parquet");
const writer = await ParquetWriter.openFile(new ParquetSchema(structuredClone(schemaFields)), parquetPath);

const rl = createInterface({ input: createReadStream(SEED_PATH, { encoding: "utf8" }), crlfDelay: Infinity });
let header = null;
let seen = 0;
let written = 0;
const missing = [];
try {
  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const seedRow = {};
    for (let index = 0; index < header.length; index += 1) {
      const key = header[index];
      if (KEEP.has(key)) seedRow[key] = cells[index] ?? "";
    }
    const parcelId = toText(seedRow.parcel_id);
    if (!parcelId) continue;
    seen += 1;
    const zipPath = path.join(OUTPUT_DIR, parcelId, "transformed.zip");
    try {
      const files = runtimeQuery.readTransformedZipJsonFiles(zipPath);
      if (files["property.json"] === undefined) {
        if (missing.length < 20) missing.push(parcelId);
        continue;
      }
      const row = await mapTransformedFilesToQueryTableRow({
        parcelId,
        files,
        seedRow,
        runtimeRoot,
      });
      await writer.appendRow(runtimeQuery.toParquetRecord(row));
      written += 1;
    } catch {
      if (missing.length < 20) missing.push(parcelId);
    }
    if (seen % 20000 === 0) {
      process.stderr.write(`query-table ${seen} written=${written} missing=${missing.length}\n`);
    }
  }
} finally {
  await writer.close();
}

if (missing.length > 0) {
  throw new Error(`Missing transformed.zip/property.json. First: ${missing.join(", ")}`);
}

const coverage = runtimeQuery.buildCoverageSnapshot({
  county: COUNTY_KEY,
  source: "appraisal",
  ingestedCount: written,
  expectedCount: seen,
  exportedAt: new Date().toISOString(),
});
const coveragePath = path.join(WORKING_DIR, "dataset-coverage.json");
const manifestPath = path.join(WORKING_DIR, "manifest.json");
await writeFile(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
const artifacts = {
  county: COUNTY_KEY,
  parquetPath,
  coveragePath,
  manifestPath,
  rowCount: written,
  expectedCount: seen,
};
await writeFile(manifestPath, `${JSON.stringify(artifacts, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(artifacts)}\n`);
