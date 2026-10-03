#!/usr/bin/env node
/**
 * Reconcile residual Santa Clara GIS transforms against the publication seed.
 * Retries only currently invalid parcel dirs from immutable captured page JSON.
 * Does not re-fetch Socrata, alter captures, hash, CAR, export, or upload.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { defaultRuntimeRoot, SOCRATA_PAGE_LIMIT, toText } from "../counties/santa-clara/seed.mjs";
import {
  bulkEntryFromCapturedRecord,
  classifyGisApn,
  loadPageCapture,
  pageCaptureDirName,
} from "../counties/santa-clara/page-capture.mjs";
import { captureAndTransform, inspectParcelTransform } from "../counties/santa-clara/adapter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ROOT = path.join(ROOT, "data", "runs", "santa-clara-full");
const PAGES_ROOT = path.join(ROOT, "data", "captures", "santa-clara", "pages");
const PARCELS_DIR = path.join(RUN_ROOT, "parcels");
const SEED_PATH = path.join(RUN_ROOT, "publication-seed.csv");
const CACHED_MANIFEST = path.join(ROOT, "data", "runs", "lexicon-coverage", "manifest.json");
const SCANNER = path.join(ROOT, "scripts", "santa-clara-scan-transforms.py");
const OUT_PATH = path.join(RUN_ROOT, "reconciliation.json");

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

async function loadSeedIndex() {
  const rl = createInterface({ input: createReadStream(SEED_PATH, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = null;
  /** @type {Map<string, { pageOffset: string, pageLimit: string }>} */
  const index = new Map();
  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const row = Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""]));
    const apn = toText(row.parcel_id);
    if (!apn) continue;
    if (index.has(apn)) throw new Error(`Duplicate APN in publication seed: ${apn}`);
    index.set(apn, { pageOffset: toText(row.page_offset), pageLimit: toText(row.page_limit) || String(SOCRATA_PAGE_LIMIT) });
  }
  return index;
}

function loadHistoricalFailedApns() {
  try {
    const text = execFileSync("cat", [path.join(RUN_ROOT, "transform-failures.jsonl")], { encoding: "utf8" });
    const apns = new Set();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.parcelId) apns.add(String(row.parcelId));
    }
    return apns;
  } catch {
    return new Set();
  }
}

function runScan(outPath) {
  execFileSync("python3", [SCANNER, "--seed", SEED_PATH, "--parcels", PARCELS_DIR, "--out", outPath], {
    stdio: "inherit",
  });
  return JSON.parse(execFileSync("cat", [outPath], { encoding: "utf8" }));
}

async function retryInvalid(invalidApns, seedIndex) {
  const byPage = new Map();
  for (const apn of invalidApns) {
    const meta = seedIndex.get(apn);
    if (!meta) throw new Error(`Invalid APN ${apn} is not in the publication seed`);
    const key = `${meta.pageOffset}:${meta.pageLimit}`;
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(apn);
  }
  await readFile(CACHED_MANIFEST, "utf8");
  process.env.ELEPHANT_SCHEMA_MANIFEST_URL = pathToFileURL(CACHED_MANIFEST).href;
  const htmlDir = await mkdtemp(path.join(tmpdir(), "scc-reconcile-html-"));
  const originalFetch = globalThis.fetch;
  let gisHttpCalls = 0;
  globalThis.fetch = async (...args) => {
    gisHttpCalls += 1;
    throw new Error(`reconcile issued GIS HTTP: ${String(args[0])}`);
  };
  const attempted = [];
  const recovered = [];
  const unrecovered = [];
  try {
    for (const [key, apns] of byPage) {
      const [pageOffset, pageLimit] = key.split(":");
      const pageDir = path.join(PAGES_ROOT, pageCaptureDirName({ offset: pageOffset, limit: pageLimit }));
      const capture = await loadPageCapture(pageDir);
      const wanted = new Set(apns);
      const bulkGisByApn = new Map();
      const seedRows = [];
      for (const gisRecord of capture.records) {
        const apn = toText(gisRecord?.apn);
        if (!wanted.has(apn) || classifyGisApn(apn) !== "valid") continue;
        const entry = bulkEntryFromCapturedRecord(capture, gisRecord);
        bulkGisByApn.set(apn, entry);
        seedRows.push(entry.row);
      }
      const missingOnPage = apns.filter((apn) => !bulkGisByApn.has(apn));
      for (const apn of missingOnPage) {
        unrecovered.push({ parcelId: apn, error: `APN not present on captured page offset=${pageOffset}` });
      }
      for (const apn of seedRows.map((row) => row.parcel_id)) {
        attempted.push(apn);
        await rm(path.join(PARCELS_DIR, apn), { recursive: true, force: true });
      }
      if (seedRows.length === 0) continue;
      process.stderr.write(`retry page offset=${pageOffset} n=${seedRows.length}\n`);
      const manifest = await captureAndTransform({
        seedRows,
        htmlDir,
        outputDir: PARCELS_DIR,
        liveFetch: false,
        bulkGisByApn,
        skipCompleted: false,
        writeManifest: false,
        runtimeRoot: defaultRuntimeRoot(),
      });
      for (const result of manifest.results) {
        const inspection = await inspectParcelTransform(path.join(PARCELS_DIR, result.parcelId));
        if (result.transformSuccess && inspection.valid) recovered.push(result.parcelId);
        else {
          unrecovered.push({
            parcelId: result.parcelId,
            error: result.error || inspection.reason || "retry did not produce a valid transformed.zip",
          });
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(htmlDir, { recursive: true, force: true });
  }
  return { attempted, recovered, unrecovered, gisHttpCalls };
}

async function main() {
  const seedIndex = await loadSeedIndex();
  const historicalFailed = loadHistoricalFailedApns();
  const preScanPath = path.join(RUN_ROOT, "reconciliation-prescan.json");
  const preScan = runScan(preScanPath);
  const currentlyInvalid = new Set(preScan.invalid.map((row) => row.parcelId));
  for (const apn of historicalFailed) {
    if (!seedIndex.has(apn)) continue;
    const inspection = await inspectParcelTransform(path.join(PARCELS_DIR, apn));
    if (!inspection.valid) currentlyInvalid.add(apn);
  }

  const retry =
    currentlyInvalid.size > 0
      ? await retryInvalid([...currentlyInvalid].sort(), seedIndex)
      : { attempted: [], recovered: [], unrecovered: [], gisHttpCalls: 0 };

  const postScanPath = path.join(RUN_ROOT, "reconciliation-postscan.json");
  const postScan = runScan(postScanPath);
  const report = {
    generatedAt: new Date().toISOString(),
    historicalFailureJsonlCount: historicalFailed.size,
    seedApns: seedIndex.size,
    validCompletedTransforms: postScan.validCompletedTransforms,
    invalidOrMissingTransforms: postScan.invalidOrMissingTransforms,
    extraParcelDirsNotInSeed: postScan.extraParcelDirsNotInSeed,
    oneToOneWithSeed: postScan.oneToOne,
    retriesAttempted: retry.attempted.length,
    retriesRecovered: retry.recovered.length,
    unrecovered: retry.unrecovered,
    postScanInvalid: postScan.invalid,
    gisHttpCalls: retry.gisHttpCalls,
    captureProvenanceAltered: false,
    socrataRefetched: false,
    prescanInvalidCount: preScan.invalidOrMissingTransforms,
  };
  await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    path.join(RUN_ROOT, "transform-failures.current.jsonl"),
    `${postScan.invalid.map((row) => JSON.stringify(row)).join("\n")}${postScan.invalid.length ? "\n" : ""}`,
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.oneToOneWithSeed || report.unrecovered.length > 0 || report.validCompletedTransforms !== 494841) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
