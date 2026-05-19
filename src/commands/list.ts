import { connect, SCORE_SQL } from "../db.ts";
import type { ListArgs, ListingRow } from "../types.ts";

export function cmdList(args: ListArgs): void {
  const db = connect();
  const where: string[] = ["status = 'active'"];
  const params: Record<string, unknown> = {};

  if (args.maxPrice !== undefined) {
    where.push("price_pcm <= $max_price");
    params.$max_price = args.maxPrice;
  }
  if (args.postcode) {
    where.push("postcode_area = $pc");
    params.$pc = args.postcode.toUpperCase();
  }
  if (args.beds !== undefined) {
    where.push("beds = $beds");
    params.$beds = args.beds;
  }
  if (args.furnished)  where.push("furnished_status IN ('yes','optional','part')");
  if (args.parking)    where.push("parking_status IN ('allocated','off-street','driveway')");
  if (args.directLine) where.push("on_direct_line = 1");

  const sql = `SELECT *, ${SCORE_SQL} AS score
               FROM listings
               WHERE ${where.join(" AND ")}
               ORDER BY score DESC, price_pcm ASC`;

  const rows = db.query(sql).all(params) as ListingRow[];
  db.close();

  if (rows.length === 0) { console.log("(no matches)"); return; }

  console.log(
    `${"£/mo".padEnd(6)}  ${"Beds".padEnd(4)}  ${"PC".padEnd(5)}  ` +
    `${"Parking".padEnd(10)}  ${"EPC".padEnd(3)}  ${"Score".padStart(5)}  Address`
  );
  console.log("-".repeat(100));
  for (const r of rows) {
    const price = `£${String(r.price_pcm).padStart(4)}`;
    const beds  = r.beds !== null ? `${r.beds}b` : "?b";
    console.log(
      `  ${price}  ${beds.padEnd(4)}  ` +
      `${(r.postcode_area ?? "?").padEnd(5)}  ` +
      `${(r.parking_status ?? "?").padEnd(10)}  ` +
      `${(r.epc ?? "?").padEnd(3)}  ` +
      `${String(r.score ?? 0).padStart(5)}  ` +
      `${r.address}`
    );
    console.log(`          ${r.source_url}`);
  }
}
