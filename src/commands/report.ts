import { connect, SCORE_SQL } from "../db.ts";
import { SOURCE_LABELS, HTML_OUT } from "../config.ts";
import { renderDashboard, type DashboardPayload } from "../template.ts";
import type { ListingRow } from "../types.ts";

export async function cmdReport(): Promise<void> {
  const db = connect();
  const rows = db.query(
    `SELECT *, ${SCORE_SQL} AS score
     FROM listings WHERE status='active'
     ORDER BY score DESC, price_pcm ASC`
  ).all() as ListingRow[];

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
  const total = rows.length;
  const unique = groups.size;
  db.close();

  const payload: DashboardPayload[] = Array.from(groups.values()).map(items => {
    const primary = items.find(r => r.source === "openrent")
                 ?? [...items].sort((a, b) => a.price_pcm - b.price_pcm)[0]!;
    return {
      id:            primary.id,
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
    };
  });

  const html = renderDashboard({
    payload,
    bySource,
    sourceLabels: SOURCE_LABELS,
    total,
    unique,
  });
  await Bun.write(HTML_OUT, html);
  console.log(`Wrote ${HTML_OUT}  (${unique} unique, ${total} raw)`);
}
