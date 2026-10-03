/**
 * Bounded San Jose ReRoof roof-age extract.
 *
 * Queries ArcGIS building-permit layers 7, 8, and 9 for exact WORKDESC = 'ReRoof',
 * normalizes every feature, and estimates one roof age per undashed APN.
 * Writes the tracked snapshot the CRM can read without a network call.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeSantaClaraParcelIdentifier } from "../counties/santa-clara/permits/apn.mjs";
import {
  SAN_JOSE_ROOF_AGE_AS_OF_DATE,
  estimateParcelRoofAge,
} from "../counties/santa-clara/permits/roof-age.mjs";
import {
  SAN_JOSE_BUILDING_PERMIT_LAYERS,
  normalizeSanJoseArcgisFeature,
  querySanJoseArcgisLayer,
} from "../counties/santa-clara/permits/sanjose-arcgis.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(
  ROOT,
  "fixtures",
  "santa-clara-permits",
  "san-jose-reroof-roof-age.json",
);

const WHERE = "WORKDESC = 'ReRoof'";
const PAGE_SIZE = 2000;
const MAX_PAGES = 20;

const PROOF = {
  "09241022": {
    roof_date: "2026-09-12",
    roof_age_years: 0,
    roof_age_confidence: "high",
    roof_age_permit_id: "2026-135571-RS",
    roof_age_eligibility_reason: "accepted_completed_primary_roof_replacement",
    olderThan15Years: false,
  },
  "68958007": {
    roof_date: null,
    roof_age_years: null,
    roof_age_permit_id: null,
    roof_age_eligibility_reason: "no_valid_anchor",
    olderThan15Years: false,
  },
  "67620085": {
    roof_date: "2010-06-01",
    roof_age_years: 16,
    roof_age_confidence: "high",
    roof_age_permit_id: "2010-012446-RS",
    roof_age_eligibility_reason: "accepted_completed_primary_roof_replacement",
    olderThan15Years: true,
  },
};

function sharedClient() {
  return {
    minimumDelayMs: 250,
    maxAttempts: 4,
    timeoutMs: 120_000,
  };
}

async function fetchReRoofLayer(layer) {
  const clientOptions = sharedClient();
  const features = [];
  const pages = [];
  const seen = new Set();
  let offset = 0;
  for (;;) {
    const payload = await querySanJoseArcgisLayer(
      layer,
      {
        where: WHERE,
        resultOffset: offset,
        resultRecordCount: PAGE_SIZE,
        orderByFields: "OBJECTID ASC",
      },
      clientOptions,
    );
    const page = payload.features ?? [];
    const exceeded = payload.exceededTransferLimit === true;
    let added = 0;
    for (const feature of page) {
      const objectId = feature?.attributes?.OBJECTID;
      const key = `${layer.layerId}:${objectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push(feature);
      added += 1;
    }
    pages.push({
      resultOffset: offset,
      returned: page.length,
      added,
      exceededTransferLimit: exceeded,
    });
    console.error(
      `layer ${layer.layerId} offset ${offset} returned ${page.length} exceededTransferLimit ${exceeded}`,
    );
    if (!exceeded) break;
    if (page.length === 0) {
      throw new Error(
        `layer ${layer.layerId} reported exceededTransferLimit with an empty page at offset ${offset}`,
      );
    }
    offset += page.length;
    if (pages.length > MAX_PAGES) {
      throw new Error(`layer ${layer.layerId} exceeded the ${MAX_PAGES} page bound`);
    }
  }
  return { features, pages };
}

function summaryRow(result) {
  const fields = result.queryFields;
  return {
    parcel_identifier: result.parcelIdentifier,
    builtYear: null,
    roof_date: fields.roof_date,
    roof_age_years: fields.roof_age_years,
    roof_age_source: fields.roof_age_source,
    roof_age_confidence: fields.roof_age_confidence,
    roof_age_permit_id: fields.roof_age_permit_id,
    roof_age_eligibility_reason: fields.roof_age_eligibility_reason,
    olderThan15Years: result.olderThanThreshold,
  };
}

function assertRowShape(row) {
  if (row.builtYear !== null) {
    throw new Error(`${row.parcel_identifier} builtYear must stay null`);
  }
  if (
    row.roof_age_eligibility_reason !== "accepted_completed_primary_roof_replacement" &&
    row.roof_age_eligibility_reason !== "no_valid_anchor"
  ) {
    throw new Error(
      `${row.parcel_identifier} unexpected eligibility ${row.roof_age_eligibility_reason}`,
    );
  }
  if (normalizeSantaClaraParcelIdentifier(row.parcel_identifier) !== row.parcel_identifier) {
    throw new Error(`${row.parcel_identifier} is not an undashed APN`);
  }
}

function assertProof(parcels) {
  for (const [apn, expected] of Object.entries(PROOF)) {
    const row = parcels[apn];
    if (!row) throw new Error(`proof APN ${apn} missing from extract`);
    for (const [field, value] of Object.entries(expected)) {
      if (row[field] !== value) {
        throw new Error(`${apn} ${field} ${JSON.stringify(row[field])} !== ${JSON.stringify(value)}`);
      }
    }
  }
}

const permitsByApn = new Map();
const layersByApn = new Map();
const layerStats = [];
let featureCount = 0;
let unkeyedMissingApn = 0;

for (const layer of SAN_JOSE_BUILDING_PERMIT_LAYERS) {
  const { features, pages } = await fetchReRoofLayer(layer);
  featureCount += features.length;
  let normalized = 0;
  for (const feature of features) {
    let record;
    try {
      record = normalizeSanJoseArcgisFeature(feature, {
        layer,
        requestedParcelIdentifier: feature?.attributes?.APN,
        requestedPropertyId: null,
      });
    } catch (error) {
      if (error?.code === "arcgis_parcel_mismatch" || error?.code === "invalid_parcel_identifier") {
        unkeyedMissingApn += 1;
        continue;
      }
      throw error;
    }
    if (record.improvement_type !== "ReRoof") {
      throw new Error(
        `${record.permit_number} improvement_type ${JSON.stringify(record.improvement_type)} is not exact ReRoof`,
      );
    }
    const bucket = permitsByApn.get(record.parcel_identifier) ?? [];
    bucket.push(record);
    permitsByApn.set(record.parcel_identifier, bucket);
    const layerIds = layersByApn.get(record.parcel_identifier) ?? new Set();
    layerIds.add(layer.layerId);
    layersByApn.set(record.parcel_identifier, layerIds);
    normalized += 1;
  }
  layerStats.push({
    layerId: layer.layerId,
    name: layer.name,
    url: layer.url,
    featureCount: features.length,
    normalizedCount: normalized,
    pages,
  });
}

const apns = [...permitsByApn.keys()].sort();
const parcels = {};
let validRoofAgeAnchors = 0;
let olderThan15Years = 0;
let noValidAnchor = 0;

for (let index = 0; index < apns.length; index += 1) {
  const parcelIdentifier = apns[index];
  const result = await estimateParcelRoofAge({
    parcelIdentifier,
    permits: permitsByApn.get(parcelIdentifier),
    asOfDate: SAN_JOSE_ROOF_AGE_AS_OF_DATE,
  });
  const row = summaryRow(result);
  assertRowShape(row);
  parcels[parcelIdentifier] = row;
  if (row.roof_age_eligibility_reason === "accepted_completed_primary_roof_replacement") {
    validRoofAgeAnchors += 1;
  } else {
    noValidAnchor += 1;
  }
  if (row.olderThan15Years) olderThan15Years += 1;
  if ((index + 1) % 500 === 0 || index + 1 === apns.length) {
    console.error(`estimated ${index + 1}/${apns.length}`);
  }
}

assertProof(parcels);

const snapshot = {
  collectionMethod:
    "San Jose ArcGIS MapServer HTTPS JSON query on building-permit layers 7, 8, and 9. where WORKDESC = 'ReRoof', returnGeometry false, outFields *, ordered by OBJECTID, paged with resultOffset and resultRecordCount until exceededTransferLimit is false. Each feature is normalizeSanJoseArcgisFeature. All normalized ReRoof permits for one undashed APN go into one estimateParcelRoofAge call. FINALDATE is the terminal date. builtYear is null. Issue date is not a roof age.",
  layerIds: SAN_JOSE_BUILDING_PERMIT_LAYERS.map((layer) => layer.layerId),
  asOfDate: SAN_JOSE_ROOF_AGE_AS_OF_DATE,
  where: WHERE,
  returnGeometry: false,
  pageSize: PAGE_SIZE,
  layers: layerStats,
  counts: {
    features: featureCount,
    unkeyedMissingApn,
    apns: apns.length,
    apnsOnMultipleLayers: [...layersByApn.values()].filter((layerIds) => layerIds.size > 1).length,
    validRoofAgeAnchors,
    olderThan15Years,
    noValidAnchor,
  },
  parcels,
};

await writeFile(OUTPUT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.error(`wrote ${OUTPUT}`);
console.log(
  JSON.stringify(
    {
      output: OUTPUT,
      counts: snapshot.counts,
      proof: Object.fromEntries(
        Object.keys(PROOF).map((apn) => [apn, parcels[apn]]),
      ),
    },
    null,
    2,
  ),
);
