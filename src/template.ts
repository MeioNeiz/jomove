import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(HERE, "template.html");

export type DashboardSource = { src: string; url: string };

export type ListingUserState = {
  viewed:    boolean;
  favourite: boolean;
  rating:    number | null;
  comment:   string;
};

export type CostComponent = { label: string; delta: number };
export type CostAdjustment = { delta: number; components: CostComponent[] };

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
  image_url: string | null;
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

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderDashboard(d: DashboardData): string {
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const lastUpdated = d.generatedAt.slice(0, 16).replace("T", " ");
  const sourceChips = Object.entries(d.sourceLabels)
    .map(([k, v]) =>
      `<div class="stat"><div class="num">${d.bySource[k] ?? 0}</div>` +
      `<div class="label">${esc(v)}</div></div>`
    )
    .join("");
  return template
    .replace("{{LAST_UPDATED}}", esc(lastUpdated))
    .replace("{{GENERATED_AT}}", esc(d.generatedAt))
    .replace(/\{\{UNIQUE\}\}/g, String(d.unique))
    .replace("{{TOTAL}}", String(d.total))
    .replace("{{SOURCE_CHIPS}}", sourceChips)
    .replace("{{DATA_JSON}}", JSON.stringify(d.payload))
    .replace("{{APP_STATE_JSON}}", JSON.stringify(d.appState));
}
