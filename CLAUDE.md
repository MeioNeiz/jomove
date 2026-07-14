# Jomove — agent notes

## Don't start the dev server

The user keeps `bun run dev` running themselves in another terminal.
Spawning a second `bun run dev` (background or otherwise) crashes the
existing one because Bun's hot-reload binds the same port and SQLite
WAL.

Instead, to verify a change:
- Hit `http://localhost:3000/` or `/api/listings` with `curl` — the
  user's running server picks up edits via `--hot`.
- If you genuinely need a fresh server (e.g. CLAUDE.md asks for a build
  check), use `bun --port 0 jomove.ts serve` or pick a non-3000 port,
  and stop it before finishing the turn.

Same applies to any other long-running command the user owns — check
for an existing process before launching one yourself.

## Deploy

Production runs on an Oracle Cloud VM (`ubuntu@193.123.180.81`) at
`/home/ubuntu/jomove`, fronted by nginx at <https://jomove.jomify.lol>.

The previous VM (`opc@132.145.34.57`) was reclaimed by Oracle after
months of inactivity — its DB (favourites/ratings/comments/images) is
gone. This VM started fresh from the `old_search/` archive in July 2026.

- **Push to deploy.** `.github/workflows/deploy.yml` fires on push to
  `main`: SSH in → `git pull` → `bun install --frozen-lockfile` →
  `sudo systemctl restart jomove`. Reuses `DEPLOY_*` secrets from jomify.
- **systemd units** live in `deploy/` and are installed to
  `/etc/systemd/system/`:
  - `jomove.service` — web on `127.0.0.1:3000`, nginx fronts 443.
  - `jomove-scrape.service` + `.timer` — auto-scrape twice daily
    (10:00, 17:15 Europe/London — named timezone auto-handles BST/GMT).
    The timer actually targets `jomove-scrape-gate.service`
    (`scrape-if-due.sh`), which skips the run if a scrape — scheduled
    or manual — already happened within the last 2 hours (checks the
    mtime of `data/.last-auto-scrape`, touched by every successful run).
    Manual triggers via `jomove-scrape.service` directly always run,
    gate-free — see Ops helpers below.
- **nginx**: `ops/nginx-jomove.conf` → `/etc/nginx/conf.d/jomove.conf`.
  Let's Encrypt cert under `/etc/letsencrypt/live/jomove.jomify.lol/`,
  renewed by the same certbot timer that handles `admin.jomify.lol`.
- **GH Actions does NOT install changed unit files.** If `deploy/*` or
  `ops/*` change, run manually:
  ```
  ssh ubuntu@193.123.180.81 'cd ~/jomove && \
    sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/ && \
    sudo systemctl daemon-reload'
  ```

## Ops helpers

```
ssh ubuntu@193.123.180.81 'sudo journalctl -u jomove -f'                # web logs
ssh ubuntu@193.123.180.81 'sudo journalctl -u jomove-scrape -n 50'      # scrape logs
ssh ubuntu@193.123.180.81 'sudo systemctl start jomove-scrape.service'  # one-off scrape (gate-free, always runs)
ssh ubuntu@193.123.180.81 'sudo systemctl restart jomove'               # restart web
```

The prod DB at `/home/ubuntu/jomove/data/jomove.db` holds **live user state**
(favourites, comments, ratings, custom images). Never blindly overwrite —
back up first (`cp ... /tmp/jomove-vm-backup-$(date +%s).db`).

SMTP isn't configured on prod; `auto-scrape` runs without notifications.
Drop `SMTP_HOST/PORT/USER/PASS/NOTIFY_TO` into `/home/ubuntu/jomove/.env` to
enable email digests of new listings.

## OpenRent proxy

OpenRent fronts everything with AWS WAF and blocks the Oracle Cloud IP.
The scraper has two-stage fallback:

1. **Paid rotating endpoint** (preferred): set `OPENRENT_PROXY` in
   `/home/ubuntu/jomove/.env`. Webshare free tier suffices — sign up at
   <https://www.webshare.io/>, then use the **rotating backbone**, not
   an individual proxy IP:
   ```
   OPENRENT_PROXY=http://<user>-rotate:<pass>@p.webshare.io:80
   ```
   (Append `-rotate` to your username; the bare username pins to one IP
   which gets WAF-blocked.) The scraper retries 405 responses up to 12x
   through the same endpoint — each retry hits a freshly rotated IP, so
   ~30% per-IP pass rate becomes ~97% overall. Runs in ~5–6 min for the
   full ~230 listings via Promise.all concurrency of 3.
2. **Free-proxy pool** (fallback): scrapes public lists and sustain-
   tests candidates. Healthy proxies are remembered in
   `data/proxy-health.json` — the next run starts from a warm pool of
   recently-good IPs instead of probing the full list again.

Without `OPENRENT_PROXY`, you'll see slow degradation as free proxies
get burned (currently ~0–50 listings/run). With it, expect ~230/run.

## Misc

- Bun + TS, no build step.
- SQLite lives at `data/jomove.db` (WAL). Touch it via `bun -e '...'`
  one-liners rather than spinning up the server.
- British English; ~90 char lines; minimal comments (WHY only).
