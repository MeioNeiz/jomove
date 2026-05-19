import { connect, SCORE_SQL } from "../db.ts";
import { SOURCE_LABELS, HTML_OUT } from "../config.ts";
import { renderDashboard, type DashboardPayload } from "../template.ts";
import type { ListingRow } from "../types.ts";

export async function cmdReport(): Promise<void> {
  const db = connect();
  // include let_agreed too — dashboard hides them by default but can toggle.
  const rows = db.query(
    `SELECT *, ${SCORE_SQL} AS score
     FROM listings
     ORDER BY score DESC, price_pcm ASC`
  ).all() as ListingRow[];

  // Persistent annotations seeded by scripts/seed-notes.ts.
  const seedRows = db.query(
    "SELECT dedupe_key, comment FROM user_notes"
  ).all() as Array<{ dedupe_key: string; comment: string }>;
  const seedByKey = new Map(seedRows.map(r => [r.dedupe_key, r.comment]));

  const groups = new Map<string, ListingRow[]>();
  for (const r of rows) {
    const arr = groups.get(r.dedupe_key);
    if (arr) arr.push(r);
    else groups.set(r.dedupe_key, [r]);
  }

  const bySourceRaw = db.query(
    "SELECT source, COUNT(*) AS c FROM listings WHERE status='active' GROUP BY source"
  ).all() as Array<{ source: string; c: number }>;
  const bySource: Record<string, number> = Object.fromEntries(
    bySourceRaw.map(r => [r.source, r.c])
  );
  const total = rows.filter(r => r.status === "active").length;
  const unique = groups.size;
  db.close();

  const payload: DashboardPayload[] = Array.from(groups.values()).map(items => {
    const primary = items.find(r => r.source === "openrent")
                 ?? [...items].sort((a, b) => a.price_pcm - b.price_pcm)[0]!;
    // group status is let_agreed only if every source thinks so
    const groupStatus = items.every(r => r.status === "let_agreed")
                        ? "let_agreed"
                        : "active";
    // earliest first_seen across portals = when this property first appeared
    const firstSeen = items
      .map(r => r.first_seen)
      .sort()[0]!;
    return {
      id:            primary.id,
      dedupe_key:    primary.dedupe_key,
      status:        groupStatus,
      first_seen:    firstSeen,
      score:         primary.score ?? 0,
      address:       primary.address,
      price:         primary.price_pcm,
      beds:          primary.beds,
      baths:         primary.baths,
      furnished:     primary.furnished_status ?? "unclear",
      furnished_raw: primary.furnished_raw ?? "",
      parking:       primary.parking_status ?? "unclear",
      parking_raw:   primary.parking_raw ?? "",
      epc:           primary.epc ?? "",
      deposit:       primary.deposit,
      available:     primary.available_date ?? "",
      available_raw: primary.available_raw ?? "",
      pc:            primary.postcode_area ?? "",
      pc_full:       primary.postcode_full ?? "",
      green:         primary.near_green_space ?? "",
      rail:          primary.rail_access ?? "",
      direct:        Boolean(primary.on_direct_line),
      why:           primary.why_worth_a_look ?? "",
      caveats:       primary.caveats ?? "",
      sources:       items.map(r => ({ src: r.source, url: r.source_url })),
      seed_comment:  seedByKey.get(primary.dedupe_key) ?? null,
    };
  });

  const html = renderDashboard({
    payload,
    bySource,
    sourceLabels: SOURCE_LABELS,
    total,
    unique,
    generatedAt: new Date().toISOString().slice(0, 19),
  });
  await Bun.write(HTML_OUT, html);
  console.log(`Wrote ${HTML_OUT}  (${unique} unique, ${total} active, ${rows.length} raw)`);
}
