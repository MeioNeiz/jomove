# Jomove audit — findings & task plan

Generated 2026-05-21. Findings from a full read of the codebase
(`jomove.ts`, all of `src/**`, `src/template.html`, configs, deploy bits).

## Architecture at a glance

```
scrapers/*.ts ──► results_<portal>.md ──► markdown.ts ──► SQLite (listings)
                                                          │
                                                          ├──► payload.ts ──► template.html (server-rendered)
                                                          │                       │
                                                          └────────── /api/listings (polled every 5s)
```

The roundtrip through markdown files is the central architectural choice
that drives a lot of the friction.

---

## Bugs (correctness, ordered by impact)

- **B1.** Postcode regex ⇄ SCORE_SQL mismatch — SO16/SO50 listings lose
  scoring bonuses silently. `src/field-parsers.ts:45-49`,
  `src/db.ts:86-149`, `src/scrapers/filters.ts:13`.
- **B2.** Two sources of truth for the move-in deadline
  (`src/db.ts:84` vs `src/config.ts:10`).
- **B3.** `parseListingType` can return `"house"` but downstream
  (badges, beds filter) doesn't handle it — listings filtered out.
  `src/field-parsers.ts:74-82`, `src/template.html:1097, 1251-1256`.
- **B4.** Dashboard polling never picks up `prune` / `verify` / status
  flips because `dataVersion` uses `MAX(last_seen)` which isn't bumped
  by those operations. `src/payload.ts:18-23`,
  `src/template.html:1838-1871`.
- **B5.** `directLine` heuristic — "not on the direct line; change at
  St Denys" still scores as direct. `src/dedupe.ts:18-25`.
- **B6.** `postcodeBand` regex `[12355]` has a duplicate `5` — was
  meant `[12345]`. `src/template.html:965`.
- **B7.** Both `esc()` implementations miss `"` and `'`. Listings with
  quotes in addresses corrupt attributes (and are a latent XSS surface
  if scrapers ever pulled untrusted data). `src/template.ts:85-90`,
  `src/template.html:805-807`.
- **B8.** Migrations aren't transactional — rating-doubling can apply
  twice if a crash hits between UPDATE and sentinel INSERT.
  `src/db.ts:173-222`.
- **B9.** Ingest writes 300+ rows outside a transaction — slow + not
  atomic. `src/commands/ingest.ts:99-110`.
- **B10.** `escBlock` doesn't escape `## ` lines — a description
  starting with `##` swallows subsequent fields.
  `src/scrapers/output.ts:39-45`.
- **B11.** HTTP rate-limit has a race when called concurrently for the
  same host. `src/scrapers/http.ts:75-100`.
- **B12.** `extractPageModel` end-of-JSON detector is fragile.
  `src/scrapers/rightmove.ts:104-114`.
- **B13.** Set-Cookie comma split corrupts cookies with commas in
  values. `src/scrapers/http.ts:56-67`.
- **B14.** Cost-overrides validation has 3 near-duplicate
  implementations that disagree on length-clipping.
  `src/cost.ts`, `src/payload.ts:30-48`, `src/commands/serve.ts:131-146`,
  `src/template.html:814-828`.
- **B15.** Gumtree "address" is actually the title.
  `src/scrapers/gumtree.ts:232-236`.
- **B16.** Geocoder uses multiple DB handles concurrently — wasteful;
  rare risk of SQLITE_BUSY. `src/geocode.ts:249-263`.
- **B17.** `available_date` parser silently mis-reads non-UK formats.
  `src/field-parsers.ts:100-108`.
- **B18.** `/api/app-state/:key` accepts arbitrary keys — anyone with
  HTTP access can pollute migration sentinels.
  `src/commands/serve.ts:233-252`.

## Maintainability

- **M1.** `template.html` is 1885 lines of mixed HTML/CSS/JS — by far
  the biggest tax. Split into CSS/TS/HTML.
- **M2.** Markdown roundtrip is unnecessary for `auto-scrape`. Scrapers
  produce typed `ScrapedListing` objects, then serialise to MD just to
  re-parse them. `src/scrapers/output.ts`, `src/markdown.ts`,
  `src/commands/ingest.ts`.
- **M3.** Adding a portal touches ~5 files. The 4 scrapers all
  duplicate `ScrapeReport`. Refactor → one `PortalConfig` per portal.
- **M4.** Adding a listing field touches ~10 files. Field-definition
  registry would collapse this. Interim win: merge ingest INSERT/UPDATE
  into `ON CONFLICT DO UPDATE`.
- **M5.** Magic-string vocab everywhere (`"active"`, `"let_agreed"`,
  `"yes"`, `"allocated"`…). Make them union types.
- **M6.** Duplicated helpers: `nowIso` (5 copies), `esc` (3 copies,
  different rules), `decodeHtml` (4 copies), JSON-LD extractor (3
  copies). Pull into `src/util/*`.
- **M7.** `SCORE_SQL` is a giant untestable string. Move scoring to TS.
- **M8.** Cruft committed at root: `results_*.md`, `plan.md`,
  `old_search/`. Move under `data/scrapes/current/` (gitignored).
- **M9.** No tests at all. Even a tiny `bun test` suite around
  parsers/dedupe/cost would pay back fast.

## Performance

- **P1.** Polling re-builds the entire payload every 5s regardless of
  whether anything changed. Add `/api/version` + ETag.
- **P2.** Template file read on every page render. Cache once.
- **P3.** `connect()` opens a new SQLite handle per request — also see
  B16. Hold one handle for the server's lifetime.
- **P4.** No HTTP compression. ~100 KB payload every 5s, every poll.
- **P5.** Frontend rebuilds all card DOM on every poll, even for tiny
  changes. Diff per-row.
- **P6.** SCORE_SQL recomputed on every list query — fine at 300 rows,
  matters at 30k.
- **P7.** Leaflet loaded from CDN — vendor it.
- **P8.** `migrate()` probes 4 tables on every `connect()`. Gate on a
  schema-version flag.

---

## Task plan

### Phase 1 — quick wins, low risk

- [x] **T1** B1: widen postcode regex + scraper filters to match
  SCORE_SQL (SO16, SO50)
- [x] **T2** B2: single source of truth for `DEADLINE`
- [x] **T3** B6: fix `postcodeBand` duplicate `5` in regex
- [x] **T4** B7: escape `"` and `'` in both `esc()`s
- [x] **T5** B9: wrap ingest in `db.transaction(...)`
- [x] **T6** M6: pull `nowIso`, `esc`, `decodeHtml` into shared utils
- [x] **T7** P2: cache `template.html` at module load
- [x] **T8** P3 + B16: hold one DB handle for server lifetime
- [x] **T9** P1: `/api/version` endpoint + smarter client polling
- [x] **T10** P8: gate migrate on schema-version sentinel
- [x] **T11** B7 extra: fix dataVersion to include note/status updates
  (covers B4)

### Phase 2 — meaningful refactors

- [x] **T12** M2: direct-ingest path (`ingestListings(db, listings)`)
  used by auto-scrape, MD path delegates to it
- [x] **T13** M4 (interim): collapse ingest INSERT/UPDATE into
  `ON CONFLICT DO UPDATE`
- [x] **T14** M3: `PORTALS` registry consumed by auto-scrape +
  http-check + config labels
- [x] **T15** M1: extract CSS and JS from `template.html` into
  separate served files

### Phase 3 — stretch

- [x] **T16** M7: move SCORE_SQL into `src/score.ts` (TS)
- [x] **T17** M9: `bun test` suite around pure functions
- [x] **T18** P5: incremental polling diffs (only re-render changed
  rows)

### Side-fixes done as part of the refactors

- B3 (parseListingType "house"): handled by adding `house` to badge
  rendering + bedsFilter and accepting houses through scrapers
  (decision: keep "house" as first-class).
- B10 (`escBlock` `##` lines): output.ts escape extended.
- B12, B13, B17, B18: fixed where touched.
- B14: cost-overrides validation consolidated into one shared module.
- P4 (gzip): added via Bun-aware Accept-Encoding handler.

---

## Implementation result

All 18 tasks across the 3 phases landed. Headline outcomes:

- Type-clean (`bunx tsc --noEmit` passes, including 2 pre-existing strictness
  issues fixed in passing).
- `bun test` — 37 tests / 65 expects / 0 fails across `dedupe`, `field-parsers`,
  `cost`, `score`.
- Smoke-tested live: ingest is idempotent, `/api/version` ETag round-trips,
  status mutations bump dataVersion, dashboard scaffold loads CSS/JS
  correctly.
- Two extra bugs caught by the test suite and fixed: `parseFurnished("not
  specified")` was returning `"no"` (now `"unclear"`), and
  `parsePostcodeFull("SO171BJ")` wasn't normalising whitespace (now returns
  `"SO17 1BJ"`).
- One regression caught by smoke testing and fixed: the background
  geocoder used to `db.close()` the handle it received, which killed the
  newly-shared long-lived connection. Reworked to accept either a fresh
  factory (CLI) or an existing Database (server).

## Open questions / blockers

(Listed at the end of the implementation message.)
