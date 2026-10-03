/**
 * Santa Clara query-table mapping. Parquet schema is loaded from the
 * bundled Pinellas schema so writeQueryTableParquet stays on the existing path.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { normalizeSantaClaraParcelIdentifier } from "./permits/apn.mjs";
import { defaultRuntimeRoot } from "./seed.mjs";

export const SOURCE_SYSTEM = "santa_clara_gis";
export const COUNTY_KEY = "santa-clara";
export const COUNTY_NAME = "Santa Clara";
export const STATE_CODE = "CA";

export function santaClaraPropertyId(parcelId) {
  return createHash("sha256").update(`${SOURCE_SYSTEM}:${parcelId}`).digest("hex").slice(0, 32);
}

function toText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value) {
  const parsed = toNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

/**
 * Roof-age columns only. These names are the CRM snapshot fields that match
 * the query-table roof-age columns, plus builtYear and olderThan15Years.
 * This schema is not the full county query table.
 */
export const ROOF_AGE_TABLE_SCHEMA_FIELDS = Object.freeze({
  parcel_identifier: { type: "UTF8" },
  builtYear: { type: "INT64", optional: true },
  roof_date: { type: "UTF8", optional: true },
  roof_age_years: { type: "INT64", optional: true },
  roof_age_source: { type: "UTF8", optional: true },
  roof_age_confidence: { type: "UTF8", optional: true },
  roof_age_permit_id: { type: "UTF8", optional: true },
  roof_age_eligibility_reason: { type: "UTF8", optional: true },
  olderThan15Years: { type: "BOOLEAN" },
});

/**
 * Map one in-memory roof-age snapshot parcel onto a query row.
 * The row is keyed by the undashed APN. This function does not read zips.
 */
export function mapRoofAgeSnapshotParcelToQueryRow(parcel) {
  if (parcel == null || typeof parcel !== "object") {
    throw new Error("roof-age snapshot parcel must be an object");
  }
  const parcelIdentifier = normalizeSantaClaraParcelIdentifier(parcel.parcel_identifier);
  if (parcel.olderThan15Years !== true && parcel.olderThan15Years !== false) {
    throw new Error(`${parcelIdentifier} olderThan15Years must be boolean`);
  }
  return {
    parcel_identifier: parcelIdentifier,
    builtYear: toInteger(parcel.builtYear),
    roof_date: toText(parcel.roof_date),
    roof_age_years: toInteger(parcel.roof_age_years),
    roof_age_source: toText(parcel.roof_age_source),
    roof_age_confidence: toText(parcel.roof_age_confidence),
    roof_age_permit_id: toText(parcel.roof_age_permit_id),
    roof_age_eligibility_reason: toText(parcel.roof_age_eligibility_reason),
    olderThan15Years: parcel.olderThan15Years,
  };
}

export async function loadQueryTableSchemaFields(runtimeRoot = defaultRuntimeRoot()) {
  const pinellas = await import(pathToFileURL(path.join(runtimeRoot, "src/counties/pinellas/query-table.mjs")).href);
  return pinellas.QUERY_TABLE_SCHEMA_FIELDS;
}

export async function mapTransformedFilesToQueryTableRow({
  parcelId,
  files,
  seedRow = null,
  roofAgeLineage = null,
  runtimeRoot = defaultRuntimeRoot(),
}) {
  const queryTable = await import(pathToFileURL(path.join(runtimeRoot, "src/core/query-table.mjs")).href);
  const address = await import(pathToFileURL(path.join(runtimeRoot, "src/core/address-signature.mjs")).href);
  const roofAge = await import(pathToFileURL(path.join(runtimeRoot, "src/roof-age/integration.ts")).href);
  const property = files["property.json"] ?? {};
  const addressRecord = files["address.json"] ?? {};
  const unnormalized = files["unnormalized_address.json"] ?? {};
  const lot = files["lot.json"] ?? {};
  const situsText =
    toText(unnormalized.full_address) ??
    toText(addressRecord.unnormalized_address) ??
    toText(seedRow?.situs_address);
  const parsed = queryTable.parseUnnormalizedAddress(situsText);
  const addressStreet = parsed.street ?? toText(addressRecord.street_name);
  const addressZip = parsed.postalCode ?? toText(seedRow?.situs_zip_code) ?? toText(addressRecord.postal_code);
  const identity = address.mintSitusAddressIdentity({
    state: STATE_CODE,
    postalCode: addressZip,
    street: addressStreet,
  });
  const lotAreaSqft = toNumber(lot.lot_area_sqft);
  const geometry = files["geometry.json"] ?? {};
  return {
    property_id: santaClaraPropertyId(parcelId),
    property_cid: null,
    request_identifier: parcelId,
    parcel_identifier: toText(property.parcel_identifier) ?? toText(files["parcel.json"]?.parcel_identifier) ?? parcelId,
    source_system: SOURCE_SYSTEM,
    county_name: COUNTY_NAME,
    state_code: STATE_CODE,
    address_street: addressStreet,
    address_city: parsed.city ?? toText(seedRow?.situs_city_name) ?? toText(addressRecord.city),
    address_zip: addressZip,
    elephant_uuid: identity?.elephantUuid ?? null,
    elephant_token: identity?.elephantToken ?? null,
    latitude: toNumber(geometry.latitude) ?? toNumber(seedRow?.latitude),
    longitude: toNumber(geometry.longitude) ?? toNumber(seedRow?.longitude),
    lot_size_acre: lotAreaSqft !== null ? lotAreaSqft / 43_560 : null,
    lot_area_sqft: lotAreaSqft,
    exterior_wall_material: null,
    roof_covering_material: null,
    ...roofAge.roofAgeQueryFields(
      roofAgeLineage
        ? {
            roof_date: roofAgeLineage.roofDate ?? null,
            roof_age_years: roofAgeLineage.roofAgeYears ?? null,
            source_payload: { roof_age_lineage: roofAgeLineage },
          }
        : {},
    ),
    property_type: toText(property.property_type),
    property_usage_type: toText(property.property_usage_type),
    ownership_estate_type: toText(property.ownership_estate_type),
    built_year: toInteger(property.property_structure_built_year),
    livable_floor_area: toNumber(property.livable_floor_area),
    total_area: toNumber(property.total_area),
    assessed_value: null,
    market_value: null,
    land_value: null,
    avm_value: null,
    owner_name: null,
    owners_text: null,
    owner_count: null,
    owner_occupied: null,
    last_sale_date: null,
    last_sale_price: null,
    subdivision: null,
    has_permits: false,
    permit_count: 0,
    has_sunbiz_tenant: false,
    has_bbb_contractor: false,
    hoa_flag: null,
    hoa_cid: null,
    hoa_name: null,
    hoa_sunbiz_document_number: null,
    property_manager_cid: null,
    property_manager_name: null,
    property_manager_sunbiz_document_number: null,
    hoa_pm_status: null,
  };
}
