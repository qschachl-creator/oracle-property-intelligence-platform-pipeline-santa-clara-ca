/**
 * Fetch Socrata GIS JSON for the appraisal sample APNs (offline fixture cache).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APNS = ["09201021", "14810022", "09234015", "10417087", "09206033"];
const SELECT = [
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
].join(",");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "fixtures", "santa-clara-replay", "html");
await mkdir(outDir, { recursive: true });

for (const apn of APNS) {
  const url = new URL("https://data.sccgov.org/resource/ubcd-cewv.json");
  url.searchParams.set("$select", SELECT);
  url.searchParams.set("$where", `apn='${apn}'`);
  url.searchParams.set("$limit", "1");
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${apn} HTTP ${response.status}: ${await response.text()}`);
  }
  const parsed = await response.json();
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed[0].apn !== apn) {
    throw new Error(`${apn} unexpected GIS body`);
  }
  await writeFile(path.join(outDir, `${apn}.html`), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  console.error(`${apn} ${parsed[0].situs_street_name} ${parsed[0].jurisdiction}`);
}
