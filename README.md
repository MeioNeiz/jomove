# Jomove

Lightweight Southampton rental tracker. Parses agent listings collected in
markdown files into a small SQLite database and renders a sortable,
filterable static HTML dashboard.

No frameworks. Python 3.10+ stdlib only. No build step. The dashboard is
one self-contained `dashboard.html` you can open in any browser or host
anywhere.

## Quick start

```sh
python jomove.py init        # create data/jomove.db
python jomove.py ingest      # parse results_*.md → SQLite
python jomove.py report      # write dashboard.html
```

Open `dashboard.html` in a browser. Sort by clicking a column header,
filter from the bar at the top, click any row to expand the full notes.

## CLI queries

```sh
python jomove.py list --max-price 1000 --parking --direct-line
python jomove.py list --postcode SO15 --beds 1 --furnished
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

Append a new block, run `jomove ingest`, then `jomove report`. Ingest is
idempotent — re-running updates existing listings keyed by URL.

## Scoring

Each listing gets a score out of 110 based on these weights, reflecting
the search priorities:

| Factor | Points |
|---|---|
| Direct rail line to Central + Airport Parkway | 30 |
| Real parking (allocated / driveway / off-street) | 20 |
| Permit / on-street parking | 10 |
| Price ≤ £900 / ≤ £1000 / ≤ £1100 | 20 / 15 / 10 |
| Furnished (yes / optional / part) | 15 / 12 / 8 |
| Near a park / green space | 15 |
| EPC A or B / C | 10 / 5 |

Adjust in `SCORE_SQL` if your priorities change.

## Files

| Path | Purpose |
|---|---|
| `jomove.py` | All the code (CLI + parser + HTML renderer) |
| `results_*.md` | Source-of-truth markdown per portal |
| `data/jomove.db` | SQLite, gitignored — rebuilt from markdown |
| `dashboard.html` | Generated, committable so others can view without running |
| `dashboard.md` | Older curated digest, kept for reference |
