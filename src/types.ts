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
};

export type ListingRow = Listing & {
  id: number;
  first_seen: string;
  last_seen: string;
  status: string;
  score?: number;
};

export type ListArgs = {
  maxPrice?: number;
  postcode?: string;
  beds?: number;
  furnished: boolean;
  parking: boolean;
  directLine: boolean;
};
