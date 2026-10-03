/**
 * Santa Clara seed APN: undashed 8-digit text (GIS ubcd-cewv).
 * Dashed 3-2-3 is accepted only as a display form of the same identifier.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { defaultRuntimeRoot } from "../seed.mjs";

const { PermitSourceError } = await import(
  pathToFileURL(path.join(defaultRuntimeRoot(), "src/permits/errors.mjs")).href
);

export function dashedSantaClaraApn(undashed) {
  return `${undashed.slice(0, 3)}-${undashed.slice(3, 5)}-${undashed.slice(5)}`;
}

export function normalizeSantaClaraParcelIdentifier(value) {
  if (value == null) {
    throw new PermitSourceError("missing Santa Clara parcel identifier", {
      classification: "permanent",
      code: "invalid_parcel_identifier",
    });
  }
  if (typeof value === "number") {
    throw new PermitSourceError(
      "Santa Clara parcel identifier must stay text (refusing numeric APN)",
      {
        classification: "permanent",
        code: "invalid_parcel_identifier",
      },
    );
  }
  const raw = String(value);
  if (/^\s*$/.test(raw) || /[eE]/.test(raw)) {
    throw new PermitSourceError(
      `malformed Santa Clara parcel identifier ${JSON.stringify(value)}`,
      {
        classification: "permanent",
        code: "invalid_parcel_identifier",
      },
    );
  }
  const trimmed = raw.trim();
  const dashed = trimmed.match(/^(\d{3})-(\d{2})-(\d{3})$/);
  const undashed = dashed ? `${dashed[1]}${dashed[2]}${dashed[3]}` : trimmed;
  if (!/^\d{8}$/.test(undashed)) {
    throw new PermitSourceError(
      `malformed Santa Clara parcel identifier ${JSON.stringify(value)}`,
      {
        classification: "permanent",
        code: "invalid_parcel_identifier",
      },
    );
  }
  return undashed;
}
