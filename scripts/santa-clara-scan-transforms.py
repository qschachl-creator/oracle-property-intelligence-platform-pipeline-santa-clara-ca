#!/usr/bin/env python3
"""Scan publication-seed APNs for currently valid transformed.zip artifacts."""
from __future__ import annotations

import argparse
import csv
import json
import os
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

REQUIRED = ("data/property.json", "data/parcel.json")
MIN_BYTES = 200


def inspect_zip(zip_path: str) -> str | None:
    try:
        size = os.path.getsize(zip_path)
    except OSError:
        return "transformed.zip missing"
    if size < MIN_BYTES:
        return "transformed.zip too small"
    if not zipfile.is_zipfile(zip_path):
        return "transformed.zip is not a readable ZIP"
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
            for required in REQUIRED:
                if required not in names:
                    return f"transformed.zip is missing {required}"
            for required in REQUIRED:
                json.loads(zf.read(required))
    except Exception as exc:  # noqa: BLE001
        return f"transformed.zip unreadable: {exc}"
    return None


def inspect_apn(args: tuple[str, str]) -> tuple[str, str | None]:
    apn, parcels_dir = args
    return apn, inspect_zip(os.path.join(parcels_dir, apn, "transformed.zip"))


def load_seed_apns(seed_path: Path) -> list[str]:
    apns: list[str] = []
    with seed_path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            apn = (row.get("parcel_id") or "").strip()
            if apn:
                apns.append(apn)
    return apns


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", required=True)
    parser.add_argument("--parcels", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--workers", type=int, default=max(4, os.cpu_count() or 4))
    args = parser.parse_args()
    seed_path = Path(args.seed)
    parcels_dir = args.parcels
    apns = load_seed_apns(seed_path)
    invalid: list[dict[str, str]] = []
    valid = 0
    chunk = 4000
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        done = 0
        for start in range(0, len(apns), chunk):
            payload = [(apn, parcels_dir) for apn in apns[start : start + chunk]]
            for apn, reason in pool.map(inspect_apn, payload, chunksize=100):
                done += 1
                if reason is None:
                    valid += 1
                else:
                    invalid.append({"parcelId": apn, "reason": reason})
            print(f"scanned {done}/{len(apns)} valid={valid} invalid={len(invalid)}", flush=True)
    extra_dirs = 0
    try:
        with os.scandir(parcels_dir) as entries:
            seed_set = set(apns)
            for entry in entries:
                if entry.is_dir(follow_symlinks=False) and entry.name not in seed_set:
                    extra_dirs += 1
    except FileNotFoundError:
        extra_dirs = -1
    report = {
        "seedApns": len(apns),
        "validCompletedTransforms": valid,
        "invalidOrMissingTransforms": len(invalid),
        "extraParcelDirsNotInSeed": extra_dirs,
        "oneToOne": valid == len(apns) and len(invalid) == 0 and extra_dirs == 0,
        "invalid": sorted(invalid, key=lambda row: row["parcelId"]),
    }
    Path(args.out).write_text(json.dumps(report) + "\n")
    print(json.dumps({k: report[k] for k in report if k != "invalid"}, indent=2), flush=True)


if __name__ == "__main__":
    main()
