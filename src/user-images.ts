import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { USER_IMAGES_DIR } from "./config.ts";

const EXTS = ["png", "jpg", "webp"] as const;
type Ext = typeof EXTS[number];

export function safeName(dedupeKey: string): string {
  return createHash("sha1").update(dedupeKey).digest("hex");
}

function extFromContentType(ct: string | null): Ext {
  const t = (ct ?? "").toLowerCase();
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("webp")) return "webp";
  return "png";
}

/** Upsert a user image. Replaces any existing image for this listing. */
export async function saveUserImage(
  db: Database,
  dedupeKey: string,
  body: ArrayBuffer,
  contentType: string | null,
): Promise<{ url: string; ext: Ext }> {
  if (!existsSync(USER_IMAGES_DIR)) mkdirSync(USER_IMAGES_DIR, { recursive: true });

  const safe = safeName(dedupeKey);
  const ext = extFromContentType(contentType);

  // Wipe any stale file with a different extension so only one image exists.
  for (const old of EXTS) {
    if (old === ext) continue;
    const p = join(USER_IMAGES_DIR, `${safe}.${old}`);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }

  await Bun.write(join(USER_IMAGES_DIR, `${safe}.${ext}`), body);

  const updatedAt = new Date().toISOString().slice(0, 19);
  db.query(`
    INSERT INTO user_images (dedupe_key, ext, updated_at)
    VALUES ($k, $e, $t)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      ext        = excluded.ext,
      updated_at = excluded.updated_at
  `).run({
    $k: dedupeKey,
    $e: ext,
    $t: updatedAt,
  });

  return { url: imageUrl(safe, ext, updatedAt), ext };
}

export function deleteUserImage(db: Database, dedupeKey: string): void {
  const safe = safeName(dedupeKey);
  for (const ext of EXTS) {
    const p = join(USER_IMAGES_DIR, `${safe}.${ext}`);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
  db.query("DELETE FROM user_images WHERE dedupe_key = ?").run(dedupeKey);
}

export function loadUserImages(db: Database): Map<string, string> {
  const rows = db.query("SELECT dedupe_key, ext, updated_at FROM user_images")
    .all() as Array<{ dedupe_key: string; ext: Ext; updated_at: string }>;
  return new Map(rows.map(r => [
    r.dedupe_key,
    imageUrl(safeName(r.dedupe_key), r.ext, r.updated_at),
  ]));
}

/** Resolve a request path like `/user-images/<hash>.<ext>` to a file. */
export function resolveUserImagePath(urlPath: string): string | null {
  const m = urlPath.match(/^\/user-images\/([a-f0-9]{40})\.(png|jpg|webp)$/);
  if (!m) return null;
  return join(USER_IMAGES_DIR, `${m[1]}.${m[2]}`);
}

function imageUrl(safe: string, ext: Ext, updatedAt: string): string {
  return `/user-images/${safe}.${ext}?v=${encodeURIComponent(updatedAt)}`;
}
