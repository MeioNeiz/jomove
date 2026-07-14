#!/usr/bin/env bash
# Gate for the scheduled auto-scrape timer. Skips if a scrape (manual or
# scheduled) already ran within the last 2 hours, so a manual trigger
# close to 10:00/17:15 doesn't get immediately duplicated by the timer.
# Manual triggers (`systemctl start jomove-scrape.service`) bypass this
# gate entirely — it only sits in front of the timer.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MARKER="data/.last-auto-scrape"
COOLDOWN_SECS=7200

if [ -f "$MARKER" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$MARKER") ))
  if [ "$AGE" -lt "$COOLDOWN_SECS" ]; then
    echo "scrape-if-due: last auto-scrape ${AGE}s ago (<2h) — skipping scheduled run"
    exit 0
  fi
fi

exec sudo systemctl start jomove-scrape.service
