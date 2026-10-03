import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CslbParseError,
  buildPrivateSnapshot,
  hasRoofingClassification,
  joinPersonnel,
  parseCountyListCsv,
  parsePersonnelCsv,
  refuseLexiconEmit,
  requireLicenseIdentifier,
} from "../counties/santa-clara/cslb.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "fixtures", "santa-clara-cslb");

test("license identifiers stay text and keep leading zeros", () => {
  assert.equal(requireLicenseIdentifier("0488238", "fixture"), "0488238");
  assert.equal(requireLicenseIdentifier(" 968567 ", "fixture"), "968567");
});

test("missing or malformed license identifiers fail closed", () => {
  assert.throws(() => requireLicenseIdentifier("", "empty"), CslbParseError);
  assert.throws(() => requireLicenseIdentifier("   ", "blank"), CslbParseError);
  assert.throws(() => requireLicenseIdentifier(null, "null"), CslbParseError);
  assert.throws(() => requireLicenseIdentifier("12e4", "sci"), /scientific notation/);
  assert.throws(() => requireLicenseIdentifier("ABC123", "alpha"), CslbParseError);
  assert.throws(() => requireLicenseIdentifier("123456789", "too-long"), CslbParseError);
});

test("county-list parser preserves name, status, dates, class, address, phone, bond, and WC", async () => {
  const csv = await readFile(path.join(FIXTURE, "county-list.csv"), "utf8");
  const licenses = parseCountyListCsv(csv, { requirePilotScope: true });
  assert.equal(licenses.length, 2);
  assert.equal(licenses[0].licenseNumber, "0488238");
  assert.equal(licenses[0].businessName, "ECONOMY ROOFING INC");
  assert.equal(licenses[0].status, "CLEAR");
  assert.equal(licenses[0].issueDate, "03/11/1986");
  assert.equal(licenses[0].expirationDate, "02/29/2028");
  assert.equal(licenses[0].phoneNumber, "(408) 615 7200");
  assert.equal(licenses[0].address, "2988 NEAL AVENUE");
  assert.equal(licenses[0].contractorBondNumber, "PB10163407995");
  assert.equal(licenses[0].workersCompPolicyNumber, "9091902");
  assert.ok(hasRoofingClassification(licenses[0].classifications));
  assert.deepEqual(licenses[1].classifications, ["B", "C10", "C20", "C36", "C38", "C39"]);
});

test("county-list parser fails closed when a data row omits LicenseNumber", () => {
  const csv = `LicenseNumber,BusinessType,BusinessName,Address,City,State,ZIP Code,County,PhoneNumber,IssueDate,ExpirationDate,Classification(s),Status,SuretyCompany,ContractorBondNumber,BondEffectiveDate,BondCancellationDate,WorkersCompCoverageType,WorkersCompInsuranceCompany,WorkersCompPolicyNumber,EffectiveDate,ExpirationDate1,CancellationDate,WorkersCompSuspendDate
,Corporation,NO LICENSE,1 MAIN,SAN JOSE,CA,95112,Santa Clara,555,01/01/2020,01/01/2026, C39, CLEAR,,,,,,,
`;
  assert.throws(() => parseCountyListCsv(csv, { requirePilotScope: true }), /missing license identifier/);
});

test("personnel parser links current qualifiers and ignores out-of-scope licenses", async () => {
  const county = parseCountyListCsv(await readFile(path.join(FIXTURE, "county-list.csv"), "utf8"), {
    requirePilotScope: true,
  });
  const personnel = parsePersonnelCsv(await readFile(path.join(FIXTURE, "personnel.csv"), "utf8"), {
    licenseNumbers: county.map((row) => row.licenseNumber),
  });
  assert.equal(personnel.length, 2);
  assert.equal(personnel[0].licenseNumber, "0488238");
  assert.equal(personnel[0].name, "DAVIS                              JANE           A");
  assert.equal(personnel[0].currentlyAssociated, true);
  const joined = joinPersonnel(county, personnel);
  assert.equal(joined.licensesWithPersonnel, 2);
  assert.equal(joined.personnelRows.length, 2);
});

test("personnel parser fails closed on missing LIC-NO", () => {
  const csv = `LIC-NO,LastUpdated,REC-TP,SEQ-NO,Name-TP,Name,EMP-Titl-CDE,CL-CDE,CL-CDE-STAT,ASSN-DT,DIS-ASSN-DT,SURETY-TP,SuretyCompany,BOND-NO,BOND-AMT,EffectiveDate,CancellationDate,JointVentureLicenseType,JointVentureLicenseNumber
,01/01/2024,Class/Title,1, Principal, SOMEONE, Officer, C39, Y, 01/01/2020, ,,,,,,,
`;
  assert.throws(() => parsePersonnelCsv(csv), /missing license identifier/);
});

test("private snapshot does not enable lexicon or Atlas emit", async () => {
  const licenses = parseCountyListCsv(await readFile(path.join(FIXTURE, "county-list.csv"), "utf8"), {
    requirePilotScope: true,
  });
  const personnel = parsePersonnelCsv(await readFile(path.join(FIXTURE, "personnel.csv"), "utf8"), {
    licenseNumbers: licenses.map((row) => row.licenseNumber),
  });
  const snapshot = buildPrivateSnapshot({
    licenses,
    personnel,
    countySource: { url: "https://www2.cslb.ca.gov/onlineservices/dataportal/ListByCounty" },
    personnelSource: { url: "https://www.cslb.ca.gov/Onlineservices/DataPortal/ContractorList" },
  });
  assert.equal(snapshot.public, false);
  assert.deepEqual(snapshot.lexicon_emit, refuseLexiconEmit());
  assert.equal(snapshot.corporate_registry.production_business_entity_api, "government-agencies-only");
  assert.match(snapshot.corporate_registry.unattended_access_blocker, /Incapsula/);
  assert.ok(snapshot.gap_codes.includes("sos_corporate_identity_unresolved"));
});
