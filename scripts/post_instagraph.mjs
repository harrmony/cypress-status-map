// scripts/post_instagraph.mjs
import fs from "node:fs/promises";
import sharp from "sharp";

const EVENT_FILE = "event.json";
const GRAPH_VERSION = "v25.0";

// We'll generate this file in the data branch
const OUTPUT_IMAGE_FILE = "ig_post.png";

// Base template image lives in main branch checkout
const BASE_IMAGE_PATH = "../main/CypressIGPost.png";

// This URL must point to the data branch file AFTER it is pushed
// (we’ll adjust the workflow order so it is pushed before posting)
const IMAGE_URL =
  "https://raw.githubusercontent.com/harrmony/cypress-status-map/data/ig_post.png";

const IG_USER_ID = process.env.IG_USER_ID;
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

function requiredEnv() {
  const missing = [];
  if (!IG_USER_ID) missing.push("IG_USER_ID");
  if (!ACCESS_TOKEN) missing.push("IG_ACCESS_TOKEN");
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function writeJson(p, obj) {
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Basic line wrapping by character count (good enough for captions like yours).
// If you want “true” width-based wrapping later, we can upgrade.
function wrapLines(text, maxChars = 34, maxLines = 10) {
  const words = String(text).replace(/\r/g, "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);

  // If truncated, add ellipsis
  if (words.length && lines.length === maxLines) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length > 3 ? last.slice(0, Math.max(0, last.length - 3)) + "..." : "...";
  }

  return lines;
}

async function generateCaptionedImage({ caption }) {
  const base = sharp(BASE_IMAGE_PATH);
  const meta = await base.metadata();

  const width = meta.width ?? 1080;
  const height = meta.height ?? 1080;

  // Layout
  const padding = Math.round(width * 0.06);
  const fontSize = Math.max(26, Math.round(width * 0.032)); // scales with image
  const lineHeight = Math.round(fontSize * 1.25);

  // Where to place the caption block (top-left-ish by default)
  const x = padding;
  const y = padding;

  const lines = wrapLines(caption, 38, 10);

  // Optional: a subtle white backing box so black text is always readable
  const boxPad = Math.round(fontSize * 0.55);
  const boxWidth = Math.round(width - padding * 2);
  const boxHeight = Math.min(
    height - padding * 2,
    lines.length * lineHeight + boxPad * 2
  );

  const tspans = lines
    .map((ln, i) => {
      const dy = i === 0 ? 0 : lineHeight;
      return `<tspan x="${x + boxPad}" dy="${dy}">${escapeXml(ln)}</tspan>`;
    })
    .join("");

  const svg = `
  <svg width="${width}" height="${height}">
    <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="24" ry="24"
          fill="rgba(255,255,255,0.80)"/>
    <text x="${x + boxPad}" y="${y + boxPad + fontSize}"
          font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
          font-size="${fontSize}"
          fill="#000000">
      ${tspans}
    </text>
  </svg>`;

  await base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(OUTPUT_IMAGE_FILE);

  console.log(`[image] Wrote ${OUTPUT_IMAGE_FILE}`);
}

async function graph(pathPart, { method = "GET", params = {} } = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${pathPart}`);
  url.searchParams.set("access_token", ACCESS_TOKEN);

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { method });
  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    const detail = json?.error ? JSON.stringify(json.error) : text;
    throw new Error(
      `Graph API ${method} ${pathPart} failed: HTTP ${res.status} ${detail}`
    );
  }

  return json ?? {};
}

async function createImageContainer({ imageUrl, caption }) {
  const resp = await graph(`${IG_USER_ID}/media`, {
    method: "POST",
    params: { image_url: imageUrl, caption },
  });
  return resp.id; // creation_id
}

async function getContainerStatus(creationId) {
  const resp = await graph(`${creationId}`, {
    method: "GET",
    params: { fields: "status_code" },
  });
  return resp.status_code; // FINISHED | IN_PROGRESS | ERROR
}

async function publishContainer(creationId) {
  const resp = await graph(`${IG_USER_ID}/media_publish`, {
    method: "POST",
    params: { creation_id: creationId },
  });
  return resp.id; // ig media id
}

async function waitUntilFinished(creationId, { maxWaitMs = 2 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (true) {
    const status = await getContainerStatus(creationId);
    console.log(`[post] ${creationId} status_code=${status}`);

    if (status === "FINISHED") return;
    if (status === "ERROR") throw new Error(`Container ${creationId} status_code=ERROR`);

    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Timed out waiting for container ${creationId} to finish`);
    }
    await sleep(5000);
  }
}

async function main() {
  requiredEnv();
  const GENERATE_ONLY = process.argv.includes("--generate-only");

  let event;
  try {
    event = await readJson(EVENT_FILE);
  } catch {
    console.log(`[skip] No ${EVENT_FILE} found`);
    return;
  }

  if (!event?.placeholders) {
    console.log("[skip] event.json has no placeholders");
    return;
  }

  if (event.placeholders.instagram_posted) {
    console.log(
      `[skip] Already posted (instagram_post_id=${event.placeholders.instagram_post_id})`
    );
    return;
  }

  const caption = event.placeholders.caption;
  if (!caption) {
    console.log("[skip] No caption in event.placeholders.caption");
    return;
  }

  // 1) Generate image file locally (to be committed/pushed by workflow)
  await generateCaptionedImage({ caption });

  if (GENERATE_ONLY) {
  console.log("[image] Generate-only mode, skipping IG post.");
  return;
}

  // 2) Post using public URL (must exist publicly before this runs — workflow change below)
  console.log(`[post] Using image_url=${IMAGE_URL}`);
  console.log("[post] Creating container...");

  const creationId = await createImageContainer({ imageUrl: IMAGE_URL, caption });

  console.log(`[post] Container created: ${creationId}. Polling status...`);
  await waitUntilFinished(creationId);

  console.log("[post] Publishing...");
  const mediaId = await publishContainer(creationId);

  console.log(`[done] Published IG media id: ${mediaId}`);

  event.placeholders.instagram_posted = true;
  event.placeholders.instagram_post_id = mediaId;

  await writeJson(EVENT_FILE, event);
  console.log(`[done] Updated ${EVENT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});