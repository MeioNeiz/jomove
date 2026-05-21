# Jomove

Lightweight Southampton rental tracker. Parses agent listings from
markdown into SQLite and renders a sortable, filterable static HTML
dashboard with favourites / ratings / comments persisted in your
browser.

Bun + TypeScript. One built-in DB dep (`bun:sqlite`). No build step.
Dashboard is served by a tiny `bun run dev` server that re-renders on
each request and hot-reloads code changes.

## Quick start

```sh
# Windows
winget install Oven-sh.Bun
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

```sh
bun install
bun run ingest old_search    # one-time: load historical scrapes into SQLite
bun run dev                  # serves http://localhost:3000 — leave running
# in another terminal whenever you want fresh data:
bun run ingest current_search
# → browser shows new data on next poll, no refresh needed
```

## Commands

```sh
bun run init                       # create data/jomove.db
bun run ingest <dir-or-file>       # parse markdown into SQLite (idempotent, keyed on URL)
bun run dev                        # live server on :3000 with hot reload (= bun run serve without --hot)
bun run archive --label NAME       # snapshot root results_*.md → scrapes/<timestamp>-NAME/
bun run prune --days 7             # mark listings unseen for 7+ days as `let_agreed`
bun run prune --days 7 --dry-run   # preview without writing
bun run list --postcode SO17 --furnished --parking
```

## Scrape workflow

Each scrape gets preserved as a snapshot directory. Typical loop:

```sh
# 1. Spawn agents to write fresh markdown into the root results_*.md files
#    (this is the part Claude orchestrates — see the existing per-portal prompts)

# 2. Ingest the new data
bun run ingest .

# 3. Snapshot this run before the next one
bun run archive --label refresh

# 4. (optional) flag listings missing from the latest scrape
bun run prune --days 7
```

After step 3, `scrapes/<timestamp>-<label>/` holds those markdown files
forever and root is empty for the next scrape. The DB has accumulated
data from every ingest; no listing is lost.

`ingest` accepts directories (scans for `results_*.md`) or specific
files. Re-running updates rows in place by `source_url`.

## Dashboard

Open `http://localhost:3000` and:

- **Filter** by postcode, beds, max price, fuzzy text search, must-have flags
  (furnished / parking / direct rail), favourites-only, hide-viewed, new-only,
  show-let-agreed.
- **Sort** by score, price, your rating, newest first, address.
- **★ favourite** a listing, **✓** mark as viewed, **⇄** add to compare
  (up to 2). Click *Compare (2/2)* to open a side-by-side modal.
- **Rate** 1–5 stars and leave **comments** per listing — persisted in
  SQLite, keyed on the dedupe key (survives re-ingest).
- **NEW** badges appear on listings whose `first_seen` is later than your
  last visit. *Mark all seen* clears them.
- **LET AGREED** badges appear on listings flagged by `bun run prune`.

State lives in SQLite (`data/jomove.db`, tables `user_notes` and
`app_state`). Delete the rows to reset.

## Scoring

Each listing gets a score out of ~103. Tuned for: cycle distance to the
airport, walkable home from city-centre nightlife, a car (so direct rail
is a small nudge, not a vote-decider).

| Factor | Points |
|---|---|
| Price ≤ £900 / £900–1000 / £1000–1100 | 20 / 15 / 10 |
| Furnished (yes/optional/part) | 15 |
| Furnished unclear | 7 |
| Any parking (allocated/driveway/off-street/permit/on-street) | 10 |
| Parking unclear | 5 |
| Direct rail line | 10 |
| Postcode **sweet spot** (SO17 1/2/3 — Portswood/Highfield) | 20 |
| Postcode **central but OK** (SO15 1/2, SO14 0/6/7) | 10 |
| Postcode SO15/SO14 (area only, no sector) | 5 |
| Postcode SO15 3/5/7/8, SO14 1/2/3/5, SO18 | 0 (penalised) |
| Near Southampton Common specifically | 10 |
| EPC A or B | 8 |
| EPC C | 4 |

Edit `src/db.ts` (`SCORE_SQL`) to retune.

## Adding new listings

Format used in `results_<portal>.md`:

```
## <Address> — £<price> pcm
- **Link:** <direct URL>
- **Beds/Baths:** 1 bed, 1 bath
- **Furnished:** Yes
- **Parking:** allocated
- **EPC:** C
- **Deposit:** £1,000
- **Available:** 8 June 2026
- **Postcode area:** SO15 (Hill Lane)
- **Near green space:** Southampton Common ~5 min walk
- **Rail access:** Central ~15 min walk (direct Airport Parkway line)
- **Why it's worth a look:** ...
- **Caveats / things to verify:** ...

---
```

Drop new blocks into the right file, then:

```sh
bun run ingest .
bun run prune --days 7    # mark stale listings as let_agreed
```

## Project layout

```
jomove.ts                   CLI entry, dispatches to commands
package.json                bun scripts
tsconfig.json
src/
  config.ts                 paths, source list, labels
  types.ts                  shared TS types
  db.ts                     sqlite connect, schema, SCORE_SQL
  field-parsers.ts          price / furnished / parking / EPC / dates
  dedupe.ts                 dedupe key + direct-line detector
  markdown.ts               block-level markdown parser
  template.ts               loads template.html, substitutes variables
  template.html             dashboard markup + embedded JS (sort/filter/state/polling)
  payload.ts                builds the dashboard payload from SQLite
  commands/
    init.ts
    ingest.ts
    list.ts
    prune.ts
    serve.ts                dev server: serves / + /api/listings
data/jomove.db              gitignored, rebuilt from markdown
old_search/                 archived per-portal markdown
private/, local/, personal/ gitignored — drop local-only scratch here
```
