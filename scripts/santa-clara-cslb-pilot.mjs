#!/usr/bin/env node
/**
 * Acquire a private CSLB Santa Clara + C-39 baseline from the official portal.
 * Does not emit lexicon company/person/license records or Atlas output.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COUNTY_LIST_COLUMNS,
  PERSONNEL_COLUMNS,
  buildPrivateSnapshot,
  countyXlsxToCsv,
  parseCountyListCsv,
  parsePersonnelCsv,
  sha256Hex,
} from "../counties/santa-clara/cslb.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_XLSX = path.join(ROOT, "scripts", "cslb-xlsx-to-csv.py");
const PYTHON_DOWNLOAD = path.join(ROOT, "scripts", "cslb-portal-download.py");
const OUT_DIR = path.join(ROOT, "data", "identity", "cslb", "pilot-santa-clara-c39");

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  execFileSync("python3", [PYTHON_DOWNLOAD, OUT_DIR], { stdio: "inherit" });
  const meta = JSON.parse(await readFile(path.join(OUT_DIR, "download-meta.json"), "utf8"));
  const countyBytes = await readFile(meta.list_by_county.path);
  const personnelBytes = await readFile(meta.personnel.path);
  const countyCsv = await countyXlsxToCsv(countyBytes, PYTHON_XLSX);
  const licenses = parseCountyListCsv(countyCsv, { requirePilotScope: true });
  const personnelRows = parsePersonnelCsv(personnelBytes, {
    licenseNumbers: licenses.map((row) => row.licenseNumber),
  });
  const countySource = {
    url: meta.list_by_county.url,
    method: "POST",
    form: {
      classification: "C-39",
      county: "43",
      countyName: "Santa Clara",
    },
    downloadedAt: meta.list_by_county.downloadedAt,
    contentType: meta.list_by_county.contentType,
    contentDisposition: meta.list_by_county.contentDisposition,
    sha256: sha256Hex(countyBytes),
    bytes: countyBytes.length,
    rawSchema: COUNTY_LIST_COLUMNS,
  };
  const personnelSource = {
    url: meta.personnel.url,
    method: "POST",
    file: "Personnel",
    format: "csv",
    downloadedAt: meta.personnel.downloadedAt,
    portalAsOfDate: meta.personnel.portalAsOfDate,
    contentType: meta.personnel.contentType,
    contentDisposition: meta.personnel.contentDisposition,
    sha256: sha256Hex(personnelBytes),
    bytes: personnelBytes.length,
    rawSchema: PERSONNEL_COLUMNS,
  };
  const snapshot = buildPrivateSnapshot({
    licenses,
    personnel: personnelRows,
    countySource,
    personnelSource,
  });
  snapshot.freshness = {
    portalAsOfDate: meta.personnel.portalAsOfDate,
    countyWorkbookDownloadedAt: meta.list_by_county.downloadedAt,
    personnelDownloadedAt: meta.personnel.downloadedAt,
  };

  await mkdir(path.join(OUT_DIR, "derived"), { recursive: true });
  await writeFile(path.join(OUT_DIR, "derived", "county-list.csv"), countyCsv);
  await writeFile(
    path.join(OUT_DIR, "derived", "licenses.json"),
    `${JSON.stringify(licenses, null, 2)}\n`,
  );
  await writeFile(
    path.join(OUT_DIR, "derived", "personnel.json"),
    `${JSON.stringify(personnelRows, null, 2)}\n`,
  );
  await writeFile(path.join(OUT_DIR, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({ outputDir: OUT_DIR, ...snapshot.counts, freshness: snapshot.freshness }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
