#!/usr/bin/env node
/**
 * Full Santa Clara GIS county-group capture + offline transform.
 * Exact paginated Socrata provenance. GIS coverage only (APPROVED_EXCEPTION).
 * Does not use data/seeds/santa-clara.csv as exact-request provenance.
 * Does not validate/hash/CAR/export-tables, upload, touch Atlas, or start PermitFeed.
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/santa-clara-full-gis-capture-transform.mjs
 */
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { defaultRuntimeRoot, SEED_COLUMNS, SOCRATA_PAGE_LIMIT, toText } from "../counties/santa-clara/seed.mjs";
import {
  bulkEntryFromCapturedRecord,
  captureSocrataPage,
  classifyGisApn,
  loadPageCapture,
  pageCaptureDirName,
} from "../counties/santa-clara/page-capture.mjs";
import { captureAndTransform } from "../counties/santa-clara/adapter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_LIMIT = SOCRATA_PAGE_LIMIT;
const CACHED_MANIFEST = path.join(ROOT, "data", "runs", "lexicon-coverage", "manifest.json");
const PAGES_ROOT = path.join(ROOT, "data", "captures", "santa-clara", "pages");
const RUN_ROOT = path.join(ROOT, "data", "runs", "santa-clara-full");
const PARCELS_DIR = path.join(RUN_ROOT, "parcels");
const SEED_PATH = path.join(RUN_ROOT, "publication-seed.csv");
const CATALOG_PATH = path.join(PAGES_ROOT, "catalog.json");
const CAPTURE_REPORT_PATH = path.join(RUN_ROOT, "capture-report.json");
const TRANSFORM_REPORT_PATH = path.join(RUN_ROOT, "transform-report.json");
const FAILURES_PATH = path.join(RUN_ROOT, "transform-failures.jsonl");
const PROGRESS_PATH = path.join(RUN_ROOT, "progress.json");

function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function csvLine(row) {
  return SEED_COLUMNS.map((column) => csvCell(row[column] ?? "")).join(",");
}

function directoryBytes(dir) {
  try {
    const out = execFileSync("du", ["-sk", dir], { encoding: "utf8" }).trim();
    const kib = Number.parseInt(out.split(/\s+/)[0], 10);
    return Number.isFinite(kib) ? kib * 1024 : 0;
  } catch {
    return 0;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function captureAllPages() {
  const pages = [];
  const captureStarted = process.hrtime.bigint();
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    const outDir = path.join(PAGES_ROOT, pageCaptureDirName({ offset, limit: PAGE_LIMIT }));
    process.stderr.write(`capture offset=${offset} limit=${PAGE_LIMIT}\n`);
    let lastError = null;
    let captured = null;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        // Resume only when the stored $select matches, including the_geom.
        // Older pages that omitted the_geom are recaptured, not deleted here.
        captured = await captureSocrataPage({
          offset,
          limit: PAGE_LIMIT,
          outDir,
          resume: true,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        process.stderr.write(`capture retry ${attempt} offset=${offset}: ${error instanceof Error ? error.message : String(error)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
    if (!captured) throw lastError;
    const pageMeta = {
      offset,
      limit: PAGE_LIMIT,
      dir: outDir,
      sha256: captured.sha256,
      byteLength: captured.byteLength,
      rowCount: captured.rowCount,
      retrievedAt: captured.retrievedAt,
      resumed: Boolean(captured.resumed),
      httpElapsedSeconds: captured.httpElapsedSeconds ?? 0,
      sourceHttpRequest: captured.sourceHttpRequest,
    };
    pages.push(pageMeta);
    await writeJson(CATALOG_PATH, {
      coverage_claim: "GIS feature coverage for a public-data candidate run, not complete assessed-roll coverage",
      pageLimit: PAGE_LIMIT,
      pages,
    });
    if (captured.rowCount < PAGE_LIMIT) break;
  }
  const captureSeconds = Number(process.hrtime.bigint() - captureStarted) / 1e9;
  return { pages, captureSeconds };
}

function consumePageRecords(capture, seenApns, stats) {
  const bulkGisByApn = new Map();
  const seedRows = [];
  for (const gisRecord of capture.records) {
    stats.gisFeaturesFetched += 1;
    const apn = toText(gisRecord?.apn);
    const kind = classifyGisApn(apn);
    if (kind === "missing") {
      stats.missingApn += 1;
      continue;
    }
    if (kind === "invalid") {
      stats.invalidApn += 1;
      if (stats.invalidSamples.length < 20) stats.invalidSamples.push(apn);
      continue;
    }
    if (seenApns.has(apn)) {
      stats.duplicateApn += 1;
      if (stats.duplicateSamples.length < 20) stats.duplicateSamples.push(apn);
      continue;
    }
    seenApns.add(apn);
    const entry = bulkEntryFromCapturedRecord(capture, gisRecord);
    bulkGisByApn.set(apn, entry);
    seedRows.push(entry.row);
    stats.validApn += 1;
  }
  return { bulkGisByApn, seedRows };
}

async function main() {
  process.stderr.write(`PAGES_ROOT=${PAGES_ROOT}\nRUN_ROOT=${RUN_ROOT}\nPARCELS_DIR=${PARCELS_DIR}\n`);
  await mkdir(RUN_ROOT, { recursive: true });
  await mkdir(PAGES_ROOT, { recursive: true });
  await mkdir(PARCELS_DIR, { recursive: true });

  const { pages, captureSeconds } = await captureAllPages();
  const captureBytes = pages.reduce((sum, page) => sum + (page.byteLength || 0), 0);
  const captureReport = {
    coverage_claim: "GIS feature coverage for a public-data candidate run, not complete assessed-roll coverage",
    pageCount: pages.length,
    captureSeconds,
    captureBytes,
    pages: pages.map((page) => ({
      offset: page.offset,
      limit: page.limit,
      sha256: page.sha256,
      byteLength: page.byteLength,
      rowCount: page.rowCount,
      retrievedAt: page.retrievedAt,
      resumed: page.resumed,
      dir: page.dir,
      sourceHttpRequest: page.sourceHttpRequest,
    })),
  };
  await writeJson(CAPTURE_REPORT_PATH, captureReport);
  await writeJson(CATALOG_PATH, captureReport);

  await readFile(CACHED_MANIFEST, "utf8");
  process.env.ELEPHANT_SCHEMA_MANIFEST_URL = pathToFileURL(CACHED_MANIFEST).href;

  const htmlDir = await mkdtemp(path.join(tmpdir(), "scc-full-empty-html-"));
  const seedStream = createWriteStream(SEED_PATH);
  seedStream.write(`${SEED_COLUMNS.join(",")}\n`);

  const stats = {
    gisFeaturesFetched: 0,
    validApn: 0,
    missingApn: 0,
    invalidApn: 0,
    duplicateApn: 0,
    invalidSamples: [],
    duplicateSamples: [],
  };
  const seenApns = new Set();
  let transformed = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  let gisHttpCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    gisHttpCalls += 1;
    throw new Error(`offline full transform issued GIS HTTP: ${String(args[0])}`);
  };

  const transformStarted = process.hrtime.bigint();
  try {
    for (const page of pages) {
      const capture = await loadPageCapture(page.dir);
      const { bulkGisByApn, seedRows } = consumePageRecords(capture, seenApns, stats);
      for (const row of seedRows) seedStream.write(`${csvLine(row)}\n`);
      if (seedRows.length === 0) continue;
      const manifest = await captureAndTransform({
        seedRows,
        htmlDir,
        outputDir: PARCELS_DIR,
        liveFetch: false,
        bulkGisByApn,
        skipCompleted: true,
        writeManifest: false,
        runtimeRoot: defaultRuntimeRoot(),
        onParcel: (result, done, total) => {
          if (done % 1000 === 0 || done === total) {
            process.stderr.write(
              `transform offset=${page.offset} ${done}/${total} ok=${transformed} skip=${skipped} fail=${failed}\n`,
            );
          }
        },
      });
      for (const result of manifest.results) {
        if (result.skipped) skipped += 1;
        else if (result.transformSuccess) transformed += 1;
        else {
          failed += 1;
          failures.push({ parcelId: result.parcelId, error: result.error });
        }
      }
      await writeJson(PROGRESS_PATH, {
        pageOffset: page.offset,
        validApn: stats.validApn,
        transformed,
        skipped,
        failed,
        gisHttpCalls,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    seedStream.end();
    await finished(seedStream);
  }

  const transformSeconds = Number(process.hrtime.bigint() - transformStarted) / 1e9;
  await writeFile(
    FAILURES_PATH,
    failures.map((row) => JSON.stringify(row)).join("\n") + (failures.length ? "\n" : ""),
  );
  const captureDisk = directoryBytes(PAGES_ROOT);
  const runDisk = directoryBytes(RUN_ROOT);
  const transformReport = {
    coverage_claim: "GIS feature coverage for a public-data candidate run, not complete assessed-roll coverage",
    usedOldSeedCsv: false,
    gisFeaturesFetched: stats.gisFeaturesFetched,
    validPublicationSeedApns: stats.validApn,
    missingApn: stats.missingApn,
    invalidApn: stats.invalidApn,
    duplicateApn: stats.duplicateApn,
    invalidSamples: stats.invalidSamples,
    duplicateSamples: stats.duplicateSamples,
    capturePageCount: pages.length,
    captureBytes,
    captureSeconds,
    transformSuccess: transformed,
    transformSkippedCompleted: skipped,
    transformFailure: failed,
    transformSeconds,
    gisHttpCalls,
    captureDiskBytes: captureDisk,
    runDiskBytes: runDisk,
    diskBytes: captureDisk + runDisk,
    seedPath: SEED_PATH,
    parcelsDir: PARCELS_DIR,
    failuresPath: FAILURES_PATH,
    lexiconManifest: process.env.ELEPHANT_SCHEMA_MANIFEST_URL,
  };
  await writeJson(TRANSFORM_REPORT_PATH, transformReport);
  console.log(JSON.stringify(transformReport, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
