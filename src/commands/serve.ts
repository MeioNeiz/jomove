import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../db.ts";
import { renderDashboard } from "../template.ts";
import { buildPayload, dataVersion, bumpDataVersion } from "../payload.ts";
import {
  ensurePostcodeGeocodes, kickoffAddressGeocodingBackground,
} from "../geocode.ts";
import {
  saveUserImage, deleteUserImage, resolveUserImagePath,
} from "../user-images.ts";
import { nowIso } from "../util/now.ts";
import { cmdAutoScrape, type AutoScrapeResult } from "./auto-scrape.ts";
import { handleTileRequest } from "../web/tile-proxy.ts";

export type ServeArgs = { port: number };

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..", "web");

// Static dashboard assets served directly from disk so `bun --hot` picks up
// edits without a server restart.
const STATIC_ASSETS: Record<string, { path: string; type: string }> = {
  "/dashboard.css": { path: join(WEB_DIR, "dashboard.css"), type: "text/css; charset=utf-8" },
  "/dashboard.js":  { path: join(WEB_DIR, "dashboard.js"),  type: "application/javascript; charset=utf-8" },
};

// Single-flight lock for the in-process auto-scrape kicked off from the
// dashboard. Concurrent triggers from a second tab get a 409.
type ScrapeState = {
  running:    boolean;
  startedAt:  string | null;
  lastResult: (AutoScrapeResult & { endedAt: string; error?: string }) | null;
  lastError:  string | null;
};
const scrapeState: ScrapeState = {
  running: false, startedAt: null, lastResult: null, lastError: null,
};

// Keys the dashboard is allowed to upsert via /api/app-state/:key. Anything
// else (e.g. internal migration sentinels) is rejected so a stray HTTP caller
// can't pollute the singleton state table.
const ALLOWED_APP_STATE_KEYS = new Set([
  "last_visit_at",
  "filters",
  "sort",
]);

/**
 * Tiny dev server. Routes:
 *   GET  /                          dashboard HTML
 *   GET  /api/listings              full payload (listings + state)
 *   GET  /api/version               { generatedAt } — cheap poll target
 *   POST /api/notes/:dedupeKey      upsert per-listing user state (partial OK)
 *   POST /api/app-state/:key        upsert an allow-listed app_state value
 *   POST /api/listings/:key/status  flip a property's status (active|let_agreed)
 *   DELETE /api/notes/:dedupeKey    clear all annotations for that property
 *
 * One SQLite handle is shared across requests — WAL means readers don't
 * block, and bumping data_version on every mutation keeps polling clients
 * in sync with `prune` / `verify` / direct status flips.
 */
export function cmdServe(args: ServeArgs): void {
  const db = connect();

  const handlers = makeHandlers(db);

  const server = Bun.serve({
    port: args.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        if (path === "/" || path === "/index.html") {
          return await handlers.handleRoot();
        }
        const asset = STATIC_ASSETS[path];
        if (asset && req.method === "GET") {
          return new Response(Bun.file(asset.path), {
            headers: {
              "Content-Type": asset.type,
              // Short cache so edits via --hot show up on the next refresh.
              "Cache-Control": "no-cache",
            },
          });
        }
        if (path === "/api/version" && req.method === "GET") {
          return handlers.handleVersion(req);
        }
        if (path === "/api/listings" && req.method === "GET") {
          return await handlers.handleListings(req);
        }
        if (path === "/api/scrape" && req.method === "POST") {
          return handlers.handleScrapeStart();
        }
        if (path === "/api/scrape/status" && req.method === "GET") {
          return handlers.handleScrapeStatus();
        }
        if (path.startsWith("/api/tile/") && req.method === "GET") {
          return await handleTileRequest(path);
        }

        const noteMatch = path.match(/^\/api\/notes\/(.+)$/);
        if (noteMatch) {
          const key = decodeURIComponent(noteMatch[1]!);
          if (req.method === "POST")   return await handlers.handleNoteUpsert(key, req);
          if (req.method === "DELETE") return handlers.handleNoteDelete(key);
          return new Response("Method not allowed", { status: 405 });
        }

        const stateMatch = path.match(/^\/api\/app-state\/(.+)$/);
        if (stateMatch) {
          const key = decodeURIComponent(stateMatch[1]!);
          if (req.method === "POST") return await handlers.handleAppStateUpsert(key, req);
          return new Response("Method not allowed", { status: 405 });
        }

        const statusMatch = path.match(/^\/api\/listings\/(.+)\/status$/);
        if (statusMatch) {
          const key = decodeURIComponent(statusMatch[1]!);
          if (req.method === "POST") return await handlers.handleListingStatus(key, req);
          return new Response("Method not allowed", { status: 405 });
        }

        const userImgMatch = path.match(/^\/api\/user-image\/(.+)$/);
        if (userImgMatch) {
          const key = decodeURIComponent(userImgMatch[1]!);
          if (req.method === "POST")   return await handlers.handleUserImageUpload(key, req);
          if (req.method === "DELETE") return handlers.handleUserImageDelete(key);
          return new Response("Method not allowed", { status: 405 });
        }

        if (path.startsWith("/user-images/")) {
          return await handlers.handleUserImageServe(path);
        }

        return new Response("Not found", { status: 404 });
      } catch (err) {
        console.error("request error:", err);
        return new Response("Server error", { status: 500 });
      }
    },
    error(err) {
      console.error("server error:", err);
      return new Response("Server error", { status: 500 });
    },
  });

  // Background address-geocoding loop. Latched, safe to kick off once at
  // startup — handlers don't need to re-arm it on every request now that
  // the connection is long-lived.
  kickoffAddressGeocodingBackground(db);

  console.log(`Jomove dev server: http://localhost:${server.port}/`);
  console.log(`(Ctrl+C to stop. Ingest in another terminal — the dashboard auto-updates.)`);
}

function makeHandlers(db: Database) {
  return {
    async handleRoot(): Promise<Response> {
      await ensurePostcodeGeocodes(db);
      // Latched — picks up newly-ingested addresses without a restart.
      kickoffAddressGeocodingBackground(db);
      const data = buildPayload(db);
      const html = renderDashboard(data);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    },

    handleVersion(req: Request): Response {
      const v = dataVersion(db);
      // ETag-based 304: polling clients can hit this with If-None-Match and
      // the server replies with no body when nothing has changed.
      const etag = `"${v}"`;
      if (req.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return Response.json({ generatedAt: v }, {
        headers: { ETag: etag, "Cache-Control": "no-store" },
      });
    },

    async handleListings(req: Request): Promise<Response> {
      await ensurePostcodeGeocodes(db);
      kickoffAddressGeocodingBackground(db);
      const payload = buildPayload(db);
      const etag = `"${payload.generatedAt}"`;
      if (req.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return Response.json(payload, {
        headers: { ETag: etag, "Cache-Control": "no-store" },
      });
    },

    // Fire-and-forget scrape trigger. Returns 202 immediately; client polls
    // /api/scrape/status to follow progress. 409 if a scrape is already in
    // flight (single-flight lock).
    handleScrapeStart(): Response {
      if (scrapeState.running) {
        return Response.json(
          { ok: false, status: "already_running", startedAt: scrapeState.startedAt },
          { status: 409 },
        );
      }
      scrapeState.running   = true;
      scrapeState.startedAt = nowIso();
      scrapeState.lastError = null;
      (async () => {
        const startedAt = scrapeState.startedAt!;
        try {
          // cmdAutoScrape uses its own DB connection — fine alongside the
          // server's long-lived handle. WAL handles cross-connection visibility.
          const result = await cmdAutoScrape({});
          scrapeState.lastResult = { ...result, endedAt: nowIso() };
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          console.error(`scrape: failed — ${msg}`);
          scrapeState.lastError = msg;
          scrapeState.lastResult = {
            portals: [], total: 0, errors: 1, perPortal: [],
            durationMs: Date.now() - new Date(startedAt + "Z").getTime(),
            endedAt: nowIso(), error: msg,
          };
        } finally {
          scrapeState.running   = false;
          scrapeState.startedAt = null;
          // cmdAutoScrape already bumps data_version via ingestListings,
          // but bump again so a zero-write scrape still nudges the poll.
          bumpDataVersion(db, nowIso());
        }
      })();
      return Response.json(
        { ok: true, status: "started", startedAt: scrapeState.startedAt },
        { status: 202 },
      );
    },

    handleScrapeStatus(): Response {
      return Response.json({
        running:    scrapeState.running,
        startedAt:  scrapeState.startedAt,
        lastResult: scrapeState.lastResult,
        lastError:  scrapeState.lastError,
      });
    },

    async handleNoteUpsert(key: string, req: Request): Promise<Response> {
      const patch = await req.json() as Partial<{
        viewed:         boolean;
        favourite:      boolean;
        rating:         number | null;
        comment:        string;
        media_index:    number;
        cost_overrides: CostOverridesPatch;
      }>;

      const cur = db.query(
        "SELECT viewed, favourite, rating, comment, media_index, cost_overrides FROM user_notes WHERE dedupe_key = ?"
      ).get(key) as {
        viewed: number; favourite: number; rating: number | null;
        comment: string | null; media_index: number;
        cost_overrides: string | null;
      } | null;

      const next = {
        viewed:         patch.viewed    ?? Boolean(cur?.viewed),
        favourite:      patch.favourite ?? Boolean(cur?.favourite),
        rating:         "rating"      in patch ? patch.rating ?? null  : (cur?.rating ?? null),
        comment:        "comment"     in patch ? (patch.comment ?? "") : (cur?.comment ?? ""),
        media_index:    "media_index" in patch ? (patch.media_index ?? 0) : (cur?.media_index ?? 0),
        cost_overrides: "cost_overrides" in patch
          ? sanitiseCostOverrides(patch.cost_overrides)
          : (cur?.cost_overrides ?? null),
      };

      const now = nowIso();
      db.query(`
        INSERT INTO user_notes (dedupe_key, viewed, favourite, rating, comment, media_index, cost_overrides, updated_at)
        VALUES ($dedupe_key, $viewed, $favourite, $rating, $comment, $media_index, $cost_overrides, $updated_at)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          viewed         = excluded.viewed,
          favourite      = excluded.favourite,
          rating         = excluded.rating,
          comment        = excluded.comment,
          media_index    = excluded.media_index,
          cost_overrides = excluded.cost_overrides,
          updated_at     = excluded.updated_at
      `).run({
        $dedupe_key:     key,
        $viewed:         next.viewed ? 1 : 0,
        $favourite:      next.favourite ? 1 : 0,
        $rating:         next.rating,
        $comment:        next.comment,
        $media_index:    next.media_index,
        $cost_overrides: next.cost_overrides,
        $updated_at:     now,
      });
      bumpDataVersion(db, now);

      return Response.json({ ok: true, state: next });
    },

    handleNoteDelete(key: string): Response {
      db.query("DELETE FROM user_notes WHERE dedupe_key = ?").run(key);
      bumpDataVersion(db, nowIso());
      return Response.json({ ok: true });
    },

    async handleListingStatus(key: string, req: Request): Promise<Response> {
      const body = await req.json() as { status?: unknown };
      if (body.status !== "active" && body.status !== "let_agreed") {
        return new Response("Bad status", { status: 400 });
      }
      const res = db.query(
        "UPDATE listings SET status = ? WHERE dedupe_key = ?"
      ).run(body.status, key);
      bumpDataVersion(db, nowIso());
      return Response.json({ ok: true, changes: res.changes });
    },

    async handleAppStateUpsert(key: string, req: Request): Promise<Response> {
      if (!ALLOWED_APP_STATE_KEYS.has(key)) {
        return new Response("Unknown key", { status: 400 });
      }
      const body = await req.json() as { value: unknown };
      const now = nowIso();
      db.query(`
        INSERT INTO app_state (key, value, updated_at)
        VALUES ($key, $value, $updated_at)
        ON CONFLICT(key) DO UPDATE SET
          value      = excluded.value,
          updated_at = excluded.updated_at
      `).run({
        $key:        key,
        $value:      JSON.stringify(body.value ?? null),
        $updated_at: now,
      });
      bumpDataVersion(db, now);
      return Response.json({ ok: true });
    },

    async handleUserImageUpload(key: string, req: Request): Promise<Response> {
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0) return new Response("Empty body", { status: 400 });
      if (buf.byteLength > 8 * 1024 * 1024) {
        return new Response("Image too large (>8MB)", { status: 413 });
      }
      const { url } = await saveUserImage(db, key, buf, req.headers.get("content-type"));
      bumpDataVersion(db, nowIso());
      return Response.json({ ok: true, url });
    },

    handleUserImageDelete(key: string): Response {
      deleteUserImage(db, key);
      bumpDataVersion(db, nowIso());
      return Response.json({ ok: true });
    },

    async handleUserImageServe(urlPath: string): Promise<Response> {
      const filePath = resolveUserImagePath(urlPath);
      if (!filePath) return new Response("Not found", { status: 404 });
      const file = Bun.file(filePath);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    },
  };
}

type CostOverridesPatch = {
  remove?: string[];
  add?:    { label: string; delta: number }[];
} | null;

function sanitiseCostOverrides(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "object") return null;
  const o = raw as { remove?: unknown; add?: unknown };
  const remove = Array.isArray(o.remove)
    ? o.remove.filter((s): s is string => typeof s === "string")
    : [];
  const add = Array.isArray(o.add)
    ? o.add
        .filter((c: any) =>
          c && typeof c.label === "string" && Number.isFinite(Number(c.delta)))
        .map((c: any) => ({ label: String(c.label).slice(0, 40), delta: Number(c.delta) }))
    : [];
  if (remove.length === 0 && add.length === 0) return null;
  return JSON.stringify({ remove, add });
}
