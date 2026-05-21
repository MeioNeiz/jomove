#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { cmdInit } from "./src/commands/init.ts";
import { cmdIngest } from "./src/commands/ingest.ts";
import { cmdList } from "./src/commands/list.ts";
import { cmdPrune } from "./src/commands/prune.ts";
import { cmdServe } from "./src/commands/serve.ts";
import { cmdArchive } from "./src/commands/archive.ts";
import { cmdVerify } from "./src/commands/verify.ts";
import { cmdAutoScrape } from "./src/commands/auto-scrape.ts";

const USAGE = `Usage: bun jomove.ts <command> [...args]

Commands:
  init                          create empty SQLite database
  ingest [dir-or-file ...]      parse results_*.md into SQLite (defaults to .)
  serve  [--port N]             run dev server with live polling (default 3000)
  archive [--label NAME]        move root results_*.md → scrapes/<timestamp>/
  prune  [--days N] [--dry-run] mark listings unseen for >N days as let_agreed
                                (default --days 7)
  verify [--http-only] [--dry-run] [--apply file…] [--concurrency N]
                                HTTP-check all active source URLs and mark
                                confirmed-removed as let_agreed. Writes
                                verify_survivors.md for AI follow-up unless
                                --http-only. --apply file.txt marks every
                                URL in the file (one per line) as let_agreed.
  auto-scrape [--portals=openrent,rightmove,onthemarket,gumtree]
              [--no-ingest] [--no-archive] [--no-notify] [--label NAME]
                                deterministic server-side scrapers. Writes
                                results_<portal>.md, then ingests + archives,
                                then emails a digest of new listings (SMTP
                                creds in .env — see .env.example).
  list   [--max-price N] [--postcode SOxx] [--beds N]
         [--furnished] [--parking] [--direct-line]

Examples:
  bun jomove.ts serve
  bun jomove.ts ingest old_search
  bun jomove.ts archive --label refresh
  bun jomove.ts prune --days 7 --dry-run
  bun jomove.ts verify --http-only
  bun jomove.ts verify --apply verify_removed_openrent.txt
  bun jomove.ts list --postcode SO17`;

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

const argv = Bun.argv.slice(2);
const sub = argv[0];
const rest = argv.slice(1);

switch (sub) {
  case "init":
    cmdInit();
    break;
  case "ingest":
    await cmdIngest(rest.length > 0 ? rest : ["."]);
    break;
  case "serve": {
    const { values } = parseArgs({
      args: rest,
      options: { "port": { type: "string" } },
      strict: false,
    });
    cmdServe({ port: values["port"] ? Number(values["port"]) : 3000 });
    break;
  }
  case "archive": {
    const { values } = parseArgs({
      args: rest,
      options: { "label": { type: "string" } },
      strict: false,
    });
    cmdArchive({ label: values["label"] as string | undefined });
    break;
  }
  case "prune": {
    const { values } = parseArgs({
      args: rest,
      options: {
        "days":    { type: "string" },
        "dry-run": { type: "boolean" },
      },
      strict: false,
    });
    cmdPrune({
      days:   values["days"] ? Number(values["days"]) : 7,
      dryRun: Boolean(values["dry-run"]),
    });
    break;
  }
  case "verify": {
    const { values } = parseArgs({
      args: rest,
      options: {
        "http-only":   { type: "boolean" },
        "dry-run":     { type: "boolean" },
        "apply":       { type: "string", multiple: true },
        "concurrency": { type: "string" },
        "out":         { type: "string" },
      },
      strict: false,
    });
    await cmdVerify({
      httpOnly:      Boolean(values["http-only"]),
      dryRun:        Boolean(values["dry-run"]),
      apply:         (values["apply"] as string[] | undefined) ?? [],
      concurrency:   values["concurrency"] ? Number(values["concurrency"]) : 5,
      survivorsPath: (values["out"] as string | undefined) ?? "verify_survivors.md",
    });
    break;
  }
  case "auto-scrape": {
    const { values } = parseArgs({
      args: rest,
      options: {
        "portals":    { type: "string" },
        "no-ingest":  { type: "boolean" },
        "no-archive": { type: "boolean" },
        "no-notify":  { type: "boolean" },
        "label":      { type: "string" },
      },
      strict: false,
    });
    const portalsStr = values["portals"] as string | undefined;
    await cmdAutoScrape({
      portals:      portalsStr ? portalsStr.split(",").map(s => s.trim()).filter(Boolean) : undefined,
      ingest:       !values["no-ingest"],
      archive:      !values["no-archive"],
      notify:       !values["no-notify"],
      archiveLabel: values["label"] as string | undefined,
    });
    break;
  }
  case "list": {
    const { values } = parseArgs({
      args: rest,
      options: {
        "max-price":   { type: "string" },
        "postcode":    { type: "string" },
        "beds":        { type: "string" },
        "furnished":   { type: "boolean" },
        "parking":     { type: "boolean" },
        "direct-line": { type: "boolean" },
      },
      strict: false,
    });
    cmdList({
      maxPrice:   values["max-price"] ? Number(values["max-price"]) : undefined,
      postcode:   values["postcode"] as string | undefined,
      beds:       values["beds"] ? Number(values["beds"]) : undefined,
      furnished:  Boolean(values["furnished"]),
      parking:    Boolean(values["parking"]),
      directLine: Boolean(values["direct-line"]),
    });
    break;
  }
  default:
    usage();
}
