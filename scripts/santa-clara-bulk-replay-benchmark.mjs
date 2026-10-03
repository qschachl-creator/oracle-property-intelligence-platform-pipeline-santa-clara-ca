#!/usr/bin/env node
/**
 * Bounded GIS page capture + offline replay.
 * Captures one Socrata page (exact $offset/$limit stored at fetch time), then
 * transforms at most 1000 APNs from that raw page JSON with zero GIS HTTP.
 * Does not use the old seed CSV as exact-request provenance. Does not hash,
 * upload, touch Atlas, or run the full 494,841-row county.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { defaultRuntimeRoot, toText } from "../counties/santa-clara/seed.mjs";
import {
  captureSocrataPage,
  indexBulkGisFromPageCapture,
  loadPageCapture,
  pageCaptureDirName,
  sha256Hex,
} from "../counties/santa-clara/page-capture.mjs";
import { captureAndTransform } from "../counties/santa-clara/adapter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHED_MANIFEST = path.join(ROOT, "data", "runs", "lexicon-coverage", "manifest.json");
const LIMIT = Number.parseInt(process.env.SCC_BULK_REPLAY_LIMIT || "1000", 10);
const PAGE_OFFSET = Number.parseInt(process.env.SCC_GIS_PAGE_OFFSET || "0", 10);
const FULL_SEED_ROWS = 494841;

function directoryBytes(dir) {
  const out = execFileSync("du", ["-sk", dir], { encoding: "utf8" }).trim();
  const kib = Number.parseInt(out.split(/\s+/)[0], 10);
  return kib * 1024;
}

async function main() {
  if (!Number.isFinite(LIMIT) || LIMIT < 100 || LIMIT > 1000) {
    throw new Error("SCC_BULK_REPLAY_LIMIT must be between 100 and 1000");
  }
  const pageDir = path.join(
    ROOT,
    "data",
    "captures",
    "santa-clara",
    "pages",
    pageCaptureDirName({ offset: PAGE_OFFSET, limit: LIMIT }),
  );
  await rm(pageDir, { recursive: true, force: true });
  const captured = await captureSocrataPage({
    offset: PAGE_OFFSET,
    limit: LIMIT,
    outDir: pageDir,
  });
  const pageHttpSeconds = captured.httpElapsedSeconds;
  const loaded = await loadPageCapture(pageDir);
  if (loaded.sha256 !== sha256Hex(loaded.rawBytes)) {
    throw new Error("loaded page digest does not match raw bytes");
  }
  const bulkGisByApn = indexBulkGisFromPageCapture(loaded);
  const seedRows = [];
  for (const record of loaded.records) {
    const apn = toText(record.apn);
    if (!/^\d{8}$/.test(apn)) continue;
    seedRows.push(bulkGisByApn.get(apn).row);
    if (seedRows.length >= LIMIT) break;
  }
  if (seedRows.length < 100) {
    throw new Error(`Captured page produced only ${seedRows.length} 8-digit APNs`);
  }

  await readFile(CACHED_MANIFEST, "utf8");
  process.env.ELEPHANT_SCHEMA_MANIFEST_URL = pathToFileURL(CACHED_MANIFEST).href;
  const htmlDir = await mkdtemp(path.join(tmpdir(), "scc-bulk-empty-html-"));
  const outputDir = path.join(ROOT, "data", "runs", "gis-bulk-replay", `page-offset-${PAGE_OFFSET}-n${seedRows.length}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const originalFetch = globalThis.fetch;
  let gisHttpCalls = 0;
  globalThis.fetch = async (...args) => {
    gisHttpCalls += 1;
    throw new Error(`offline bulk replay issued GIS HTTP: ${String(args[0])}`);
  };
  let transformSeconds;
  let manifest;
  try {
    const started = process.hrtime.bigint();
    manifest = await captureAndTransform({
      seedRows,
      htmlDir,
      outputDir,
      liveFetch: false,
      bulkGisByApn,
      runtimeRoot: defaultRuntimeRoot(),
    });
    transformSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  } finally {
    globalThis.fetch = originalFetch;
    await rm(htmlDir, { recursive: true, force: true });
  }

  const ok = manifest.results.filter((row) => row.transformSuccess);
  const failed = manifest.results.filter((row) => !row.transformSuccess);
  if (failed.length > 0) {
    throw new Error(`Bulk replay failed for ${failed.length} parcels: ${failed[0].error}`);
  }
  if (gisHttpCalls !== 0) {
    throw new Error(`offline transform issued ${gisHttpCalls} GIS HTTP calls`);
  }
  const firstId = seedRows[0].parcel_id;
  const lastId = seedRows[seedRows.length - 1].parcel_id;
  const property = JSON.parse(await readFile(path.join(outputDir, firstId, "data", "property.json"), "utf8"));
  const propertyLast = JSON.parse(await readFile(path.join(outputDir, lastId, "data", "property.json"), "utf8"));
  const bulkMeta = JSON.parse(await readFile(path.join(outputDir, firstId, "bulk_capture.json"), "utf8"));
  const query = property.source_http_request?.multiValueQueryString ?? {};
  if (query.$where) throw new Error("Bulk replay must not stamp $where");
  if (query.$offset?.[0] !== String(PAGE_OFFSET)) throw new Error("entity $offset does not match capture");
  if (query.$limit?.[0] !== String(LIMIT)) throw new Error("entity $limit does not match capture");
  if (JSON.stringify(property.source_http_request) !== JSON.stringify(propertyLast.source_http_request)) {
    throw new Error("parcels from the same page must share the exact stored page request");
  }
  if (bulkMeta.captureSha256 !== loaded.sha256) {
    throw new Error("bulk_capture digest does not match raw page artifact");
  }
  const bytesWritten = directoryBytes(outputDir);
  const parcelsPerSec = ok.length / transformSeconds;
  const report = {
    measured: true,
    pageCapture: {
      dir: pageDir,
      httpElapsedSeconds: pageHttpSeconds,
      sha256: loaded.sha256,
      byteLength: loaded.byteLength,
      rowCountOnPage: loaded.rowCount,
      sourceHttpRequest: loaded.sourceHttpRequest,
    },
    transformOnly: {
      parcelCount: ok.length,
      wallClockSeconds: transformSeconds,
      gisHttpCalls,
      bytesWritten,
      parcelsPerSec,
    },
    sampleApn: firstId,
    sampleSourceHttpRequest: property.source_http_request,
    captureKind: ok[0]?.captureKind ?? null,
    lexiconManifest: process.env.ELEPHANT_SCHEMA_MANIFEST_URL,
    usedOldSeedCsv: false,
    extrapolation: {
      label: "extrapolation",
      measured: false,
      fullSeedRows: FULL_SEED_ROWS,
      estimatedTransformOnlySeconds: FULL_SEED_ROWS / parcelsPerSec,
      estimatedTransformOnlyHours: FULL_SEED_ROWS / parcelsPerSec / 3600,
      estimatedWorkDirBytes: (bytesWritten / ok.length) * FULL_SEED_ROWS,
      basis: `linear scale of transform-only time/disk from ${ok.length} parcels indexed from one captured Socrata page; does not include paging HTTP for a full recapture`,
    },
  };
  await writeFile(path.join(outputDir, "benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
