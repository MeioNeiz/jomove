import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);

export const DB_PATH = join(ROOT, "data", "jomove.db");
export const USER_IMAGES_DIR = join(ROOT, "data", "user-images");

export const DEADLINE = "2026-08-11";

// SOURCES and SOURCE_LABELS used to live here as hand-edited maps. They are
// now derived from src/scrapers/registry.ts so adding a portal touches one
// file. Re-exported here for compatibility with existing imports.
export { SOURCES, SOURCE_LABELS } from "./scrapers/registry.ts";
