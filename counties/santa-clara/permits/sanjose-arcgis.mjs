/**
 * San Jose building-permit ArcGIS vendor module.
 *
 * Implements the bundled permit adapter search/detail contract
 * (`searchParcel`, `fetchPermitDetail`, `probe`) using
 * `elephant.normalized-permit-record.v1`.
 *
 * Not registered in runtime `src/permits/adapters/index.mjs`. Do not start
 * PermitFeed. CONTRACTOR/APPLICANT stay search-key text; no company/person edges.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { defaultRuntimeRoot } from "../seed.mjs";
import { normalizeSantaClaraParcelIdentifier } from "./apn.mjs";

const runtimeRoot = defaultRuntimeRoot();
const { createStablePermitId, normalizedPermitRecordSchema } = await import(
  pathToFileURL(path.join(runtimeRoot, "src/permits/contracts.mjs")).href
);
const { PermitSourceError } = await import(
  pathToFileURL(path.join(runtimeRoot, "src/permits/errors.mjs")).href
);
const { PermitHttpClient } = await import(
  pathToFileURL(path.join(runtimeRoot, "src/permits/http.mjs")).href
);
const { isRoofPermit, normalizeSourcePayload } = await import(
  pathToFileURL(path.join(runtimeRoot, "src/permits/normalization.mjs")).href
);

export const SAN_JOSE_ARCGIS_MAP_SERVER =
  "https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_PermitsAndComplaints/MapServer";

export const SAN_JOSE_BUILDING_PERMIT_LAYERS = Object.freeze([
  {
    layerId: 7,
    name: "Recent Building Permit (30 Days)",
    url: `${SAN_JOSE_ARCGIS_MAP_SERVER}/7`,
  },
  {
    layerId: 8,
    name: "Active Building Permit",
    url: `${SAN_JOSE_ARCGIS_MAP_SERVER}/8`,
  },
  {
    layerId: 9,
    name: "Expired Building Permit",
    url: `${SAN_JOSE_ARCGIS_MAP_SERVER}/9`,
  },
]);

export const SAN_JOSE_ARCGIS_FIELD_MAP = Object.freeze({
  permitNumber: "FOLDERNUM",
  permitType: "WORKDESC",
  status: "PERMITAPPROVAL",
  description: "WORKDESC",
  address: "ADDRESS",
  parcelIdentifier: "APN",
  issuedAt: "ISSUEDATE",
  completedAt: "FINALDATE",
  estimatedValue: "PERMITVALUE",
  contractorName: "CONTRACTOR",
  applicantName: "APPLICANT",
});

const COUNTY_KEY = "santa-clara";
const COUNTY_NAME = "Santa Clara";
const SOURCE_SYSTEM = "san_jose_arcgis_permits";
const DETAIL_FINGERPRINT_VERSION = "sanjose-arcgis-v1";

function stringValue(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function dateValue(value) {
  if (value == null || value === "") return null;
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

function moneyValue(value) {
  if (value == null || value === "") return null;
  const amount = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function queryUrl(layerUrl, parameters) {
  const url = new URL(`${layerUrl.replace(/\/+$/, "")}/query`);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function roofingFromSourceText(...values) {
  if (isRoofPermit(...values)) return true;
  return values.some((value) => /roof|reroof|re-roof|shingle/i.test(String(value ?? "")));
}

/**
 * One ArcGIS JSON query. Same URL shape as parcel search:
 * HTTPS `/query`, `f=json`, `returnGeometry=false`, `outFields`.
 * Caller parameters override those defaults (count queries pass `outFields=""`).
 */
export async function querySanJoseArcgisLayer(layer, parameters = {}, options = {}) {
  const httpClient =
    options.client ??
    new PermitHttpClient({
      minimumDelayMs: options.minimumDelayMs ?? 500,
      maxAttempts: options.maxAttempts ?? 4,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  const { body: payload } = await httpClient.json(
    queryUrl(layer.url, {
      f: "json",
      outFields: "*",
      returnGeometry: false,
      ...parameters,
    }),
  );
  if (payload.error) {
    throw new PermitSourceError(
      `ArcGIS query failed: ${payload.error.message ?? "unknown error"}`,
      {
        classification: "permanent",
        code: "arcgis_query_failed",
      },
    );
  }
  return payload;
}

export function sanJoseArcgisJurisdiction() {
  return {
    key: "san-jose",
    name: "San Jose",
    adapterKey: "arcgis-feature-service",
    adapterConfig: {
      sourceSystem: SOURCE_SYSTEM,
      layerUrl: SAN_JOSE_BUILDING_PERMIT_LAYERS[1].url,
      objectIdField: "OBJECTID",
      parcelField: "APN",
      fieldMap: { ...SAN_JOSE_ARCGIS_FIELD_MAP },
      detailFingerprintVersion: DETAIL_FINGERPRINT_VERSION,
    },
  };
}

export function normalizeSanJoseArcgisFeature(
  feature,
  {
    jurisdiction = sanJoseArcgisJurisdiction(),
    layer,
    requestedParcelIdentifier,
    requestedPropertyId = null,
  },
) {
  const attributes = feature?.attributes ?? {};
  const permitNumber = stringValue(attributes.FOLDERNUM);
  if (!permitNumber) {
    throw new PermitSourceError("San Jose ArcGIS feature has no FOLDERNUM", {
      classification: "permanent",
      code: "arcgis_missing_permit_key",
    });
  }

  const sourceApnRaw = attributes.APN;
  if (sourceApnRaw == null || String(sourceApnRaw).trim() === "") {
    throw new PermitSourceError("San Jose ArcGIS feature is missing APN", {
      classification: "permanent",
      code: "arcgis_parcel_mismatch",
    });
  }
  const sourceParcelIdentifier = normalizeSantaClaraParcelIdentifier(sourceApnRaw);
  const requested = normalizeSantaClaraParcelIdentifier(requestedParcelIdentifier);
  if (sourceParcelIdentifier !== requested) {
    throw new PermitSourceError(
      `ArcGIS feature parcel ${sourceParcelIdentifier} differs from requested parcel ${requested}`,
      {
        classification: "permanent",
        code: "arcgis_parcel_mismatch",
      },
    );
  }

  const workDesc = stringValue(attributes.WORKDESC);
  const subDesc = stringValue(attributes.SUBDESC);
  const description = [workDesc, subDesc].filter(Boolean).join(" | ");
  const issuedDate =
    dateValue(attributes.ISSUEDATEUTC) ?? dateValue(attributes.ISSUEDATE);
  const finalDate =
    dateValue(attributes.FINALDATEUTC) ?? dateValue(attributes.FINALDATE);
  const contractorName = stringValue(attributes.CONTRACTOR);
  const applicantName = stringValue(attributes.APPLICANT);
  const layerUrl = layer?.url ?? SAN_JOSE_BUILDING_PERMIT_LAYERS[1].url;

  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey: COUNTY_KEY,
      jurisdictionKey: jurisdiction.key,
      sourceRecordId: permitNumber,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: requested,
    permit_number: permitNumber,
    improvement_type: workDesc,
    improvement_status: stringValue(attributes.PERMITAPPROVAL),
    improvement_action: null,
    permit_issue_date: issuedDate,
    application_received_date: null,
    final_inspection_date: finalDate,
    permit_close_date: null,
    completion_date: null,
    expiration_date: null,
    opened_date: null,
    source_system: SOURCE_SYSTEM,
    county_name: COUNTY_NAME,
    project_description: description || null,
    description: description || null,
    estimated_job_value: moneyValue(attributes.PERMITVALUE),
    fee: null,
    countyKey: COUNTY_KEY,
    jurisdictionKey: jurisdiction.key,
    sourceRecordId: permitNumber,
    sourceUrl: layerUrl,
    requestedParcelIdentifier: requested,
    requestedPropertyId,
    workAddress: stringValue(attributes.ADDRESS),
    isRoofPermit: roofingFromSourceText(workDesc, subDesc, description),
    contractors: contractorName
      ? [
          {
            businessName: contractorName,
            licenseNumber: null,
            qualifierName: null,
            sourceRole: "contractor",
            phone: null,
            email: null,
          },
        ]
      : [],
    inspections: [],
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      attributes,
      rawApplicant: applicantName,
      rawContractor: contractorName,
      sourceParcelIdentifier,
      layerId: layer?.layerId ?? null,
      layerName: layer?.name ?? null,
      detailFingerprintVersion: DETAIL_FINGERPRINT_VERSION,
      identityEdges: false,
    }),
  });
}

export function createSanJoseArcgisAdapter(jurisdiction, options = {}) {
  const resolved = jurisdiction ?? sanJoseArcgisJurisdiction();
  const layers = options.layers ?? SAN_JOSE_BUILDING_PERMIT_LAYERS;
  const httpClient =
    options.client ??
    new PermitHttpClient({
      minimumDelayMs: options.minimumDelayMs ?? 500,
      maxAttempts: options.maxAttempts ?? 4,
      timeoutMs: options.timeoutMs ?? 60_000,
    });

  async function executeQuery(layer, parameters) {
    return querySanJoseArcgisLayer(layer, parameters, { client: httpClient });
  }

  return {
    key: "arcgis-feature-service",
    async probe() {
      const payload = await executeQuery(layers[1], {
        where: "1=1",
        returnCountOnly: true,
        outFields: "",
      });
      return {
        status: "ready",
        ok: true,
        count: payload.count ?? null,
        parcelSearch: true,
      };
    },

    async searchParcel(parcelIdentifier, request = {}) {
      const requestedParcelIdentifier =
        normalizeSantaClaraParcelIdentifier(parcelIdentifier);
      const where = `APN = ${sqlLiteral(requestedParcelIdentifier)}`;
      const references = [];
      let reported = 0;
      for (const layer of layers) {
        const countPayload = await executeQuery(layer, {
          where,
          returnCountOnly: true,
          outFields: "",
        });
        const count = Number.isInteger(countPayload.count) ? countPayload.count : 0;
        reported += count;
        const payload = await executeQuery(layer, {
          where,
          resultRecordCount: Math.max(count, 1),
          orderByFields: "OBJECTID ASC",
        });
        const features = payload.features ?? [];
        for (const feature of features) {
          const record = normalizeSanJoseArcgisFeature(feature, {
            jurisdiction: resolved,
            layer,
            requestedParcelIdentifier,
            requestedPropertyId: request.requestedPropertyId ?? null,
          });
          references.push({
            sourceRecordId: record.sourceRecordId,
            permitNumber: record.permit_number,
            sourceUrl: layer.url,
            layerId: layer.layerId,
            feature,
            requestedParcelIdentifier,
            requestedPropertyId: request.requestedPropertyId ?? null,
          });
        }
      }
      const unique = [
        ...new Map(references.map((row) => [row.sourceRecordId, row])).values(),
      ];
      return Object.assign(unique, {
        reconciliation: {
          returned: unique.length,
          reported,
          truncated: unique.length < reported,
        },
      });
    },

    async fetchPermitDetail(reference, request = {}) {
      return normalizeSanJoseArcgisFeature(reference.feature, {
        jurisdiction: resolved,
        layer: layers.find((row) => row.layerId === reference.layerId) ?? {
          layerId: reference.layerId,
          name: null,
          url: reference.sourceUrl,
        },
        requestedParcelIdentifier:
          request.requestedParcelIdentifier ?? reference.requestedParcelIdentifier,
        requestedPropertyId:
          request.requestedPropertyId ?? reference.requestedPropertyId ?? null,
      });
    },
  };
}
