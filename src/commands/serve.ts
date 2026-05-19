import { connect } from "../db.ts";
import { renderDashboard } from "../template.ts";
import { buildPayload } from "../payload.ts";

export type ServeArgs = { port: number };

/**
 * Tiny dev server. Routes:
 *   GET  /                       dashboard HTML
 *   GET  /api/listings           full payload (listings + state)
 *   POST /api/notes/:dedupeKey   upsert per-listing user state (partial OK)
 *   POST /api/app-state/:key     upsert an app_state value
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
          return handleRoot();
        }
        if (path === "/api/listings" && req.method === "GET") {
          return handleListings();
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

  console.log(`Jomove dev server: http://localhost:${server.port}/`);
  console.log(`(Ctrl+C to stop. Ingest in another terminal — the dashboard auto-updates.)`);
}

// ---------- handlers ----------

function handleRoot(): Response {
  const db = connect();
  try {
    const data = buildPayload(db);
    return new Response(renderDashboard(data), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } finally {
    db.close();
  }
}

function handleListings(): Response {
  const db = connect();
  try {
    return Response.json(buildPayload(db), {
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    db.close();
  }
}

async function handleNoteUpsert(key: string, req: Request): Promise<Response> {
  const patch = await req.json() as Partial<{
    viewed:    boolean;
    favourite: boolean;
    rating:    number | null;
    comment:   string;
  }>;

  const db = connect();
  try {
    const cur = db.query(
      "SELECT viewed, favourite, rating, comment FROM user_notes WHERE dedupe_key = ?"
    ).get(key) as {
      viewed: number; favourite: number; rating: number | null; comment: string | null;
    } | null;

    const next = {
      viewed:    patch.viewed    ?? Boolean(cur?.viewed),
      favourite: patch.favourite ?? Boolean(cur?.favourite),
      rating:    "rating"  in patch ? patch.rating  ?? null : (cur?.rating ?? null),
      comment:   "comment" in patch ? (patch.comment ?? "")  : (cur?.comment ?? ""),
    };

    db.query(`
      INSERT INTO user_notes (dedupe_key, viewed, favourite, rating, comment, updated_at)
      VALUES ($dedupe_key, $viewed, $favourite, $rating, $comment, $updated_at)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        viewed     = excluded.viewed,
        favourite  = excluded.favourite,
        rating     = excluded.rating,
        comment    = excluded.comment,
        updated_at = excluded.updated_at
    `).run({
      $dedupe_key: key,
      $viewed:     next.viewed ? 1 : 0,
      $favourite:  next.favourite ? 1 : 0,
      $rating:     next.rating,
      $comment:    next.comment,
      $updated_at: nowIso(),
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
