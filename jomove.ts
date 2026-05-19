#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { cmdInit } from "./src/commands/init.ts";
import { cmdIngest } from "./src/commands/ingest.ts";
import { cmdReport } from "./src/commands/report.ts";
import { cmdList } from "./src/commands/list.ts";

const USAGE = `Usage: bun jomove.ts <command> [...args]

Commands:
  init                          create empty SQLite database
  ingest [dir-or-file ...]      parse results_*.md into SQLite (defaults to .)
  report                        render dashboard.html from SQLite
  list   [--max-price N] [--postcode SOxx] [--beds N]
         [--furnished] [--parking] [--direct-line]

Examples:
  bun jomove.ts ingest old_search
  bun jomove.ts list --postcode SO15 --furnished --parking`;

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
