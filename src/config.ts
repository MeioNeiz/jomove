import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);

export const DB_PATH = join(ROOT, "data", "jomove.db");
export const HTML_OUT = join(ROOT, "dashboard.html");

export const DEADLINE = "2026-06-29";

export const SOURCES: Record<string, string> = {
  "results_openrent.md":    "openrent",
  "results_rightmove.md":   "rightmove",
  "results_zoopla.md":      "zoopla",
  "results_onthemarket.md": "onthemarket",
  "results_gumtree.md":     "gumtree",
};

export const SOURCE_LABELS: Record<string, string> = {
  openrent:    "OpenRent",
  rightmove:   "Rightmove",
  zoopla:      "Zoopla",
  onthemarket: "OnTheMarket",
  gumtree:     "Gumtree",
};
