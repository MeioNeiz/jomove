//---------- payload + meta ----------
// Injected by template.html: an inline <script> sets these globals from the
// server-rendered payload before this file is evaluated.
const DATA       = (window.__JOMOVE_DATA__       || []);
const APP_STATE  = (window.__JOMOVE_APP_STATE__  || null);
const GENERATED_AT = (window.__JOMOVE_GENERATED_AT__ || "1970-01-01T00:00:00");
const IS_LIVE    = location.protocol.startsWith("http");

// Render a UTC ISO timestamp as "YYYY-MM-DD HH:mm" in Europe/London — server
// stores everything in UTC but the dashboard is a UK-only app.
function formatLondonStamp(iso) {
  const d = new Date(/Z$/.test(iso) ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value; return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const STATE_KEY = "jomove:state:v1";  // localStorage fallback (file:// only)
const META_KEY  = "jomove:meta:v1";

let STATE = {};  // { [dedupe_key]: { viewed, favourite, rating, comment } }
let META  = {};  // { lastVisitAt }

if (IS_LIVE) {
  // Server (SQLite) is the source of truth — state arrives in the payload.
  for (const r of DATA) STATE[r.dedupe_key] = { ...(r.state || {}) };
  if (APP_STATE && APP_STATE.lastVisitAt) META.lastVisitAt = APP_STATE.lastVisitAt;
} else {
  // file:// mode — fall back to localStorage.
  try { STATE = JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); } catch {}
  try { META  = JSON.parse(localStorage.getItem(META_KEY)  || "{}"); } catch {}
}

// On very first visit, suppress NEW badges (no baseline).
if (!META.lastVisitAt) {
  META.lastVisitAt = GENERATED_AT;
  persistLastVisitAt();
}

function stateOf(k) {
  if (!STATE[k]) STATE[k] = {};
  return STATE[k];
}

// Compact fingerprint over the listing-level fields that affect rendering.
// User-state fields (favourite/rating/comment) live in STATE, not the row,
// so they don't need to be included. Keep this in sync with cardHtml().
function listingFingerprint(r) {
  return [
    r.status, r.price, r.beds, r.baths,
    r.furnished, r.parking, r.epc, r.deposit,
    r.available, r.pc_full, r.pc,
    r.green, r.rail, r.direct ? 1 : 0,
    r.listing_type, r.why, r.caveats,
    r.score,
    (r.media || []).length,
    (r.sources || []).map(s => s.src + s.url).join("|"),
    JSON.stringify(r.cost_adjustments && r.cost_adjustments.auto || []),
  ].join("");
}

// Track in-flight POSTs so a polling refresh doesn't clobber a just-edited row.
const pendingNoteWrites = new Set();

// Server-reachability indicator. Any successful fetch flips us online;
// any network failure flips us offline. Browser-side rendering only.
let _serverOnline = true;
function setServerOnline(ok) {
  if (ok === _serverOnline) return;
  _serverOnline = ok;
  const el = document.getElementById("server-status");
  if (el) el.classList.toggle("hidden", ok);
}

function patchState(k, patch) {
  // `viewed` is reserved for "viewed in person" — only the user toggles it
  // via the ✓ button. Adding a rating/comment marks a listing as REVIEWED
  // (derived state via isReviewed), which is a separate filter dimension.
  STATE[k] = { ...stateOf(k), ...patch };
  if (IS_LIVE) {
    pendingNoteWrites.add(k);
    fetch("/api/notes/" + encodeURIComponent(k), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(patch),
    }).then(r => setServerOnline(r.ok))
      .catch(() => setServerOnline(false))
      .finally(() => pendingNoteWrites.delete(k));
  } else {
    localStorage.setItem(STATE_KEY, JSON.stringify(STATE));
  }
}

function persistLastVisitAt() {
  if (IS_LIVE) {
    fetch("/api/app-state/last_visit_at", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ value: META.lastVisitAt }),
    }).then(r => setServerOnline(r.ok))
      .catch(() => setServerOnline(false));
  } else {
    localStorage.setItem(META_KEY, JSON.stringify(META));
  }
}

// Debounced filter/sort persistence — server-mode only.
let _filterSaveTimer = null;
function persistFiltersAndSort() {
  if (!IS_LIVE) return;
  clearTimeout(_filterSaveTimer);
  _filterSaveTimer = setTimeout(() => {
    const f = { ...filters };
    if (Number.isNaN(f.maxPrice)) f.maxPrice = null;
    fetch("/api/app-state/filters", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ value: f }),
    }).then(r => setServerOnline(r.ok))
      .catch(() => setServerOnline(false));
    fetch("/api/app-state/sort", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ value: filters.sort }),
    }).then(r => setServerOnline(r.ok))
      .catch(() => setServerOnline(false));
  }, 350);
}

//---------- media / carousel helpers ----------
function clampIdx(i, len) {
  if (!len) return 0;
  return ((i % len) + len) % len;
}
function gmapsHref(query) {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query);
}
function renderMediaItem(item, r) {
  if (!item) return "";
  if (item.kind === "scraped") {
    return `<img class="card-image" src="${esc(item.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`;
  }
  if (item.kind === "user") {
    return `<img class="card-image" src="${esc(item.url)}" alt="" loading="lazy">`;
  }
  if (item.kind === "map") {
    // Leaflet inits lazily into .leaflet-mount; map is interactive.
    // Click-through to Google Maps is via the postcode badge below the card.
    return `<div class="card-map">
              <div class="leaflet-mount" data-lat="${item.lat}" data-lon="${item.lon}"></div>
            </div>`;
  }
  return "";
}

const _leafletMounted = new WeakSet();
const _leafletObserver = ("IntersectionObserver" in window)
  ? new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) initLeafletMount(e.target);
      }
    }, { rootMargin: "200px" })
  : null;

function initLeafletMount(el) {
  if (_leafletMounted.has(el)) return;
  if (typeof L === "undefined") return; // script still loading; retry later
  const lat = Number(el.dataset.lat), lon = Number(el.dataset.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const map = L.map(el, {
    // Interactive: drag, double-click zoom, pinch zoom, +/- buttons.
    // scrollWheelZoom intentionally OFF so the page can scroll over the map
    // without trapping the wheel. Default zoom control disabled so we can
    // place it in the bottom-right (top-left is taken by carousel nav).
    zoomControl: false, attributionControl: true,
    scrollWheelZoom: false, doubleClickZoom: true,
    dragging: true, touchZoom: true, boxZoom: true,
    keyboard: false, tap: true,
  }).setView([lat, lon], 13);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OSM",
  }).addTo(map);
  L.marker([lat, lon]).addTo(map);
  _leafletMounted.add(el);
}

function bindLeafletInCard(card) {
  const mount = card.querySelector(".leaflet-mount");
  if (!mount) return;
  if (_leafletObserver) _leafletObserver.observe(mount);
  else initLeafletMount(mount);
}

/** Re-render just the media slot of one card (after carousel nav). */
function rerenderCardMedia(card, r, idx) {
  const stage = card.querySelector(".media-stage");
  if (!stage) return;
  stage.innerHTML = renderMediaItem(r.media[idx], r);
  const counter = card.querySelector(".media-nav .counter");
  if (counter) counter.textContent = `${idx + 1}/${r.media.length}`;
  card.querySelector(".card-media").dataset.idx = idx;
  bindLeafletInCard(card);
}
// Retry mounts once Leaflet's <script> finishes loading.
window.addEventListener("load", () => {
  document.querySelectorAll(".leaflet-mount").forEach(el => {
    if (!_leafletMounted.has(el)) initLeafletMount(el);
  });
});

//---------- helpers ----------
const SRC_LABEL = { openrent:"OR", rightmove:"RM", zoopla:"Z", onthemarket:"OTM", gumtree:"GT" };
const PARK_RANK = { allocated:5, driveway:5, "off-street":5, permit:3, "on-street":3, unclear:1, none:0, "":0 };

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtPrice(n) { return "£" + n.toLocaleString(); }
function fmtDate(iso, raw) { if (iso) return iso; return raw || "?"; }

// Compute the resolved cost adjustment from base auto + user overrides.
// Mirrors src/cost.ts so the dashboard can re-render instantly on edit
// without waiting for the next poll.
function resolveCostAdjustment(r) {
  const auto = (r.cost_adjustments && r.cost_adjustments.auto) || [];
  const ov   = stateOf(r.dedupe_key).cost_overrides
            || { remove: [], add: [] };
  const removed = new Set(ov.remove || []);
  const kept = auto
    .filter(c => !removed.has(c.label))
    .map(c => ({ label: c.label, delta: c.delta, source: "auto" }));
  const adds = (ov.add || [])
    .filter(c => c && typeof c.label === "string" && Number.isFinite(c.delta))
    .map(c => ({ label: c.label, delta: c.delta, source: "user" }));
  const components = [...kept, ...adds];
  const delta = components.reduce((s, c) => s + c.delta, 0);
  return { delta, components, auto };
}

function costAdjHtml(r) {
  const adj = resolveCostAdjustment(r);
  const cls = adj.delta === 0 ? "cost-zero" : (adj.delta < 0 ? "cost-down" : "cost-up");
  const sign = adj.delta === 0 ? "±" : (adj.delta < 0 ? "−" : "+");
  const amount = adj.delta === 0 ? "£0" : `£${Math.abs(adj.delta)}`;
  const breakdown = adj.components.length
    ? adj.components.map(c => `${c.label}: ${c.delta < 0 ? "−" : "+"}£${Math.abs(c.delta)}`).join(" · ")
    : "no adjustments — click to add";
  const eff = r.price + adj.delta;
  const title = `${breakdown} · effective ≈£${eff}/mo — click to edit`;
  return `<span class="cost-adj ${cls}" title="${esc(title)}">${sign}${amount}</span>`;
}

// ---------- cost-overrides editor ----------
const COST_PRESETS = [
  { label: "water incl",    delta: -25 },
  { label: "heating incl",  delta: -60 },
  { label: "bills incl",    delta: -130 },
  { label: "wifi incl",     delta: -30 },
];

function cloneOverrides(ov) {
  return {
    remove: [...(ov?.remove || [])],
    add:    (ov?.add || []).map(c => ({ label: c.label, delta: c.delta })),
  };
}

function emptyIfTrivial(ov) {
  if ((ov.remove?.length || 0) === 0 && (ov.add?.length || 0) === 0) return null;
  return ov;
}

function setCostOverrides(key, ov) {
  patchState(key, { cost_overrides: emptyIfTrivial(ov) });
}

function buildCostEditor(r) {
  const adj = resolveCostAdjustment(r);
  const ov  = cloneOverrides(stateOf(r.dedupe_key).cost_overrides);
  const items = adj.components.map(c => {
    const dir = c.delta < 0 ? "ce-down" : "ce-up";
    const sign = c.delta < 0 ? "−" : "+";
    const klass = c.source === "user" ? "ce-user" : "ce-auto";
    return `
      <li class="${klass} ${dir}">
        <span class="ce-label">${esc(c.label)}</span>
        <span class="ce-delta">${sign}£${Math.abs(c.delta)}</span>
        <button class="ce-x" data-ce-remove="${esc(c.label)}" data-ce-source="${c.source}"
                title="Remove this adjustment">×</button>
      </li>`;
  }).join("");

  // Hide presets already active (either as live auto or as a user-add).
  const activeLabels = new Set(adj.components.map(c => c.label));
  const presets = COST_PRESETS
    .filter(p => !activeLabels.has(p.label))
    .map(p => `<button class="ce-preset" data-ce-add="${esc(p.label)}" data-ce-delta="${p.delta}">+ ${esc(p.label)} ${p.delta < 0 ? "−" : "+"}£${Math.abs(p.delta)}</button>`)
    .join("");

  const totalCls = adj.delta === 0 ? "" : (adj.delta < 0 ? "cost-down" : "cost-up");
  const totalSign = adj.delta === 0 ? "±" : (adj.delta < 0 ? "−" : "+");
  const hasOv = (ov.remove.length + ov.add.length) > 0;

  return `
    <div class="cost-editor" data-key="${esc(r.dedupe_key)}">
      <div class="ce-title">Cost adjustments</div>
      <ul>${items || `<li class="ce-empty">No adjustments yet.</li>`}</ul>
      ${presets ? `<div class="ce-presets">${presets}</div>` : ""}
      <div class="ce-custom">
        <input class="ce-label-in" type="text" placeholder="Custom label (e.g. cleaning)" maxlength="40">
        <input class="ce-amount-in" type="number" step="1" placeholder="±£">
        <button class="ce-add-custom" disabled>Add</button>
      </div>
      <div class="ce-foot">
        <span>Total: <span class="ce-total ${totalCls}">${totalSign}£${Math.abs(adj.delta)}</span></span>
        <span>
          <button class="ce-reset" ${hasOv ? "" : "disabled"} title="Drop all user edits, restore auto">Reset</button>
          <button class="ce-close">Close</button>
        </span>
      </div>
    </div>`;
}

function closeAllCostEditors(except) {
  document.querySelectorAll(".cost-editor").forEach(el => {
    if (el !== except) el.remove();
  });
}

function openCostEditor(card, r) {
  closeAllCostEditors();
  const body = card.querySelector(".card-body");
  if (!body) return;
  body.insertAdjacentHTML("afterbegin", buildCostEditor(r));
  const editor = body.querySelector(".cost-editor");
  // Wire custom-add button enable state
  const lblIn = editor.querySelector(".ce-label-in");
  const amtIn = editor.querySelector(".ce-amount-in");
  const addBtn = editor.querySelector(".ce-add-custom");
  const refreshAdd = () => {
    addBtn.disabled = !(lblIn.value.trim() && amtIn.value.trim() && Number.isFinite(Number(amtIn.value)));
  };
  lblIn.addEventListener("input", refreshAdd);
  amtIn.addEventListener("input", refreshAdd);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { editor.remove(); }
    if (e.key === "Enter" && (e.target === lblIn || e.target === amtIn)) {
      if (!addBtn.disabled) addBtn.click();
    }
  });
}

function refreshCostUI(key) {
  const card = _cardNodes.get(key);
  if (!card) return;
  const r = DATA.find(x => x.dedupe_key === key);
  if (!r) return;
  // Rebuild pill
  const top = card.querySelector(".card-top .cost-adj");
  const tmp = document.createElement("div");
  tmp.innerHTML = costAdjHtml(r);
  if (top && tmp.firstElementChild) top.replaceWith(tmp.firstElementChild);
  // Rebuild editor (if open) — preserves focus is not critical here
  const open = card.querySelector(".cost-editor");
  if (open) {
    open.remove();
    openCostEditor(card, r);
  }
}

// ---------- furnishing badge + picker ----------
// The furn badge is click-to-edit: it opens a small picker so a mis-scraped
// or "furn ?" listing can be pinned to the right level. The override lives in
// user state (furnished_override), survives re-scrapes, and re-weights the
// server-side score on the next poll.
const FURN_LEVELS = [
  { value: "yes",      label: "Furnished" },
  { value: "part",     label: "Part furnished" },
  { value: "optional", label: "Optional" },
  { value: "no",       label: "Unfurnished" },
  { value: "unclear",  label: "Unclear" },
];

function furnBadgeHtml(r) {
  const f = r.furnished;
  const cls  = f === "no" ? "bad" : f === "unclear" ? "muted" : "good";
  const text = f === "no" ? "unfurn" : f === "unclear" ? "furn ?" : f;
  const overridden = stateOf(r.dedupe_key).furnished_override != null;
  const title = overridden
    ? "Furnishing (manually set) — click to change"
    : "Click to set furnishing level";
  return `<span class="badge ${cls} furn-badge${overridden ? " furn-set" : ""}" title="${esc(title)}">${esc(text)}</span>`;
}

function buildFurnPicker(r) {
  const cur = r.furnished;
  const overridden = stateOf(r.dedupe_key).furnished_override != null;
  const opts = FURN_LEVELS.map(l =>
    `<button class="furn-opt${cur === l.value ? " active" : ""}" data-furn-set="${l.value}">${esc(l.label)}</button>`
  ).join("");
  const scraped = FURN_LEVELS.find(l => l.value === r.furnished_scraped);
  const scrapedLabel = scraped ? scraped.label : (r.furnished_scraped || "unclear");
  const reset = overridden
    ? `<button class="furn-reset" data-furn-reset>↺ Reset to scraped (${esc(scrapedLabel)})</button>`
    : "";
  return `
    <div class="furn-picker" data-key="${esc(r.dedupe_key)}">
      <div class="fp-title">Furnishing</div>
      <div class="fp-opts">${opts}</div>
      ${reset}
    </div>`;
}

function closeAllFurnPickers(except) {
  document.querySelectorAll(".furn-picker").forEach(el => {
    if (el !== except) el.remove();
  });
}

function openFurnPicker(card, r) {
  closeAllFurnPickers();
  const facets = card.querySelector(".facets");
  if (!facets) return;
  facets.insertAdjacentHTML("afterend", buildFurnPicker(r));
}

// Swap just the furn badge in place — keeps the card's Leaflet map mounted
// (a full re-render would tear it down). Score re-weighting lands on the
// next poll, which rebuilds the card from the server-resolved payload.
function refreshFurnBadge(card, r) {
  const el = card.querySelector(".furn-badge");
  if (!el) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = furnBadgeHtml(r);
  const fresh = tmp.firstElementChild;
  if (fresh) el.replaceWith(fresh);
}

function postcodeBand(pcFull, pcArea) {
  const pc = pcFull || "";
  if (/^SO17 /.test(pc) || (!pc && pcArea === "SO17")) return "sweet";
  if (/^SO15 [12]/.test(pc) || /^SO14 [067]/.test(pc)) return "ok";
  if (/^SO15 [3578]/.test(pc) || /^SO14 [12345]/.test(pc) || /^SO18/.test(pc) ||
      (!pc && pcArea === "SO18")) return "penalty";
  return "neutral";
}
function isNew(item) {
  if (!META.lastVisitAt) return false;
  return item.first_seen > META.lastVisitAt && !stateOf(item.dedupe_key).viewed;
}
function newBadgeTitle(item) {
  // first_seen lacks a TZ suffix; treat as UTC for the diff (matches how
  // ingest writes it). Good enough for human-readable "X ago".
  const seenMs = new Date(item.first_seen + "Z").getTime();
  if (!Number.isFinite(seenMs)) return "First seen " + item.first_seen;
  const mins = Math.max(0, Math.round((Date.now() - seenMs) / 60000));
  let ago;
  if (mins < 60)            ago = mins + " min ago";
  else if (mins < 60 * 24)  ago = Math.round(mins / 60) + " h ago";
  else                      ago = Math.round(mins / (60 * 24)) + " d ago";
  return "First seen " + item.first_seen.replace("T", " ") + " (" + ago + ")";
}
function isReviewed(item) {
  const s = stateOf(item.dedupe_key);
  const hasRating  = typeof s.rating === "number" && s.rating >= 1;
  const hasComment = typeof s.comment === "string" && s.comment.trim() !== "";
  return hasRating && hasComment;
}

//---------- filtering + sorting ----------
const EPC_RANK = { A:1, B:2, C:3, D:4, E:5, F:6, G:7 };
const ALL_BEDS = ["studio","1","2","3+"];
// Legacy persisted bed-filter shape (pre-studio split). Used to upgrade
// saved filters so returning users keep seeing studios.
const LEGACY_BEDS = ["1","2","3+"];
// Sentinel for the "Other" / unknown-outcode bucket.
const OTHER_PC = "_other";

// Postcode universe derived from the payload. Recomputed whenever DATA
// changes (initial load + poll refresh). Returns an array of unique
// outcodes sorted numerically; OTHER_PC appended if any row has no pc.
function computeAllPcs(data) {
  const seen = new Set();
  let hasOther = false;
  for (const r of data) {
    const pc = r.pc || "";
    if (pc) seen.add(pc);
    else hasOther = true;
  }
  const out = [...seen].sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ""), 10);
    const nb = parseInt(b.replace(/\D/g, ""), 10);
    return (Number.isFinite(na) ? na : 999) - (Number.isFinite(nb) ? nb : 999);
  });
  if (hasOther) out.push(OTHER_PC);
  return out;
}

let ALL_PCS = computeAllPcs(DATA);

function pcLabel(p) { return p === OTHER_PC ? "?" : p.replace(/^SO/, ""); }
function pcTitle(p) { return p === OTHER_PC ? "Listings with no recognised outcode" : `Outcode ${p}`; }

function renderPcCheckboxes() {
  const body = document.getElementById("f-pc-body");
  if (!body) return;
  body.innerHTML = ALL_PCS.map(p =>
    `<label class="check" title="${esc(pcTitle(p))}">` +
      `<input class="f-pc" type="checkbox" value="${esc(p)}"> ${esc(pcLabel(p))}` +
    `</label>`
  ).join("");
}

const filters = {
  search: "",
  pcs: [...ALL_PCS],        // all-ticked default == no filter
  bedsSet: [...ALL_BEDS],   // all-ticked default == no filter
  minPrice: NaN,
  maxPrice: NaN,
  useEffectivePrice: false,
  furnMode: "",             // "" | "hide-no" | "furnished" | "yes"
  parkMode: "",             // "" | "hide-none" | "strict"
  reviewedMode: "",         // "" | "only" | "hide"  (reviewed = rating + comment)
  viewedMode: "",           // "" | "only" | "hide"  (viewed = physically been there)
  letMode: "",              // "" hide (default) | "include" | "only"
  rail: false,
  availBy: "",              // YYYY-MM-DD
  epcMin: "",               // "" | "A" | ... | "G"
  firstSeenDays: "",        // "" | number-string
  favs: false,
  newOnly: false,
  inclHouseshare: false,
  sort: "score",
};

// Restore saved filter/sort selection from server (no-op in file:// mode).
// Migrates the older single-select / boolean shape so personal-tool persisted
// state still loads cleanly.
if (IS_LIVE && APP_STATE) {
  if (APP_STATE.filters && typeof APP_STATE.filters === "object") {
    const f = APP_STATE.filters;
    // Migrate legacy single-select / boolean shape.
    if (typeof f.pc === "string" && !Array.isArray(f.pcs)) {
      f.pcs = f.pc ? [f.pc] : [...ALL_PCS];
    }
    if (typeof f.beds === "string" && !Array.isArray(f.bedsSet)) {
      f.bedsSet = f.beds ? [f.beds] : [...ALL_BEDS];
    }
    if (f.furn === true && !f.furnMode) f.furnMode = "furnished";
    if (f.park === true && !f.parkMode) f.parkMode = "hide-none";
    if (f.hideViewed === true && !f.viewedMode) f.viewedMode = "hide";
    if (f.inclLetAgreed === true && !f.letMode) f.letMode = "include";
    delete f.pc; delete f.beds; delete f.furn; delete f.park;
    delete f.hideViewed; delete f.inclLetAgreed;
    Object.assign(filters, f);
    if (filters.minPrice == null) filters.minPrice = NaN;
    if (filters.maxPrice == null) filters.maxPrice = NaN;
    if (!Array.isArray(filters.pcs))     filters.pcs     = [...ALL_PCS];
    if (!Array.isArray(filters.bedsSet)) filters.bedsSet = [...ALL_BEDS];
    // Empty array = "show all" (any earlier session ended up here under the
    // previous semantics). Normalise so the UI checkboxes match what's shown.
    if (filters.pcs.length === 0)     filters.pcs     = [...ALL_PCS];
    if (filters.bedsSet.length === 0) filters.bedsSet = [...ALL_BEDS];
    // Upgrade old persisted shape: if every legacy bed value is ticked
    // and "studio" isn't present, treat that as "show all" and add it.
    if (filters.bedsSet.length === LEGACY_BEDS.length &&
        LEGACY_BEDS.every(b => filters.bedsSet.includes(b)) &&
        !filters.bedsSet.includes("studio")) {
      filters.bedsSet = [...ALL_BEDS];
    }
    // Postcode filter migration: the saved set may include outcodes that
    // are no longer in the data, or be missing ones that now appear. If
    // every outcode in the saved set is still present AND the saved set
    // covers every currently-known outcode, leave it alone (= no filter).
    // Otherwise intersect with the current universe; if that leaves the
    // set empty, fall back to "all ticked".
    const savedSet = new Set(filters.pcs);
    const intersect = filters.pcs.filter(p => ALL_PCS.includes(p));
    // Special case the previous "all four hardcoded outcodes" snapshot —
    // expand to whatever the current data universe is so SO16/SO50 don't
    // get silently excluded for returning users.
    const wasOldAllTicked =
      savedSet.size === 4 &&
      ["SO14","SO15","SO17","SO18"].every(p => savedSet.has(p));
    if (wasOldAllTicked || intersect.length === 0) {
      filters.pcs = [...ALL_PCS];
    } else {
      filters.pcs = intersect;
    }
  }
  if (APP_STATE.sort) filters.sort = APP_STATE.sort;
}

function applyFiltersToDOM() {
  document.getElementById("f-search").value = filters.search || "";
  document.querySelectorAll(".f-pc").forEach(el => {
    el.checked = filters.pcs.includes(el.value);
  });
  document.querySelectorAll(".f-beds").forEach(el => {
    el.checked = filters.bedsSet.includes(el.value);
  });
  document.getElementById("f-price-min").value = Number.isFinite(filters.minPrice) ? filters.minPrice : "";
  document.getElementById("f-price").value     = Number.isFinite(filters.maxPrice) ? filters.maxPrice : "";
  document.getElementById("f-use-eff").checked = !!filters.useEffectivePrice;
  document.getElementById("f-furn").value      = filters.furnMode || "";
  document.getElementById("f-park").value      = filters.parkMode || "";
  document.getElementById("f-reviewed").value  = filters.reviewedMode || "";
  document.getElementById("f-viewed").value    = filters.viewedMode || "";
  document.getElementById("f-let").value       = filters.letMode || "";
  document.getElementById("f-rail").checked    = !!filters.rail;
  document.getElementById("f-avail-by").value  = filters.availBy || "";
  document.getElementById("f-epc-min").value   = filters.epcMin || "";
  document.getElementById("f-first-seen").value = filters.firstSeenDays || "";
  document.getElementById("f-favs").checked            = !!filters.favs;
  document.getElementById("f-new").checked             = !!filters.newOnly;
  document.getElementById("f-incl-houseshare").checked = !!filters.inclHouseshare;
  document.getElementById("f-sort").value              = filters.sort || "score";
}

function passesPcs(r) {
  // All ticked = no filter. Compare set membership rather than length so
  // a saved filter from when the data universe was smaller still counts.
  if (ALL_PCS.every(p => filters.pcs.includes(p))) return true;
  const pc = r.pc || OTHER_PC;
  return filters.pcs.includes(pc);
}
function passesBeds(r) {
  if (filters.bedsSet.length === ALL_BEDS.length) return true;
  // Studios are their own bucket — bed count is irrelevant when listing_type=studio.
  if (r.listing_type === "studio") return filters.bedsSet.includes("studio");
  if (r.beds == null) return false;
  if (filters.bedsSet.includes("3+") && r.beds >= 3) return true;
  return filters.bedsSet.includes(String(r.beds));
}
function passesFurn(r) {
  switch (filters.furnMode) {
    case "hide-no":    return r.furnished !== "no";
    case "furnished":  return ["yes","optional","part"].includes(r.furnished);
    case "yes":        return r.furnished === "yes";
    default:           return true;
  }
}
function passesPark(r) {
  switch (filters.parkMode) {
    case "hide-none":  return r.parking !== "none";
    case "strict":     return r.parking !== "none" && r.parking !== "unclear";
    default:           return true;
  }
}
function passesAvailBy(r) {
  if (!filters.availBy) return true;
  if (!r.available)     return true;  // unknown date — keep
  return r.available <= filters.availBy;
}
function passesEpcMin(r) {
  if (!filters.epcMin) return true;
  if (!r.epc)          return true;  // unknown — keep
  const want = EPC_RANK[filters.epcMin] ?? 99;
  const got  = EPC_RANK[r.epc]          ?? 99;
  return got <= want;
}
function passesFirstSeen(r) {
  if (!filters.firstSeenDays) return true;
  const days = Number(filters.firstSeenDays);
  if (!Number.isFinite(days) || days <= 0) return true;
  const cutoffMs = Date.now() - days * 86400_000;
  return new Date(r.first_seen).getTime() >= cutoffMs;
}
function effectivePriceFor(r) {
  if (!filters.useEffectivePrice) return r.price;
  // Use locally-resolved overrides so the filter is consistent with the pill,
  // not the (possibly stale) server-computed delta in r.cost_adjustments.
  return r.price + resolveCostAdjustment(r).delta;
}

function applyFilters(items) {
  return items.filter(r => {
    if (filters.search) {
      const hay = (r.address + " " + r.pc_full + " " + r.green).toLowerCase();
      if (!hay.includes(filters.search)) return false;
    }
    if (!passesPcs(r))       return false;
    if (!passesBeds(r))      return false;
    if (!Number.isNaN(filters.minPrice) && effectivePriceFor(r) < filters.minPrice) return false;
    if (!Number.isNaN(filters.maxPrice) && effectivePriceFor(r) > filters.maxPrice) return false;
    if (!passesFurn(r))      return false;
    if (!passesPark(r))      return false;
    if (filters.rail && !r.direct) return false;
    if (!passesAvailBy(r))   return false;
    if (!passesEpcMin(r))    return false;
    if (!passesFirstSeen(r)) return false;

    const s = stateOf(r.dedupe_key);
    if (filters.favs && !s.favourite) return false;
    if (filters.newOnly && !isNew(r)) return false;
    if (filters.viewedMode === "only" && !s.viewed) return false;
    if (filters.viewedMode === "hide" &&  s.viewed) return false;
    if (filters.reviewedMode === "only" && !isReviewed(r)) return false;
    if (filters.reviewedMode === "hide" &&  isReviewed(r)) return false;
    // Let-agreed: "" = hide (default), "include" = show, "only" = exclude actives.
    if (filters.letMode === "only"    && r.status !== "let_agreed") return false;
    if (filters.letMode === ""        && r.status === "let_agreed") return false;
    if (!filters.inclHouseshare && r.listing_type === "houseshare") return false;
    return true;
  });
}
function applySort(items) {
  const [key, dirRaw] = filters.sort.split("-");
  // "Score" in the dropdown has no -desc suffix; high-is-better keys default
  // to desc so the natural reading ("sort by rating") puts your 10s on top.
  const highIsBetter = key === "score" || key === "rating" || key === "first_seen";
  const dir = (dirRaw || (highIsBetter ? "desc" : "asc")) === "desc" ? -1 : 1;
  const v = (r) => {
    if (key === "score")      return r.score;
    if (key === "price")      return effectivePriceFor(r);
    if (key === "first_seen") return r.first_seen;
    if (key === "address")    return r.address.toLowerCase();
    if (key === "rating")     return stateOf(r.dedupe_key).rating || 0;
    return 0;
  };
  return items.slice().sort((a, b) => {
    const va = v(a), vb = v(b);
    if (va === vb) {
      // tiebreak: score desc, then effective price asc (matches sort meaning).
      return (b.score - a.score) || (effectivePriceFor(a) - effectivePriceFor(b));
    }
    return (va < vb ? -1 : 1) * dir;
  });
}

//---------- compare ----------
const compareSet = new Set();
function refreshCompareBtn() {
  const btn = document.getElementById("btn-compare");
  btn.textContent = `Compare (${compareSet.size}/2)`;
  btn.disabled = compareSet.size !== 2;
}
function openCompare() {
  const keys = [...compareSet];
  const items = keys.map(k => DATA.find(r => r.dedupe_key === k)).filter(Boolean);
  if (items.length !== 2) return;
  const body = document.getElementById("cmp-body");
  body.innerHTML = items.map(r => `
    <div class="cmp-col">
      <h3>${esc(r.address)}</h3>
      <div class="price">${fmtPrice(r.price)} <span style="font-size:13px;color:var(--muted);font-weight:400">${r.beds ?? "?"} bed</span></div>
      <dl>
        <dt>Score</dt><dd><strong>${r.score}</strong></dd>
        <dt>Postcode</dt><dd>${esc(r.pc_full || r.pc || "?")}</dd>
        <dt>Furnished</dt><dd>${esc(stateOf(r.dedupe_key).furnished_override != null ? r.furnished : (r.furnished_raw || r.furnished || "?"))}</dd>
        <dt>Parking</dt><dd>${esc(r.parking_raw || r.parking || "?")}</dd>
        <dt>EPC</dt><dd>${r.epc ? `<span class="epc epc-${r.epc}">EPC ${r.epc}</span>` : "?"}</dd>
        <dt>Rail</dt><dd>${esc(r.rail || "?")}</dd>
        <dt>Green</dt><dd>${esc(r.green || "?")}</dd>
        <dt>Available</dt><dd>${esc(fmtDate(r.available, r.available_raw))}</dd>
        <dt>Deposit</dt><dd>${r.deposit ? "£" + r.deposit : "?"}</dd>
        <dt>Why</dt><dd>${esc(r.why || "")}</dd>
        <dt>Caveats</dt><dd>${esc(r.caveats || "")}</dd>
        <dt>Sources</dt><dd>${r.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener" data-stop title="Click: shared window · ⌘/Ctrl-click: new tab">${SRC_LABEL[s.src] || s.src} ↗</a>`).join(" ")}</dd>
      </dl>
    </div>
  `).join("");
  document.getElementById("compare").showModal();
}

//---------- rendering ----------
function cardHtml(r) {
  const st = stateOf(r.dedupe_key);
  const newBadge = isNew(r) ? `<span class="badge new" title="${esc(newBadgeTitle(r))}">NEW</span>` : "";
  const letAgreed = r.status === "let_agreed" ? `<span class="badge let-agreed">LET AGREED</span>` : "";
  const band = postcodeBand(r.pc_full, r.pc);
  const pcBadge = band === "sweet"   ? `<span class="badge sweet">sweet spot</span>` :
                  band === "penalty" ? `<span class="badge penalty">remote/west</span>` : "";
  const parkingBadge = r.parking === "none" ? `<span class="badge bad">no parking</span>` :
                       r.parking === "unclear" ? `<span class="badge muted">parking ?</span>` :
                       `<span class="badge good">${esc(r.parking)}</span>`;
  const furnBadge = furnBadgeHtml(r);
  const epcBadge = r.epc ? `<span class="epc epc-${r.epc}">EPC ${r.epc}</span>` :
                           `<span class="epc epc-unknown">EPC ?</span>`;
  const railBadge = r.direct ? `<span class="badge good">direct</span>` : `<span class="badge muted">change</span>`;
  const greenBadge = r.green && /common/i.test(r.green) ? `<span class="badge good">Common</span>` : "";
  const typeBadge =
    r.listing_type === "houseshare" ? `<span class="badge type-share">HOUSE SHARE</span>` :
    r.listing_type === "studio"     ? `<span class="badge type-studio">STUDIO</span>` :
    r.listing_type === "maisonette" ? `<span class="badge type-maisonette">MAISONETTE</span>` :
    r.listing_type === "flat"       ? `<span class="badge type-flat">FLAT</span>` :
    r.listing_type === "house"      ? `<span class="badge type-house">HOUSE</span>` :
    "";

  const rating = st.rating || 0;
  const ratingHtml = [1,2,3,4,5,6,7,8,9,10].map(n =>
    `<button data-r="${n}" class="${n <= rating ? "lit" : ""}" aria-label="${n} out of 10">★</button>`
  ).join("");

  const sourcesHtml = r.sources.map(s =>
    `<a href="${esc(s.url)}" target="_blank" rel="noopener" data-stop
        title="Click: open in shared window · ⌘/Ctrl-click: new tab · Shift-click: new window · Right-click: more"
        >${SRC_LABEL[s.src] || s.src}</a>`
  ).join("");

  const classes = [
    "card",
    st.favourite ? "fav" : "",
    r.status === "let_agreed" ? "let-agreed" : "",
    compareSet.has(r.dedupe_key) ? "compare-selected" : "",
  ].filter(Boolean).join(" ");

  // Media: [map?, scraped?, user-pasted?]. Map is the default (index 0)
  // because location is the screen-stage signal. The stage holds the
  // active item only; nav arrows + dots appear on hover when >1 item.
  const media = Array.isArray(r.media) ? r.media : [];
  const hasScraped = media.some(m => m.kind === "scraped");
  const hasUser    = media.some(m => m.kind === "user");
  const idx = clampIdx(st.media_index || 0, media.length);
  const stageInner = media.length === 0
    ? `<div class="card-placeholder">
         ${r.why ? `<div class="why">${esc(r.why)}</div>` : ""}
         <div class="hint">📋 Paste an image (Ctrl+V)</div>
       </div>`
    : renderMediaItem(media[idx], r);

  const navHtml = media.length > 1
    ? `<div class="media-nav">
         <button class="media-prev" aria-label="Previous">‹</button>
         <span class="counter">${idx + 1}/${media.length}</span>
         <button class="media-next" aria-label="Next">›</button>
       </div>`
    : "";

  // Kind label dropped: the carousel counter ("1/2", "2/2") makes which-
  // item-am-I-on obvious, and the content (map vs photo) speaks for itself.
  const kindBadge = "";

  // Paste affordance whenever there's no scraped image. Re-paste replaces.
  const pasteBtn = hasScraped
    ? ""
    : `<button class="paste-btn${hasUser ? " user-img-replace" : ""}"
                title="Paste image from clipboard">📋 ${hasUser ? "Replace" : "Paste"}</button>`;

  const mediaHtml = `<div class="card-media" data-idx="${idx}" data-len="${media.length}">
    <div class="media-stage">${stageInner}</div>
    ${navHtml}${kindBadge}${pasteBtn}
  </div>`;

  // Clickable postcode badge → Google Maps. Uses the full address as the
  // search target (more precise than just an SO15 area chip).
  const pcText = r.pc_full || r.pc;
  const pcHtml = pcText
    ? `<a class="badge pc-link" data-stop target="_blank" rel="noopener"
          title="Open in Google Maps: ${esc(r.map_link_query)}"
          href="${esc(gmapsHref(r.map_link_query))}"
       >${esc(pcText)} ↗</a>`
    : "";

  return `
    <article class="${classes}" data-key="${esc(r.dedupe_key)}">
      ${mediaHtml}
      <div class="card-body">
      <div class="card-top">
        <span class="price">${fmtPrice(r.price)}</span>
        ${costAdjHtml(r)}
        <span class="beds">${r.beds ?? "?"} bed</span>
        <span class="spacer"></span>
        <span class="score" title="Score (max ~103)">${r.score}</span>
        <span class="icons">
          <button class="btn-fav ${st.favourite ? "on" : ""}" title="Favourite">★</button>
          <button class="btn-viewed ${st.viewed ? "viewed-on" : ""}" title="Viewed">✓</button>
          <button class="btn-cmp ${compareSet.has(r.dedupe_key) ? "cmp-on" : ""}" title="Add to compare">⇄</button>
          <button class="btn-let ${r.status === "let_agreed" ? "let-on" : ""}" title="Mark as let agreed">🏷</button>
        </span>
      </div>
      <div class="badges">
        ${newBadge}
        ${letAgreed}
        ${typeBadge}
        ${pcBadge}
        ${pcHtml}
      </div>
      <h3 class="address">${esc(r.address)}</h3>
      <ul class="facets">
        <li>${parkingBadge}</li>
        <li>${furnBadge}</li>
        <li>${epcBadge}</li>
        <li>${railBadge}</li>
        ${greenBadge ? `<li>${greenBadge}</li>` : ""}
        <li><span class="badge muted">${esc(fmtDate(r.available, r.available_raw))}</span></li>
      </ul>
      <div class="rating" data-key="${esc(r.dedupe_key)}">${ratingHtml}</div>
      <textarea class="comment" data-key="${esc(r.dedupe_key)}" placeholder="Your notes…">${esc(st.comment || "")}</textarea>
      <div class="card-foot">
        <div class="sources">${sourcesHtml}</div>
        <button class="expand-btn">More ↓</button>
      </div>
      <div class="detail">
        <div class="row"><div class="k">Why</div>${esc(r.why || "(none)")}</div>
        <div class="row"><div class="k">Caveats / verify</div>${esc(r.caveats || "(none)")}</div>
        <div class="row"><div class="k">Rail</div>${esc(r.rail || "(none)")}</div>
        <div class="row"><div class="k">Green</div>${esc(r.green || "(none)")}</div>
        ${r.deposit ? `<div class="row"><div class="k">Deposit</div>£${r.deposit}</div>` : ""}
      </div>
      </div>
    </article>
  `;
}

// Card DOM cache keyed by dedupe_key. Persisting nodes across renders keeps
// Leaflet maps mounted instead of being destroyed-and-rebuilt on every state
// change (rating, favourite, viewed, compare). Only state-driven bits update
// in place; listing-data changes flow through pollOnce, which clears the cache.
const _cardNodes = new Map();

function updateCardState(node, r) {
  const st = stateOf(r.dedupe_key);
  node.classList.toggle("fav", !!st.favourite);
  node.classList.toggle("let-agreed", r.status === "let_agreed");
  node.classList.toggle("compare-selected", compareSet.has(r.dedupe_key));

  const favBtn = node.querySelector(".btn-fav");
  if (favBtn) favBtn.classList.toggle("on", !!st.favourite);
  const viewedBtn = node.querySelector(".btn-viewed");
  if (viewedBtn) viewedBtn.classList.toggle("viewed-on", !!st.viewed);
  const cmpBtn = node.querySelector(".btn-cmp");
  if (cmpBtn) cmpBtn.classList.toggle("cmp-on", compareSet.has(r.dedupe_key));
  const letBtn = node.querySelector(".btn-let");
  if (letBtn) letBtn.classList.toggle("let-on", r.status === "let_agreed");

  const rating = st.rating || 0;
  node.querySelectorAll(".rating button").forEach((btn, i) => {
    btn.classList.toggle("lit", i < rating);
  });

  // NEW badge toggles with first_seen vs lastVisitAt + viewed.
  const badges = node.querySelector(".badges");
  if (badges) {
    const want = isNew(r);
    let badge = badges.querySelector(".badge.new");
    if (want && !badge) {
      badge = document.createElement("span");
      badge.className = "badge new";
      badge.textContent = "NEW";
      badge.title = newBadgeTitle(r);
      badges.insertBefore(badge, badges.firstChild);
    } else if (!want && badge) {
      badge.remove();
    } else if (want && badge) {
      // Keep the tooltip's "X ago" fresh across re-renders/polls.
      badge.title = newBadgeTitle(r);
    }
    const wantLet = r.status === "let_agreed";
    let letBadge = badges.querySelector(".badge.let-agreed");
    if (wantLet && !letBadge) {
      letBadge = document.createElement("span");
      letBadge.className = "badge let-agreed";
      letBadge.textContent = "LET AGREED";
      badges.insertBefore(letBadge, badges.firstChild);
    } else if (!wantLet && letBadge) {
      letBadge.remove();
    }
  }

  // Comment textarea: only sync if user isn't editing it (don't blow away typing).
  const ta = node.querySelector(".comment");
  if (ta && document.activeElement !== ta) {
    const want = st.comment || "";
    if (ta.value !== want) ta.value = want;
  }
}

function ensureCard(r) {
  const cached = _cardNodes.get(r.dedupe_key);
  if (cached) {
    updateCardState(cached, r);
    return { node: cached, created: false };
  }
  const tmp = document.createElement("div");
  tmp.innerHTML = cardHtml(r);
  const node = tmp.firstElementChild;
  _cardNodes.set(r.dedupe_key, node);
  return { node, created: true };
}

function render() {
  const filtered = applySort(applyFilters(DATA));
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");

  // Evict cached nodes whose listing has dropped out of DATA (poll churn).
  const liveKeys = new Set(DATA.map(r => r.dedupe_key));
  for (const key of [..._cardNodes.keys()]) {
    if (!liveKeys.has(key)) {
      const n = _cardNodes.get(key);
      if (n && n.parentElement) n.remove();
      _cardNodes.delete(key);
    }
  }

  const visible = new Set();
  let cursor = 0;
  for (const r of filtered) {
    const { node, created } = ensureCard(r);
    // Only touch the DOM when this node isn't already where it belongs.
    // Blind appendChild on every iteration shuffles each card through the
    // DOM (remove+insert) even for stable orderings, which causes 1 reflow
    // per card per click — visually a full view reset.
    if (grid.children[cursor] !== node) {
      grid.insertBefore(node, grid.children[cursor] || null);
    }
    if (created) bindLeafletInCard(node);
    visible.add(r.dedupe_key);
    cursor++;
  }
  // Detach filtered-out cards (kept in cache so re-appearing is free).
  for (const [key, node] of _cardNodes) {
    if (!visible.has(key) && node.parentElement) node.remove();
  }
  empty.hidden = filtered.length !== 0;

  document.getElementById("visible-count").textContent = filtered.length;
  let favCount = 0, newCount = 0, reviewedCount = 0;
  for (const r of DATA) {
    if (r.status !== "let_agreed") {
      if (stateOf(r.dedupe_key).favourite) favCount++;
      if (isNew(r)) newCount++;
      if (isReviewed(r)) reviewedCount++;
    }
  }
  document.getElementById("fav-count").textContent      = favCount;
  document.getElementById("new-count").textContent      = newCount;
  document.getElementById("reviewed-count").textContent = reviewedCount;
  refreshCompareBtn();
}

//---------- event wiring ----------
function bindFilters() {
  const map = {
    "f-search":         v => filters.search = v.toLowerCase().trim(),
    "f-price-min":      v => filters.minPrice = v === "" ? NaN : Number(v),
    "f-price":          v => filters.maxPrice = v === "" ? NaN : Number(v),
    "f-use-eff":        v => filters.useEffectivePrice = v,
    "f-furn":           v => filters.furnMode = v,
    "f-park":           v => filters.parkMode = v,
    "f-reviewed":       v => filters.reviewedMode = v,
    "f-viewed":         v => filters.viewedMode = v,
    "f-let":            v => filters.letMode = v,
    "f-rail":           v => filters.rail = v,
    "f-avail-by":       v => filters.availBy = v,
    "f-epc-min":        v => filters.epcMin = v,
    "f-first-seen":     v => filters.firstSeenDays = v,
    "f-favs":           v => filters.favs = v,
    "f-new":            v => filters.newOnly = v,
    "f-incl-houseshare":v => filters.inclHouseshare = v,
    "f-sort":           v => filters.sort = v,
  };
  for (const [id, setter] of Object.entries(map)) {
    const el = document.getElementById(id);
    const handler = () => {
      const v = el.type === "checkbox" ? el.checked : el.value;
      setter(v); render(); persistFiltersAndSort();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  }

  // Multi-checkbox groups (postcodes, beds) — collect the checked values.
  // Unticking the last box auto-reverts to "all ticked" so the visual state
  // always matches the result set ("if showing all, all should be checked").
  // PC group uses delegation since its DOM is rebuilt by renderPcCheckboxes
  // after polls; beds group is static so direct binding is fine.
  const wireGroupDelegated = (containerSel, cls, target, getAll) => {
    const container = document.querySelector(containerSel);
    if (!container) return;
    container.addEventListener("change", (e) => {
      if (!e.target.matches("." + cls)) return;
      let next = [...container.querySelectorAll("." + cls + ":checked")]
        .map(x => x.value);
      if (next.length === 0) {
        next = [...getAll()];
        container.querySelectorAll("." + cls).forEach(x => x.checked = true);
      }
      filters[target] = next;
      render(); persistFiltersAndSort();
    });
  };
  wireGroupDelegated("#f-pc-body", "f-pc", "pcs", () => ALL_PCS);

  const wireGroup = (cls, target, all) => {
    document.querySelectorAll("." + cls).forEach(el => {
      el.addEventListener("change", () => {
        let next = [...document.querySelectorAll("." + cls + ":checked")]
          .map(x => x.value);
        if (next.length === 0) {
          next = [...all];
          document.querySelectorAll("." + cls).forEach(x => x.checked = true);
        }
        filters[target] = next;
        render(); persistFiltersAndSort();
      });
    });
  };
  wireGroup("f-beds", "bedsSet", ALL_BEDS);

  document.getElementById("btn-reset").onclick = () => {
    Object.assign(filters, {
      search:"", pcs:[...ALL_PCS], bedsSet:[...ALL_BEDS],
      minPrice:NaN, maxPrice:NaN, useEffectivePrice:false,
      furnMode:"", parkMode:"", reviewedMode:"", viewedMode:"",
      letMode:"", rail:false,
      availBy:"", epcMin:"", firstSeenDays:"",
      favs:false, newOnly:false,
      inclHouseshare:false, sort:"score",
    });
    applyFiltersToDOM();
    render();
    persistFiltersAndSort();
  };
  document.getElementById("btn-mark-seen").onclick = () => {
    META.lastVisitAt = GENERATED_AT;
    persistLastVisitAt();
    render();
  };
  document.getElementById("btn-compare").onclick = openCompare;
}

async function pasteImageFromClipboard(key, btn) {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    alert("Your browser doesn't expose the clipboard. Try focusing this card and pressing Ctrl+V instead.");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith("image/")) {
          const blob = await item.getType(type);
          await uploadUserImage(key, blob, btn);
          return;
        }
      }
    }
    alert("No image found in clipboard. Copy an image first.");
  } catch (err) {
    alert("Paste failed: " + (err.message || err));
  }
}

async function uploadUserImage(key, blob, btn) {
  if (btn) btn.classList.add("busy");
  try {
    const res = await fetch("/api/user-image/" + encodeURIComponent(key), {
      method:  "POST",
      headers: { "Content-Type": blob.type || "image/png" },
      body:    blob,
    });
    if (!res.ok) {
      alert("Upload failed: " + res.status + " " + (await res.text()));
      return;
    }
    const { url } = await res.json();
    // Patch DATA in place + re-render this card without losing scroll/filters
    const item = DATA.find(r => r.dedupe_key === key);
    if (item) item.user_image_url = url;
    render();
  } catch (err) {
    alert("Upload failed: " + (err.message || err));
  } finally {
    if (btn) btn.classList.remove("busy");
  }
}

// Plain click on a source link opens in a single named window.
// Modifier-key clicks (Ctrl/Cmd, Shift, middle) fall through to browser default.
function smartOpenLink(e, anchor) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return false;
  e.preventDefault();
  e.stopPropagation();
  const win = window.open(anchor.href, "jomove-listings");
  if (win) win.focus();
  return true;
}

function bindGrid() {
  const grid = document.getElementById("grid");
  grid.addEventListener("click", (e) => {
    const t = e.target;
    const srcAnchor = t.closest("a[data-stop]");
    if (srcAnchor) { smartOpenLink(e, srcAnchor); return; }
    const card = t.closest(".card");
    if (!card) return;
    const key = card.dataset.key;

    // ---------- cost-overrides editor ----------
    if (t.matches(".cost-adj")) {
      e.stopPropagation();
      const r = DATA.find(x => x.dedupe_key === key);
      if (!r) return;
      const existing = card.querySelector(".cost-editor");
      if (existing) existing.remove();
      else openCostEditor(card, r);
      return;
    }
    const editor = t.closest(".cost-editor");
    if (editor) {
      e.stopPropagation();
      const r = DATA.find(x => x.dedupe_key === key);
      if (!r) return;
      const ov = cloneOverrides(stateOf(key).cost_overrides);

      if (t.matches(".ce-close")) { editor.remove(); return; }
      if (t.matches(".ce-reset")) { setCostOverrides(key, { remove: [], add: [] }); refreshCostUI(key); return; }
      if (t.matches(".ce-x")) {
        const label = t.dataset.ceRemove;
        const source = t.dataset.ceSource;
        if (source === "auto") {
          if (!ov.remove.includes(label)) ov.remove.push(label);
        } else {
          ov.add = ov.add.filter(c => c.label !== label);
        }
        setCostOverrides(key, ov);
        refreshCostUI(key);
        return;
      }
      if (t.matches(".ce-preset")) {
        const label = t.dataset.ceAdd;
        const delta = Number(t.dataset.ceDelta);
        // If the label was previously removed from auto, un-remove it.
        const removedIdx = ov.remove.indexOf(label);
        if (removedIdx >= 0) {
          ov.remove.splice(removedIdx, 1);
        } else {
          // Skip if already active via auto without removal.
          const adj = resolveCostAdjustment(r);
          if (!adj.components.some(c => c.label === label)) {
            ov.add.push({ label, delta });
          }
        }
        setCostOverrides(key, ov);
        refreshCostUI(key);
        return;
      }
      if (t.matches(".ce-add-custom")) {
        const lblIn = editor.querySelector(".ce-label-in");
        const amtIn = editor.querySelector(".ce-amount-in");
        const label = (lblIn.value || "").trim();
        const delta = Number(amtIn.value);
        if (!label || !Number.isFinite(delta)) return;
        ov.add.push({ label, delta });
        setCostOverrides(key, ov);
        refreshCostUI(key);
        return;
      }
      return;
    }

    // ---------- furnishing picker ----------
    if (t.closest(".furn-badge")) {
      e.stopPropagation();
      const r = DATA.find(x => x.dedupe_key === key);
      if (!r) return;
      const existing = card.querySelector(".furn-picker");
      if (existing) existing.remove();
      else openFurnPicker(card, r);
      return;
    }
    const furnPicker = t.closest(".furn-picker");
    if (furnPicker) {
      e.stopPropagation();
      const r = DATA.find(x => x.dedupe_key === key);
      if (!r) return;
      if (t.matches("[data-furn-set]")) {
        const val = t.dataset.furnSet;
        r.furnished = val;                       // local echo for instant badge
        patchState(key, { furnished_override: val });
        refreshFurnBadge(card, r);
        furnPicker.remove();
      } else if (t.matches("[data-furn-reset]")) {
        r.furnished = r.furnished_scraped;
        patchState(key, { furnished_override: null });
        refreshFurnBadge(card, r);
        furnPicker.remove();
      }
      return;
    }

    if (t.matches(".btn-fav")) {
      const s = stateOf(key);
      patchState(key, { favourite: !s.favourite });
      render();
      return;
    }
    if (t.matches(".btn-viewed")) {
      const s = stateOf(key);
      patchState(key, { viewed: !s.viewed });
      render();
      return;
    }
    if (t.matches(".btn-cmp")) {
      if (compareSet.has(key)) compareSet.delete(key);
      else if (compareSet.size < 2) compareSet.add(key);
      else { /* already at 2 — ignore */ }
      render();
      return;
    }
    if (t.matches(".btn-let")) {
      const item = DATA.find(x => x.dedupe_key === key);
      if (!item) return;
      const next = item.status === "let_agreed" ? "active" : "let_agreed";
      item.status = next;
      if (IS_LIVE) {
        fetch("/api/listings/" + encodeURIComponent(key) + "/status", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ status: next }),
        }).then(r => setServerOnline(r.ok))
          .catch(() => setServerOnline(false));
      }
      render();
      return;
    }
    if (t.matches(".rating button")) {
      const r = Number(t.dataset.r);
      const cur = stateOf(key).rating || 0;
      patchState(key, { rating: cur === r ? 0 : r });
      render();
      return;
    }
    if (t.matches(".expand-btn")) {
      const detail = card.querySelector(".detail");
      const open = detail.classList.toggle("open");
      t.textContent = open ? "Less ↑" : "More ↓";
      return;
    }
    if (t.matches(".paste-btn")) {
      e.stopPropagation();
      pasteImageFromClipboard(key, t);
      return;
    }
    if (t.matches(".media-prev") || t.matches(".media-next")) {
      e.stopPropagation();
      e.preventDefault();
      const dir = t.matches(".media-next") ? 1 : -1;
      const r = DATA.find(x => x.dedupe_key === key);
      if (!r || !r.media || r.media.length < 2) return;
      const cur = stateOf(key).media_index || 0;
      const next = clampIdx(cur + dir, r.media.length);
      patchState(key, { media_index: next });
      // Local DOM swap is cheap; avoids re-rendering all cards.
      rerenderCardMedia(card, r, next);
      return;
    }
  });

  // Ctrl+V while hovering a no-scrape-image card → paste into that card.
  let _hoverCard = null;
  grid.addEventListener("mouseover", (e) => {
    const c = e.target.closest && e.target.closest(".card");
    if (c) _hoverCard = c.dataset.key;
  });
  grid.addEventListener("mouseout", (e) => {
    const c = e.target.closest && e.target.closest(".card");
    if (c && c.dataset.key === _hoverCard) _hoverCard = null;
  });
  document.addEventListener("paste", (e) => {
    if (!_hoverCard) return;
    if (e.target && e.target.matches && e.target.matches(".comment, input, textarea")) return;
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const blob = item.getAsFile();
    if (!blob) return;
    const btn = document.querySelector(`.card[data-key="${CSS.escape(_hoverCard)}"] .paste-btn`);
    uploadUserImage(_hoverCard, blob, btn);
  });

  // comment save on input (debounced)
  let saveTimer;
  grid.addEventListener("input", (e) => {
    if (!e.target.matches(".comment")) return;
    const key = e.target.dataset.key;
    const val = e.target.value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => patchState(key, { comment: val }), 250);
  });

  // open sources in new tab without triggering card-level handlers
  grid.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-stop]");
    if (a) e.stopPropagation();
  }, true);
}

//---------- scrape button ----------
// "Scrape now" triggers POST /api/scrape, then polls /api/scrape/status
// every 3s until the run completes. The data-version poll picks up new
// listings automatically while the scrape is in flight.
let _scrapeStatusTimer = null;
function setScrapeBtn(text, disabled) {
  const btn = document.getElementById("btn-scrape");
  if (!btn) return;
  btn.textContent = text;
  btn.disabled = !!disabled;
}
async function refreshScrapeStatus() {
  try {
    const res = await fetch("/api/scrape/status", { cache: "no-store" });
    if (!res.ok) return;
    const s = await res.json();
    if (s.running) {
      const elapsedS = s.startedAt
        ? Math.max(0, Math.round((Date.now() - new Date(s.startedAt + "Z").getTime()) / 1000))
        : null;
      setScrapeBtn(elapsedS != null ? `Scraping… ${elapsedS}s` : "Scraping…", true);
    } else {
      if (_scrapeStatusTimer) {
        clearInterval(_scrapeStatusTimer);
        _scrapeStatusTimer = null;
      }
      // Show last result briefly, then revert.
      if (s.lastError) {
        setScrapeBtn(`Scrape failed`, false);
        document.getElementById("btn-scrape").title = s.lastError;
      } else if (s.lastResult) {
        const r = s.lastResult;
        const secs = Math.round((r.durationMs || 0) / 1000);
        setScrapeBtn(`Done · ${r.total} found (${secs}s)`, false);
        document.getElementById("btn-scrape").title =
          r.perPortal.map(p => `${p.portal}: ${p.written}`).join(" · ");
      } else {
        setScrapeBtn("Scrape now", false);
      }
      setTimeout(() => setScrapeBtn("Scrape now", false), 5000);
      // Force a payload refresh in case the version poll missed the bump.
      pollOnce();
    }
  } catch { /* swallow */ }
}
function bindScrapeButton() {
  const btn = document.getElementById("btn-scrape");
  if (!btn) return;
  btn.onclick = async () => {
    setScrapeBtn("Starting…", true);
    try {
      const res = await fetch("/api/scrape", { method: "POST" });
      if (res.status === 409) {
        // Already running (another tab kicked it off) — just track it.
      } else if (res.status !== 202 && !res.ok) {
        setScrapeBtn("Scrape failed", false);
        setTimeout(() => setScrapeBtn("Scrape now", false), 3000);
        return;
      }
      setScrapeBtn("Scraping…", true);
      if (!_scrapeStatusTimer) {
        _scrapeStatusTimer = setInterval(refreshScrapeStatus, 3000);
      }
    } catch {
      setScrapeBtn("Scrape failed", false);
      setTimeout(() => setScrapeBtn("Scrape now", false), 3000);
    }
  };
  // On load, mirror current server-side scrape state (covers reload-during-scrape).
  refreshScrapeStatus();
}

function bindDialog() {
  const dlg = document.getElementById("compare");
  document.getElementById("cmp-close").onclick = () => dlg.close();
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) { dlg.close(); return; }
    const a = e.target.closest("a[data-stop]");
    if (a) smartOpenLink(e, a);
  });
}

renderPcCheckboxes();
applyFiltersToDOM();
bindFilters();
bindGrid();
bindDialog();
bindScrapeButton();
render();

// Close any open cost-editor / furn-picker when clicking outside it.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".cost-editor") && !e.target.closest(".cost-adj")) {
    closeAllCostEditors();
  }
  if (!e.target.closest(".furn-picker") && !e.target.closest(".furn-badge")) {
    closeAllFurnPickers();
  }
});

//---------- live polling (dev server only) ----------
// Hit /api/version every 5s — a tiny JSON object. Only fetch the full
// payload when generatedAt advances. Both endpoints support If-None-Match
// (the server replies 304), so even a "version-changed" check is cheap.
let CURRENT_VERSION = GENERATED_AT;
async function pollOnce() {
  try {
    const vres = await fetch("/api/version", {
      cache: "no-store",
      headers: { "If-None-Match": `"${CURRENT_VERSION}"` },
    });
    setServerOnline(vres.ok || vres.status === 304);
    if (vres.status === 304) return;
    if (!vres.ok) return;
    const ver = await vres.json();
    if (!ver.generatedAt || ver.generatedAt <= CURRENT_VERSION) return;

    const res = await fetch("/api/listings", { cache: "no-store" });
    setServerOnline(res.ok);
    if (!res.ok) return;
    const fresh = await res.json();
    if (!fresh.generatedAt || fresh.generatedAt <= CURRENT_VERSION) return;
    CURRENT_VERSION = fresh.generatedAt;

    // Index previous DATA by dedupe_key so we can diff. Anything whose
    // visible-field fingerprint changes gets its card node evicted so
    // render() rebuilds just that one (and re-mounts its Leaflet map);
    // everything else stays in place — no DOM thrash, no map flicker.
    const prevByKey = new Map();
    for (const r of DATA) prevByKey.set(r.dedupe_key, r);

    DATA.length = 0;
    for (const r of fresh.payload) DATA.push(r);
    for (const r of fresh.payload) {
      if (!pendingNoteWrites.has(r.dedupe_key)) {
        STATE[r.dedupe_key] = { ...(r.state || {}) };
      }
    }

    // Recompute the postcode checkbox universe — a new scrape may include
    // a previously-unseen outcode. Auto-tick the new ones if the user's
    // current filter is "all", otherwise leave their choices alone.
    const nextAllPcs = computeAllPcs(DATA);
    if (nextAllPcs.join(",") !== ALL_PCS.join(",")) {
      const wasAll = ALL_PCS.every(p => filters.pcs.includes(p));
      const added = nextAllPcs.filter(p => !ALL_PCS.includes(p));
      ALL_PCS = nextAllPcs;
      if (wasAll) filters.pcs = [...ALL_PCS];
      else        filters.pcs = [...filters.pcs, ...added]
                                  .filter(p => ALL_PCS.includes(p));
      renderPcCheckboxes();
      applyFiltersToDOM();
    }

    document.getElementById("last-updated").textContent =
      formatLondonStamp(fresh.generatedAt);
    flashStatus("updated");

    // Drop cached nodes whose listing-level data actually moved. Keep
    // everything else so cards retain their Leaflet mounts and DOM state.
    for (const r of fresh.payload) {
      const prev = prevByKey.get(r.dedupe_key);
      if (!prev || listingFingerprint(prev) !== listingFingerprint(r)) {
        const cached = _cardNodes.get(r.dedupe_key);
        if (cached) {
          if (cached.parentElement) cached.remove();
          _cardNodes.delete(r.dedupe_key);
        }
      }
    }
    render();
  } catch {
    // file:// can't fetch — protocol check above prevents this case;
    // when running via http, this is a real outage signal.
    if (IS_LIVE) setServerOnline(false);
  }
}
function flashStatus(msg) {
  const el = document.getElementById("poll-status");
  el.textContent = " · " + msg;
  el.style.color = "var(--good)";
  setTimeout(() => { el.textContent = ""; }, 2500);
}
// Only poll when served via HTTP(S). Skipping file:// avoids needless errors.
if (location.protocol.startsWith("http")) {
  setInterval(pollOnce, 5000);
}
