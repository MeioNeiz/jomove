#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { cmdInit } from "./src/commands/init.ts";
import { cmdIngest } from "./src/commands/ingest.ts";
import { cmdReport } from "./src/commands/report.ts";
import { cmdList } from "./src/commands/list.ts";
import { cmdPrune } from "./src/commands/prune.ts";

const USAGE = `Usage: bun jomove.ts <command> [...args]

Commands:
  init                          create empty SQLite database
  ingest [dir-or-file ...]      parse results_*.md into SQLite (defaults to .)
  report                        render dashboard.html from SQLite
  prune  [--days N] [--dry-run] mark listings unseen for >N days as let_agreed
                                (default --days 7)
  list   [--max-price N] [--postcode SOxx] [--beds N]
         [--furnished] [--parking] [--direct-line]

Examples:
  bun jomove.ts ingest old_search
  bun jomove.ts prune --days 7 --dry-run
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
    cmdIngest(rest.length > 0 ? rest : ["."]);
    break;
  case "report":
    await cmdReport();
    break;
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
