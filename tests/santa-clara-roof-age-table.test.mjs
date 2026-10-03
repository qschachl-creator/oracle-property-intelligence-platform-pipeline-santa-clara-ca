import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ROOF_AGE_SNAPSHOT_RELATIVE_PATH,
  ROOF_AGE_TABLE_DIR,
  readRoofAgeQueryRows,
  writeRoofAgeQueryTable,
} from "../counties/santa-clara/roof-age-table.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, ROOF_AGE_SNAPSHOT_RELATIVE_PATH);

const REROOF_FEATURES = 7787;
const APNS = 6955;
const ACCEPTED_ANCHORS = 59;
const OLDER_THAN_15 = 5;
const ACCEPTED_REASON = "accepted_completed_primary_roof_replacement";

test("San Jose roof-age table keeps the frozen ReRoof census", async () => {
  const snapshot = JSON.parse(await readFile(FIXTURE, "utf8"));
  assert.equal(snapshot.counts.features, REROOF_FEATURES);
  assert.equal(
    snapshot.layers.reduce((sum, layer) => sum + layer.featureCount, 0),
    REROOF_FEATURES,
  );
  assert.equal(snapshot.counts.apns, APNS);
  assert.equal(Object.keys(snapshot.parcels).length, APNS);

  let accepted = 0;
  let older = 0;
  for (const parcel of Object.values(snapshot.parcels)) {
    if (parcel.roof_age_eligibility_reason === ACCEPTED_REASON) accepted += 1;
    if (parcel.olderThan15Years === true) older += 1;
  }
  assert.equal(accepted, ACCEPTED_ANCHORS);
  assert.equal(snapshot.counts.validRoofAgeAnchors, ACCEPTED_ANCHORS);
  assert.equal(older, OLDER_THAN_15);
  assert.equal(snapshot.counts.olderThan15Years, OLDER_THAN_15);

  const written = await writeRoofAgeQueryTable({
    snapshot,
    outputDir: path.join(ROOT, ROOF_AGE_TABLE_DIR),
    sourceSnapshotPath: ROOF_AGE_SNAPSHOT_RELATIVE_PATH,
  });
  assert.equal(written.rowCount, APNS);
  assert.equal(written.manifest.asOfDate, snapshot.asOfDate);
  assert.equal(written.manifest.sourceSnapshotPath, ROOF_AGE_SNAPSHOT_RELATIVE_PATH);
  assert.equal(
    JSON.parse(await readFile(written.manifestPath, "utf8")).sourceSnapshotPath,
    ROOF_AGE_SNAPSHOT_RELATIVE_PATH,
  );

  const rows = await readRoofAgeQueryRows(written.parquetPath);
  assert.equal(rows.length, APNS);
  assert.equal(
    rows.filter((row) => row.roof_age_eligibility_reason === ACCEPTED_REASON).length,
    ACCEPTED_ANCHORS,
  );
  assert.equal(rows.filter((row) => row.olderThan15Years === true).length, OLDER_THAN_15);

  const byParcel = new Map(rows.map((row) => [row.parcel_identifier, row]));
  assert.equal(byParcel.size, APNS);
  const olderRoof = byParcel.get("67620085");
  assert.ok(olderRoof);
  assert.equal(olderRoof.parcel_identifier, "67620085");
  assert.equal(olderRoof.builtYear, null);
  assert.equal(olderRoof.roof_date, "2010-06-01");
  assert.equal(olderRoof.roof_age_years, 16);
  assert.equal(olderRoof.roof_age_source, "permit_updated");
  assert.equal(olderRoof.roof_age_confidence, "high");
  assert.equal(olderRoof.roof_age_permit_id, "2010-012446-RS");
  assert.equal(olderRoof.roof_age_eligibility_reason, ACCEPTED_REASON);
  assert.equal(olderRoof.olderThan15Years, true);
});
