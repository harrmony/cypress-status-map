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

await fs.writeFile("status.json", JSON.stringify(out, null, 2));
console.log("Wrote status.json");
