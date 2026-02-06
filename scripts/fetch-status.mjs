import fs from "node:fs/promises";

const URL = "https://www.cypressmountain.com/api/reportpal?resortName=cy&useReportPal=true";


// DATE AND UPDATE TIMING CONTROLS

const TIME_ZONE = "America/Vancouver";

// Months to run: Nov–May
function inSeason(month /* 1-12 */) {
  return month === 11 || month === 12 || (month >= 1 && month <= 5);
}

// Get Vancouver-local parts (DST-safe)
function getVancouverParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const get = (type) => Number(parts.find(p => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),   // 1-12
    day: get("day"),
    hour: get("hour"),     // 0-23
    minute: get("minute")  // 0-59
  };
}

//HELPERS FOR HISTORICAL DATA

const HISTORY_FILE = "history.json";
const EVENT_FILE = "event.json";
const HISTORY_RETENTION_HOURS = 48;

// ---- Timezone helpers (DST-safe) ----
function getTzParts(date, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const get = (type) => Number(parts.find(p => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}

function getOffsetMinutes(date, timeZone = TIME_ZONE) {
  // Offset = (local time as UTC) - (actual UTC) in minutes
  const p = getTzParts(date, timeZone);
  const localAsUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (localAsUTC - date.getTime()) / 60000;
}

function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = TIME_ZONE) {
  // Convert "Vancouver local clock time" -> real UTC instant
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  let offset = getOffsetMinutes(guess, timeZone);
  let utcMs = guess.getTime() - offset * 60000;

  // second pass handles DST boundaries more reliably
  guess = new Date(utcMs);
  offset = getOffsetMinutes(guess, timeZone);
  utcMs = new Date(Date.UTC(year, month - 1, day, hour, minute, second)).getTime() - offset * 60000;

  return new Date(utcMs);
}

function ymdKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---- History helpers ----
async function readJsonOrNull(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function pruneSnapshots(snapshots, now = new Date()) {
  const cutoff = now.getTime() - HISTORY_RETENTION_HOURS * 60 * 60 * 1000;
  return (snapshots || []).filter(s => {
    const t = Date.parse(s?.fetched_at);
    return Number.isFinite(t) && t >= cutoff;
  });
}

function nearestSnapshot(snapshots, targetDate, toleranceMinutes = 90) {
  const targetMs = targetDate.getTime();
  const tolMs = toleranceMinutes * 60 * 1000;

  let best = null;
  let bestDiff = Infinity;

  for (const s of snapshots || []) {
    const ms = Date.parse(s?.fetched_at);
    if (!Number.isFinite(ms)) continue;
    const diff = Math.abs(ms - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }

  if (!best || bestDiff > tolMs) return null;
  return best;
}

function setOfOpen(obj) {
  const out = new Set();
  for (const [name, status] of Object.entries(obj || {})) {
    if (String(status).toLowerCase() === "open") out.add(name);
  }
  return out;
}

function diffOpens(prev, curr) {
  const prevOpen = setOfOpen(prev);
  const currOpen = setOfOpen(curr);

  const opened = [];
  const closed = [];

  for (const name of currOpen) if (!prevOpen.has(name)) opened.push(name);
  for (const name of prevOpen) if (!currOpen.has(name)) closed.push(name);

  opened.sort();
  closed.sort();
  return { opened, closed };
}


// TIMING CONTROL

function minutesSinceMidnight({ hour, minute }) {
  return hour * 60 + minute;
}

// Your rules -> returns min interval in ms, or null to "don't update"
function getMinIntervalMs(nowParts) {
  if (!inSeason(nowParts.month)) return null; // only Nov–May

  const m = minutesSinceMidnight(nowParts);

  // Stop updating after 11pm
  if (m >= 23 * 60) return null;

  // Not needed before 5:00am (your first window starts at 5)
  if (m < 5 * 60) return null;

  // 5:00–7:00 early report: every 10 min
  if (m >= 5 * 60 && m < 7 * 60) return 10 * 60 * 1000;

  // 7:00–7:50 (not specified): default to every 10 min
  if (m >= 7 * 60 && m < (7 * 60 + 50)) return 10 * 60 * 1000;

  // 7:50–10:30 rolling opening: every 5 min
  if (m >= (7 * 60 + 50) && m < (10 * 60 + 30)) return 5 * 60 * 1000;

  // 10:30–6pm: every 10 min
  return 10 * 60 * 1000;
}



// Read last fetched time to respect the interval
async function shouldRunNow() {
  const now = new Date();
  const nowParts = getVancouverParts(now);
  const minIntervalMs = getMinIntervalMs(nowParts);

  if (minIntervalMs === null) {
    console.log(`[skip] Outside update window (Vancouver time ${nowParts.hour}:${String(nowParts.minute).padStart(2,"0")}, month ${nowParts.month})`);
    return false;
  }

  try {
    const existing = JSON.parse(await fs.readFile("status.json", "utf8"));
    if (existing?.fetched_at) {
      const last = new Date(existing.fetched_at).getTime();
      const delta = now.getTime() - last;
      if (Number.isFinite(last) && delta >= 0 && delta < minIntervalMs) {
        console.log(`[skip] Last fetch ${(delta/60000).toFixed(1)} min ago; need ${(minIntervalMs/60000)} min`);
        return false;
      }
    }
  } catch {
    // No prior status.json or unreadable -> allow run
  }

  console.log(`[run] In window; min interval ${(minIntervalMs/60000)} min`);
  return true;
}






function normalizeStatus(s) {
  const v = String(s || "").toLowerCase();
  if (v.includes("open")) return "open";
  if (v.includes("hold")) return "on-hold";
  if (v.includes("closed")) return "closed";
  return "unknown";
}


if (!(await shouldRunNow())) process.exit(0);

const res = await fetch(URL, { headers: { accept: "application/json" } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);

const data = await res.json();

const lifts = {};
const trails = {};

const areas = data?.facilities?.areas?.area ?? [];
for (const area of areas) {
  for (const lift of (area?.lifts?.lift ?? [])) {
    lifts[lift.name] = normalizeStatus(lift.statusIcon || lift.status);
  }
  for (const trail of (area?.trails?.trail ?? [])) {
    trails[trail.name] = normalizeStatus(trail.statusIcon || trail.status);
  }
}

const out = {
  fetched_at: new Date().toISOString(),
  source_updated: data.updated ?? null,
  lifts_updated: data.liftsUpdated ?? null,
  trails_updated: data.trailsUpdated ?? null,
  operations: data?.operations ?? null,
  lifts,
  trails
};


// UPDATE CURRENT STATUS
await fs.writeFile("status.json", JSON.stringify(out, null, 2));
console.log("Wrote status.json");


// UPDATE HISTORY
const now = new Date();

// Load history (or initialize)
const history = (await readJsonOrNull(HISTORY_FILE)) || { tz: TIME_ZONE, snapshots: [], meta: {} };

// Append a lightweight snapshot (only what we need)
history.snapshots = history.snapshots || [];
history.snapshots.push({
  fetched_at: out.fetched_at,
  source_updated: out.source_updated,
  lifts: out.lifts,
  trails: out.trails,
  operations: out.operations
});

// Prune to last 48h
history.snapshots = pruneSnapshots(history.snapshots, now);

// Compute target instants (Vancouver time)
const todayParts = getTzParts(now, TIME_ZONE);
const yesterdayParts = getTzParts(new Date(now.getTime() - 24 * 60 * 60 * 1000), TIME_ZONE);

const target10amToday = zonedTimeToUtc({
  year: todayParts.year, month: todayParts.month, day: todayParts.day,
  hour: 10, minute: 0, second: 0
}, TIME_ZONE);

const target3pmYesterday = zonedTimeToUtc({
  year: yesterdayParts.year, month: yesterdayParts.month, day: yesterdayParts.day,
  hour: 15, minute: 0, second: 0
}, TIME_ZONE);

// Find nearest snapshots
const snapToday10 = nearestSnapshot(history.snapshots, target10amToday, 90);
const snapYest3 = nearestSnapshot(history.snapshots, target3pmYesterday, 300); // UPDATED TO 5h TOLERANCE FOR TESTING - CHANGE BACK TO 90

// Build event key so we only fire once per day
const eventKey = `${ymdKey(todayParts)}_10am_vs_${ymdKey(yesterdayParts)}_3pm`;
history.meta = history.meta || {};
const alreadyFired = history.meta.last_event_key === eventKey;

let event = null;

if (snapToday10 && snapYest3 && !alreadyFired) {
  // Diff lifts + trails
  const liftsDiff = diffOpens(snapYest3.lifts, snapToday10.lifts);
  const trailsDiff = diffOpens(snapYest3.trails, snapToday10.trails);

  const openedCount = liftsDiff.opened.length + trailsDiff.opened.length;
  const closedCount = liftsDiff.closed.length + trailsDiff.closed.length;

  const OPEN_THRESHOLD = 3;   // tweak
  const CLOSE_THRESHOLD = 3;  // tweak

  const significant = openedCount >= OPEN_THRESHOLD || closedCount >= CLOSE_THRESHOLD;

  if (significant) {
    event = {
      key: eventKey,
      created_at: new Date().toISOString(),
      compare: {
        from: { label: "yesterday_3pm", fetched_at: snapYest3.fetched_at },
        to:   { label: "today_10am", fetched_at: snapToday10.fetched_at }
      },
      summary: {
        opened_total: openedCount,
        closed_total: closedCount,
        opened_lifts: liftsDiff.opened.length,
        closed_lifts: liftsDiff.closed.length,
        opened_trails: trailsDiff.opened.length,
        closed_trails: trailsDiff.closed.length
      },
      details: {
        lifts: liftsDiff,
        trails: trailsDiff
      },
      placeholders: {
        screenshot_path: null,
        instagram_posted: false,
        instagram_post_id: null,
        caption: null
      }
    };

    // Save event placeholder for later automation steps
    await fs.writeFile(EVENT_FILE, JSON.stringify(event, null, 2));
    console.log(`[event] Significant change detected → wrote ${EVENT_FILE}`);

    // Mark as fired so we don't spam
    history.meta.last_event_key = eventKey;
    history.meta.last_event_created_at = event.created_at;
  } else {
    console.log(`[event] Not significant (opened=${openedCount}, closed=${closedCount})`);
  }
} else {
  if (!snapToday10 || !snapYest3) {
    console.log("[event] Not enough history near targets yet (need snapshots near 10am today and 3pm yesterday).");
  } else if (alreadyFired) {
    console.log(`[event] Already fired for ${eventKey}`);
  }
}

// Always write history
await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
console.log(`Wrote ${HISTORY_FILE} (snapshots=${history.snapshots.length})`);

