---
description: Verify active listings still exist. HTTP triage first, then AI confirmation on survivors.
---

# /verify — find let / removed listings

Two-stage check: a cheap HTTP pass marks the obviously-removed ones,
then one parallel AI agent per portal confirms the survivors.

## Step 1 — HTTP triage

Run:

```sh
bun jomove.ts verify
```

This:
- Hits every `status='active'` source URL once (concurrency 5, ~15s timeout)
- Marks 404/410/index-redirect/kill-phrase hits as `let_agreed` in SQLite
- Writes the remaining "alive/unclear" listings to `verify_survivors.md`,
  grouped by portal.

If the file is missing or empty, skip Step 2 — nothing left to verify.

## Step 2 — AI confirmation on survivors

Open `verify_survivors.md`. It contains one `## <portal>` section per
source. Spawn ONE Agent per portal section **in a single message**
(parallel). Use `subagent_type: "general-purpose"`.

### Per-agent prompt template

> You are confirming whether rental listings on `<PORTAL>` are still live
> or have been let / removed. Read the URLs listed under the `## <PORTAL>`
> section of `verify_survivors.md` in the repo root.
>
> For each URL:
> 1. WebFetch the page.
> 2. Decide: **removed** (let agreed / under offer / no longer
>    available / 404 / portal index) or **still listed** (an active
>    listing detail page with price, beds, and an enquire/contact button).
> 3. If unsure, treat as still listed — being conservative is fine, the
>    HTTP pass and the next prune cycle will pick it up later.
>
> Output: write `verify_removed_<portal>.txt` in the repo root with one
> URL per line for each **removed** listing (blank lines and `#` comments
> ignored). Do NOT include still-listed URLs.
>
> When done, report: how many you checked, how many you marked removed,
> and any patterns you noticed (e.g. "all SO15 listings on <portal> are
> gone — site may have changed").

Substitute `<PORTAL>` with the section name (openrent, rightmove,
zoopla, onthemarket, gumtree).

## Step 3 — apply

Once all agents return, apply their findings:

```sh
bun jomove.ts verify --apply verify_removed_openrent.txt verify_removed_rightmove.txt \
                              verify_removed_zoopla.txt verify_removed_onthemarket.txt \
                              verify_removed_gumtree.txt
```

(Skip any files that weren't created — agents only write a file when
they found removals.)

Then delete the now-consumed verify_* files so they don't get re-applied
on a future run:

```sh
rm verify_survivors.md verify_removed_*.txt
```

## Just the HTTP pass

Skip the AI follow-up entirely:

```sh
bun run verify:http
```

Useful for a quick sweep — runs in a few seconds for the whole DB.
