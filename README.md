# Jomove

Lightweight Southampton rental tracker. Parses agent listings collected in
markdown files into a small SQLite database and renders a sortable,
filterable static HTML dashboard.

Bun + TypeScript. One built-in DB dep (`bun:sqlite`). No build step.
The dashboard is one self-contained `dashboard.html` you open in any
browser.

## Quick start

Install Bun:

```sh
# Windows
winget install Oven-sh.Bun
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

Then:

```sh
bun install
bun run init                # create data/jomove.db
bun run ingest old_search   # parse markdown into SQLite (idempotent)
bun run report              # write dashboard.html
```

Open `dashboard.html` in a browser. Click any column header to sort,
filter from the bar at the top, click a row to expand its full notes.

## CLI queries

```sh
bun run list --max-price 1000 --parking --direct-line
bun run list --postcode SO15 --beds 1 --furnished
```

## Adding listings

Each per-source markdown file (`results_<site>.md`) uses one block per
listing:

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

Append a new block, run `bun run ingest <dir>`, then `bun run report`.
Ingest is keyed on URL — re-running updates existing rows in place.

## Scoring

Each listing gets a score out of 110 reflecting the search priorities:

| Factor | Points |
|---|---|
| Direct rail line to Central + Airport Parkway | 30 |
| Real parking (allocated / driveway / off-street) | 20 |
| Permit / on-street parking | 10 |
| Price ≤ £900 / ≤ £1000 / ≤ £1100 | 20 / 15 / 10 |
| Furnished (yes / optional / part) | 15 / 12 / 8 |
| Near a park / green space | 15 |
| EPC A or B / C | 10 / 5 |

Adjust in `src/db.ts` (`SCORE_SQL`) if your priorities change.

## Project layout

```
jomove.ts                   CLI entry — dispatches to commands
package.json                bun scripts
tsconfig.json
src/
  config.ts                 paths, source list, labels
  types.ts                  shared TS types
  db.ts                     sqlite connect, schema, scoring SQL
  field-parsers.ts          price / furnished / parking / EPC / dates
  dedupe.ts                 dedupe key + direct-rail-line detection
  markdown.ts               block-level markdown parser
  template.ts               loads template.html, substitutes variables
  template.html             dashboard HTML + embedded JS for sort/filter
  commands/
    init.ts
    ingest.ts
    list.ts
    report.ts
data/jomove.db              gitignored, rebuilt from markdown
old_search/                 archived per-portal markdown
dashboard.html              generated; commit it so others see the result
```
