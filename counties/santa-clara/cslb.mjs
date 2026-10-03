/**
 * Private CSLB identity baseline for Santa Clara (not lexicon / Atlas output).
 *
 * Official Public Data Portal only. Does not emit company, person, license,
 * contractor edges, or Atlas artifacts while CA SOS corporate identity is unresolved.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const CSLB_DATA_PORTAL_HOME = "https://www.cslb.ca.gov/Onlineservices/DataPortal/";
export const CSLB_CONTRACTOR_LIST_URL =
  "https://www.cslb.ca.gov/Onlineservices/DataPortal/ContractorList";
export const CSLB_LIST_BY_COUNTY_URL =
  "https://www2.cslb.ca.gov/onlineservices/dataportal/ListByCounty";
export const CSLB_PILOT_COUNTY_NAME = "Santa Clara";
export const CSLB_PILOT_COUNTY_CODE = "43";
export const CSLB_PILOT_CLASSIFICATION = "C-39";

export const COUNTY_LIST_COLUMNS = Object.freeze([
  "LicenseNumber",
  "BusinessType",
  "BusinessName",
  "Address",
  "City",
  "State",
  "ZIP Code",
  "County",
  "PhoneNumber",
  "IssueDate",
  "ExpirationDate",
  "Classification(s)",
  "Status",
  "SuretyCompany",
  "ContractorBondNumber",
  "BondEffectiveDate",
  "BondCancellationDate",
  "WorkersCompCoverageType",
  "WorkersCompInsuranceCompany",
  "WorkersCompPolicyNumber",
  "EffectiveDate",
  "ExpirationDate1",
  "CancellationDate",
  "WorkersCompSuspendDate",
]);

export const PERSONNEL_COLUMNS = Object.freeze([
  "LIC-NO",
  "LastUpdated",
  "REC-TP",
  "SEQ-NO",
  "Name-TP",
  "Name",
  "EMP-Titl-CDE",
  "CL-CDE",
  "CL-CDE-STAT",
  "ASSN-DT",
  "DIS-ASSN-DT",
  "SURETY-TP",
  "SuretyCompany",
  "BOND-NO",
  "BOND-AMT",
  "EffectiveDate",
  "CancellationDate",
  "JointVentureLicenseType",
  "JointVentureLicenseNumber",
]);

export const PRESERVED_LICENSE_FIELDS = Object.freeze([
  "licenseNumber",
  "businessType",
  "businessName",
  "address",
  "city",
  "state",
  "zipCode",
  "county",
  "phoneNumber",
  "issueDate",
  "expirationDate",
  "classificationsRaw",
  "classifications",
  "status",
  "suretyCompany",
  "contractorBondNumber",
  "bondEffectiveDate",
  "bondCancellationDate",
  "workersCompCoverageType",
  "workersCompInsuranceCompany",
  "workersCompPolicyNumber",
  "workersCompEffectiveDate",
  "workersCompExpirationDate",
  "workersCompCancellationDate",
  "workersCompSuspendDate",
]);

export const PRESERVED_PERSONNEL_FIELDS = Object.freeze([
  "licenseNumber",
  "lastUpdated",
  "recordType",
  "sequenceNumber",
  "nameType",
  "name",
  "employeeTitles",
  "classificationCodes",
  "classificationStatuses",
  "associationDates",
  "disassociationDates",
  "currentlyAssociated",
  "suretyType",
  "suretyCompany",
  "bondNumber",
  "bondAmount",
  "effectiveDate",
  "cancellationDate",
  "jointVentureLicenseType",
  "jointVentureLicenseNumber",
]);

const LICENSE_ID_PATTERN = /^\d{1,8}$/;

export class CslbParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "CslbParseError";
  }
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function requireLicenseIdentifier(raw, context) {
  if (raw == null) {
    throw new CslbParseError(`missing license identifier (${context})`);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
      throw new CslbParseError(`malformed license identifier (${context})`);
    }
    return String(raw);
  }
  if (typeof raw !== "string") {
    throw new CslbParseError(`malformed license identifier (${context})`);
  }
  if (/^\s*$/.test(raw)) {
    throw new CslbParseError(`missing license identifier (${context})`);
  }
  if (/[eE]/.test(raw) && /[0-9]/.test(raw)) {
    throw new CslbParseError(`malformed license identifier (${context}): scientific notation`);
  }
  const trimmed = raw.trim();
  if (!LICENSE_ID_PATTERN.test(trimmed)) {
    throw new CslbParseError(`malformed license identifier (${context}): ${JSON.stringify(raw)}`);
  }
  return trimmed;
}

export function parseClassifications(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  return String(raw)
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function hasRoofingClassification(classifications) {
  return classifications.some((token) => {
    const compact = token.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return compact === "C39";
  });
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      if (field.endsWith("\r")) field = field.slice(0, -1);
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    if (field.endsWith("\r")) field = field.slice(0, -1);
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).filter((cells) => cells.some((c) => String(c).trim() !== ""));
  return {
    header,
    records: records.map((cells) => {
      const obj = {};
      for (let i = 0; i < header.length; i += 1) {
        obj[header[i]] = cells[i] ?? "";
      }
      return obj;
    }),
  };
}

function requireHeader(header, expected, label) {
  for (const col of expected) {
    if (!header.includes(col)) {
      throw new CslbParseError(`${label} missing column ${col}`);
    }
  }
}

export function parseCountyListCsv(text, options = {}) {
  const { header, records } = parseCsv(text);
  requireHeader(header, COUNTY_LIST_COLUMNS, "county list");
  const licenses = records.map((row, index) => normalizeCountyRow(row, `county list row ${index + 2}`));
  if (options.requirePilotScope) {
    for (const license of licenses) {
      if (license.county !== CSLB_PILOT_COUNTY_NAME) {
        throw new CslbParseError(
          `county list row ${license.licenseNumber} is not ${CSLB_PILOT_COUNTY_NAME}`,
        );
      }
      if (!hasRoofingClassification(license.classifications)) {
        throw new CslbParseError(
          `county list row ${license.licenseNumber} is missing ${CSLB_PILOT_CLASSIFICATION}`,
        );
      }
    }
  }
  return licenses;
}

export function normalizeCountyRow(row, context) {
  const licenseNumber = requireLicenseIdentifier(row.LicenseNumber, context);
  const classificationsRaw = row["Classification(s)"] ?? "";
  return {
    licenseNumber,
    businessType: String(row.BusinessType ?? "").trim(),
    businessName: String(row.BusinessName ?? "").trim(),
    address: String(row.Address ?? "").trim(),
    city: String(row.City ?? "").trim(),
    state: String(row.State ?? "").trim(),
    zipCode: String(row["ZIP Code"] ?? "").trim(),
    county: String(row.County ?? "").trim(),
    phoneNumber: String(row.PhoneNumber ?? "").trim(),
    issueDate: String(row.IssueDate ?? "").trim(),
    expirationDate: String(row.ExpirationDate ?? "").trim(),
    classificationsRaw: String(classificationsRaw),
    classifications: parseClassifications(classificationsRaw),
    status: String(row.Status ?? "").trim(),
    suretyCompany: String(row.SuretyCompany ?? "").trim(),
    contractorBondNumber: String(row.ContractorBondNumber ?? "").trim(),
    bondEffectiveDate: String(row.BondEffectiveDate ?? "").trim(),
    bondCancellationDate: String(row.BondCancellationDate ?? "").trim(),
    workersCompCoverageType: String(row.WorkersCompCoverageType ?? "").trim(),
    workersCompInsuranceCompany: String(row.WorkersCompInsuranceCompany ?? "").trim(),
    workersCompPolicyNumber: String(row.WorkersCompPolicyNumber ?? "").trim(),
    workersCompEffectiveDate: String(row.EffectiveDate ?? "").trim(),
    workersCompExpirationDate: String(row.ExpirationDate1 ?? "").trim(),
    workersCompCancellationDate: String(row.CancellationDate ?? "").trim(),
    workersCompSuspendDate: String(row.WorkersCompSuspendDate ?? "").trim(),
  };
}

export function parsePersonnelCsv(text, options = {}) {
  const decoded =
    typeof text === "string" ? text : new TextDecoder("windows-1252").decode(text);
  const { header, records } = parseCsv(decoded);
  requireHeader(header, PERSONNEL_COLUMNS, "personnel");
  const allowed = options.licenseNumbers ? new Set(options.licenseNumbers) : null;
  const out = [];
  for (let i = 0; i < records.length; i += 1) {
    const row = records[i];
    const licenseNumber = requireLicenseIdentifier(row["LIC-NO"], `personnel row ${i + 2}`);
    if (allowed && !allowed.has(licenseNumber)) continue;
    const disassociationDates = String(row["DIS-ASSN-DT"] ?? "");
    out.push({
      licenseNumber,
      lastUpdated: String(row.LastUpdated ?? "").trim(),
      recordType: String(row["REC-TP"] ?? "").trim(),
      sequenceNumber: String(row["SEQ-NO"] ?? "").trim(),
      nameType: String(row["Name-TP"] ?? "").trim(),
      name: String(row.Name ?? "").trimEnd().replace(/^\s+/, ""),
      employeeTitles: String(row["EMP-Titl-CDE"] ?? "").trim(),
      classificationCodes: String(row["CL-CDE"] ?? "").trim(),
      classificationStatuses: String(row["CL-CDE-STAT"] ?? "").trim(),
      associationDates: String(row["ASSN-DT"] ?? "").trim(),
      disassociationDates: disassociationDates.trim(),
      currentlyAssociated: disassociationDates.trim() === "",
      suretyType: String(row["SURETY-TP"] ?? "").trim(),
      suretyCompany: String(row.SuretyCompany ?? "").trim(),
      bondNumber: String(row["BOND-NO"] ?? "").trim(),
      bondAmount: String(row["BOND-AMT"] ?? "").trim(),
      effectiveDate: String(row.EffectiveDate ?? "").trim(),
      cancellationDate: String(row.CancellationDate ?? "").trim(),
      jointVentureLicenseType: String(row.JointVentureLicenseType ?? "").trim(),
      jointVentureLicenseNumber: String(row.JointVentureLicenseNumber ?? "").trim(),
    });
  }
  return out;
}

export function joinPersonnel(licenses, personnel) {
  const licenseSet = new Set(licenses.map((row) => row.licenseNumber));
  const rows = personnel.filter((row) => licenseSet.has(row.licenseNumber));
  const linked = new Set(rows.map((row) => row.licenseNumber));
  return {
    personnelRows: rows,
    licensesWithPersonnel: linked.size,
    licensesWithoutPersonnel: licenses.length - linked.size,
  };
}

export function refuseLexiconEmit() {
  return {
    company: false,
    person: false,
    license: false,
    contractor_has_license: false,
    contractor_has_person: false,
    property_improvement_has_contractor: false,
    atlas: false,
  };
}

export async function countyXlsxToCsv(xlsxBytes, pythonScriptPath) {
  const tmp = await mkdtemp(path.join(tmpdir(), "cslb-xlsx-"));
  const xlsxPath = path.join(tmp, "county.xlsx");
  const csvPath = path.join(tmp, "county.csv");
  await writeFile(xlsxPath, xlsxBytes);
  execFileSync("python3", [pythonScriptPath, xlsxPath, csvPath], { stdio: "pipe" });
  return readFile(csvPath, "utf8");
}

export function buildPrivateSnapshot({
  licenses,
  personnel,
  countySource,
  personnelSource,
}) {
  const joined = joinPersonnel(licenses, personnel);
  return {
    kind: "private-cslb-identity-baseline",
    public: false,
    lexicon_emit: refuseLexiconEmit(),
    corporate_registry: {
      authority: "california-sos-bizfile",
      status: "unresolved",
      production_business_entity_api: "government-agencies-only",
      unattended_access_blocker: "BizFile Incapsula; no bulk dump without SOS account; do not bypass; do not buy data",
    },
    scope: {
      county: CSLB_PILOT_COUNTY_NAME,
      classification: CSLB_PILOT_CLASSIFICATION,
      statewide_personnel_used: true,
      statewide_master_used: false,
      reason_statewide_personnel:
        "ListByCounty does not include current personnel/qualifiers required by the Oracle identity contract",
    },
    gap_codes: [
      "sos_corporate_identity_unresolved",
      "cslb_status_boundary_incomplete",
      "lexicon_license_class_absent",
      "lexicon_contractor_has_license_absent",
    ],
    counts: {
      licenses: licenses.length,
      c39SantaClara: licenses.length,
      personnelRows: joined.personnelRows.length,
      licensesWithPersonnel: joined.licensesWithPersonnel,
      licensesWithoutPersonnel: joined.licensesWithoutPersonnel,
    },
    fields_preserved: {
      license: PRESERVED_LICENSE_FIELDS,
      personnel: PRESERVED_PERSONNEL_FIELDS,
    },
    sources: {
      list_by_county: countySource,
      personnel: personnelSource,
    },
  };
}
