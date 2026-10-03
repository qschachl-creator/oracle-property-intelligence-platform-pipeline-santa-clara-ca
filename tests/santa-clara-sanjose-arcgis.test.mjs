import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizeSantaClaraParcelIdentifier } from "../counties/santa-clara/permits/apn.mjs";
import {
  createSanJoseArcgisAdapter,
  normalizeSanJoseArcgisFeature,
  sanJoseArcgisJurisdiction,
} from "../counties/santa-clara/permits/sanjose-arcgis.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "fixtures", "santa-clara-permits");
const PROPERTY_ID = "a".repeat(32);

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURE, name), "utf8"));
}

function fixtureClient(payloadsByApn) {
  return {
    async json(url) {
      const parsed = new URL(url);
      const where = parsed.searchParams.get("where") ?? "";
      const apnMatch = where.match(/APN\s*=\s*'(\d{8})'/i);
      const layerId = Number(parsed.pathname.match(/MapServer\/(\d+)/)?.[1]);
      const payload = (apnMatch && payloadsByApn[apnMatch[1]]) || {
        features: [],
        count: 0,
      };
      if (parsed.searchParams.get("returnCountOnly") === "true") {
        const count =
          payload.layerId === layerId || payload.layerId == null
            ? payload.count ?? (payload.features ?? []).length
            : 0;
        return { body: { count } };
      }
      if (payload.layerId != null && payload.layerId !== layerId) {
        return { body: { features: [], exceededTransferLimit: false } };
      }
      return {
        body: {
          features: payload.features ?? [],
          exceededTransferLimit: false,
        },
      };
    },
  };
}

test("Santa Clara APN stays 8-digit text and accepts dashed display form", () => {
  assert.equal(normalizeSantaClaraParcelIdentifier("09241022"), "09241022");
  assert.equal(normalizeSantaClaraParcelIdentifier("689-58-007"), "68958007");
});

test("Santa Clara APN fails closed on missing or malformed identifiers", () => {
  assert.throws(() => normalizeSantaClaraParcelIdentifier(""), /malformed|missing/);
  assert.throws(() => normalizeSantaClaraParcelIdentifier(null), /missing/);
  assert.throws(() => normalizeSantaClaraParcelIdentifier(68958007), /text/);
  assert.throws(() => normalizeSantaClaraParcelIdentifier("12e4"), /malformed/);
  assert.throws(() => normalizeSantaClaraParcelIdentifier("123"), /malformed/);
});

test("active reroof fixture maps ArcGIS fields without inferring completion", async () => {
  const fixture = await loadFixture("sanjose-arcgis-active-reroof.json");
  const record = normalizeSanJoseArcgisFeature(fixture.features[0], {
    layer: {
      layerId: fixture.layerId,
      name: fixture.layerName,
      url: "https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_PermitsAndComplaints/MapServer/8",
    },
    requestedParcelIdentifier: "68958007",
    requestedPropertyId: PROPERTY_ID,
  });
  assert.equal(record.schemaVersion, "elephant.normalized-permit-record.v1");
  assert.equal(record.permit_number, "1997-068904-RS");
  assert.equal(record.parcel_identifier, "68958007");
  assert.equal(record.improvement_type, "ReRoof");
  assert.equal(record.isRoofPermit, true);
  assert.equal(record.permit_issue_date, "1997-10-22");
  assert.equal(record.final_inspection_date, null);
  assert.equal(record.completion_date, null);
  assert.equal(record.permit_close_date, null);
  assert.equal(record.contractors[0].businessName, "WESTSHORE ROOFING INC  Paul Fowler");
  assert.equal(record.contractors[0].licenseNumber, null);
  assert.equal(record.sourcePayload.rawApplicant, "NONE");
  assert.equal(record.sourcePayload.rawContractor, "WESTSHORE ROOFING INC  Paul Fowler");
  assert.equal(record.sourcePayload.identityEdges, false);
  assert.equal(record.property_id, PROPERTY_ID);
});

test("finalized reroof fixture keeps issue and final dates separate", async () => {
  const fixture = await loadFixture("sanjose-arcgis-finalized-reroof.json");
  const record = normalizeSanJoseArcgisFeature(fixture.features[0], {
    layer: {
      layerId: fixture.layerId,
      name: fixture.layerName,
      url: "https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_PermitsAndComplaints/MapServer/7",
    },
    requestedParcelIdentifier: "09241022",
    requestedPropertyId: null,
  });
  assert.equal(record.permit_number, "2026-135571-RS");
  assert.equal(record.parcel_identifier, "09241022");
  assert.equal(record.permit_issue_date, "2026-08-31");
  assert.equal(record.final_inspection_date, "2026-09-12");
  assert.equal(record.completion_date, null);
  assert.equal(record.permit_close_date, null);
  assert.equal(record.improvement_status, "B-Complete");
  assert.equal(record.estimated_job_value, 12801);
  assert.equal(record.isRoofPermit, true);
  assert.equal(record.sourcePayload.rawApplicant, "ESCARCEGA,MEL  JAMES ESCARCEGA");
});

test("APN mismatch fails closed", async () => {
  const fixture = await loadFixture("sanjose-arcgis-active-reroof.json");
  assert.throws(
    () =>
      normalizeSanJoseArcgisFeature(fixture.features[0], {
        requestedParcelIdentifier: "11111111",
      }),
    /differs from requested parcel/,
  );
});

test("searchParcel returns harvest references for the active reroof and empty for zero-result APN", async () => {
  const active = await loadFixture("sanjose-arcgis-active-reroof.json");
  const zero = await loadFixture("sanjose-arcgis-zero-result.json");
  const adapter = createSanJoseArcgisAdapter(sanJoseArcgisJurisdiction(), {
    client: fixtureClient({
      68958007: active,
      11111111: zero,
    }),
  });
  const hits = await adapter.searchParcel("689-58-007", {
    requestedPropertyId: PROPERTY_ID,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sourceRecordId, "1997-068904-RS");
  assert.equal(hits.reconciliation.returned, 1);
  const detail = await adapter.fetchPermitDetail(hits[0], {
    requestedParcelIdentifier: "68958007",
    requestedPropertyId: PROPERTY_ID,
  });
  assert.equal(detail.permit_number, "1997-068904-RS");
  assert.equal(detail.completion_date, null);

  const empty = await adapter.searchParcel("11111111");
  assert.equal(empty.length, 0);
  assert.equal(empty.reconciliation.returned, 0);
  assert.equal(empty.reconciliation.reported, 0);
});
