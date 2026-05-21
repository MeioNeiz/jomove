# Plan — server-side scraper migration

Goal: replace the Claude `/scrape` workflow for **OpenRent, Rightmove,
OnTheMarket, Gumtree** with deterministic server-side scrapers, so the
app can run on a server on a cron and push notifications to Discord
when new listings appear.

Zoopla stays on the existing Claude `/scrape` flow for now (Cloudflare
managed challenge blocks plain fetch). Decide later: either run Claude
manually for Zoopla on a weekly cadence, or wire up Zoopla email
alerts + IMAP polling.

## Decisions locked in

- **Editorial prose** (`Why it's worth a look`, `Caveats / things to
  verify`): drop from new deterministic scrapers. Capture richer raw
  data instead — `description`, `key_features`, `agent_name` — so
  Claude can still analyse the corpus when invoked manually.
- **Deployment**: run on the user's Windows laptop first via Task
  Scheduler. Move later to existing Linux server that already runs a
  Discord bot. Stay on SQLite (Postgres is available on the server
  but not needed at this volume).
- **Notifications**: Discord webhook into the existing bot's server.
- **Schema contract**: scrapers emit `results_<portal>.md` in the
  existing format. Nothing downstream changes beyond the parser
  picking up new optional fields.

## Phases

### Phase 0 — Schema upgrade ✏️

Add raw-data fields so Claude has something to chew on later.

- `src/types.ts`: add `description?`, `key_features?: string[]`,
  `agent_name?` to `Listing`.
- `src/db.ts`: ADD COLUMN migrations for `description`,
  `key_features` (JSON text), `agent_name`.
- `src/markdown.ts`: parse new `**Description:**` paragraph block,
  `**Key features:**` bulleted block, and `- **Agent:** ...` bullet.
- `src/commands/ingest.ts`: write new columns.
- `.claude/commands/scrape.md`: extend the per-listing schema so
  Zoopla Claude scrapes also produce the richer fields.
- `src/template.html` / `src/template.ts` / `src/payload.ts`: surface
  description (collapsible) and key features in the UI. _Can be a
  follow-up — not blocking the scraper work._

### Phase 1 — Shared scraper infra 🔧

New `src/scrapers/` folder. Each module:

- `http.ts` — fetch wrapper. Realistic Chrome UA, `Accept-Language:
  en-GB`, redirect-follow, cookie jar, retry with jitter on 429/5xx,
  per-host rate limit (default 1.5 s).
- `filters.ts` — pure functions for the hard filters in
  `.claude/commands/scrape.md`: price ≤ £1,150, 1–2 beds, postcode
  area in SO14/15/17/18, available by `DEADLINE` from `config.ts`,
  not let-agreed, not student-only.
- `output.ts` — given `Listing[]`, write a `results_<portal>.md` in
  the schema the existing markdown parser eats.
- `images.ts` — drop URLs that look like floorplans/EPC certs
  (substring match on `floorplan` / `epc` / etc).

### Phase 2 — Per-portal scrapers 🌐

Ship one portal at a time. Each is independently usable.

#### 2a. OpenRent — first 🟢

- `src/scrapers/openrent.ts`
- Search URL: `https://www.openrent.co.uk/properties-to-rent/southampton?prices_max=1150&bedrooms_min=1&bedrooms_max=2`
- Extract IDs from `PROPERTYIDS = [...]` JS array inline in search
  HTML.
- For each ID: `GET /{id}` (301 → slug URL).
- Parse `og:title`, `og:description`, multiple `og:image`; regex over
  plain HTML for beds/baths/EPC/deposit/available/parking.
- Apply filters, emit `results_openrent.md`.

#### 2b. Rightmove

- Parse `<script id="__NEXT_DATA__">` on search, `window.PAGE_MODEL`
  on detail. Both give full structured JSON.

#### 2c. OnTheMarket

- Parse JSON-LD `RealEstateListing`. Respect `Crawl-delay: 1` from
  their `robots.txt`.

#### 2d. Gumtree

- Cards via `data-q` selectors; detail page via JSON-LD + og: tags.

### Phase 3 — CLI command 🎛️

- `bun jomove.ts auto-scrape [--portals=openrent,rightmove,...]`
- Runs scrapers in parallel; reports per-portal counts + errors.
- `--ingest` flag (default true): chains the existing `ingest` after.
- `--archive` flag (default true): chains the existing `archive`
  after.

### Phase 4 — Notifications + scheduling on laptop 📣

- `src/notify.ts` — Discord webhook poster. Embed per listing: title,
  price, postcode area, primary image thumbnail, link.
- `auto-scrape` queries DB after ingest for rows where `first_seen >=
  run_start_time`, posts each.
- Webhook URL in `.env` (gitignored).
- Windows Task Scheduler: `bun ... auto-scrape` every 3 hours.

### Phase 5 — Move to Linux server 🚚

- Copy `data/jomove.db` over.
- `bun install`; place repo in stable path.
- `crontab -e`: `0 */3 * * * cd /path && bun jomove.ts auto-scrape >> log 2>&1`
- Run `bun jomove.ts serve` under systemd alongside the Discord bot.

### Phase 6 — Zoopla decision 🅿️

- Option A: keep `/scrape` Claude command but narrow to Zoopla-only.
  Run weekly manually.
- Option B: Zoopla email alerts → dedicated mailbox → IMAP poller →
  fetch detail pages with paid unblocker (Bright Data Web Unlocker
  PAYG, ~£4–15/mo at this volume).

## No-regression rule for narrowing `/scrape`

For each portal, only remove it from the Claude `/scrape` command
once:

1. The deterministic scraper produces a listing count within ±20% of
   the most recent Claude scrape for that portal.
2. All previously-captured fields are present (Type, Beds/Baths,
   Furnished, Parking, EPC, Deposit, Available, Postcode area, plus
   ≥1 Image).
3. The new `description` / `key_features` / `agent_name` fields are
   populated for ≥80% of listings (won't always be there — some
   listings genuinely don't have agents etc).
4. Ingest runs clean against the file.

## Risks & maintenance notes

- **Selectors will break.** Mitigation: `auto-scrape` logs
  `SCRAPER_BROKEN` to Discord if a portal that historically produced
  ≥5 listings produces 0.
- **Rate-limit pushback.** Mitigation: per-host backoff in `http.ts`;
  if a portal sustains 403/429 the scraper marks itself unhealthy and
  the others continue.
- **Rightmove `PAGE_MODEL` schema changes.** Mitigation: defensive
  parsing — every field optional, never throw on missing.
- **Legal note.** All portals' T&Cs prohibit scraping. Personal
  hobby aggregation is the long-established grey area; not zero-risk
  if the project ever grew or got published.

## Effort estimate

- Phase 0 + 1: half a day
- Phase 2a (OpenRent + ship): 2–3 h
- Phase 2b–d: 3–4 h each
- Phase 3: 1–2 h
- Phase 4: 1–2 h
- Phase 5: an evening

**Total: 2–3 focused days of work.**

## Status

- [x] Phase 0 — schema (description / key_features / agent_name)
- [x] Phase 1 — infra (`src/scrapers/{http,filters,output,images}.ts`)
- [x] Phase 2a — OpenRent (82 listings, ~6 min)
- [x] Phase 2b — Rightmove (97 listings, ~3 min, 100% full postcode)
- [x] Phase 2c — OnTheMarket (132 listings, ~5 min)
- [x] Phase 2d — Gumtree (3 listings, ~5 min after card-pre-filter)
- [x] Phase 3 — CLI (`bun jomove.ts auto-scrape`)
- [x] `/scrape` Claude command narrowed to Zoopla-only
- [x] Phase 4a — Email notify module (`src/notify.ts`, nodemailer + SMTP via .env)
- [x] Phase 4b — Windows Task Scheduler: `Jomove auto-scrape` hourly via `scripts/auto-scrape.cmd`. Logs to `data/logs/auto-scrape-YYYY-MM-DD.log`. Uses `--no-archive` for scheduled runs (DB is authoritative).
- [ ] Phase 5 — Move to Linux server (crontab + systemd)
- [x] Phase 6 — Zoopla: **decided to skip** (2026-05-21). Rightmove + OnTheMarket cover most overlap. Pure-Zoopla listings ~5–10% of inventory; not worth the engineering cost given Cloudflare's hard block. `/scrape` Claude command remains as an optional manual fallback if you ever want a one-off Zoopla refresh.

## Phase 6 — Zoopla investigation (2026-05-21)

### What I tried (all blocked)

- `bun fetch` with realistic Chrome headers → **403 + `cf-mitigated: challenge`**
- `bun fetch` against `m.zoopla.co.uk`, `static.zoopla.co.uk`, `prod-aem.zoopla.co.uk`, `/api/v1/property/listing/{id}`, `/xmlsitemap/sitemap/...gz` → **all 403**
- `curl` from the shell with full sec-ch-* headers → **same 403**

The blocker is Cloudflare's **managed challenge** — the response is a JS-bearing interstitial ("Just a moment...") that has to execute the orchestrate script to mint a `cf_clearance` cookie. Without a real browser executing JS, every request is dead at the edge. This is a TLS-fingerprint-plus-JS challenge, not just a UA check, so no header tricks or `curl-impersonate`-style spoofing reliably defeats it.

### Free options that COULD work

1. **Manual cookie capture** — once a month, you open Zoopla in Chrome, copy the `cf_clearance` cookie + matching User-Agent into `.env`. Scraper forwards them. Cheap, no deps. Cookie typically lasts ~30 days and rotates as you browse. Breaks the moment Cloudflare rotates challenge configs or you change networks. Bit hacky.
2. **Playwright + UK residential IP (your laptop)** — drives a real Chromium that auto-solves the JS challenge. Works on your residential UK IP. Heavyweight (~300MB Chromium install). On the Linux server's datacentre IP, Cloudflare may flag it as a bot regardless and challenge with Turnstile (which doesn't auto-solve). So this likely works on the laptop but breaks after Phase 5 (move to server) unless paired with a residential proxy.
3. **Zoopla email alerts → IMAP poller** — set up a saved-search alert on Zoopla, get fresh listings emailed to a dedicated inbox / Gmail filter. The emails themselves contain title, price, address, image thumbnail and link. Poll IMAP, parse the email HTML, ingest. No CF bypass needed. Robust on any IP including the Linux server. Requires user setup (Zoopla account + saved search + email filter) and the IMAP-parsing code (~150 lines).

### Paid options (last resort)

4. **Bright Data Web Unlocker, PAYG** — ~£4–15/mo at this volume. Drop-in proxy, returns HTML.
5. **Apify Zoopla actor** — ~£5–20/mo, similar.

### Decision: skip

Going without Zoopla. Most Zoopla listings appear on Rightmove or OnTheMarket via the same agent; pure-Zoopla inventory is small enough that the engineering and maintenance cost (managing residential proxies, a Playwright Chromium install on the Linux server, or a fragile cookie-capture workflow) isn't justified.

Existing Zoopla rows in the DB will naturally age out via `bun jomove.ts prune` (marks unseen rows as `let_agreed` after 7 days). The `/scrape` Claude command stays as an optional manual fallback if you ever want a one-off Zoopla refresh, but it's not part of the regular schedule.

### Phase 2a notes (2026-05-21)

- Search URL filters by `prices_max=1150&bedrooms_min=1&bedrooms_max=2` — 234 IDs returned from `PROPERTYIDS`.
- 82 pass hard filters (price/beds/postcode/available/student-only/let-agreed). 152 skipped (price > £1,150, wrong postcode area, etc), 0 errors.
- Field coverage: Link/Type/Beds-Baths/Furnished/Parking/Deposit/Available/Postcode area = 100%. EPC = 41% (only when landlord lists it). Postcode (full) = 15% (OpenRent typically only shows area). Images = 78% (some listings have zero photos). Agent = 0% (landlord-direct).
- New description field: 100% coverage. Key features: 84%.
- Listings are roughly 2× the previous Claude scrape (which only processed a sample). No fields dropped vs Claude — adds description, key_features instead of why_worth_a_look / caveats.

### No-regression: all 4 ✅ (2026-05-21)

Full sweep (`bun jomove.ts auto-scrape`):

| Portal      | Written | Skipped | Errors | Runtime  | Notes                                  |
|-------------|---------|---------|--------|----------|----------------------------------------|
| OpenRent    | 83      | 151     | 0      | (in-parallel) | landlord-direct, no `agent_name`  |
| Rightmove   | 97      | 301     | 0      | (in-parallel) | 100% full postcode + description  |
| OnTheMarket | 132     | 149     | 0      | (in-parallel) | richest listing count, low full-pc|
| Gumtree     | 3       | 471     | 0      | (in-parallel) | small market for our filters      |
| **Total**   | **315** | 1,072   | 0      | 354s     | parallel max, dominated by OpenRent   |

Ingest: 42 new, 300 updated across the 4 portals (plus the existing
`results_zoopla.md` carried forward). Archive: snapshot saved to
`scrapes/2026-05-21-10-41-scrape-server/`.

`.claude/commands/scrape.md` narrowed to Zoopla-only.
