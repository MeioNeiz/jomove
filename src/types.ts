export type Listing = {
  source: string;
  source_url: string;
  address: string;
  price_pcm: number;
  beds: number | null;
  baths: number | null;
  furnished_raw: string;
  furnished_status: string;
  parking_raw: string;
  parking_status: string;
  epc: string | null;
  deposit: number | null;
  available_raw: string | null;
  available_date: string | null;
  postcode_area: string | null;
  postcode_full: string | null;
  neighbourhood: string;
  near_green_space: string;
  rail_access: string;
  on_direct_line: number;
  why_worth_a_look: string;
  caveats: string;
  dedupe_key: string;
  image_url: string | null;
  image_urls: string[];
  listing_type: string | null;
  // Raw fields captured by deterministic scrapers so Claude can analyse
  // listings later without re-fetching. Null/empty when not available.
  description: string | null;
  key_features: string[];
  agent_name: string | null;
};

// SQLite stores image_urls + key_features as JSON strings — override.
export type ListingRow = Omit<Listing, "image_urls" | "key_features"> & {
  id: number;
  first_seen: string;
  last_seen: string;
  status: string;
  score?: number;
  image_urls: string | null;
  key_features: string | null;
};

export type ListArgs = {
  maxPrice?: number;
  postcode?: string;
  beds?: number;
  furnished: boolean;
  parking: boolean;
  directLine: boolean;
};
