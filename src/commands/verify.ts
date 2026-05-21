import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "../db.ts";
import { checkLinks, type LinkCheck } from "../verify/http-check.ts";

export type VerifyArgs = {
  httpOnly:    boolean;       // skip writing the AI-survivors file
  dryRun:      boolean;       // don't write to DB
  survivorsPath: string;      // where to write survivors markdown
  apply:       string[];      // result files to apply (URLs to mark as let_agreed)
  concurrency: number;
};

/**
 * Two modes:
 *
 *   1. `--apply <file...>` — read AI-confirmed-removed URLs from one or
 *      more files (one URL per line; blank/# lines ignored) and mark
 *      them `let_agreed`. Used after the AI follow-up writes results.
 *
 *   2. default — pull every `status='active'` listing, HTTP-check each
 *      URL (cheap, no AI), mark confirmed-removed ones as `let_agreed`,
 *      and write the remaining "alive/unclear" listings to
 *      `verify_survivors.md` for an AI follow-up pass to confirm.
 *
 * `--http-only` runs (2) without writing the survivors file.
 * `--dry-run` skips all DB writes — useful to preview what would change.
 */
export async function cmdVerify(args: VerifyArgs): Promise<void> {
  if (args.apply.length > 0) {
    applyResults(args.apply, args.dryRun);
    return;
  }

  const db = connect();
  try {
    const active = db.query(
      `SELECT id, source, source_url, address, price_pcm, last_seen
       FROM listings
       WHERE status = 'active'
       ORDER BY source, last_seen ASC`,
    ).all() as Array<{
      id: number; source: string; source_url: string;
      address: string; price_pcm: number; last_seen: string;
    }>;

    if (active.length === 0) {
      console.log("No active listings to verify.");
      return;
    }

    console.log(`HTTP-checking ${active.length} active listing(s)…`);
    const checks = await checkLinks(
      active.map(r => ({ url: r.source_url, source: r.source })),
      {
        concurrency: args.concurrency,
        onProgress(done, total) {
          process.stdout.write(`\r  ${done}/${total}`);
        },
      },
    );
    process.stdout.write("\n");

    const removed = checks.filter(c => c.status === "removed");
    const alive   = checks.filter(c => c.status === "alive");
    const errored = checks.filter(c => c.status === "error");
    const skipped = checks.filter(c => c.status === "skipped");

    console.log(
      `  removed: ${removed.length}  alive: ${alive.length}  ` +
      `error: ${errored.length}  skipped: ${skipped.length}`
    );
    if (skipped.length > 0) {
      const sources = [...new Set(skipped.map(s => s.source))].join(", ");
      console.log(`  (skipped sources: ${sources} — HTTP blocked, AI follow-up handles them)`);
    }

    if (removed.length > 0) {
      console.log(`\n${args.dryRun ? "Would mark" : "Marking"} ${removed.length} listing(s) as let_agreed:`);
      for (const c of removed) {
        const row = active.find(r => r.source_url === c.url)!;
        console.log(`  [${c.source}] £${row.price_pcm}  ${row.address}  — ${c.reason}`);
      }
      if (!args.dryRun) {
        const stmt = db.query(
          `UPDATE listings SET status='let_agreed' WHERE source_url = ? AND status='active'`
        );
        const tx = db.transaction((rows: LinkCheck[]) => {
          for (const r of rows) stmt.run(r.url);
        });
        tx(removed);
      }
    }

    if (errored.length > 0) {
      console.log(`\nErrored (left active, will retry next run):`);
      for (const c of errored) {
        const row = active.find(r => r.source_url === c.url)!;
        console.log(`  [${c.source}] £${row.price_pcm}  ${row.address}  — ${c.reason}`);
      }
    }

    if (!args.httpOnly) {
      // Survivors needing AI confirmation = anything HTTP couldn't confirm
      // as removed. Skipped sources (Zoopla) MUST flow through here.
      const survivors = [...alive, ...errored, ...skipped];
      if (survivors.length > 0) {
        const md = renderSurvivorsMd(survivors, active);
        writeFileSync(args.survivorsPath, md, "utf-8");
        console.log(
          `\nWrote ${survivors.length} survivor(s) to ${args.survivorsPath} ` +
          `— run the /verify skill to AI-confirm them.`
        );
      } else if (existsSync(args.survivorsPath)) {
        // Stale survivors file is misleading after a clean pass — drop it.
        try { unlinkSync(args.survivorsPath); } catch {}
      }
    }
  } finally {
    db.close();
  }
}

function renderSurvivorsMd(
  survivors: LinkCheck[],
  active: Array<{ source_url: string; address: string; price_pcm: number; last_seen: string }>,
): string {
  const byPortal = new Map<string, LinkCheck[]>();
  for (const s of survivors) {
    const arr = byPortal.get(s.source) ?? [];
    arr.push(s);
    byPortal.set(s.source, arr);
  }

  const lines: string[] = [];
  const stamp = new Date().toISOString().slice(0, 19);
  lines.push(`# Verify survivors — ${stamp}`);
  lines.push("");
  lines.push(
    "Listings that passed the HTTP triage but still need AI confirmation. " +
    "Per-portal agents should open each URL, look for let-agreed / under-offer / " +
    "no-longer-available signals, and write confirmed-removed URLs to " +
    "`verify_removed_<portal>.txt` (one URL per line) for `bun run verify --apply` to consume.",
  );
  lines.push("");

  for (const [portal, items] of [...byPortal.entries()].sort()) {
    lines.push(`## ${portal}  (${items.length})`);
    for (const it of items) {
      const row = active.find(r => r.source_url === it.url)!;
      const flag = it.status === "error" ? `  ⚠ ${it.reason}` : "";
      lines.push(`- £${row.price_pcm}  ${row.address}${flag}`);
      lines.push(`  ${it.url}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function applyResults(paths: string[], dryRun: boolean): void {
  const urls: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      console.error(`skip: ${p} (not found)`);
      continue;
    }
    const text = readFileSync(p, "utf-8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      // Accept either a bare URL or "- <url> — reason" / "<url>  # reason" lines.
      const m = line.match(/(https?:\/\/[^\s>)]+)/);
      if (m) urls.push(m[1]!);
    }
  }
  if (urls.length === 0) {
    console.log("No URLs to apply.");
    return;
  }

  const db = connect();
  try {
    // Show what we're about to do.
    const placeholders = urls.map(() => "?").join(",");
    const rows = db.query(
      `SELECT source, address, price_pcm, status, source_url
       FROM listings
       WHERE source_url IN (${placeholders})`,
    ).all(...urls) as Array<{
      source: string; address: string; price_pcm: number;
      status: string; source_url: string;
    }>;

    const missing = urls.filter(u => !rows.some(r => r.source_url === u));
    if (missing.length > 0) {
      console.log(`\nNot in DB (skipped): ${missing.length}`);
      for (const u of missing) console.log(`  ${u}`);
    }

    const willChange = rows.filter(r => r.status === "active");
    if (willChange.length === 0) {
      console.log("Nothing to update — all listed URLs are already non-active or missing.");
      return;
    }
    console.log(`${dryRun ? "Would mark" : "Marking"} ${willChange.length} listing(s) as let_agreed:`);
    for (const r of willChange) {
      console.log(`  [${r.source}] £${r.price_pcm}  ${r.address}`);
    }

    if (!dryRun) {
      const stmt = db.query(
        `UPDATE listings SET status='let_agreed' WHERE source_url = ? AND status='active'`,
      );
      const tx = db.transaction((us: string[]) => {
        for (const u of us) stmt.run(u);
      });
      tx(willChange.map(r => r.source_url));
      console.log("Done.");
    }
  } finally {
    db.close();
  }
}
