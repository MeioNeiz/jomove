import type { Database } from "bun:sqlite";
import { SCORE_SQL } from "./db.ts";
import { SOURCE_LABELS } from "./config.ts";
import type { ListingRow } from "./types.ts";
import type { DashboardData, DashboardPayload } from "./template.ts";

/**
 * Fingerprint of the listings table. Advances whenever ingest touches a row.
 * Used as `generatedAt` so the dashboard can detect real data changes
 * (not just clock time) when polling.
 */
export function dataVersion(db: Database): string {
  const row = db.query(
    "SELECT MAX(last_seen) AS v FROM listings"
  ).get() as { v: string | null } | null;
  return row?.v ?? "1970-01-01T00:00:00";
}

/** Build the full payload the dashboard needs. Shared by `report` + `serve`. */
export function buildPayload(db: Database): DashboardData {
  const rows = db.query(
    `SELECT *, ${SCORE_SQL} AS score
     FROM listings
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
  const total = rows.filter(r => r.status === "active").length;
  const unique = groups.size;

  const payload: DashboardPayload[] = Array.from(groups.values()).map(items => {
    const primary = items.find(r => r.source === "openrent")
                 ?? [...items].sort((a, b) => a.price_pcm - b.price_pcm)[0]!;
    const groupStatus = items.every(r => r.status === "let_agreed")
                        ? "let_agreed"
                        : "active";
    const firstSeen = items.map(r => r.first_seen).sort()[0]!;
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
    };
  });

  return {
    payload,
    bySource,
    sourceLabels: SOURCE_LABELS,
    total,
    unique,
    generatedAt: dataVersion(db),
  };
}
