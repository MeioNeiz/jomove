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

## Misc

- Bun + TS, no build step.
- SQLite lives at `data/jomove.db` (WAL). Touch it via `bun -e '...'`
  one-liners rather than spinning up the server.
- British English; ~90 char lines; minimal comments (WHY only).
