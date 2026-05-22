/**
 * Server-side OSM tile proxy.
 *
 * Why this exists: the email digest embeds map tiles, but Gmail
 * proxies external images through googleusercontent. Upstream OSM
 * servers refuse the unfamiliar proxy UA with 418/403 "access
 * blocked" tiles. By serving the tiles ourselves we:
 *
 *   1. Give Gmail an HTTPS source on a known, trusted host
 *      (jomove.jomify.lol) — its proxy fetches us fine.
 *   2. Fetch upstream with a `jomove/1.0` UA + Referer so the
 *      community tile server treats us as a normal client.
 *   3. Cache each tile to `data/tiles/<z>/<x>-<y>.png` so the second
 *      email and beyond serve from disk in ~1 ms.
 *
 * We rotate through a couple of permissive providers and remember
 * which one succeeded — `tile.openstreetmap.fr/osmfr` is the primary,
 * `cartocdn` light theme is the fallback. Both follow the same
 * `/z/x/y.png` URL shape.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const CACHE_DIR = join(ROOT, "data", "tiles");

const UPSTREAMS = [
  (z: number, x: number, y: number) => `https://a.tile.openstreetmap.fr/osmfr/${z}/${x}/${y}.png`,
  (z: number, x: number, y: number) => `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
];

const UA = "jomove/1.0 (+https://jomove.jomify.lol; rental-aggregator)";
const REFERER = "https://jomove.jomify.lol/";

function tilePath(z: number, x: number, y: number): string {
  return join(CACHE_DIR, String(z), `${x}-${y}.png`);
}

async function fetchUpstream(z: number, x: number, y: number): Promise<Buffer | null> {
  for (const build of UPSTREAMS) {
    const url = build(z, x, y);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Referer": REFERER, "Accept": "image/png,image/*;q=0.8" },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status !== 200) continue;
      const ctype = res.headers.get("content-type") ?? "";
      if (!ctype.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // OSM blocked-access tiles are ~1.5 KB — real tiles are ~10-50 KB. Skip
      // anything implausibly small (one less corner case in the email).
      if (buf.byteLength < 3000) continue;
      return buf;
    } catch {
      /* try next upstream */
    }
  }
  return null;
}

/**
 * Handle `GET /api/tile/:z/:x/:y.png`. Returns the PNG bytes either
 * from disk cache or by fetching upstream. 404 on path-parse failure,
 * 502 if every upstream provider declined.
 */
export async function handleTileRequest(path: string): Promise<Response> {
  const m = path.match(/^\/api\/tile\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
  if (!m) return new Response("Not found", { status: 404 });
  const z = parseInt(m[1]!, 10);
  const x = parseInt(m[2]!, 10);
  const y = parseInt(m[3]!, 10);
  if (z < 0 || z > 19 || x < 0 || y < 0) {
    return new Response("Bad tile coordinates", { status: 400 });
  }

  const cached = tilePath(z, x, y);
  if (existsSync(cached) && statSync(cached).size > 0) {
    const buf = await readFile(cached);
    return new Response(buf, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=2592000, immutable",
        "X-Tile-Source": "cache",
      },
    });
  }

  const buf = await fetchUpstream(z, x, y);
  if (!buf) {
    return new Response("Upstream tile providers all declined", { status: 502 });
  }

  // Cache-write is best-effort — never fail the request on disk errors.
  try {
    mkdirSync(dirname(cached), { recursive: true });
    await writeFile(cached, buf);
  } catch (err) {
    console.warn("tile cache write failed:", (err as Error).message);
  }

  return new Response(buf, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=2592000, immutable",
      "X-Tile-Source": "fetch",
    },
  });
}
