const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const WORKING_DIR = process.cwd();
const DATA_DIR = path.join(WORKING_DIR, "data");
const MANIFEST_URL = process.env.ELEPHANT_SCHEMA_MANIFEST_URL || "https://lexicon.elephant.xyz/api/manifest";

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(WORKING_DIR, fileName), "utf8"));
}

function writeData(fileName, record) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, fileName), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function fetchJson(url) {
  const body = execFileSync("curl", ["-fsS", "--max-time", "60", url], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(body);
}

function loadGisRecord() {
  const raw = fs.readFileSync(path.join(WORKING_DIR, "input.html"), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Santa Clara GIS capture is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record || typeof record !== "object") {
    throw new Error("Santa Clara GIS capture is empty");
  }
  return record;
}

function cleanSourceHttpRequest(sourceHttpRequest) {
  if (!sourceHttpRequest || typeof sourceHttpRequest !== "object") {
    throw new Error("property_seed.json is missing source_http_request");
  }
  const cleaned = {
    method: sourceHttpRequest.method || "GET",
    url: sourceHttpRequest.url,
  };
  if (sourceHttpRequest.multiValueQueryString) {
    cleaned.multiValueQueryString = sourceHttpRequest.multiValueQueryString;
  }
  return cleaned;
}

function text(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rel(fromFile, toFile) {
  return { from: { "/": `./${fromFile}` }, to: { "/": `./${toFile}` } };
}

function link(fileName) {
  return { "/": `./${fileName}` };
}

function selectRequestsTheGeom(sourceHttpRequest) {
  const raw = sourceHttpRequest?.multiValueQueryString?.$select;
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  for (const value of values) {
    for (const field of String(value).split(",")) {
      if (field.trim() === "the_geom") return true;
    }
  }
  return false;
}

function parseTheGeom(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("GIS the_geom is empty");
    return JSON.parse(trimmed);
  }
  if (value && typeof value === "object") return value;
  throw new Error("GIS the_geom is not GeoJSON");
}

function coordinateInRange(longitude, latitude) {
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function pushPosition(positions, pair) {
  if (!Array.isArray(pair) || pair.length < 2) return;
  const longitude = Number(pair[0]);
  const latitude = Number(pair[1]);
  if (!coordinateInRange(longitude, latitude)) return;
  positions.push([longitude, latitude]);
}

function walkPositions(geometry, positions) {
  if (!geometry || typeof geometry !== "object") {
    throw new Error("GIS the_geom is not GeoJSON");
  }
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  if (type === "Point") {
    pushPosition(positions, coordinates);
  } else if (type === "MultiPoint" || type === "LineString") {
    for (const pair of coordinates || []) pushPosition(positions, pair);
  } else if (type === "MultiLineString" || type === "Polygon") {
    for (const line of coordinates || []) {
      for (const pair of line || []) pushPosition(positions, pair);
    }
  } else if (type === "MultiPolygon") {
    for (const polygon of coordinates || []) {
      for (const ring of polygon || []) {
        for (const pair of ring || []) pushPosition(positions, pair);
      }
    }
  } else if (type === "GeometryCollection") {
    for (const child of geometry.geometries || []) walkPositions(child, positions);
  } else {
    throw new Error(`Unsupported GIS the_geom type ${String(type)}`);
  }
}

function exteriorRings(geometry, rings) {
  if (!geometry || typeof geometry !== "object") return;
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  if (type === "Polygon" && Array.isArray(coordinates) && Array.isArray(coordinates[0])) {
    rings.push(coordinates[0]);
  } else if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    for (const polygon of coordinates) {
      if (Array.isArray(polygon) && Array.isArray(polygon[0])) rings.push(polygon[0]);
    }
  } else if (type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    for (const child of geometry.geometries) exteriorRings(child, rings);
  }
}

function ringToPolygon(ring) {
  const points = [];
  for (const pair of ring || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const longitude = Number(pair[0]);
    const latitude = Number(pair[1]);
    if (!coordinateInRange(longitude, latitude)) continue;
    points.push({ latitude, longitude });
  }
  return points.length >= 3 ? points : null;
}

// No representative-point helper exists in this repo. latitude/longitude are
// the bounding-box center of every the_geom coordinate. GeoJSON order is
// longitude, latitude. polygon is the exterior ring with the most vertices
// (holes stay out of that ring). Lexicon geometry: latitude/longitude
// number|null, polygon optional minItems 3.
function geometryRecordFromTheGeom(theGeom, sourceHttpRequest, requestIdentifier) {
  const geometry = parseTheGeom(theGeom);
  const positions = [];
  walkPositions(geometry, positions);
  if (positions.length === 0) {
    throw new Error("GIS the_geom did not contain in-range coordinates");
  }
  let minLongitude = Infinity;
  let maxLongitude = -Infinity;
  let minLatitude = Infinity;
  let maxLatitude = -Infinity;
  for (const [longitude, latitude] of positions) {
    if (longitude < minLongitude) minLongitude = longitude;
    if (longitude > maxLongitude) maxLongitude = longitude;
    if (latitude < minLatitude) minLatitude = latitude;
    if (latitude > maxLatitude) maxLatitude = latitude;
  }
  const rings = [];
  exteriorRings(geometry, rings);
  let polygon = null;
  for (const ring of rings) {
    const candidate = ringToPolygon(ring);
    if (candidate && (polygon == null || candidate.length > polygon.length)) polygon = candidate;
  }
  const record = {
    latitude: (minLatitude + maxLatitude) / 2,
    longitude: (minLongitude + maxLongitude) / 2,
    source_http_request: sourceHttpRequest,
    request_identifier: requestIdentifier,
  };
  if (polygon) record.polygon = polygon;
  return record;
}

const gis = loadGisRecord();
const propertySeed = readJson("property_seed.json");
const unnormalizedAddress = readJson("unnormalized_address.json");
const apn = String(gis.apn ?? "").trim();
const seedApn = String(propertySeed.parcel_id ?? "").trim();
if (!apn) throw new Error("GIS record is missing apn");
if (apn !== seedApn) {
  throw new Error(`GIS apn ${apn} does not match seed parcel_id ${seedApn}`);
}

const sourceHttpRequest = cleanSourceHttpRequest(propertySeed.source_http_request);
const requestIdentifier = propertySeed.request_identifier || apn;

const manifest = fetchJson(MANIFEST_URL);
if (!manifest?.County?.ipfsCid || !manifest?.Seed?.ipfsCid) {
  throw new Error(`Live lexicon manifest at ${MANIFEST_URL} is missing County/Seed data-group CIDs`);
}
const countyGroupCid = manifest.County.ipfsCid;
const seedGroupCid = manifest.Seed.ipfsCid;

// GIS extras with no live class property (additionalProperties: false, no
// source_payload on property/parcel/lot/address): objectid (geometry_join_key
// only; not a geometry field), tax_rate_area,
// jurisdiction, number_of_situs_address, shape_length, shape_area,
// situs_house_number(_suffix), situs_street_direction/name/type, situs_unit_number.
// City/state/ZIP map onto the Address unnormalized branch.
// Do not map shape_area to lot_area_sqft: Socrata column metadata has no unit;
// ArcGIS SCCProperty/0 geometryProperties.units is esriMeters (wkid 9001) for
// the published Web Mercator geometry, which does not prove the stored
// Shape_Area attribute unit. Do not invent Assessor use codes, owners, or values.

const zipRaw = text(gis.situs_zip_code);
let postalCode = zipRaw;
let plusFour = null;
if (zipRaw && /^\d{5}-\d{4}$/.test(zipRaw)) {
  postalCode = zipRaw.slice(0, 5);
  plusFour = zipRaw.slice(6);
}

// Live property class requires property_type (string enum, not null) and forbids
// source_payload. GIS does not publish Assessor use/ownership/value. LandParcel
// is the cadastral-parcel class for this GIS polygon, not an Assessor use code.
writeData("property.json", {
  parcel_identifier: apn,
  property_legal_description_text: null,
  property_type: "LandParcel",
  source_http_request: sourceHttpRequest,
  request_identifier: requestIdentifier,
});

writeData("parcel.json", {
  parcel_identifier: apn,
  source_http_request: sourceHttpRequest,
  request_identifier: requestIdentifier,
});

// Address oneOf unnormalized branch. Seed address_has_parcel.from is Address, not
// UnnormalizedAddress. Do not mix full_address / county_jurisdiction here.
writeData("address.json", {
  source_http_request: sourceHttpRequest,
  request_identifier: requestIdentifier,
  unnormalized_address: text(unnormalizedAddress.full_address),
  county_name: "Santa Clara",
  city_name: text(gis.situs_city_name),
  postal_code: postalCode,
  plus_four_postal_code: plusFour,
  state_code: text(gis.situs_state_code) || "CA",
});

writeData("lot.json", {
  source_http_request: sourceHttpRequest,
  request_identifier: requestIdentifier,
  lot_type: null,
  lot_length_feet: null,
  lot_width_feet: null,
  lot_area_sqft: null,
  landscaping_features: null,
  view: null,
  fencing_type: null,
  fence_height: null,
  fence_length: null,
  driveway_material: null,
  driveway_condition: null,
  lot_condition_issues: null,
});

writeData("relationship_property_address.json", rel("property.json", "address.json"));
writeData("relationship_property_parcel.json", rel("property.json", "parcel.json"));
writeData("relationship_property_lot.json", rel("property.json", "lot.json"));
writeData("address_has_parcel.json", rel("address.json", "parcel.json"));

// County parcel_has_geometry is an array of parcel_to_geometry
// (parcel → geometry). address_has_geometry is a separate single
// address_to_geometry link and is not used: the_geom is the parcel polygon.
let parcelGeometryRelationship = null;
if (gis.the_geom != null) {
  if (!selectRequestsTheGeom(sourceHttpRequest)) {
    throw new Error("GIS the_geom is present but source_http_request $select did not request the_geom");
  }
  if (!text(gis.objectid)) {
    throw new Error("GIS the_geom is present but objectid (geometry_join_key) is missing");
  }
  writeData("geometry.json", geometryRecordFromTheGeom(gis.the_geom, sourceHttpRequest, requestIdentifier));
  writeData("relationship_parcel_geometry.json", rel("parcel.json", "geometry.json"));
  parcelGeometryRelationship = "relationship_parcel_geometry.json";
}

const countyRelationships = {
  property_has_address: link("relationship_property_address.json"),
  property_has_parcel: [link("relationship_property_parcel.json")],
  property_has_lot: link("relationship_property_lot.json"),
};
if (parcelGeometryRelationship) {
  countyRelationships.parcel_has_geometry = [link(parcelGeometryRelationship)];
}

writeData(`${countyGroupCid}.json`, {
  label: "County",
  relationships: countyRelationships,
});

writeData(`${seedGroupCid}.json`, {
  label: "Seed",
  relationships: {
    address_has_parcel: link("address_has_parcel.json"),
  },
});
