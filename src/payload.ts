import type { Database } from "bun:sqlite";
import { SCORE_SQL } from "./db.ts";
import { SOURCE_LABELS } from "./config.ts";
import { computeCostAdjustment } from "./cost.ts";
import { loadGeocodes, addressQuery } from "./geocode.ts";
import { loadUserImages } from "./user-images.ts";
import type { ListingRow } from "./types.ts";
import type {
  AppState, CostOverrides, DashboardData, DashboardPayload,
  ListingUserState, MediaItem,
} from "./template.ts";

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

const EMPTY_STATE: ListingUserState = {
  viewed: false, favourite: false, rating: null, comment: "",
  media_index: 0, cost_overrides: null,
};

function parseCostOverrides(raw: string | null): CostOverrides | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const remove = Array.isArray(v.remove)
      ? v.remove.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const add = Array.isArray(v.add)
      ? v.add.filter((c: any) =>
          c && typeof c.label === "string" && Number.isFinite(c.delta))
         .map((c: any) => ({ label: String(c.label), delta: Number(c.delta) }))
      : [];
    if (remove.length === 0 && add.length === 0) return null;
    return { remove, add };
  } catch {
    return null;
  }
}

function parseImageUrls(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null;
  } catch {
    return null;
  }
}

function loadAppState(db: Database): AppState {
  const rows = db.query("SELECT key, value FROM app_state")
    .all() as Array<{ key: string; value: string }>;
  const out: AppState = { lastVisitAt: null, filters: null, sort: null };
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.value);
      if (r.key === "last_visit_at") out.lastVisitAt = typeof parsed === "string" ? parsed : null;
      else if (r.key === "filters")  out.filters     = parsed && typeof parsed === "object" ? parsed : null;
      else if (r.key === "sort")     out.sort        = typeof parsed === "string" ? parsed : null;
    } catch { /* skip bad rows */ }
  }
  return out;
}

/** Build the full payload the dashboard needs. */
export function buildPayload(db: Database): DashboardData {
  const rows = db.query(
    `SELECT *, ${SCORE_SQL} AS score
     FROM listings
     ORDER BY score DESC, price_pcm ASC`
  ).all() as ListingRow[];

  // Fetch all user_notes in one go and key by dedupe_key for O(1) lookup
  const noteRows = db.query(
    `SELECT dedupe_key, viewed, favourite, rating, comment, media_index, cost_overrides
       FROM user_notes`
  ).all() as Array<{
    dedupe_key: string; viewed: number; favourite: number;
    rating: number | null; comment: string | null; media_index: number;
    cost_overrides: string | null;
  }>;
  const noteByKey = new Map<string, ListingUserState>(
    noteRows.map(n => [n.dedupe_key, {
      viewed:         Boolean(n.viewed),
      favourite:      Boolean(n.favourite),
      rating:         n.rating,
      comment:        n.comment ?? "",
      media_index:    n.media_index ?? 0,
      cost_overrides: parseCostOverrides(n.cost_overrides),
    }])
  );

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

  const coords = loadGeocodes(db);
  const userImages = loadUserImages(db);

  const payload: DashboardPayload[] = Array.from(groups.values()).map(items => {
    const primary = items.find(r => r.source === "openrent")
                 ?? [...items].sort((a, b) => a.price_pcm - b.price_pcm)[0]!;
    const groupStatus = items.every(r => r.status === "let_agreed")
                        ? "let_agreed"
                        : "active";
    const firstSeen = items.map(r => r.first_seen).sort()[0]!;

    // Geocode preference: precise full-postcode hit first, else the
    // address-based Nominatim hit. Returns null if neither resolved (yet).
    const fullPcCoord = primary.postcode_full ? coords.get(primary.postcode_full) ?? null : null;
    const addrCoord   = !fullPcCoord
      ? (coords.get(addressQuery(primary.address, primary.postcode_area)) ?? null)
      : null;
    const coord = fullPcCoord ?? addrCoord;

    // Build media items. Order matters — index 0 is the default view.
    // Rule: map (location) is most informative for screening, show first.
    const media: MediaItem[] = [];
    if (coord) media.push({ kind: "map", lat: coord.lat, lon: coord.lon });
    // Collect every scraped image URL across all source rows for this group,
    // then de-dupe preserving first-seen order. Falls back to the legacy
    // image_url column if image_urls is empty (older rows pre-migration).
    const seenImg = new Set<string>();
    for (const r of items) {
      const urls = parseImageUrls(r.image_urls) ?? (r.image_url ? [r.image_url] : []);
      for (const url of urls) {
        if (seenImg.has(url)) continue;
        seenImg.add(url);
        media.push({ kind: "scraped", url });
      }
    }
    const userImg = userImages.get(primary.dedupe_key) ?? null;
    if (userImg) media.push({ kind: "user", url: userImg });

    // Google Maps target: prefer the full address (more precise than just
    // the area postcode). Falls back to postcode if address is missing.
    const mapLinkQuery = primary.address
      ? `${primary.address}, Southampton, UK`
      : (primary.postcode_full || primary.postcode_area || "Southampton");

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
      state:         noteByKey.get(primary.dedupe_key) ?? { ...EMPTY_STATE },
      media,
      map_link_query: mapLinkQuery,
      listing_type:   primary.listing_type ?? null,
      cost_adjustments: computeCostAdjustment({
        why_worth_a_look: primary.why_worth_a_look,
        caveats:          primary.caveats,
        parking_raw:      primary.parking_raw,
        epc:              primary.epc,
        overrides:        noteByKey.get(primary.dedupe_key)?.cost_overrides ?? null,
      }),
    };
  });

  return {
    payload,
    bySource,
    sourceLabels: SOURCE_LABELS,
    total,
    unique,
    generatedAt: dataVersion(db),
    appState: loadAppState(db),
  };
}
