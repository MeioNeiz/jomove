import { readFileSync } from "node:fs";
import type { Listing } from "./types.ts";
import {
  parsePrice, parseBedsBaths, parseFurnished, parseParking,
  parsePostcodeArea, parsePostcodeFull, parseDeposit, parseEpc, parseAvailable,
  parseListingType,
} from "./field-parsers.ts";
import { dedupeKey, directLine } from "./dedupe.ts";

const FIELD_RE = /^-\s+\*\*([^:*]+):\*\*\s+(.+?)\s*$/gm;
const HEADER_RE = /^(.+?)\s+—\s+£([\d,]+)\s+pcm/;

// Multi-line section block: `**Description:**` paragraph, captured until
// the next `**Section:**` heading, a `---` separator, or end of block.
function extractSection(block: string, name: string): string {
  const heading = `**${name}:**`;
  const start = block.indexOf(heading);
  if (start < 0) return "";
  let end = block.length;
  // Look for the next paragraph-style heading or block separator after the
  // section's content begins.
  const after = start + heading.length;
  const stop = block.slice(after).search(/\n\*\*[A-Z][^*]*?:\*\*|\n---\s*$|\n---\s*\n/m);
  if (stop >= 0) end = after + stop;
  return block.slice(after, end).trim();
}

export function parseFile(path: string, source: string): Listing[] {
  const text = readFileSync(path, "utf-8");
  const blocks = text.split(/\n(?=## )/);
  const out: Listing[] = [];

  for (const block of blocks) {
    if (!block.startsWith("## ")) continue;
    const header = block.split("\n", 1)[0]!.slice(3);
    const m = header.match(HEADER_RE);
    if (!m) continue;

    const address = m[1]!.trim();
    const price = parsePrice(m[2]!);

    const fields: Record<string, string> = {};
    const images: string[] = [];
    FIELD_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FIELD_RE.exec(block)) !== null) {
      const name = fm[1]!.trim();
      const value = fm[2]!.trim();
      // Multiple "Image:" bullets per listing — collect rather than overwrite
      if (name === "Image") {
        const url = extractUrl(value);
        if (url) images.push(url);
      } else {
        fields[name] = value;
      }
    }

    let link = (fields["Link"] ?? "").trim();
    const linkM = link.match(/^\[.*?\]\((.+?)\)\s*$/);
    if (linkM) link = linkM[1]!;
    if (!link.startsWith("http")) continue;

    // De-dupe images (same URL listed twice) preserving order.
    const imageUrls = [...new Set(images)];
    const primaryImage = imageUrls[0] ?? null;

    const description = extractSection(block, "Description") || null;
    const featuresRaw = extractSection(block, "Key features");
    const keyFeatures = featuresRaw
      ? featuresRaw
          .split(/\r?\n/)
          .map(l => l.replace(/^[-*]\s+/, "").trim())
          .filter(Boolean)
      : [];
    const agentName = (fields["Agent"] ?? "").trim() || null;

    const bb = parseBedsBaths(fields["Beds/Baths"] ?? "");
    const furnRaw = fields["Furnished"] ?? "";
    const parkRaw = fields["Parking"] ?? "";
    const avail = parseAvailable(fields["Available"] ?? "");
    const pcText = (fields["Postcode area"] ?? "") + " "
                 + (fields["Postcode"] ?? "")      + " "
                 + address;
    const pcArea = parsePostcodeArea(pcText);
    const pcFull = parsePostcodeFull(pcText);

    out.push({
      source,
      source_url:       link,
      address,
      price_pcm:        price,
      beds:             bb.beds,
      baths:            bb.baths,
      furnished_raw:    furnRaw,
      furnished_status: parseFurnished(furnRaw),
      parking_raw:      parkRaw,
      parking_status:   parseParking(parkRaw),
      epc:              parseEpc(fields["EPC"] ?? ""),
      deposit:          parseDeposit(fields["Deposit"] ?? ""),
      available_raw:    avail.raw,
      available_date:   avail.iso,
      postcode_area:    pcArea,
      postcode_full:    pcFull,
      neighbourhood:    fields["Postcode area"] ?? "",
      near_green_space: fields["Near green space"] ?? "",
      rail_access:      fields["Rail access"] ?? "",
      on_direct_line:   directLine(fields["Rail access"]),
      why_worth_a_look: fields["Why it's worth a look"] ?? "",
      caveats:          fields["Caveats / things to verify"] ?? "",
      dedupe_key:       dedupeKey(address, price, pcArea),
      image_url:        primaryImage,
      image_urls:       imageUrls,
      // Type field may not be present (older scrapes); also try to guess from
      // the address header so e.g. "House Share, ..." classifies even without a Type bullet.
      listing_type:     parseListingType(fields["Type"] ?? address),
      description,
      key_features:     keyFeatures,
      agent_name:       agentName,
    });
  }
  return out;
}

/** Pull a URL out of either a bare URL or markdown-link form `[label](url)`. */
function extractUrl(raw: string): string | null {
  let url = raw.trim();
  if (!url) return null;
  const m = url.match(/^\[.*?\]\((.+?)\)\s*$/);
  if (m) url = m[1]!;
  return url.startsWith("http") ? url : null;
}
