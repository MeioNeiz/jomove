import { connect } from "../db.ts";
import { renderDashboard } from "../template.ts";
import { buildPayload } from "../payload.ts";

export type ServeArgs = { port: number };

/**
 * Tiny dev server. Serves the dashboard at `/` and the live payload at
 * `/api/listings`. The dashboard polls the API every few seconds and
 * re-renders if the data version (MAX(last_seen)) has advanced.
 *
 * Each request re-opens the SQLite connection — fine for personal use,
 * sub-millisecond, and means ingest in another terminal is picked up
 * immediately.
 */
export function cmdServe(args: ServeArgs): void {
  const server = Bun.serve({
    port: args.port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const db = connect();
        const data = buildPayload(db);
        db.close();
        return new Response(renderDashboard(data), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/listings") {
        const db = connect();
        const data = buildPayload(db);
        db.close();
        return Response.json(data, {
          headers: { "Cache-Control": "no-store" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
    error(err) {
      console.error("server error:", err);
      return new Response("Server error", { status: 500 });
    },
  });

  console.log(`Jomove dev server: http://localhost:${server.port}/`);
  console.log(`(Ctrl+C to stop. Ingest in another terminal — the dashboard auto-updates.)`);
}
