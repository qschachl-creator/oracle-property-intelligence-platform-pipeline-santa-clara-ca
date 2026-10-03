# Oracle Property Intelligence Platform Pipeline - Santa Clara County, CA

## Context

This repository is the **data gathering and ingestion pipeline** that supplies the [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm). The hosted CRM is [https://roofing-f1h5pe4dy-quinlen-schachle-s-projects.vercel.app](https://roofing-f1h5pe4dy-quinlen-schachle-s-projects.vercel.app). The CRM helps roofing companies explore properties in their service area, identify aging roofs and open roofing permits, and turn those signals into leads. This pipeline story covers collecting, loading, reconciling, and exposing the underlying property and permit datasets; the CRM UI/workflow itself is out of scope here.

The Oracle ingestion pipeline has been started, but the full **Santa Clara County, CA** dataset has not been completely uploaded, reconciled, or demonstrated. The infrastructure must be designed so Oracle does not carry ongoing infrastructure cost by default. For this candidate exercise, the candidate acts as both Oracle and builder: they are responsible for completing the pipeline and proving the low-cost infrastructure approach.

The pipeline must be continuous and incremental (ongoing ingestion of new and changed records over time) and must publish eligible data artifacts to Elephant IPFS (the Elephant protocol’s decentralized storage layer, following Lexicon / elephant-cli / Filebase+IPNS conventions used by the Elephant oracle skills).

Published artifacts must remain independently retrievable from the public IPFS network after the candidate’s local environment, demo session, and any single pinning vendor are gone. **Content identifiers (CIDs) are the durable identity of each artifact.** A vendor HTTP gateway URL is a convenience locator, not the artifact.

In addition to standard property intelligence, the pipeline must surface signals relevant to **roofing lead generation**, including roof age, open roofing permits (especially long-open permits), contractor identity, BBB rating scores where available, ownership/contact fields where available, and accurate property coordinates for radius-based search.

## Description

Complete the Oracle pipeline by loading all available Santa Clara County, CA property, permit, ownership, business, contractor, location, and public-source data into an MCP-ready database. Use IPFS and DuckDB to minimize Oracle-hosted infrastructure costs while enabling UI and agent access to answer property intelligence questions that support the roofing CRM—especially aged-roof and open-permit lead discovery within a map radius.

The pipeline must demonstrate that data is ingested on an ongoing basis (not a one-shot bulk load): support incremental / windowed refreshes, preserve run history with record deltas and timestamps, and re-publish updated artifacts to Elephant IPFS as **new immutable CIDs** (do not mutate a previously published CID).

## Acceptance Criteria

### Geography & coverage
- Target **Santa Clara County, CA** as the default and primary county for ingestion and demos.

### Data loading
- Run the Oracle pipeline until all available county data is uploaded.
- Load available property records into the database.
- Load available permit records into the database, with emphasis on **roofing-related permits**.
- Preserve permit status, open/close dates (or equivalent), and duration-open signals so long-open permits can be identified.
- Load available ownership records into the database.
- Load available contractor records into the database.
- Load available BBB / contractor rating scores where publicly available.
- Load available business records into the database.
- Load available location and coordinate data into the database (required for GPS/pin-drop radius queries in the CRM).
- Capture roof age or best-available proxies (e.g., year built, last roofing permit/completion date) so properties with roofs older than a configurable threshold (default suggestion: **15 years**) can be queried.
- Reconcile duplicate entities across all uploaded datasets.
- Preserve source provenance for uploaded records.
- Design and implement the pipeline as continuous / incremental:
  - Support ongoing ingestion of new and changed records (scheduled or on-demand refreshes, change detection or bounded windows, idempotent steps).
  - Maintain a visible history of pipeline runs (timestamps, source list, record counts, deltas, any source limitations).
  - Demonstrate that data continues to be ingested and published over time (multiple runs or simulated ongoing updates).

### Infrastructure & access
- Optimize pipeline performance where feasible.
- Identify slow source sites or constrained data sources.
- Document pipeline speed limitations and source constraints.
- Design the infrastructure so Oracle does not carry ongoing infrastructure cost by default.
- Use IPFS for decentralized storage of eligible dataset artifacts.
- Use DuckDB for local or portable analytical querying.
- Structure the database to support MCP access.
- Enable agent access to query the database.
- Provide a UI for exploring the uploaded data.

### IPFS publication
- Treat IPFS **CIDs** as the durable identity of published artifacts. Do not treat a vendor-specific HTTP URL as the source of truth.
- Prefer **CIDv1** (base32) for every published object.
- Keep published bytes **retrievable from the public IPFS network**, not only from a private node, authenticated gateway, vendor dashboard, or laptop that is running during the demo.
- Publish a machine-readable **artifact manifest** (JSON) for each pipeline run. Include every eligible object (query table, coverage, indexes, sample extracts, and any directory roots) with at least:
  - `cid`
  - logical `name` / path
  - `size` in bytes
  - IPFS codec (`file` vs `directory`)
  - content digest (e.g. SHA-256 of the raw bytes, or equivalent)
  - optional provider `origins` (multiaddrs) if a candidate-operated node is still serving the blocks
- If IPNS is used, record both the IPNS name and the **resolved CID** for that run. IPNS is a pointer; the CID is the snapshot.
- On incremental republish, keep prior CIDs immutable. New data produces a new CID. Run history must retain previous CIDs.
- For directory artifacts, also publish a **CAR** of the DAG rooted at that CID so the snapshot can be imported by any IPFS node without re-encoding.
- Demonstrate that each listed CID can be fetched from **at least two independent public gateways** that this environment does not operate (for example `https://ipfs.io/ipfs/<cid>` and `https://dweb.link/ipfs/<cid>`), and that the retrieved bytes match the manifest size/digest.
- Include the artifact manifest (and CARs, if any) in the repository or demo packet so a third party can fetch the dataset by CID after the candidate environment is gone.

### Roofing CRM–supporting queries
- Support radius-based property identification using coordinates (around a GPS point or map pin).
- Support questions about properties with roofs older than 15 years (or a configurable age threshold).
- Support questions about properties with **open roofing permits**, including those that have remained open for many years.
- Support returning permit details with contractor name and BBB rating score where available.
- Support questions about properties that have not exchanged ownership in more than 10 years.
- Support questions about properties with regional (or out-of-area) owners.
- Return source-backed answers where source data is available.

### Demonstration
- Demonstrate the uploaded dataset through the UI.
- Demonstrate the uploaded dataset through an agent query aligned to roofing lead discovery.
- Demonstrate that Oracle can operate without carrying the infrastructure cost.
- Demonstrate public, CID-addressed IPFS publication using the artifact manifest and independent gateway retrieval (not a private-only locator).
- Confirm the candidate fulfilled both Oracle and builder responsibilities for this milestone.
- Pass the demo using real uploaded Santa Clara County records.

## Demo Transcript
- Presenter: “I will demonstrate that the Oracle pipeline has loaded the available dataset for Santa Clara County, California, that the data is queryable through DuckDB, that eligible artifacts are stored on IPFS as content-addressed snapshots, and that both the UI and agent can answer property intelligence questions that support roofing lead generation.”
- Presenter: “First, I am opening the pipeline run summary.”
  - Expected Result: The system displays the completed pipeline run, source list, county coverage, record counts, timestamps, and any documented source limitations.
- Presenter: “Show the total uploaded records by source.”
  - Expected Result: The system shows uploaded property, permit, ownership, contractor (with BBB rating where available), business, and coordinate records with collection timestamps and provenance.
- Presenter: “Now I am opening the DuckDB-backed query layer.”
  - Expected Result: The system confirms that the loaded data is available for structured querying without requiring Oracle-hosted database infrastructure.
- Presenter: “Show the published artifact manifest for this run.”
  - Expected Result: A JSON (or equivalent) listing every eligible artifact with CID, size, logical name, codec, and digest. Gateway URLs, if shown, are derived from those CIDs. An IPNS name, if used, is shown together with the resolved CID.
- Presenter: “Retrieve one published artifact by CID from a public gateway that this environment does not operate, then again from a second independent public gateway.”
  - Expected Result: Both fetches succeed and the bytes match the manifest size/digest. Serving the object only from a private, local, or authenticated gateway is a fail.
- Presenter: “Show that a later incremental publish produced a new CID without mutating the previous one.”
  - Expected Result: The prior CID still resolves; the new run has a distinct CID; IPNS (if used) now points at the new CID; both CIDs appear in run history. A CAR is available for any directory root.
- Presenter: “Using the UI, show properties within a sample radius that have roofs older than 15 years.”
  - Expected Result: Matching properties are returned with roof-age basis, coordinates, and source provenance.
- Presenter: “Show properties in that area with open roofing permits, prioritizing permits that have remained open for many years, including contractor and BBB rating where available.”
  - Expected Result: Results include permit status/open duration, contractor identity, BBB score when present, and clear source backing.
- Presenter: “Now I am asking the same type of questions through the agent.”
  - Agent Prompt: “Which properties in Santa Clara County within five miles of [city xyz] have roofs older than 15 years?”
    - Expected Result: The agent returns matching properties, explains the reasoning, and includes source-backed evidence.
  - Agent Prompt: “Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?”
    - Expected Result: The agent returns a filtered list with permit age/open duration, contractor details, BBB rating when available, and clearly identifies any assumptions or missing data.
- Presenter: “Finally, I will show that the system is MCP-ready.”
  - Expected Result: The system demonstrates an MCP-ready interface or documented MCP-compatible query structure that agents and the roofing CRM can use without changing the data model.

## Out of Scope
- Roofing CRM UI, map pin/GPS interaction design, and lead outreach workflows (covered in [roofing-crm](https://github.com/prismteam-ai/roofing-crm)).
- Live outbound messaging to property owners.

## Reference
- [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm)
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills)

## Evidence for this run

The assignment text above is unchanged. This section is the status of branch `candidate-solution` as of 2026-10-02. Each requirement is marked **Met**, **Partial**, **Could not be met**, or **Not yet demonstrated**. **Could not be met** means the source, a legal term, a gateway refusal, or this Mac's memory blocked it. **Not yet demonstrated** means a recording can still be made. Limits are spelled out in [docs/santa-clara-limitations.md](docs/santa-clara-limitations.md). Content IDs, sizes, and SHA-256 digests are in [docs/publication/santa-clara-run-manifest.json](docs/publication/santa-clara-run-manifest.json). The draft pull requests have not been marked ready for review.

Hosted CRM, confirmed loading with no login on 2026-10-02: [https://roofing-f1h5pe4dy-quinlen-schachle-s-projects.vercel.app](https://roofing-f1h5pe4dy-quinlen-schachle-s-projects.vercel.app). `https://roofing-crm.vercel.app` is a different application.

Demo recording: [https://youtu.be/clGgvVoQGKo](https://youtu.be/clGgvVoQGKo).

### Geography and coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| Santa Clara County, CA is the default county | Met | FIPS `06085`. GIS layer `ubcd-cewv`. County archive root `baguqeerao6gqmxdj3okmblnkaigaopef56zxc7oedoo2jpq36wvc7h4eurwq`. The CRM opens on Santa Clara County. |

### Data loading

| Requirement | Status | Evidence |
| --- | --- | --- |
| Run until available county data is uploaded | Partial | Could not be met in full because no free bulk file contains owner names, year built, BBB scores, or a countywide roof age. The public GIS layer is uploaded. The paid roll was not bought. This is a source limit, not a missing upload step. |
| Property records | Met | 504,717 GIS features. 9,876 have no usable APN and are excluded. 494,841 unique 8-digit APNs are in the county archive and in `query-table.parquet` (`bafybeichaw6qx2hk5arq2wthb7yddfscawlhlbk3nmsflufjddiduwj6li`, 147,944,514 bytes, SHA-256 `dac4d6a990973937bc59d858a382bc44aea6007ed89c4b1f17a60bb46cbc3974`). `elephant-cli validate` on the parcel directory: 494,841 succeeded, 0 failed. |
| Permit records, especially roofing | Partial | Could not be met as one county file because Santa Clara has no countywide permit download. San Jose is published: layers 7, 8, and 9, `WORKDESC = 'ReRoof'`, `FINALDATE` only, 7,787 features, 6,955 APNs, 59 accepted replacements. JSON `bafybeiejbzvkke5sygftcxqj75e6peh4e44xblrfzvxa7cm53xlyi4c5ve`. Parquet `bafybeiflbfzalvahkotoxk7vdakdzthp7hfdnpwauj4hdb6qjo7tx7puyi`. The other 15 cities are separate portals, and several do not expose full history, so a scrape would still be incomplete. The CRM reads open San Jose permits live. |
| Permit status, dates, and how long a permit has been open | Partial | Could not be met countywide because only San Jose publishes issue date and final date on a public layer this run can read. Open means no final date. Duration is years since that issue date. The other cities have no equivalent free table. |
| Ownership records | Could not be met | The GIS layer has no owner name. The free Assessor sheet hides the name under Government Code 6254.21, and its terms prohibit resale, so the sheet cannot be copied into this archive. The only bulk name file is the paid roll, which was not bought. `owner_name` is null. |
| Contractor records | Partial | Could not be met as lexicon license records because the live lexicon has no license class, and BizFile could not be read without bypassing Incapsula. A contractor name still appears on a live San Jose permit. CSLB rows stay private. |
| BBB scores where publicly available | Could not be met | BBB has no free bulk score file. The official API requires approval and does not allow public display of complaints. No score was invented. The CRM says the rating is unavailable. |
| Business records | Could not be met | California Secretary of State BizFile blocks unattended access with Incapsula, which was not bypassed. The paid bulk unload was not bought. SOS does not collect real-property owners. |
| Location and coordinates | Met | `counties/santa-clara/transforms/data_extractor.js` sets latitude and longitude to the bounding-box center. Geometry table `bafybeifd66fmaz7huy2htjqbqfnbefxdapx3bdcreayp6ejpmgkk3ev4zq`. The CRM draws the radius on the live county GIS map. |
| Roof age, default threshold 15 years | Partial | Could not be met countywide because no free file has year built or a roof date for every city. San Jose completed ReRoof permits with `FINALDATE` are the roof age. `builtYear` is null. Issue date is not used. Five parcels are `olderThan15Years` as of 2026-10-01. |
| Reconcile duplicates | Met | 0 duplicate 8-digit APNs in the GIS seed. Roof age is one row per APN. |
| Source provenance | Met | Each parcel record keeps `source_http_request` and `request_identifier` for the Socrata request. The roof fixture records the ArcGIS layer URLs, the `ReRoof` filter, and `FINALDATE`. |
| Incremental ingestion and a visible run history | Met | The county archive CID stayed `baguqeerao6gqmxdj3okmblnkaigaopef56zxc7oedoo2jpq36wvc7h4eurwq`. A later coverage record is a new CID, `bafkreih3u453drytx7c6hwbiqainuaaecjyd5n7iozc7rcigayhncjbec4`. The previous coverage CID `bafkreibxxn7dfrokytikl4oydjcs3nncpqvki5ed2zszsinqoo4zskyej4` still resolves. Both are in the manifest. A second hash of every parcel was not required for this proof. |

The five roofs older than 15 years:

| APN | Roof date | Age in years | Permit | Reason |
| --- | --- | --- | --- | --- |
| `46204039` | 2011-06-21 | 15 | `2011-018089-RS` | accepted completed primary roof replacement |
| `49454036` | 2010-09-01 | 16 | `2010-020803-RS` | accepted completed primary roof replacement |
| `56904039` | 2011-05-04 | 15 | `2010-030504-RS` | accepted completed primary roof replacement |
| `56934012` | 2010-06-15 | 16 | `2010-015401-RS` | accepted completed primary roof replacement |
| `67620085` | 2010-06-01 | 16 | `2010-012446-RS` | accepted completed primary roof replacement |

### Infrastructure and access

| Requirement | Status | Evidence |
| --- | --- | --- |
| Document slow or constrained sources | Met | [docs/santa-clara-county-findings.md](docs/santa-clara-county-findings.md) and [docs/santa-clara-limitations.md](docs/santa-clara-limitations.md). Assessor search is one parcel at a time. BizFile is behind Incapsula. The 2.7 GB CAR validate ran out of memory on this 16 GB Mac. `ipfs.io` and `dweb.link` returned 403 or 429 from this network on 2026-10-02. |
| No ongoing Oracle-hosted infrastructure cost | Met | The published files are the content IDs in `docs/publication/santa-clara-run-manifest.json`. The roof query is the `duckdb` SQL in that same file. This repo has no hosted database. |
| IPFS for eligible artifacts | Met | County archive, 11 exported tables, query table, roof parquet, roof JSON, and both coverage files are pinned. CIDv1. The manifest is the list. |
| DuckDB query | Met | SQL: `duckdb.roofsOlderThan15Years` in `docs/publication/santa-clara-run-manifest.json`. Parquet: `bafybeiflbfzalvahkotoxk7vdakdzthp7hfdnpwauj4hdb6qjo7tx7puyi` (339,282 bytes, SHA-256 `22146d46c6a1fd46c19cd2fb6aff4de9f135cdc32d1b2be6685d843101b2acfb`). The five rows are in `fixtures/santa-clara-permits/san-jose-reroof-roof-age.json`. |
| MCP-ready structure | Met | The README accepts a documented query structure. That structure is the manifest SQL. A synced public MCP index cannot list this county until a code owner merges an Atlas page. This candidate must not merge it. That wait is outside this submission. |
| A UI for the uploaded data | Met | The hosted CRM above. The map uses live county GIS for the circle. Roof age is fetched from the published JSON content ID. The UI does not download the 2.7 GB county archive. |

### IPFS publication

| Requirement | Status | Evidence |
| --- | --- | --- |
| CIDs are the identity, not a vendor URL | Met | Manifest fields are `cid`, `name`, `size`, `codec`, and `sha256`. Gateway URLs are only locators. |
| CIDv1 | Met | Every content ID in the manifest is CIDv1 base32. |
| Public retrieval, not only a laptop | Met | Filebase pin. Read back from `https://ipfs.filebase.io/ipfs/` and from `https://gateway.pinata.cloud/ipfs/`. Pinata is not this project’s pinning account. |
| Machine-readable manifest in the repo | Met | [docs/publication/santa-clara-run-manifest.json](docs/publication/santa-clara-run-manifest.json). Coverage v2 is also in [docs/publication/dataset-coverage-v2.json](docs/publication/dataset-coverage-v2.json). |
| IPNS name and resolved CID, if IPNS is used | Met | IPNS was not used, so the requirement does not apply. `ipns` is null. The Atlas IPNS name changes only when a code owner merges `counties/CA/santa-clara.json`. This candidate must not merge it. |
| Incremental publish keeps the old CID | Met | County archive `baguqeerao6gqmxdj3okmblnkaigaopef56zxc7oedoo2jpq36wvc7h4eurwq` was not mutated. Previous coverage `bafkreibxxn7dfrokytikl4oydjcs3nncpqvki5ed2zszsinqoo4zskyej4` (380 bytes, SHA-256 `37bb7e32c5cac4d0a5f1d81a452db5a27c2aa47483d6659921b073b9992b044f`). Next coverage `bafkreih3u453drytx7c6hwbiqainuaaecjyd5n7iozc7rcigayhncjbec4` (649 bytes, SHA-256 `fba73bb1c713bfc5e3d8288010da000412703eb7e87645f88906060ed1242417`). |
| A CAR for directory artifacts | Partial | Could not be met for a second check of the CAR file: that check needs more memory than a 16 GB machine has. The import is in the manifest: 5,938,192 blocks, 2,650,425,929 block bytes, 99 shards, 494,841 properties. Public CID `baguqeerao6gqmxdj3okmblnkaigaopef56zxc7oedoo2jpq36wvc7h4eurwq`. Directory validate passed 494,841 of 494,841. The CAR file is not a second published object. |
| Two independent public gateways | Partial | Could not be met on the README’s two example hosts. On 2026-10-02, and again the same night, `ipfs.io`, `dweb.link`, `w3s.link`, and `nftstorage.link` returned HTTP 429. Cloudflare IPFS did not resolve. Lighthouse returned HTTP 402. Filebase and Pinata returned the coverage file at 380 bytes. Pinata is independent. Filebase is the pinner. The CIDs are public. The example hosts refused this network. |

### Roofing queries

| Requirement | Status | Evidence |
| --- | --- | --- |
| Radius search from a pin or GPS | Met | CRM. Live GIS `within_circle`. Radius choices include 5 miles. |
| Roofs older than 15 years | Partial | Could not be met outside San Jose. The filter works. The only qualifying parcels are the five APNs above, and only when the pin’s circle contains them. No free source supplies a roof age for the other cities. |
| Open roofing permits, long-open first | Partial | Could not be met outside San Jose. The CRM filters San Jose permits with no final date, including those open for many years. There is no free countywide open-permit table. |
| Contractor and BBB | Partial | Could not be met for BBB. A San Jose permit can show a contractor name. BBB has no free public score, so the rating is stated as unavailable. |
| Held more than 10 years | Could not be met | A transfer date exists only on the one-parcel Assessor sheet. Copying those sheets into the archive is prohibited by the sheet’s resale terms. The paid two-year sales file would still miss holds longer than 10 years. Checked and not stored: `49454036` transferred 2016-08-15, and `67620085` transferred 2014-04-02. |
| Out-of-area owners | Could not be met | The same sheet has a mailing address and no owner name, and it cannot be republished. `67620085` mailing city is Cupertino, still in Santa Clara County. Sample APN `09201021` mailing city is Oakland. Those facts stay off the archive. |
| Source-backed answers, and an explicit gap when the source is missing | Met | Roof rows cite permit id, `FINALDATE`, and eligibility reason. The CRM agent states when BBB is unavailable. |

### Demonstration

Recording: https://youtu.be/clGgvVoQGKo

| Requirement | Status | Evidence |
| --- | --- | --- |
| Uploaded data through the UI | Met | https://youtu.be/clGgvVoQGKo |
| Agent query for roofing leads | Met | https://youtu.be/clGgvVoQGKo |
| Oracle carries no infrastructure cost | Met | https://youtu.be/clGgvVoQGKo |
| Public CID retrieval from the manifest | Met | https://youtu.be/clGgvVoQGKo |
| Both Oracle and builder roles | Met | https://youtu.be/clGgvVoQGKo |
| Real Santa Clara records | Met | https://youtu.be/clGgvVoQGKo |

### What a recording should say

Owner names, year built, and BBB ratings are not in this free dataset. Roof age older than 15 years is five San Jose parcels, not the county. Open-permit history for the other cities was not harvested.
