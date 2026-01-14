import fs from "node:fs/promises";

const URL = "https://www.cypressmountain.com/api/reportpal?resortName=cy&useReportPal=true";

function normalizeStatus(s) {
  const v = String(s || "").toLowerCase();
  if (v.includes("open")) return "open";
  if (v.includes("hold")) return "on-hold";
  if (v.includes("closed")) return "closed";
  return "unknown";
}

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
