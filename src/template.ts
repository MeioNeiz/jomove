import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { esc } from "./util/html.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(HERE, "template.html");

// Cached at module load — the template doesn't change at runtime.
// (Bun's --hot reload triggers a module reload, which re-runs this.)
const TEMPLATE = readFileSync(TEMPLATE_PATH, "utf-8");

export type DashboardSource = { src: string; url: string };

export type ListingUserState = {
  viewed:         boolean;
  favourite:      boolean;
  rating:         number | null;
  comment:        string;
  media_index:    number;
  cost_overrides: CostOverrides | null;
};

export type CostOverrides = {
  remove: string[];                 // auto-detected labels to suppress
  add:    { label: string; delta: number }[];  // user-added items
};

export type MediaItem =
  | { kind: "map";     lat: number; lon: number }
  | { kind: "scraped"; url: string }
  | { kind: "user";    url: string };

export type CostComponent = { label: string; delta: number; source?: "auto" | "user" };
export type CostAdjustment = {
  delta:      number;
  components: CostComponent[];      // resolved list (auto-kept + user-added)
  auto:       CostComponent[];      // full auto list ungated, for re-enable lookups
};

export type DashboardPayload = {
  id: number;
  dedupe_key: string;
  status: string;
  first_seen: string;
  score: number;
  address: string;
  price: number;
  beds: number | null;
  baths: number | null;
  furnished: string;
  furnished_raw: string;
  parking: string;
  parking_raw: string;
  epc: string;
  deposit: number | null;
  available: string;
  available_raw: string;
  pc: string;
  pc_full: string;
  green: string;
  rail: string;
  direct: boolean;
  why: string;
  caveats: string;
  sources: DashboardSource[];
  state: ListingUserState;
  media: MediaItem[];
  map_link_query: string;
  listing_type: string | null;
  cost_adjustments: CostAdjustment;
};

export type AppState = {
  lastVisitAt: string | null;
  filters:     Record<string, unknown> | null;
  sort:        string | null;
};

export type DashboardData = {
  payload: DashboardPayload[];
  bySource: Record<string, number>;
  sourceLabels: Record<string, string>;
  total: number;
  unique: number;
  generatedAt: string;
  appState: AppState;
};

/** Format a UTC ISO timestamp as "YYYY-MM-DD HH:mm" in Europe/London. */
function formatLondon(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function renderDashboard(d: DashboardData): string {
  const lastUpdated = formatLondon(d.generatedAt);
  const sourceChips = Object.entries(d.sourceLabels)
    .map(([k, v]) =>
      `<div class="stat"><div class="num">${d.bySource[k] ?? 0}</div>` +
      `<div class="label">${esc(v)}</div></div>`
    )
    .join("");
  return TEMPLATE
    .replace("{{LAST_UPDATED}}", esc(lastUpdated))
    .replace("{{GENERATED_AT}}", esc(d.generatedAt))
    .replace(/\{\{UNIQUE\}\}/g, String(d.unique))
    .replace("{{TOTAL}}", String(d.total))
    .replace("{{SOURCE_CHIPS}}", sourceChips)
    .replace("{{DATA_JSON}}", JSON.stringify(d.payload))
    .replace("{{APP_STATE_JSON}}", JSON.stringify(d.appState));
}
