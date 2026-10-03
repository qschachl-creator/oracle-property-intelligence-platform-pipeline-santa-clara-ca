import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mapTransformedFilesToQueryTableRow } from "../counties/santa-clara/query-table.mjs";
import {
  SAN_JOSE_OLDER_ROOF_LAYER_CHECK,
  SAN_JOSE_ROOF_AGE_AS_OF_DATE,
  estimateParcelRoofAge,
  normalizeFixtureFeature,
  normalizedPermitToRoofAgeRow,
} from "../counties/santa-clara/permits/roof-age.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "fixtures", "santa-clara-permits");

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURE, name), "utf8"));
}

async function estimateFixture(name) {
  const fixture = await loadFixture(name);
  const permit = normalizeFixtureFeature(fixture);
  return estimateParcelRoofAge({
    parcelIdentifier: permit.parcel_identifier,
    permits: [permit],
  });
}

test("completed 2026 reroof is a young roof and is not older than 15 years", async () => {
  const result = await estimateFixture("sanjose-arcgis-finalized-reroof.json");
  assert.equal(result.parcelIdentifier, "09241022");
  assert.equal(result.estimate.schemaVersion, "elephant.roof-age-estimate.v1");
  assert.equal(result.estimate.asOfDate, SAN_JOSE_ROOF_AGE_AS_OF_DATE);
  assert.equal(result.estimate.anchor.type, "permit_terminal_date");
  assert.equal(result.estimate.anchor.date, "2026-09-12");
  assert.equal(result.estimate.anchor.source.dateField, "completionDate");
  assert.equal(result.estimate.anchor.source.sourceRecordId, "2026-135571-RS");
  assert.equal(result.estimate.estimatedAgeYears, 0);
  assert.equal(result.estimate.confidence, "high");
  assert.equal(result.estimate.workClassification, "primary_roof_replacement");
  assert.equal(result.estimate.eligibility.eligible, true);
  assert.equal(
    result.estimate.eligibility.reason,
    "accepted_completed_primary_roof_replacement",
  );
  assert.equal(result.olderThanThreshold, false);
  assert.equal(result.estimate.anchor.date === "2026-08-31", false);
});

test("1997 reroof without FINALDATE stays no_valid_anchor", async () => {
  const fixture = await loadFixture("sanjose-arcgis-active-reroof.json");
  const permit = normalizeFixtureFeature(fixture);
  const row = normalizedPermitToRoofAgeRow(permit);
  assert.equal(permit.permit_issue_date, "1997-10-22");
  assert.equal(permit.final_inspection_date, null);
  assert.equal(row.completionDate, null);
  assert.equal(row.closeDate, null);
  assert.equal(row.issueDate, "1997-10-22");
  assert.equal(row.sourcePayload.roofAgeEvidenceStates.completionDate, "confirmed_empty");

  const result = await estimateParcelRoofAge({
    parcelIdentifier: permit.parcel_identifier,
    permits: [permit],
  });
  assert.equal(result.parcelIdentifier, "68958007");
  assert.equal(result.estimate.schemaVersion, "elephant.roof-age-estimate.v1");
  assert.equal(result.estimate.anchor, null);
  assert.equal(result.estimate.estimatedAgeYears, null);
  assert.equal(result.estimate.confidence, "none");
  assert.equal(result.estimate.eligibility.eligible, false);
  assert.equal(result.estimate.eligibility.reason, "no_valid_anchor");
  assert.equal(result.olderThanThreshold, false);
  assert.equal(result.queryFields.roof_date, null);
  assert.equal(result.queryFields.roof_age_years, null);
  assert.notEqual(result.queryFields.roof_date, "1997-10-22");
});

test("layer 9 has a completed 2010 reroof older than 15 years", async () => {
  assert.equal(SAN_JOSE_OLDER_ROOF_LAYER_CHECK.found, true);
  assert.equal(SAN_JOSE_OLDER_ROOF_LAYER_CHECK.counts[7], 0);
  assert.equal(SAN_JOSE_OLDER_ROOF_LAYER_CHECK.counts[8], 0);
  assert.equal(SAN_JOSE_OLDER_ROOF_LAYER_CHECK.counts[9], 5);
  const result = await estimateFixture("sanjose-arcgis-expired-reroof-2010.json");
  assert.equal(result.parcelIdentifier, "67620085");
  assert.equal(result.estimate.anchor.type, "permit_terminal_date");
  assert.equal(result.estimate.anchor.date, "2010-06-01");
  assert.equal(result.estimate.anchor.source.sourceRecordId, "2010-012446-RS");
  assert.equal(result.estimate.estimatedAgeYears, 16);
  assert.equal(result.estimate.confidence, "high");
  assert.equal(result.estimate.eligibility.reason, "accepted_completed_primary_roof_replacement");
  assert.equal(result.olderThanThreshold, true);
});

test("query-table roof-age fields follow the estimate for the proof APNs", async () => {
  for (const [fixtureName, parcelId, expectedReason] of [
    ["sanjose-arcgis-finalized-reroof.json", "09241022", "accepted_completed_primary_roof_replacement"],
    ["sanjose-arcgis-active-reroof.json", "68958007", "no_valid_anchor"],
    ["sanjose-arcgis-expired-reroof-2010.json", "67620085", "accepted_completed_primary_roof_replacement"],
  ]) {
    const result = await estimateFixture(fixtureName);
    const row = await mapTransformedFilesToQueryTableRow({
      parcelId,
      files: { "property.json": { parcel_identifier: parcelId, property_type: "LandParcel" } },
      roofAgeLineage: result.lineage,
    });
    assert.equal(row.parcel_identifier, parcelId);
    assert.equal(row.built_year, null);
    assert.equal(row.roof_date, result.queryFields.roof_date);
    assert.equal(row.roof_age_years, result.queryFields.roof_age_years);
    assert.equal(row.roof_age_confidence, result.queryFields.roof_age_confidence);
    assert.equal(row.roof_age_eligibility_reason, expectedReason);
    assert.equal(row.roof_age_eligibility_reason, result.estimate.eligibility.reason);
    assert.equal(row.roof_age_permit_id, result.queryFields.roof_age_permit_id);
    if (result.estimate.anchor?.type === "permit_terminal_date") {
      assert.equal(row.roof_date, result.estimate.anchor.date);
      assert.equal(row.roof_age_years, result.estimate.estimatedAgeYears);
      assert.equal(row.roof_age_source, "permit_updated");
    } else {
      assert.equal(row.roof_age_source, "none");
      assert.equal(row.roof_age_permit_id, null);
    }
  }
});

test("San Jose ReRoof snapshot is APN-keyed and the proof parcels match the estimator", async () => {
  const snapshot = await loadFixture("san-jose-reroof-roof-age.json");
  assert.equal(snapshot.asOfDate, SAN_JOSE_ROOF_AGE_AS_OF_DATE);
  assert.deepEqual(snapshot.layerIds, [7, 8, 9]);
  assert.equal(snapshot.where, "WORKDESC = 'ReRoof'");
  assert.equal(snapshot.returnGeometry, false);
  assert.match(snapshot.collectionMethod, /exceededTransferLimit/);
  assert.match(snapshot.collectionMethod, /normalizeSanJoseArcgisFeature/);
  assert.match(snapshot.collectionMethod, /estimateParcelRoofAge/);

  assert.equal(
    snapshot.layers.reduce((sum, layer) => sum + layer.featureCount, 0),
    snapshot.counts.features,
  );
  for (const layer of snapshot.layers) {
    assert.equal(layer.pages.at(-1).exceededTransferLimit, false);
    assert.equal(
      layer.pages.reduce((sum, page) => sum + page.returned, 0),
      layer.featureCount,
    );
  }
  assert.equal(Number.isInteger(snapshot.counts.apnsOnMultipleLayers), true);
  assert.ok(snapshot.counts.apnsOnMultipleLayers >= 0);
  assert.ok(snapshot.counts.apnsOnMultipleLayers <= snapshot.counts.apns);

  const parcels = snapshot.parcels;
  const rows = Object.values(parcels);
  assert.equal(rows.length, snapshot.counts.apns);
  assert.equal(Object.keys(parcels).length, snapshot.counts.apns);
  assert.ok(rows.length > 3);

  let validRoofAgeAnchors = 0;
  let olderThan15Years = 0;
  let noValidAnchor = 0;
  for (const row of rows) {
    assert.equal(row.builtYear, null);
    assert.match(row.parcel_identifier, /^\d{8}$/);
    assert.equal(parcels[row.parcel_identifier], row);
    if (row.roof_age_eligibility_reason === "accepted_completed_primary_roof_replacement") {
      validRoofAgeAnchors += 1;
      assert.equal(typeof row.roof_date, "string");
      assert.equal(Number.isInteger(row.roof_age_years), true);
      assert.equal(row.roof_age_confidence, "high");
      assert.equal(row.roof_age_source, "permit_updated");
      assert.equal(typeof row.roof_age_permit_id, "string");
      assert.equal(row.olderThan15Years, row.roof_age_years >= 15);
    } else {
      assert.equal(row.roof_age_eligibility_reason, "no_valid_anchor");
      noValidAnchor += 1;
      assert.equal(row.roof_date, null);
      assert.equal(row.roof_age_years, null);
      assert.equal(row.roof_age_permit_id, null);
      assert.equal(row.olderThan15Years, false);
    }
    if (row.olderThan15Years) olderThan15Years += 1;
  }
  assert.equal(validRoofAgeAnchors, snapshot.counts.validRoofAgeAnchors);
  assert.equal(olderThan15Years, snapshot.counts.olderThan15Years);
  assert.equal(noValidAnchor, snapshot.counts.noValidAnchor);
  assert.equal(
    validRoofAgeAnchors + noValidAnchor,
    snapshot.counts.apns,
  );

  const young = parcels["09241022"];
  assert.equal(young.roof_date, "2026-09-12");
  assert.equal(young.roof_age_years, 0);
  assert.equal(young.roof_age_confidence, "high");
  assert.equal(young.roof_age_permit_id, "2026-135571-RS");
  assert.equal(young.roof_age_eligibility_reason, "accepted_completed_primary_roof_replacement");
  assert.equal(young.olderThan15Years, false);
  assert.equal(young.builtYear, null);

  const missing = parcels["68958007"];
  assert.equal(missing.roof_age_eligibility_reason, "no_valid_anchor");
  assert.equal(missing.roof_date, null);
  assert.equal(missing.roof_age_years, null);
  assert.equal(missing.roof_age_permit_id, null);
  assert.equal(missing.olderThan15Years, false);
  assert.equal(missing.builtYear, null);

  const older = parcels["67620085"];
  assert.equal(older.roof_date, "2010-06-01");
  assert.equal(older.roof_age_years, 16);
  assert.equal(older.roof_age_confidence, "high");
  assert.equal(older.roof_age_permit_id, "2010-012446-RS");
  assert.equal(older.roof_age_eligibility_reason, "accepted_completed_primary_roof_replacement");
  assert.equal(older.olderThan15Years, true);
  assert.equal(older.builtYear, null);
});
