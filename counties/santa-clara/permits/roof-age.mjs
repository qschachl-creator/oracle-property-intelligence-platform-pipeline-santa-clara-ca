/**
 * San Jose roof-age proof. Source vocabulary is mapped into the bundled
 * estimator. FINALDATE is the only terminal date, via the normalized
 * final_inspection_date field. Issue dates are chronology only. Year built
 * is passed as null.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { defaultRuntimeRoot } from "../seed.mjs";
import {
  SAN_JOSE_BUILDING_PERMIT_LAYERS,
  normalizeSanJoseArcgisFeature,
} from "./sanjose-arcgis.mjs";

export const SAN_JOSE_ROOF_AGE_AS_OF_DATE = "2026-10-01";
export const SAN_JOSE_ROOF_AGE_THRESHOLD_YEARS = 15;
export const SAN_JOSE_ROOF_AGE_SOURCE_SYSTEM = "san_jose_arcgis_permits";

/** Exact PERMITAPPROVAL values observed on ReRoof rows with FINALDATE. */
export const SAN_JOSE_ROOF_AGE_PROFILE = Object.freeze({
  version: "santa-clara-san-jose-arcgis-roof-profile-v1",
  sources: [
    {
      sourceSystem: SAN_JOSE_ROOF_AGE_SOURCE_SYSTEM,
      statusMappings: [
        { field: "improvement_status", value: "B-Complete", status: "completed" },
        { field: "improvement_status", value: "B-4. Complete", status: "completed" },
      ],
      workMappings: [
        {
          field: "improvement_type",
          value: "ReRoof",
          classification: "primary_roof_replacement",
        },
      ],
    },
  ],
});

/** San Jose is one of 16 jurisdictions, so permit history is partial. */
export const SAN_JOSE_ROOF_AGE_COVERAGE = Object.freeze({
  state: "partial",
  caveats: ["partial_history"],
});

/**
 * Live layer check on 2026-10-01.
 * where: WORKDESC = 'ReRoof' AND FINALDATE IS NOT NULL AND FINALDATE < DATE '2011-10-01'
 * Layers 7 and 8 returned 0. Layer 9 returned 5.
 */
export const SAN_JOSE_OLDER_ROOF_LAYER_CHECK = Object.freeze({
  asOfDate: SAN_JOSE_ROOF_AGE_AS_OF_DATE,
  thresholdYears: SAN_JOSE_ROOF_AGE_THRESHOLD_YEARS,
  layers: SAN_JOSE_BUILDING_PERMIT_LAYERS.map((layer) => layer.layerId),
  where: "WORKDESC = 'ReRoof' AND FINALDATE IS NOT NULL AND FINALDATE < DATE '2011-10-01'",
  counts: { 7: 0, 8: 0, 9: 5 },
  found: true,
  proofParcelIdentifier: "67620085",
});

async function loadRoofAgeRuntime(runtimeRoot) {
  const estimator = await import(
    pathToFileURL(path.join(runtimeRoot, "src/roof-age/estimator.ts")).href
  );
  const integration = await import(
    pathToFileURL(path.join(runtimeRoot, "src/roof-age/integration.ts")).href
  );
  return { estimator, integration };
}

/**
 * FINALDATE is already normalized to final_inspection_date.
 * The estimator accepts only completionDate or closeDate as a terminal date,
 * so the final date is placed on completionDate. permit_issue_date is not
 * copied onto either terminal field.
 */
export function normalizedPermitToRoofAgeRow(record) {
  const finalDate = record.final_inspection_date ?? null;
  const closeDate = record.permit_close_date ?? null;
  return {
    sourceSystem: record.source_system,
    sourceRecordId: record.sourceRecordId,
    improvementStatus: record.improvement_status,
    improvementType: record.improvement_type,
    completionDate: finalDate,
    closeDate,
    issueDate: record.permit_issue_date ?? null,
    sourcePayload: {
      terminalDateSourceField: "FINALDATE",
      normalizedTerminalField: "final_inspection_date",
      roofAgeEvidenceStates: {
        completionDate: finalDate ? "confirmed_present" : "confirmed_empty",
        closeDate: closeDate ? "confirmed_present" : "confirmed_empty",
      },
    },
  };
}

export function isOlderThanThreshold(estimate, thresholdYears = SAN_JOSE_ROOF_AGE_THRESHOLD_YEARS) {
  return (
    estimate.eligibility.eligible === true &&
    estimate.anchor?.type === "permit_terminal_date" &&
    Number.isInteger(estimate.estimatedAgeYears) &&
    estimate.estimatedAgeYears >= thresholdYears
  );
}

export async function estimateParcelRoofAge({
  parcelIdentifier,
  permits,
  asOfDate = SAN_JOSE_ROOF_AGE_AS_OF_DATE,
  runtimeRoot = defaultRuntimeRoot(),
}) {
  const { estimator, integration } = await loadRoofAgeRuntime(runtimeRoot);
  const rows = permits.map(normalizedPermitToRoofAgeRow);
  const historicalCoverage = {
    state: SAN_JOSE_ROOF_AGE_COVERAGE.state,
    caveats: [...SAN_JOSE_ROOF_AGE_COVERAGE.caveats],
  };
  const estimate = estimator.estimateRoofAge(
    {
      asOfDate,
      builtYear: null,
      permits: rows.map(integration.permitRowToRoofAgeEvidence),
      historicalCoverage,
    },
    SAN_JOSE_ROOF_AGE_PROFILE,
  );
  const lineage = integration.resolveCanonicalRoofAge(
    {
      propertyId: parcelIdentifier,
      structureId: null,
      sourceSystem: SAN_JOSE_ROOF_AGE_SOURCE_SYSTEM,
      sourceRecordId: parcelIdentifier,
      builtYear: null,
      roofDate: null,
      roofAgeYears: null,
      sourcePayload: null,
      permits: rows,
    },
    {
      asOfDate,
      historicalCoverage,
      profile: SAN_JOSE_ROOF_AGE_PROFILE,
    },
  );
  const queryFields = integration.roofAgeQueryFields({
    roof_date: lineage.roofDate,
    roof_age_years: lineage.roofAgeYears,
    source_payload: { roof_age_lineage: lineage },
  });
  return {
    parcelIdentifier,
    estimate,
    lineage,
    queryFields,
    olderThanThreshold: isOlderThanThreshold(estimate),
  };
}

export function normalizeFixtureFeature(fixture) {
  const layer =
    SAN_JOSE_BUILDING_PERMIT_LAYERS.find((row) => row.layerId === fixture.layerId) ?? {
      layerId: fixture.layerId,
      name: fixture.layerName,
      url: `https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_PermitsAndComplaints/MapServer/${fixture.layerId}`,
    };
  const feature = fixture.features[0];
  return normalizeSanJoseArcgisFeature(feature, {
    layer,
    requestedParcelIdentifier: feature.attributes.APN,
    requestedPropertyId: null,
  });
}
