#!/usr/bin/env python3
"""Convert a CSLB ListByCounty Open XML workbook to CSV (assignment-local)."""
import csv
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def shared_strings(zf):
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    values = []
    for si in root.findall(f"{NS}si"):
        values.append("".join((t.text or "") for t in si.findall(f".//{NS}t")))
    return values


def cell_value(cell, strings):
    kind = cell.attrib.get("t")
    inline = cell.find(f"{NS}is")
    if kind == "inlineStr" and inline is not None:
        return "".join((t.text or "") for t in inline.findall(f".//{NS}t"))
    value = cell.find(f"{NS}v")
    if value is None:
        return ""
    if kind == "s":
        return strings[int(value.text)]
    return value.text or ""


def convert(xlsx_path, csv_path):
    with zipfile.ZipFile(xlsx_path) as zf:
        strings = shared_strings(zf)
        sheet_name = "xl/worksheets/sheet.xml"
        if sheet_name not in zf.namelist():
            sheet_name = "xl/worksheets/sheet1.xml"
        sheet = ET.fromstring(zf.read(sheet_name))
        rows = sheet.findall(f"{NS}sheetData/{NS}row")
        with Path(csv_path).open("w", encoding="utf-8", newline="") as out:
            writer = csv.writer(out)
            for row in rows:
                writer.writerow([cell_value(cell, strings) for cell in row.findall(f"{NS}c")])


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: cslb-xlsx-to-csv.py <xlsx> <csv>")
    convert(sys.argv[1], sys.argv[2])
