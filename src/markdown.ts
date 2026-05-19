import { readFileSync } from "node:fs";
import type { Listing } from "./types.ts";
import {
  parsePrice, parseBedsBaths, parseFurnished, parseParking,
  parsePostcodeArea, parsePostcodeFull, parseDeposit, parseEpc, parseAvailable,
} from "./field-parsers.ts";
import { dedupeKey, directLine } from "./dedupe.ts";

const FIELD_RE = /^-\s+\*\*([^:*]+):\*\*\s+(.+?)\s*$/gm;
const HEADER_RE = /^(.+?)\s+—\s+£([\d,]+)\s+pcm/;

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
    FIELD_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FIELD_RE.exec(block)) !== null) {
      fields[fm[1]!.trim()] = fm[2]!.trim();
    }

    let link = (fields["Link"] ?? "").trim();
    const linkM = link.match(/^\[.*?\]\((.+?)\)\s*$/);
    if (linkM) link = linkM[1]!;
    if (!link.startsWith("http")) continue;

    const bb = parseBedsBaths(fields["Beds/Baths"] ?? "");
    const furnRaw = fields["Furnished"] ?? "";
    const parkRaw = fields["Parking"] ?? "";
    const avail = parseAvailable(fields["Available"] ?? "");
    const pcText = (fields["Postcode area"] ?? "") + " " + address;
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
    });
  }
  return out;
}
