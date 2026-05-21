import { connect } from "../db.ts";
import { renderDashboard } from "../template.ts";
import { buildPayload } from "../payload.ts";
import {
  ensurePostcodeGeocodes, kickoffAddressGeocodingBackground,
} from "../geocode.ts";
import {
  saveUserImage, deleteUserImage, resolveUserImagePath,
} from "../user-images.ts";

export type ServeArgs = { port: number };

/**
 * Tiny dev server. Routes:
 *   GET  /                       dashboard HTML
 *   GET  /api/listings           full payload (listings + state)
 *   POST /api/notes/:dedupeKey   upsert per-listing user state (partial OK)
 *   POST /api/app-state/:key     upsert an app_state value
 *   POST /api/listings/:key/status  flip a property's status (active|let_agreed)
 *   DELETE /api/notes/:dedupeKey clear all annotations for that property
 *
 * Each request re-opens the SQLite connection — fine for personal use,
 * sub-millisecond, and means ingest in another terminal is picked up
 * immediately.
 */
export function cmdServe(args: ServeArgs): void {
  const server = Bun.serve({
    port: args.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        if (path === "/" || path === "/index.html") {
          return await handleRoot();
        }
        if (path === "/api/listings" && req.method === "GET") {
          return await handleListings();
        }

        const noteMatch = path.match(/^\/api\/notes\/(.+)$/);
        if (noteMatch) {
          const key = decodeURIComponent(noteMatch[1]!);
          if (req.method === "POST")   return await handleNoteUpsert(key, req);
          if (req.method === "DELETE") return handleNoteDelete(key);
          return new Response("Method not allowed", { status: 405 });
        }

        const stateMatch = path.match(/^\/api\/app-state\/(.+)$/);
        if (stateMatch) {
          const key = decodeURIComponent(stateMatch[1]!);
          if (req.method === "POST") return await handleAppStateUpsert(key, req);
          return new Response("Method not allowed", { status: 405 });
        }

        const statusMatch = path.match(/^\/api\/listings\/(.+)\/status$/);
        if (statusMatch) {
          const key = decodeURIComponent(statusMatch[1]!);
          if (req.method === "POST") return await handleListingStatus(key, req);
          return new Response("Method not allowed", { status: 405 });
        }

        const userImgMatch = path.match(/^\/api\/user-image\/(.+)$/);
        if (userImgMatch) {
          const key = decodeURIComponent(userImgMatch[1]!);
          if (req.method === "POST")   return await handleUserImageUpload(key, req);
          if (req.method === "DELETE") return handleUserImageDelete(key);
          return new Response("Method not allowed", { status: 405 });
        }

        if (path.startsWith("/user-images/")) {
          return await handleUserImageServe(path);
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

  // Kick off the slow address-geocoding loop in the background (1 req/sec
  // per Nominatim's ToS). The dashboard auto-picks up new coords via polling.
  kickoffAddressGeocodingBackground(connect);

  console.log(`Jomove dev server: http://localhost:${server.port}/`);
  console.log(`(Ctrl+C to stop. Ingest in another terminal — the dashboard auto-updates.)`);
}

// ---------- handlers ----------

async function handleRoot(): Promise<Response> {
  const db = connect();
  try {
    await ensurePostcodeGeocodes(db);
    // Latched — no-op while a pass is in flight, otherwise picks up
    // newly-ingested addresses without needing a server restart.
    kickoffAddressGeocodingBackground(connect);
    const data = buildPayload(db);
    return new Response(renderDashboard(data), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } finally {
    db.close();
  }
}

async function handleListings(): Promise<Response> {
  const db = connect();
  try {
    await ensurePostcodeGeocodes(db);
    kickoffAddressGeocodingBackground(connect);
    return Response.json(buildPayload(db), {
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    db.close();
  }
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

async function handleNoteUpsert(key: string, req: Request): Promise<Response> {
  const patch = await req.json() as Partial<{
    viewed:         boolean;
    favourite:      boolean;
    rating:         number | null;
    comment:        string;
    media_index:    number;
    cost_overrides: CostOverridesPatch;
  }>;

  const db = connect();
  try {
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
      $updated_at:     nowIso(),
    });

    return Response.json({ ok: true, state: next });
  } finally {
    db.close();
  }
}

function handleNoteDelete(key: string): Response {
  const db = connect();
  try {
    db.query("DELETE FROM user_notes WHERE dedupe_key = ?").run(key);
    return Response.json({ ok: true });
  } finally {
    db.close();
  }
}

async function handleListingStatus(key: string, req: Request): Promise<Response> {
  const body = await req.json() as { status?: unknown };
  if (body.status !== "active" && body.status !== "let_agreed") {
    return new Response("Bad status", { status: 400 });
  }
  const db = connect();
  try {
    const res = db.query(
      "UPDATE listings SET status = ? WHERE dedupe_key = ?"
    ).run(body.status, key);
    return Response.json({ ok: true, changes: res.changes });
  } finally {
    db.close();
  }
}

async function handleAppStateUpsert(key: string, req: Request): Promise<Response> {
  const body = await req.json() as { value: unknown };
  const db = connect();
  try {
    db.query(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES ($key, $value, $updated_at)
      ON CONFLICT(key) DO UPDATE SET
        value      = excluded.value,
        updated_at = excluded.updated_at
    `).run({
      $key:        key,
      $value:      JSON.stringify(body.value ?? null),
      $updated_at: nowIso(),
    });
    return Response.json({ ok: true });
  } finally {
    db.close();
  }
}

function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}

async function handleUserImageUpload(key: string, req: Request): Promise<Response> {
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return new Response("Empty body", { status: 400 });
  if (buf.byteLength > 8 * 1024 * 1024) {
    return new Response("Image too large (>8MB)", { status: 413 });
  }
  const db = connect();
  try {
    const { url } = await saveUserImage(db, key, buf, req.headers.get("content-type"));
    return Response.json({ ok: true, url });
  } finally {
    db.close();
  }
}

function handleUserImageDelete(key: string): Response {
  const db = connect();
  try {
    deleteUserImage(db, key);
    return Response.json({ ok: true });
  } finally {
    db.close();
  }
}

async function handleUserImageServe(urlPath: string): Promise<Response> {
  const filePath = resolveUserImagePath(urlPath);
  if (!filePath) return new Response("Not found", { status: 404 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
