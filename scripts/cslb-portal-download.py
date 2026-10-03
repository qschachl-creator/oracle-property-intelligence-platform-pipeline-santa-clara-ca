#!/usr/bin/env python3
"""Download official CSLB Public Data Portal files (no Incapsula bypass, no paid files)."""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = "OracleSantaClaraCslbPilot/1.0"
COUNTY_URL = "https://www2.cslb.ca.gov/onlineservices/dataportal/ListByCounty"
CONTRACTOR_LIST_URL = "https://www.cslb.ca.gov/Onlineservices/DataPortal/ContractorList"


def hidden(html: str, name: str) -> str:
    match = re.search(rf'name="{re.escape(name)}"[^>]*value="([^"]*)"', html)
    if not match:
        match = re.search(rf'id="{re.escape(name)}"[^>]*value="([^"]*)"', html)
    return match.group(1) if match else ""


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor())


def request(op, url, data=None):
    headers = {
        "User-Agent": UA,
        "Accept-Encoding": "identity",
        "Connection": "close",
    }
    if data is not None:
        encoded = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(
            url,
            data=encoded,
            headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
        )
    else:
        req = urllib.request.Request(url, headers=headers)
    with op.open(req, timeout=300) as response:
        chunks = []
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return response.geturl(), response.headers, b"".join(chunks)


def extract_as_of(html: str):
    labeled = re.search(r"as of\s+(\d{1,2}/\d{1,2}/\d{4})", html, re.I)
    if labeled:
        return labeled.group(1)
    dates = re.findall(r"\b(\d{1,2}/\d{1,2}/\d{4})\b", html)
    return dates[0] if dates else None


def download_county(op, classification: str, county_code: str):
    _url, _headers, body = request(op, COUNTY_URL)
    html = body.decode("utf-8", "replace")
    data = {
        "__EVENTTARGET": "",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": hidden(html, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": hidden(html, "__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": hidden(html, "__EVENTVALIDATION"),
        "ctl00$MainContent$lbClassification": classification,
        "ctl00$MainContent$lbCounty": county_code,
        "ctl00$MainContent$btnSearch": "Download",
    }
    url, headers, body = request(op, COUNTY_URL, data)
    ctype = headers.get("Content-Type") or headers.get("content-type") or ""
    disposition = headers.get("Content-Disposition") or headers.get("content-disposition") or ""
    if "spreadsheet" not in ctype and ".xlsx" not in disposition.lower():
        raise SystemExit("ListByCounty did not return Excel: %r %r" % (ctype, disposition))
    return {
        "url": COUNTY_URL,
        "finalUrl": url,
        "contentType": ctype,
        "contentDisposition": disposition,
        "downloadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bytes": body,
    }


def download_personnel(op):
    _url, _headers, body = request(op, CONTRACTOR_LIST_URL)
    html = body.decode("utf-8", "replace")
    select = {
        "__EVENTTARGET": "ctl00$MainContent$ddlStatus",
        "__EVENTARGUMENT": "",
        "__LASTFOCUS": "",
        "__VIEWSTATE": hidden(html, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": hidden(html, "__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": hidden(html, "__EVENTVALIDATION"),
        "ctl00$MainContent$ddlStatus": "P",
    }
    _url, _headers, body = request(op, CONTRACTOR_LIST_URL, select)
    html = body.decode("utf-8", "replace")
    as_of = extract_as_of(html)
    download = {
        "__EVENTTARGET": "ctl00$MainContent$lbtnPersonnelcsv",
        "__EVENTARGUMENT": "",
        "__LASTFOCUS": "",
        "__VIEWSTATE": hidden(html, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": hidden(html, "__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": hidden(html, "__EVENTVALIDATION"),
        "ctl00$MainContent$ddlStatus": "P",
    }
    url, headers, body = request(op, CONTRACTOR_LIST_URL, download)
    ctype = headers.get("Content-Type") or headers.get("content-type") or ""
    disposition = headers.get("Content-Disposition") or headers.get("content-disposition") or ""
    if "csv" not in ctype.lower() and not body.startswith(b"LIC-NO"):
        raise SystemExit("Personnel download did not return CSV: %r" % (ctype,))
    return {
        "url": CONTRACTOR_LIST_URL,
        "finalUrl": url,
        "contentType": ctype,
        "contentDisposition": disposition,
        "portalAsOfDate": as_of,
        "downloadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bytes": body,
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: cslb-portal-download.py <out-dir>")
    out = Path(sys.argv[1])
    raw = out / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    op = opener()
    county = download_county(op, "C-39", "43")
    last_error = None
    for attempt in range(1, 5):
        try:
            personnel = download_personnel(opener())
            break
        except Exception as error:
            last_error = error
            time.sleep(3 * attempt)
    else:
        raise last_error
    county_path = raw / "CSLBSearchData-santa-clara-c39.xlsx"
    personnel_path = raw / "PersonnelData.csv"
    county_path.write_bytes(county["bytes"])
    personnel_path.write_bytes(personnel["bytes"])
    meta = {
        "list_by_county": {
            "url": county["url"],
            "finalUrl": county["finalUrl"],
            "contentType": county["contentType"],
            "contentDisposition": county["contentDisposition"],
            "downloadedAt": county["downloadedAt"],
            "path": str(county_path),
            "bytes": len(county["bytes"]),
        },
        "personnel": {
            "url": personnel["url"],
            "finalUrl": personnel["finalUrl"],
            "contentType": personnel["contentType"],
            "contentDisposition": personnel["contentDisposition"],
            "portalAsOfDate": personnel["portalAsOfDate"],
            "downloadedAt": personnel["downloadedAt"],
            "path": str(personnel_path),
            "bytes": len(personnel["bytes"]),
        },
    }
    (out / "download-meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps({"countyBytes": len(county["bytes"]), "personnelBytes": len(personnel["bytes"]), "portalAsOfDate": personnel["portalAsOfDate"]}))


if __name__ == "__main__":
    main()
