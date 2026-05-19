#!/usr/bin/env python3
"""jomove — lightweight Southampton rental tracker.

Subcommands:
    init     create empty SQLite DB at data/jomove.db
    ingest   parse results_*.md files into SQLite (idempotent)
    report   render dashboard.html from SQLite
    list     query active listings from the CLI

Zero runtime deps beyond Python 3.10+ stdlib.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sqlite3
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "jomove.db"
HTML_OUT = ROOT / "dashboard.html"

SOURCES = {
    "results_openrent.md":    "openrent",
    "results_rightmove.md":   "rightmove",
    "results_zoopla.md":      "zoopla",
    "results_onthemarket.md": "onthemarket",
    "results_gumtree.md":     "gumtree",
}

SOURCE_LABELS = {
    "openrent":    "OpenRent",
    "rightmove":   "Rightmove",
    "zoopla":      "Zoopla",
    "onthemarket": "OnTheMarket",
    "gumtree":     "Gumtree",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source              TEXT    NOT NULL,
    source_url          TEXT    NOT NULL UNIQUE,
    address             TEXT    NOT NULL,
    price_pcm           INTEGER NOT NULL,
    beds                INTEGER,
    baths               INTEGER,
    furnished_raw       TEXT,
    furnished_status    TEXT,
    parking_raw         TEXT,
    parking_status      TEXT,
    epc                 TEXT,
    deposit             INTEGER,
    available_raw       TEXT,
    available_date      TEXT,
    postcode_area       TEXT,
    postcode_full       TEXT,
    neighbourhood       TEXT,
    near_green_space    TEXT,
    rail_access         TEXT,
    on_direct_line      INTEGER,
    why_worth_a_look    TEXT,
    caveats             TEXT,
    dedupe_key          TEXT,
    first_seen          TEXT NOT NULL,
    last_seen           TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_dedupe   ON listings(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_postcode ON listings(postcode_area);
CREATE INDEX IF NOT EXISTS idx_price    ON listings(price_pcm);
"""

# --- ranking ---
# weights reflect the user's stated priorities:
#   direct rail line (30)  >  parking quality (20)  =  price band (20)
#   >  furnished (15)  =  green space (15)  >  EPC (10)
SCORE_SQL = """
(CASE WHEN on_direct_line = 1 THEN 30 ELSE 0 END) +
(CASE WHEN near_green_space IS NOT NULL
       AND near_green_space != ''
       AND LOWER(TRIM(near_green_space)) NOT IN ('no','none','n/a') THEN 15 ELSE 0 END) +
(CASE
   WHEN parking_status IN ('allocated','off-street','driveway') THEN 20
   WHEN parking_status IN ('permit','on-street')                THEN 10
   WHEN parking_status = 'unclear'                              THEN 5
   ELSE 0
 END) +
(CASE
   WHEN furnished_status = 'yes'      THEN 15
   WHEN furnished_status = 'optional' THEN 12
   WHEN furnished_status = 'part'     THEN 8
   WHEN furnished_status = 'unclear'  THEN 5
   ELSE 0
 END) +
(CASE
   WHEN price_pcm <= 900  THEN 20
   WHEN price_pcm <= 1000 THEN 15
   WHEN price_pcm <= 1100 THEN 10
   ELSE 0
 END) +
(CASE
   WHEN epc IN ('A','B') THEN 10
   WHEN epc = 'C'        THEN 5
   ELSE 0
 END)
"""

# ---------- parsing helpers ----------

FIELD_RE = re.compile(r"^-\s+\*\*([^:*]+):\*\*\s+(.+?)\s*$", re.MULTILINE)


def parse_price(s: str) -> int:
    return int(s.replace(",", "").strip())


def parse_beds_baths(s: str) -> tuple[int | None, int | None]:
    if not s:
        return None, None
    m_b  = re.search(r"(\d+)\s*bed",  s.lower())
    m_ba = re.search(r"(\d+)\s*bath", s.lower())
    return (int(m_b.group(1)) if m_b else None,
            int(m_ba.group(1)) if m_ba else None)


def parse_furnished(s: str) -> str:
    if not s:
        return "unclear"
    sl = s.lower().strip()
    if sl.startswith("yes"):       return "yes"
    if sl.startswith("optional"):  return "optional"
    if "part" in sl:               return "part"
    if sl.startswith("no"):        return "no"
    if "check" in sl or "unclear" in sl:
        return "unclear"
    return "unclear"


def parse_parking(s: str) -> str:
    if not s:
        return "unclear"
    sl = s.lower()
    if "no parking" in sl or "not available" in sl or sl.startswith("not included") or sl.startswith("none"):
        return "none"
    if "allocated" in sl:                          return "allocated"
    if "driveway"  in sl:                          return "driveway"
    if "off-street" in sl or "off street" in sl:   return "off-street"
    if "residents" in sl:                          return "off-street"
    if "permit"    in sl:                          return "permit"
    if "on-street" in sl or "on street" in sl:     return "on-street"
    return "unclear"


def parse_postcode_area(s: str) -> str | None:
    if not s:
        return None
    m = re.search(r"\bSO(1[4578])\b", s.upper())
    return f"SO{m.group(1)}" if m else None


def parse_postcode_full(s: str) -> str | None:
    if not s:
        return None
    m = re.search(r"\bSO\d{1,2}\s*\d[A-Z]{2}\b", s.upper())
    return re.sub(r"\s+", " ", m.group(0)) if m else None


def parse_deposit(s: str) -> int | None:
    if not s:
        return None
    m = re.search(r"£\s?([\d,]+(?:\.\d{1,2})?)", s)
    if not m:
        return None
    try:
        return int(float(m.group(1).replace(",", "")))
    except ValueError:
        return None


_EPC_RE = re.compile(r"\b([A-G])\b")


def parse_epc(s: str) -> str | None:
    if not s:
        return None
    sl = s.lower()
    if "not listed" in sl or "pending" in sl or "being obtained" in sl:
        return None
    m = _EPC_RE.search(s.upper())
    return m.group(1) if m else None


_MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()


def parse_available(s: str) -> tuple[str | None, str | None]:
    """Return (raw, iso-yyyy-mm-dd or None). 'Now'/'Immediately' → today."""
    if not s:
        return None, None
    raw = s.strip()
    sl = raw.lower()
    if any(t in sl for t in ("immediate", "available now", "now")):
        return raw, date.today().isoformat()
    # strip trailing parenthetical
    core = raw.split("(")[0].strip().split("—")[0].strip()
    for fmt in ("%d %b %Y", "%d %B %Y", "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            return raw, datetime.strptime(core, fmt).date().isoformat()
        except ValueError:
            pass
    m = re.search(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", raw)
    if m and m.group(2)[:3].lower() in _MONTHS:
        try:
            return raw, datetime.strptime(
                f"{m.group(1)} {m.group(2)[:3]} {m.group(3)}", "%d %b %Y"
            ).date().isoformat()
        except ValueError:
            pass
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
    if m:
        try:
            return raw, date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass
    return raw, None


def direct_line(rail_text: str | None) -> int:
    """1 if the rail field implies a direct route Central ↔ Airport Parkway."""
    if not rail_text:
        return 0
    t = rail_text.lower()
    if "not direct" in t or "netley" in t or "requires change" in t or "needs a change" in t:
        return 0
    if "not on" in t and "direct" in t:
        return 0
    if any(stn in t for stn in ("central", "st denys", "swaythling", "airport parkway")):
        return 1
    return 0


_STRIP_PREFIX_RE = re.compile(
    r"^\s*(?:\d+\s*bed\s*(?:flat|apartment|maisonette)\s*,?\s*|"
    r"flat\s+\d+\s*,?\s*|apartment\s+\d+\s*,?\s*|apt\s+\d+\s*,?\s*|"
    r"\d+\s+)",
    re.IGNORECASE,
)


def dedupe_key(address: str, price: int, postcode_area: str | None) -> str:
    a = address.lower()
    a = _STRIP_PREFIX_RE.sub("", a)
    a = re.sub(r",?\s*southampton\s*,?", "", a)
    a = re.sub(r",?\s*so\d{1,2}\s*\d?[a-z]{0,2}\s*$", "", a, flags=re.IGNORECASE)
    a = a.strip(", ").strip()
    chunk = a.split(",")[0].strip()
    pc = postcode_area or ""
    return f"{chunk}|{pc}|{price}"


def parse_file(path: Path, source_name: str) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    listings = []
    blocks = re.split(r"\n(?=## )", text)
    for block in blocks:
        if not block.startswith("## "):
            continue
        header = block.split("\n", 1)[0][3:]
        m = re.match(r"^(.+?)\s+—\s+£([\d,]+)\s+pcm", header)
        if not m:
            continue
        address = m.group(1).strip()
        price = parse_price(m.group(2))
        fields: dict[str, str] = {}
        for fm in FIELD_RE.finditer(block):
            fields[fm.group(1).strip()] = fm.group(2).strip()
        link = fields.get("Link", "").strip()
        # strip markdown link wrappers if any: [text](url)
        m_link = re.match(r"^\[.*?\]\((.+?)\)\s*$", link)
        if m_link:
            link = m_link.group(1)
        if not link or not link.startswith("http"):
            continue
        beds, baths = parse_beds_baths(fields.get("Beds/Baths", ""))
        furn_raw = fields.get("Furnished", "")
        park_raw = fields.get("Parking", "")
        avail_raw, avail_iso = parse_available(fields.get("Available", ""))
        pc_text = (fields.get("Postcode area", "") + " " + address)
        pc_area = parse_postcode_area(pc_text)
        pc_full = parse_postcode_full(pc_text)
        listings.append({
            "source":           source_name,
            "source_url":       link,
            "address":          address,
            "price_pcm":        price,
            "beds":             beds,
            "baths":            baths,
            "furnished_raw":    furn_raw,
            "furnished_status": parse_furnished(furn_raw),
            "parking_raw":      park_raw,
            "parking_status":   parse_parking(park_raw),
            "epc":              parse_epc(fields.get("EPC", "")),
            "deposit":          parse_deposit(fields.get("Deposit", "")),
            "available_raw":    avail_raw,
            "available_date":   avail_iso,
            "postcode_area":    pc_area,
            "postcode_full":    pc_full,
            "neighbourhood":    fields.get("Postcode area", ""),
            "near_green_space": fields.get("Near green space", ""),
            "rail_access":      fields.get("Rail access", ""),
            "on_direct_line":   direct_line(fields.get("Rail access", "")),
            "why_worth_a_look": fields.get("Why it's worth a look", ""),
            "caveats":          fields.get("Caveats / things to verify", ""),
            "dedupe_key":       dedupe_key(address, price, pc_area),
        })
    return listings


# ---------- db ----------

def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    con.row_factory = sqlite3.Row
    return con


# ---------- commands ----------

def cmd_init(_args) -> int:
    connect().close()
    print(f"Initialised database at {DB_PATH}")
    return 0


def cmd_ingest(_args) -> int:
    con = connect()
    now = datetime.now().isoformat(timespec="seconds")
    inserted = updated = skipped = 0
    for fname, source in SOURCES.items():
        path = ROOT / fname
        if not path.exists():
            continue
        for L in parse_file(path, source):
            existing = con.execute(
                "SELECT id FROM listings WHERE source_url = ?", (L["source_url"],)
            ).fetchone()
            if existing:
                con.execute(
                    """UPDATE listings SET
                       address=:address, price_pcm=:price_pcm, beds=:beds, baths=:baths,
                       furnished_raw=:furnished_raw, furnished_status=:furnished_status,
                       parking_raw=:parking_raw, parking_status=:parking_status,
                       epc=:epc, deposit=:deposit, available_raw=:available_raw,
                       available_date=:available_date, postcode_area=:postcode_area,
                       postcode_full=:postcode_full, neighbourhood=:neighbourhood,
                       near_green_space=:near_green_space, rail_access=:rail_access,
                       on_direct_line=:on_direct_line, why_worth_a_look=:why_worth_a_look,
                       caveats=:caveats, dedupe_key=:dedupe_key, last_seen=:last_seen
                       WHERE source_url=:source_url""",
                    {**L, "last_seen": now},
                )
                updated += 1
            else:
                con.execute(
                    """INSERT INTO listings (source, source_url, address, price_pcm, beds, baths,
                       furnished_raw, furnished_status, parking_raw, parking_status, epc, deposit,
                       available_raw, available_date, postcode_area, postcode_full, neighbourhood,
                       near_green_space, rail_access, on_direct_line, why_worth_a_look, caveats,
                       dedupe_key, first_seen, last_seen)
                       VALUES (:source, :source_url, :address, :price_pcm, :beds, :baths,
                       :furnished_raw, :furnished_status, :parking_raw, :parking_status, :epc, :deposit,
                       :available_raw, :available_date, :postcode_area, :postcode_full, :neighbourhood,
                       :near_green_space, :rail_access, :on_direct_line, :why_worth_a_look, :caveats,
                       :dedupe_key, :first_seen, :last_seen)""",
                    {**L, "first_seen": now, "last_seen": now},
                )
                inserted += 1
    con.commit()
    con.close()
    print(f"Ingest done: {inserted} new, {updated} updated, {skipped} skipped")
    return 0


def cmd_list(args) -> int:
    con = connect()
    where = ["status = 'active'"]
    params: dict = {}
    if args.max_price:
        where.append("price_pcm <= :max_price"); params["max_price"] = args.max_price
    if args.postcode:
        where.append("postcode_area = :pc");      params["pc"] = args.postcode.upper()
    if args.beds:
        where.append("beds = :beds");             params["beds"] = args.beds
    if args.furnished:
        where.append("furnished_status IN ('yes','optional','part')")
    if args.parking:
        where.append("parking_status IN ('allocated','off-street','driveway')")
    if args.direct_line:
        where.append("on_direct_line = 1")
    sql = (f"SELECT *, {SCORE_SQL} AS score FROM listings "
           f"WHERE {' AND '.join(where)} ORDER BY score DESC, price_pcm ASC")
    rows = con.execute(sql, params).fetchall()
    con.close()
    if not rows:
        print("(no matches)")
        return 0
    print(f"{'£/mo':>6}  {'Beds':<4}  {'PC':<5}  {'Parking':<10}  "
          f"{'EPC':<3}  {'Score':>5}  Address")
    print("-" * 100)
    for r in rows:
        print(f"  £{r['price_pcm']:>4}  "
              f"{(str(r['beds']) + 'b') if r['beds'] is not None else '?b':<4}  "
              f"{r['postcode_area'] or '?':<5}  "
              f"{(r['parking_status'] or '?'):<10}  "
              f"{(r['epc'] or '?'):<3}  "
              f"{r['score']:>5}  "
              f"{r['address']}")
        print(f"          {r['source_url']}")
    return 0


# ---------- HTML rendering ----------

def _e(s):
    return html.escape(s or "")


def cmd_report(_args) -> int:
    con = connect()
    rows = con.execute(
        f"SELECT *, {SCORE_SQL} AS score FROM listings WHERE status='active' "
        f"ORDER BY score DESC, price_pcm ASC"
    ).fetchall()

    # group by dedupe_key
    groups: dict[str, list[sqlite3.Row]] = {}
    for r in rows:
        groups.setdefault(r["dedupe_key"], []).append(r)

    by_source = dict(con.execute(
        "SELECT source, COUNT(*) FROM listings WHERE status='active' GROUP BY source"
    ).fetchall())
    total = sum(by_source.values())
    unique = len(groups)
    con.close()

    payload = []
    for key, items in groups.items():
        # primary listing: prefer OpenRent (no fees), else cheapest, else first
        primary = next((r for r in items if r["source"] == "openrent"), None) or \
                  sorted(items, key=lambda r: r["price_pcm"])[0]
        sources = [{"src": r["source"], "url": r["source_url"]} for r in items]
        payload.append({
            "id":            primary["id"],
            "score":         primary["score"],
            "address":       primary["address"],
            "price":         primary["price_pcm"],
            "beds":          primary["beds"],
            "baths":         primary["baths"],
            "furnished":     primary["furnished_status"] or "unclear",
            "furnished_raw": primary["furnished_raw"] or "",
            "parking":       primary["parking_status"] or "unclear",
            "parking_raw":   primary["parking_raw"] or "",
            "epc":           primary["epc"] or "",
            "deposit":       primary["deposit"],
            "available":     primary["available_date"] or "",
            "available_raw": primary["available_raw"] or "",
            "pc":            primary["postcode_area"] or "",
            "pc_full":       primary["postcode_full"] or "",
            "green":         primary["near_green_space"] or "",
            "rail":          primary["rail_access"] or "",
            "direct":        bool(primary["on_direct_line"]),
            "why":           primary["why_worth_a_look"] or "",
            "caveats":       primary["caveats"] or "",
            "sources":       sources,
        })

    HTML_OUT.write_text(_render_template(payload, by_source, total, unique),
                        encoding="utf-8")
    print(f"Wrote {HTML_OUT}  ({unique} unique, {total} raw)")
    return 0


def _render_template(payload, by_source, total, unique) -> str:
    data_json = json.dumps(payload, ensure_ascii=False)
    last_updated = datetime.now().strftime("%Y-%m-%d %H:%M")
    source_chips = "".join(
        f'<div class="stat"><div class="num">{by_source.get(k, 0)}</div>'
        f'<div class="label">{html.escape(v)}</div></div>'
        for k, v in SOURCE_LABELS.items()
    )
    return TEMPLATE \
        .replace("{{LAST_UPDATED}}", html.escape(last_updated)) \
        .replace("{{UNIQUE}}",       str(unique)) \
        .replace("{{TOTAL}}",        str(total)) \
        .replace("{{SOURCE_CHIPS}}", source_chips) \
        .replace("{{DATA_JSON}}",    data_json)


TEMPLATE = r"""<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>Jomove — Southampton Rentals</title>
<style>
  :root{--bg:#fafafa;--fg:#1a1a1a;--muted:#666;--border:#e3e3e3;--accent:#0066cc;
        --good:#0a7e3a;--warn:#b56500;--bad:#c92a2a;--row:#fff;--row-hover:#f3f6fb;}
  *{box-sizing:border-box}
  body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
       background:var(--bg);color:var(--fg);margin:0;padding:20px;max-width:1500px;margin:0 auto;}
  h1{margin:0 0 4px;font-size:24px;font-weight:700;letter-spacing:-.5px}
  h1 .by{color:var(--muted);font-weight:400;font-size:14px;margin-left:8px}
  .subtitle{color:var(--muted);margin-bottom:18px;font-size:13px}
  .summary{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .stat{background:white;border:1px solid var(--border);border-radius:6px;padding:8px 12px;min-width:84px}
  .stat .num{font-size:18px;font-weight:600;line-height:1}
  .stat .label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-top:3px}
  .filters{background:white;border:1px solid var(--border);border-radius:6px;
           padding:12px 14px;margin-bottom:14px;display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end}
  .filters label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;
                 display:block;margin-bottom:3px}
  .filters input[type=number],.filters select{font:inherit;padding:5px 8px;
            border:1px solid var(--border);border-radius:4px;background:white;min-width:90px}
  .filters .check{display:flex;align-items:center;gap:6px}
  .filters .check label{margin:0;text-transform:none;font-size:13px;color:var(--fg);letter-spacing:0}
  .filters button{font:inherit;padding:5px 12px;border:1px solid var(--border);
                  background:white;border-radius:4px;cursor:pointer}
  .filters button:hover{background:#eee}
  table{width:100%;border-collapse:collapse;background:white;border:1px solid var(--border);
        border-radius:6px;overflow:hidden}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top;font-size:13px}
  th{background:#f5f5f5;font-size:11px;text-transform:uppercase;letter-spacing:.5px;
     color:var(--muted);cursor:pointer;user-select:none;font-weight:600}
  th.sortable::after{content:" ⇅";opacity:.3}
  th.sort-asc::after {content:" ↑";opacity:1;color:var(--accent)}
  th.sort-desc::after{content:" ↓";opacity:1;color:var(--accent)}
  tr.row{cursor:pointer}
  tr.row:hover{background:var(--row-hover)}
  tr.row:last-child td,tr.detail:last-child td{border-bottom:none}
  tr.detail td{background:#fafbfc;padding:14px 18px;font-size:13px;border-top:none}
  tr.detail .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
  tr.detail .grid div{}
  tr.detail .grid .k{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px}
  .price{font-weight:600;font-variant-numeric:tabular-nums}
  .score{font-variant-numeric:tabular-nums;font-weight:600;color:var(--accent)}
  .badge{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;
         font-weight:500;line-height:18px;white-space:nowrap}
  .badge.good{background:#e3f7ec;color:var(--good)}
  .badge.warn{background:#fff3e0;color:var(--warn)}
  .badge.bad {background:#fde7e7;color:var(--bad)}
  .badge.neutral{background:#eef;color:#445}
  .epc{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;
       font-weight:600;line-height:18px;color:white}
  .epc-A,.epc-B{background:#0a7e3a}
  .epc-C{background:#7eb53a}
  .epc-D{background:#fbc02d;color:#222}
  .epc-E,.epc-F,.epc-G{background:#c92a2a}
  .epc-unknown{background:#bbb;color:white}
  .sources a{color:var(--accent);text-decoration:none;font-size:11px;margin-right:6px;white-space:nowrap}
  .sources a:hover{text-decoration:underline}
  .hidden{display:none !important}
  .empty{padding:30px;text-align:center;color:var(--muted)}
  footer{color:var(--muted);font-size:11px;margin-top:14px;text-align:center}
  details summary{cursor:pointer;color:var(--accent);font-size:11px;margin-top:6px}
</style>
</head>
<body>
<h1>Jomove<span class="by">· Southampton rental tracker</span></h1>
<div class="subtitle">Last updated {{LAST_UPDATED}}</div>

<div class="summary">
  <div class="stat"><div class="num" id="visible-count">{{UNIQUE}}</div><div class="label">Showing</div></div>
  <div class="stat"><div class="num">{{UNIQUE}}</div><div class="label">Unique</div></div>
  <div class="stat"><div class="num">{{TOTAL}}</div><div class="label">Raw</div></div>
  {{SOURCE_CHIPS}}
</div>

<div class="filters">
  <div><label for="f-pc">Postcode</label>
    <select id="f-pc"><option value="">Any</option>
      <option>SO14</option><option>SO15</option><option>SO17</option><option>SO18</option>
    </select></div>
  <div><label for="f-beds">Beds</label>
    <select id="f-beds"><option value="">Any</option><option>1</option><option>2</option></select></div>
  <div><label for="f-price">Max £/mo</label>
    <input id="f-price" type="number" min="0" step="50" placeholder="1100"></div>
  <div class="check"><input type="checkbox" id="f-furn">
    <label for="f-furn">Furnished or optional</label></div>
  <div class="check"><input type="checkbox" id="f-park">
    <label for="f-park">Real parking</label></div>
  <div class="check"><input type="checkbox" id="f-rail">
    <label for="f-rail">Direct rail line</label></div>
  <div class="check"><input type="checkbox" id="f-deadline">
    <label for="f-deadline">Available by 29 June 2026</label></div>
  <button id="f-reset" type="button">Reset</button>
</div>

<table id="listings">
  <thead><tr>
    <th class="sortable sort-desc" data-key="score">Score</th>
    <th class="sortable" data-key="address">Address</th>
    <th class="sortable" data-key="price">£/mo</th>
    <th class="sortable" data-key="beds">Beds</th>
    <th class="sortable" data-key="parking">Parking</th>
    <th class="sortable" data-key="furnished">Furn</th>
    <th class="sortable" data-key="epc">EPC</th>
    <th class="sortable" data-key="available">Available</th>
    <th class="sortable" data-key="pc">PC</th>
    <th class="sortable" data-key="direct">Rail</th>
    <th>Sources</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<div class="empty hidden" id="empty">No listings match the current filters.</div>

<footer>Generated by <code>jomove report</code> · scoring weights: rail 30 / parking 20 / price 20 / furnished 15 / green 15 / EPC 10</footer>

<script>
const DATA = {{DATA_JSON}};
const PARK_RANK = {allocated:5,driveway:5,"off-street":5,permit:3,"on-street":3,unclear:1,none:0,"":0};
const FURN_RANK = {yes:3,optional:2,part:2,unclear:1,no:0,"":0};
const EPC_RANK  = {A:7,B:6,C:5,D:4,E:3,F:2,G:1,"":0};
const SRC_ABBR  = {openrent:"OR",rightmove:"RM",zoopla:"Z",onthemarket:"OTM",gumtree:"GT"};
const DEADLINE  = "2026-06-29";

let state = { sortKey:"score", sortDir:"desc", expanded:new Set() };

function badge(parking) {
  const cls = (parking==="allocated"||parking==="driveway"||parking==="off-street") ? "good"
            : (parking==="permit"||parking==="on-street") ? "warn"
            : (parking==="none") ? "bad" : "neutral";
  return `<span class="badge ${cls}">${parking||"?"}</span>`;
}
function furnBadge(f) {
  const cls = f==="yes"?"good" : (f==="optional"||f==="part")?"warn" : (f==="no")?"bad":"neutral";
  return `<span class="badge ${cls}">${f||"?"}</span>`;
}
function epcBadge(e) { return `<span class="epc ${e?"epc-"+e:"epc-unknown"}">${e||"?"}</span>`; }
function railBadge(d) { return d ? '<span class="badge good">direct</span>' : '<span class="badge warn">change</span>'; }
function fmtAvail(iso, raw) { if (!iso) return raw||"?"; return iso; }
function sortRows(rows) {
  const k = state.sortKey, dir = state.sortDir === "desc" ? -1 : 1;
  const v = (r) => {
    if (k==="parking")   return PARK_RANK[r.parking] ?? 0;
    if (k==="furnished") return FURN_RANK[r.furnished] ?? 0;
    if (k==="epc")       return EPC_RANK[r.epc] ?? 0;
    if (k==="direct")    return r.direct ? 1 : 0;
    if (k==="available") return r.available || "9999-99-99";
    return r[k] ?? "";
  };
  return rows.slice().sort((a,b) => {
    const va = v(a), vb = v(b);
    if (va === vb) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : 1) * dir;
  });
}
function filterRows() {
  const pc    = document.getElementById("f-pc").value;
  const beds  = document.getElementById("f-beds").value;
  const price = parseInt(document.getElementById("f-price").value, 10);
  const furn  = document.getElementById("f-furn").checked;
  const park  = document.getElementById("f-park").checked;
  const rail  = document.getElementById("f-rail").checked;
  const dl    = document.getElementById("f-deadline").checked;
  return DATA.filter(r => {
    if (pc && r.pc !== pc) return false;
    if (beds && String(r.beds) !== beds) return false;
    if (!Number.isNaN(price) && r.price > price) return false;
    if (furn && !["yes","optional","part"].includes(r.furnished)) return false;
    if (park && !["allocated","driveway","off-street"].includes(r.parking)) return false;
    if (rail && !r.direct) return false;
    if (dl && r.available && r.available > DEADLINE) return false;
    return true;
  });
}
function detailRow(r) {
  const item = (k,v) => v ? `<div><div class="k">${k}</div><div>${v}</div></div>` : "";
  const links = r.sources.map(s =>
    `<a href="${s.url}" target="_blank" rel="noopener">${SRC_ABBR[s.src]||s.src} ↗</a>`).join(" ");
  return `<tr class="detail" data-id="${r.id}"><td colspan="11">
    <div class="grid">
      ${item("Why worth a look", r.why)}
      ${item("Caveats / verify", r.caveats)}
      ${item("Rail access", r.rail)}
      ${item("Near green space", r.green)}
      ${item("Furnished (raw)", r.furnished_raw)}
      ${item("Parking (raw)", r.parking_raw)}
      ${item("Deposit", r.deposit ? "£"+r.deposit : "")}
      ${item("Postcode", r.pc_full)}
      ${item("Available (raw)", r.available_raw)}
      ${item("All sources", links)}
    </div>
  </td></tr>`;
}
function render() {
  const filtered = sortRows(filterRows());
  const tbody = document.getElementById("rows");
  if (filtered.length === 0) {
    tbody.innerHTML = "";
    document.getElementById("empty").classList.remove("hidden");
  } else {
    document.getElementById("empty").classList.add("hidden");
    tbody.innerHTML = filtered.map(r => {
      const sourceLinks = r.sources.map(s =>
        `<a href="${s.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${SRC_ABBR[s.src]||s.src}</a>`).join(" ");
      const main = `<tr class="row" data-id="${r.id}">
        <td><span class="score">${r.score}</span></td>
        <td>${r.address}</td>
        <td class="price">£${r.price.toLocaleString()}</td>
        <td>${r.beds ?? "?"}</td>
        <td>${badge(r.parking)}</td>
        <td>${furnBadge(r.furnished)}</td>
        <td>${epcBadge(r.epc)}</td>
        <td>${fmtAvail(r.available, r.available_raw)}</td>
        <td>${r.pc||"?"}</td>
        <td>${railBadge(r.direct)}</td>
        <td class="sources">${sourceLinks}</td>
      </tr>`;
      const detail = state.expanded.has(r.id) ? detailRow(r) : "";
      return main + detail;
    }).join("");
  }
  document.getElementById("visible-count").textContent = filtered.length;
  document.querySelectorAll("th.sortable").forEach(th => {
    th.classList.remove("sort-asc","sort-desc");
    if (th.dataset.key === state.sortKey) th.classList.add("sort-"+state.sortDir);
  });
}
document.querySelectorAll("th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.key;
    if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = k; state.sortDir = (k==="price"||k==="available"||k==="address"||k==="pc") ? "asc" : "desc"; }
    render();
  });
});
document.getElementById("rows").addEventListener("click", e => {
  const row = e.target.closest("tr.row");
  if (!row) return;
  const id = Number(row.dataset.id);
  if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
  render();
});
["f-pc","f-beds","f-price","f-furn","f-park","f-rail","f-deadline"].forEach(id => {
  document.getElementById(id).addEventListener("input", render);
  document.getElementById(id).addEventListener("change", render);
});
document.getElementById("f-reset").addEventListener("click", () => {
  ["f-pc","f-beds","f-price"].forEach(id => document.getElementById(id).value = "");
  ["f-furn","f-park","f-rail","f-deadline"].forEach(id => document.getElementById(id).checked = false);
  render();
});
render();
</script>
</body>
</html>
"""


# ---------- entry ----------

def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="jomove", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init",   help="create empty SQLite database").set_defaults(fn=cmd_init)
    sub.add_parser("ingest", help="parse results_*.md into SQLite").set_defaults(fn=cmd_ingest)
    sub.add_parser("report", help="render dashboard.html").set_defaults(fn=cmd_report)

    pl = sub.add_parser("list", help="query listings from CLI")
    pl.add_argument("--max-price",   type=int)
    pl.add_argument("--postcode",    help="SO14/SO15/SO17/SO18")
    pl.add_argument("--beds",        type=int)
    pl.add_argument("--furnished",   action="store_true")
    pl.add_argument("--parking",     action="store_true", help="require real parking")
    pl.add_argument("--direct-line", action="store_true")
    pl.set_defaults(fn=cmd_list)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
