---
description: Spawn a parallel agent to scrape Zoopla (the one portal not handled by `bun jomove.ts auto-scrape`), then ingest + archive.
---

# /scrape — Zoopla refresh (Claude-only portal)

OpenRent, Rightmove, OnTheMarket and Gumtree are now scraped
deterministically by `bun jomove.ts auto-scrape` and should NOT be
re-scraped here. Zoopla blocks plain `fetch` (Cloudflare managed
challenge), so it's the only portal this command still touches.

Spawn ONE agent to scrape Zoopla into `results_zoopla.md`. Use
`subagent_type: "general-purpose"`. Substitute `<PORTAL>` =
`Zoopla`, `<SEARCH_URL>` = `https://www.zoopla.co.uk/to-rent/property/southampton/`,
`<OUTPUT_FILE>` = `results_zoopla.md` in the per-agent prompt below.

## Per-agent prompt template

> Scrape `<PORTAL>` for current Southampton rental listings matching the
> criteria below. Start at `<SEARCH_URL>`. Write the output to
> `<OUTPUT_FILE>` in the repo root, overwriting any existing file.
> No cap on listings — return every listing that passes the hard filter.
>
> ### Hard filters (skip listings that fail ANY of these)
> - Price ≤ £1,150 pcm
> - 1 or 2 beds (studios count as 1 bed)
> - Postcode area is SO14, SO15, SO17, or SO18 (NOT SO16, SO19, etc.)
> - Available by 11 August 2026 (or sooner / immediately)
> - Self-contained: flat, studio, maisonette, garden flat, OR a
>   house-share/room-only (which gets tagged — see Type field below)
> - Not under offer, not let-agreed, listing still active
> - Not student-only (lettings restricted to enrolled students)
>
> ### Don't pre-filter on (let the UI / score handle)
> - Furnished status (include all)
> - Parking type (include all, even "no parking")
> - EPC rating
> - Bills-included (a perk, not a problem)
>
> ### Strategy
> - WebSearch first to find listing URLs:
>   `site:<portal-domain> to rent Southampton SO17 1 bed flat`
> - WebFetch each listing URL — prefer JSON-LD / OpenGraph meta tags
>   embedded in the source for structured data
> - 5 images max per listing, photos only (no floorplans, no EPC certs)
> - Skip rather than guess: if the postcode isn't shown on the listing,
>   omit the **Postcode** bullet (keep **Postcode area**)
>
> ### Output schema
>
> File header:
> ```
> # <Portal Display Name> — Southampton Rentals
> _Scraped YYYY-MM-DD_
> ```
>
> One block per listing:
> ```
> ## <Address> — £<price> pcm
> - **Link:** <direct listing URL>
> - **Type:** flat | studio | maisonette | houseshare
> - **Beds/Baths:** 1 bed, 1 bath
> - **Furnished:** Yes | No | Optional | Part | Unclear
> - **Parking:** allocated | driveway | off-street | permit | on-street | none | unclear
> - **EPC:** A–G | Unknown
> - **Deposit:** £<amount> | Unclear
> - **Available:** <date or "Immediately">
> - **Postcode area:** SO15 (Hill Lane)
> - **Postcode:** SO15 3JT
> - **Near green space:** Southampton Common ~5 min walk
> - **Rail access:** Central ~15 min walk (direct Airport Parkway line)
> - **Why it's worth a look:** 2–3 sentences on the upsides
> - **Caveats / things to verify:** 2–3 sentences on downsides/unknowns
> - **Agent:** <letting agent / landlord name, omit if unknown>
> - **Image:** <url1>
> - **Image:** <url2>
> - **Image:** <url3>
>
> **Description:**
> <Verbatim or near-verbatim listing description from the portal —
> as much as is sensible, multi-paragraph allowed. Omit the whole
> block if no description is available.>
>
> **Key features:**
> - <Feature one, e.g. "Double glazing">
> - <Feature two>
>
> ---
> ```
>
> ### Required vs optional fields
> Required: Address (in heading), Link, Type, Beds, price (in heading),
> Postcode area. Everything else: include if confidently known, omit
> otherwise. Don't guess a full postcode if the listing doesn't show one.
> Description / Key features / Agent: include whenever the portal
> shows them — they're the raw payload that lets later Claude runs
> reason over the corpus without re-fetching.
>
> ### Report back
> When done, state how many listings you wrote and flag anything weird
> (portal blocked, captcha, low results, etc.).

## After the agent returns

Run these two commands in the repo root:

```sh
bun jomove.ts ingest results_zoopla.md
bun jomove.ts archive --label zoopla-refresh
```

Then summarise: listings written for Zoopla, anything anomalous.

> To refresh the other four portals (OpenRent / Rightmove /
> OnTheMarket / Gumtree), run `bun jomove.ts auto-scrape` — no Claude
> agents required.
