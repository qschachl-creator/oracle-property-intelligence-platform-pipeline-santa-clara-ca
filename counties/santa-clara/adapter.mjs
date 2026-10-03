/**
 * Santa Clara county adapter: GIS JSON capture → CommonJS transform →
 * structural validateRun. Same CountyAdapter verbs as Pinellas/Duval.
 *
 * Capture source for this public-data run is Socrata `ubcd-cewv` (plain GET).
 * Assessor Real Property Search is ASP.NET + terms-gated; it is not used here.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir, readdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COUNTY_KEY,
  COUNTY_NAME,
  SOCRATA_RESOURCE_URL,
  defaultRuntimeRoot,
  toSocrataCaptureUrl,
  toText,
  socrataQueryForApn,
  buildSeed as buildSantaClaraSeedFiles,
} from "./seed.mjs";
import { assertExactPageRequest } from "./page-capture.mjs";
import { mapTransformedFilesToQueryTableRow, loadQueryTableSchemaFields } from "./query-table.mjs";

const COUNTY_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TRANSFORMS_DIR = path.join(COUNTY_ROOT, "transforms");
export const TRANSFORM_SCRIPTS = Object.freeze(["data_extractor.js"]);
export const REQUIRED_DATA_ARTIFACTS = Object.freeze(["property.json", "parcel.json"]);
export const MIN_TRANSFORMED_ZIP_BYTES = 200;
export const ZIP_LOCAL_FILE_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
export const DEFAULT_JOB_ID = "santa-clara-ingest";

function runtimeRequire(runtimeRoot) {
  return createRequire(path.join(runtimeRoot, "package.json"));
}

async function loadRuntimeModules(runtimeRoot = defaultRuntimeRoot()) {
  const { runCountyTransform } = await import(pathToFileURL(path.join(runtimeRoot, "src/core/transform-runner.mjs")).href);
  const { readTransformedZipJsonFiles, writeQueryTableParquet, buildCoverageSnapshot } = await import(
    pathToFileURL(path.join(runtimeRoot, "src/core/query-table.mjs")).href
  );
  const AdmZipCtor = runtimeRequire(runtimeRoot)("adm-zip");
  return { runCountyTransform, readTransformedZipJsonFiles, writeQueryTableParquet, buildCoverageSnapshot, AdmZipCtor };
}

export function parseSeedQueryString(raw, parcelId) {
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        /** @type {Record<string, string[]>} */
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
            out[key] = value;
          }
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch {
      // Fall through.
    }
  }
  return socrataQueryForApn(parcelId);
}

export function buildSourceHttpRequest(row) {
  const parcelId = toText(row.parcel_id);
  const url = toText(row.url) || SOCRATA_RESOURCE_URL;
  const method = toText(row.method) || "GET";
  if (toText(row.capture_sha256)) {
    const multiValueQueryString = parseSeedQueryString(row.multiValueQueryString, parcelId);
    const sourceHttpRequest = { url, method, multiValueQueryString };
    assertExactPageRequest(sourceHttpRequest);
    return sourceHttpRequest;
  }
  return {
    url,
    method,
    multiValueQueryString: parseSeedQueryString(row.multiValueQueryString, parcelId),
  };
}

export function buildSeedJsonFiles(row) {
  const sourceHttpRequest = buildSourceHttpRequest(row);
  const parcelId = toText(row.parcel_id);
  const situs = toText(row.situs_address) || toText(row.address);
  return {
    propertySeed: {
      source_http_request: sourceHttpRequest,
      request_identifier: parcelId,
      parcel_id: parcelId,
    },
    unnormalizedAddress: {
      source_http_request: sourceHttpRequest,
      request_identifier: parcelId,
      full_address: situs,
      county_jurisdiction: COUNTY_NAME,
    },
  };
}

export function parseGisCapture(body) {
  const parsed = JSON.parse(body);
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record || typeof record !== "object") {
    throw new Error("Santa Clara GIS capture is empty");
  }
  return record;
}

export function assertGisMatchesRequestedApn(body, parcelId) {
  const record = parseGisCapture(body);
  const got = toText(record.apn);
  if (got !== toText(parcelId)) {
    throw new Error(`GIS apn ${got} does not match requested ${parcelId}`);
  }
  return record;
}

export function assertGeometryJoinKey(gisRecord, seedRow) {
  const joinKey = toText(seedRow?.geometry_join_key);
  if (!joinKey) return;
  const objectId = toText(gisRecord?.objectid);
  if (objectId !== joinKey) {
    throw new Error(`geometry_join_key ${joinKey} does not match GIS objectid ${objectId || "(missing)"}`);
  }
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function transformedZipHasGeometry(parcelDir, runtimeRoot) {
  const { readTransformedZipJsonFiles } = await loadRuntimeModules(runtimeRoot);
  try {
    const files = readTransformedZipJsonFiles(path.join(parcelDir, "transformed.zip"));
    return files["geometry.json"] !== undefined;
  } catch {
    return false;
  }
}

export async function hasCompletedTransform(parcelDir) {
  const zipPath = path.join(parcelDir, "transformed.zip");
  try {
    const buffer = await readFile(zipPath);
    return buffer.length >= MIN_TRANSFORMED_ZIP_BYTES && buffer.subarray(0, 4).equals(ZIP_LOCAL_FILE_MAGIC);
  } catch {
    return false;
  }
}

export async function inspectParcelTransform(parcelDir, options = {}) {
  const runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot();
  const { readTransformedZipJsonFiles } = await loadRuntimeModules(runtimeRoot);
  if (!(await hasCompletedTransform(parcelDir))) {
    return { valid: false, reason: "transformed.zip missing, too small, or not PKZIP" };
  }
  try {
    const files = readTransformedZipJsonFiles(path.join(parcelDir, "transformed.zip"));
    for (const required of REQUIRED_DATA_ARTIFACTS) {
      if (files[required] === undefined) {
        return { valid: false, reason: `transformed.zip is missing data/${required}` };
      }
    }
    return { valid: true, reason: null };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchGisJson(row) {
  const url = toSocrataCaptureUrl(row);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Socrata GIS HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function zipDataDirectory(AdmZipCtor, dataDir, zipPath) {
  const zip = new AdmZipCtor();
  const names = await readdir(dataDir);
  for (const name of names.sort()) {
    zip.addLocalFile(path.join(dataDir, name), "data");
  }
  await new Promise((resolve, reject) => {
    zip.writeZip(zipPath, (error) => (error ? reject(error) : resolve(undefined)));
  });
}

export async function captureAndTransform({
  seedRows,
  htmlDir,
  outputDir,
  liveFetch = false,
  bulkGisByApn = null,
  skipCompleted = false,
  writeManifest = true,
  onParcel = null,
  runtimeRoot = defaultRuntimeRoot(),
}) {
  const { runCountyTransform, AdmZipCtor } = await loadRuntimeModules(runtimeRoot);
  await mkdir(outputDir, { recursive: true });
  const results = [];
  for (const row of seedRows) {
    const parcelId = row.parcel_id;
    const parcelDir = path.join(outputDir, parcelId);
    await mkdir(parcelDir, { recursive: true });
    try {
      const bulkEntry =
        bulkGisByApn instanceof Map && bulkGisByApn.has(toText(parcelId)) ? bulkGisByApn.get(toText(parcelId)) : null;
      const captureHasGeom = bulkEntry?.gisRecord?.the_geom != null;
      if (skipCompleted && (await hasCompletedTransform(parcelDir))) {
        const geometryReady = !captureHasGeom || (await transformedZipHasGeometry(parcelDir, runtimeRoot));
        if (geometryReady) {
          const skipped = {
            parcelId,
            captureKind: "skipped_completed",
            transformSuccess: true,
            skipped: true,
            propertyUsageType: null,
            error: null,
          };
          results.push(skipped);
          onParcel?.(skipped, results.length, seedRows.length);
          continue;
        }
      }
      const fixturePath = path.join(htmlDir, `${parcelId}.html`);
      const inputPath = path.join(parcelDir, "input.html");
      let body;
      let seedRow = row;
      let captureKind = "fixture_html";
      if (await pathExists(fixturePath)) {
        body = await readFile(fixturePath, "utf8");
        await copyFile(fixturePath, inputPath);
      } else if (bulkEntry) {
        const entry = bulkEntry;
        assertExactPageRequest(entry.sourceHttpRequest);
        seedRow = entry.row;
        body = `${JSON.stringify([entry.gisRecord])}\n`;
        await writeFile(inputPath, body, "utf8");
        captureKind = entry.captureKind;
        await writeFile(
          path.join(parcelDir, "bulk_capture.json"),
          `${JSON.stringify(
            {
              captureKind: entry.captureKind,
              sourceDatasetUrl: entry.sourceDatasetUrl,
              sourceRetrievedAt: entry.sourceRetrievedAt,
              pageOffset: entry.pageOffset,
              pageLimit: entry.pageLimit,
              captureSha256: entry.captureSha256,
              captureFile: entry.captureFile,
              sourceHttpRequest: entry.sourceHttpRequest,
            },
            null,
            2,
          )}\n`,
        );
      } else if (liveFetch === true) {
        body = await fetchGisJson(row);
        await writeFile(inputPath, body, "utf8");
        captureKind = "live_per_apn_socrata_get";
      } else {
        throw new Error(
          `No local GIS fixture for parcel ${parcelId} at ${fixturePath}, no bulk GIS page index for that APN, and --live-fetch was not supplied; refusing to contact Socrata.`,
        );
      }

      const gisRecord = assertGisMatchesRequestedApn(body, parcelId);
      assertGeometryJoinKey(gisRecord, seedRow);
      const seedFiles = buildSeedJsonFiles(seedRow);
      await writeFile(path.join(parcelDir, "property_seed.json"), `${JSON.stringify(seedFiles.propertySeed, null, 2)}\n`);
      await writeFile(
        path.join(parcelDir, "unnormalized_address.json"),
        `${JSON.stringify(seedFiles.unnormalizedAddress, null, 2)}\n`,
      );

      const { result, dataDir } = runCountyTransform({
        scriptsDir: TRANSFORMS_DIR,
        scriptNames: TRANSFORM_SCRIPTS,
        workDir: parcelDir,
        resultFile: "data/property.json",
      });

      const address = JSON.parse(await readFile(path.join(dataDir, "address.json"), "utf8"));
      const countyLabel = address.county_name ?? address.county;
      if (countyLabel !== COUNTY_NAME) {
        throw new Error(`transformed county must be ${COUNTY_NAME}, got ${String(countyLabel)}`);
      }

      await zipDataDirectory(AdmZipCtor, dataDir, path.join(parcelDir, "transformed.zip"));
      results.push({
        parcelId,
        captureKind,
        transformSuccess: true,
        skipped: false,
        propertyUsageType: typeof result.property_usage_type === "string" ? result.property_usage_type : null,
        error: null,
      });
      onParcel?.(results[results.length - 1], results.length, seedRows.length);
    } catch (error) {
      const failed = {
        parcelId,
        captureKind: null,
        transformSuccess: false,
        skipped: false,
        propertyUsageType: null,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(failed);
      onParcel?.(failed, results.length, seedRows.length);
    }
  }
  const manifest = { county: COUNTY_KEY, outputDir, results };
  if (writeManifest) {
    await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}

export async function validateRun(manifest, options = {}) {
  const runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot();
  const { readTransformedZipJsonFiles } = await loadRuntimeModules(runtimeRoot);
  const issues = [];
  let checked = 0;
  for (const parcel of manifest.results) {
    if (!parcel.transformSuccess) {
      issues.push({ parcelId: parcel.parcelId, reason: parcel.error ?? "transform did not succeed" });
      continue;
    }
    checked += 1;
    const parcelDir = path.join(manifest.outputDir, parcel.parcelId);
    if (!(await hasCompletedTransform(parcelDir))) {
      issues.push({ parcelId: parcel.parcelId, reason: "transformed.zip missing or not a valid PKZIP" });
      continue;
    }
    const files = readTransformedZipJsonFiles(path.join(parcelDir, "transformed.zip"));
    for (const required of REQUIRED_DATA_ARTIFACTS) {
      if (files[required] === undefined) {
        issues.push({ parcelId: parcel.parcelId, reason: `transformed.zip is missing data/${required}` });
      }
    }
  }
  return { valid: issues.length === 0, checked, issues };
}

export async function buildReconciliationArtifacts({
  outputDir,
  seedRows,
  workingDir,
  runtimeRoot = defaultRuntimeRoot(),
}) {
  const { readTransformedZipJsonFiles, writeQueryTableParquet, buildCoverageSnapshot } =
    await loadRuntimeModules(runtimeRoot);
  const schemaFields = await loadQueryTableSchemaFields(runtimeRoot);
  await mkdir(workingDir, { recursive: true });
  const expectedCount = seedRows.length;
  const rows = [];
  const missing = [];
  let seen = 0;
  for (const row of seedRows) {
    const parcelId = row.parcel_id;
    const zipPath = path.join(outputDir, parcelId, "transformed.zip");
    try {
      const files = readTransformedZipJsonFiles(zipPath);
      if (files["property.json"] === undefined) {
        missing.push(parcelId);
        continue;
      }
      rows.push(await mapTransformedFilesToQueryTableRow({ parcelId, files, seedRow: row, runtimeRoot }));
    } catch {
      missing.push(parcelId);
    }
    seen += 1;
    if (seen % 20000 === 0) {
      process.stderr.write(`query-table ${seen}/${expectedCount} missing=${missing.length}\n`);
    }
  }
  if (missing.length > 0) {
    const sample = missing.slice(0, 20).join(", ");
    throw new Error(`Missing transformed.zip/property.json for ${missing.length} seed APNs. First: ${sample}`);
  }

  const parquetPath = path.join(workingDir, "query-table.parquet");
  const coveragePath = path.join(workingDir, "dataset-coverage.json");
  const manifestPath = path.join(workingDir, "manifest.json");
  await writeQueryTableParquet({ parquetPath, schemaFields, rows });
  const coverage = buildCoverageSnapshot({
    county: COUNTY_KEY,
    source: "appraisal",
    ingestedCount: rows.length,
    expectedCount,
    exportedAt: new Date().toISOString(),
  });
  await writeFile(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
  const artifacts = {
    county: COUNTY_KEY,
    parquetPath,
    coveragePath,
    manifestPath,
    rowCount: rows.length,
    expectedCount,
  };
  await writeFile(manifestPath, `${JSON.stringify(artifacts, null, 2)}\n`);
  return artifacts;
}

export const santaClaraAdapter = {
  key: COUNTY_KEY,
  countyName: COUNTY_NAME,
  transformsDir: TRANSFORMS_DIR,
  buildSeed: buildSantaClaraSeedFiles,
  captureAndTransform,
  validateRun,
  buildReconciliationArtifacts,
};
