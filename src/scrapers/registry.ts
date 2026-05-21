/**
 * Single source of truth for which portals exist and what each one
 * needs from scrape, http-verify, dashboard, and notify.
 *
 * Adding a new portal: import its `scrape*` function, add a single
 * entry below, done. The MD-file source name + dashboard label + http
 * removed-phrases all derive from this list.
 */

import { scrapeOpenRent } from "./openrent.ts";
import { scrapeRightmove } from "./rightmove.ts";
import { scrapeOnTheMarket } from "./onthemarket.ts";
import { scrapeGumtree } from "./gumtree.ts";
import type { ScrapedListing } from "./output.ts";

export type ScrapeReport = {
  portal:  string;
  written: number;
  skipped: Array<{ id: string | number; reason: string }>;
  errors:  string[];
  /** Listings actually scraped (typed). Available for direct ingest. */
  listings: ScrapedListing[];
};

export type PortalConfig = {
  id:        string;             // "openrent"
  label:     string;             // "OpenRent"
  mdName:    string;             // "results_openrent.md"
  scrape:    () => Promise<ScrapeReport>;
  /** HTTP-verify config consumed by src/verify/http-check.ts */
  httpVerify: {
    skip?:           boolean;     // true → AI follow-up only (Cloudflare blocked)
    removedPhrases:  RegExp[];    // matched in title/og/h1 only
  };
};

export const PORTALS: PortalConfig[] = [
  {
    id:        "openrent",
    label:     "OpenRent",
    mdName:    "results_openrent.md",
    scrape:    scrapeOpenRent,
    httpVerify: {
      removedPhrases: [
        /this property is no longer available/i,
        /property has been let/i,
        /this listing has been removed/i,
      ],
    },
  },
  {
    id:        "rightmove",
    label:     "Rightmove",
    mdName:    "results_rightmove.md",
    scrape:    scrapeRightmove,
    httpVerify: {
      removedPhrases: [
        /this property has been removed/i,
        /no longer (?:on|available on) the market/i,
        /under offer/i,
        /\blet agreed\b/i,
      ],
    },
  },
  {
    id:        "zoopla",
    label:     "Zoopla",
    mdName:    "results_zoopla.md",
    // Zoopla has no deterministic scraper — AI-driven via /scrape skill.
    // Stub so PORTALS still drives mdName / label / httpVerify config.
    scrape:    async () => ({
      portal: "zoopla", written: 0, skipped: [], errors: ["no deterministic scraper"], listings: [],
    }),
    httpVerify: {
      skip: true,                    // Cloudflare returns 403 to plain fetches
      removedPhrases: [
        /listing (?:is )?no longer available/i,
        /this property is no longer/i,
        /\blet agreed\b/i,
      ],
    },
  },
  {
    id:        "onthemarket",
    label:     "OnTheMarket",
    mdName:    "results_onthemarket.md",
    scrape:    scrapeOnTheMarket,
    httpVerify: {
      removedPhrases: [
        /this property is (?:now )?(?:let|under offer)/i,
        /\blet agreed\b/i,
        /no longer (?:on|available on) the market/i,
      ],
    },
  },
  {
    id:        "gumtree",
    label:     "Gumtree",
    mdName:    "results_gumtree.md",
    scrape:    scrapeGumtree,
    httpVerify: {
      removedPhrases: [
        /this ad has been deleted/i,
        /this ad has expired/i,
        /ad is no longer available/i,
      ],
    },
  },
];

export const PORTALS_BY_ID: Record<string, PortalConfig> = Object.fromEntries(
  PORTALS.map(p => [p.id, p]),
);

/** Backwards-compatible map for the older config.ts SOURCES lookup. */
export const SOURCES: Record<string, string> = Object.fromEntries(
  PORTALS.map(p => [p.mdName, p.id]),
);

export const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  PORTALS.map(p => [p.id, p.label]),
);
