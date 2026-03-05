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

  // Layout + typography (BIG)
  const padding = Math.round(width * 0.06);
  const x = padding;
  let y = padding;

  const headerSize = Math.max(54, Math.round(width * 0.07));      // big
  const mainSize   = Math.max(42, Math.round(width * 0.052));     // big
  const itemSize   = Math.max(34, Math.round(width * 0.045));     // 2-ish sizes smaller
  const headerLH   = Math.round(headerSize * 1.15);
  const mainLH     = Math.round(mainSize * 1.22);
  const itemLH     = Math.round(itemSize * 1.22);

  const headerColor = "#0B2D5C"; // dark blue
  const black = "#000000";

  // Simple wrapping for super-long lines (keeps within image width)
  function wrapLine(line, maxChars) {
    const words = String(line).split(/\s+/).filter(Boolean);
    const out = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length <= maxChars) {
        cur = next;
      } else {
        if (cur) out.push(cur);
        cur = w;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  const rawLines = String(caption || "").replace(/\r/g, "").split("\n");

  // Build SVG text elements line-by-line
  const elements = [];
  let firstNonEmptySeen = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // Blank lines = vertical spacing (your “two line returns”)
    if (!line.trim()) {
      y += Math.round(mainLH * 0.8);
      continue;
    }

    // 1) Header: first non-empty line
    if (!firstNonEmptySeen) {
      firstNonEmptySeen = true;

      // Force exact header formatting just in case older events exist
      const headerText = "Cypress Update";

      elements.push(`
        <text x="${x}" y="${y + headerSize}"
              font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
              font-size="${headerSize}"
              font-weight="800"
              fill="${headerColor}">
          ${escapeXml(headerText)}
        </text>
      `);

      y += headerLH;
      continue;
    }

    // 2) Bracket lines: "(Name)" — bold, smaller
    const isBracket = line.trim().startsWith("(") && line.trim().endsWith(")");

    if (isBracket) {
      // Wrap only if needed; names are usually short, but safe
      const wrapped = wrapLine(line.trim(), 28);

      for (const w of wrapped) {
        elements.push(`
          <text x="${x}" y="${y + itemSize}"
                font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
                font-size="${itemSize}"
                font-weight="800"
                fill="${black}">
            ${escapeXml(w)}
          </text>
        `);
        y += itemLH;
      }

      continue;
    }

    // 3) Main category lines: "1 new chair open" / "3 new trails open" — black
    // Wrap if long (rare)
    const wrapped = wrapLine(line.trim(), 30);

    for (const w of wrapped) {
      elements.push(`
        <text x="${x}" y="${y + mainSize}"
              font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
              font-size="${mainSize}"
              font-weight="700"
              fill="${black}">
          ${escapeXml(w)}
        </text>
      `);
      y += mainLH;
    }
  }

  const svg = `
    <svg width="${width}" height="${height}">
      ${elements.join("\n")}
    </svg>
  `;

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

async function waitForImageUrl(url, { maxWaitMs = 90_000, intervalMs = 3_000 } = {}) {
  const start = Date.now();
  while (true) {
    try {
      const res = await fetch(url, { method: "GET" });
      const ct = res.headers.get("content-type") || "";
      const len = res.headers.get("content-length") || "";

      if (res.ok && ct.includes("image")) {
        console.log(`[image-url] OK ${res.status} content-type=${ct} content-length=${len}`);
        return;
      }

      console.log(`[image-url] Not ready: HTTP ${res.status} content-type=${ct}`);
    } catch (e) {
      console.log(`[image-url] Fetch error: ${e?.message || e}`);
    }

    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Timed out waiting for image_url to become available: ${url}`);
    }
    await sleep(intervalMs);
  }
}

async function main() {
  const GENERATE_ONLY = process.argv.includes("--generate-only");

  // Only require IG credentials when we intend to post
  if (!GENERATE_ONLY) requiredEnv();

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

  const captionImage =
    event.placeholders.caption_image ?? event.placeholders.caption;

  if (!captionImage) {
    console.log("[skip] No caption found in event placeholders");
    return;
  }

  // Insert the map link after "Cypress Update"
  const MAP_URL = "https://harrmony.github.io/cypress-status-map/";

  const lines = captionImage.split("\n");

  let captionIG;

  if (lines.length > 0) {
    captionIG =
      `${lines[0]}\n` +
      `Live status map → ${MAP_URL}\n\n` +
      lines.slice(1).join("\n");
  } else {
    captionIG = captionImage;
  }

  // 1) Image overlay uses captionImage ONLY (no URL)
  await generateCaptionedImage({ caption: captionImage });

  if (GENERATE_ONLY) {
    console.log("[image] Generate-only mode, skipping IG post.");
    return;
  }

  // 2) Post using public URL (must exist publicly before this runs — workflow change below)
  console.log(`[post] Using image_url=${IMAGE_URL}`);
  console.log("[post] Creating container...");


    // Cache-bust so we don't get a stale CDN response
  const imageUrlForPost = `${IMAGE_URL}?v=${encodeURIComponent(event.key || Date.now())}`;

  // Ensure the public URL is actually serving the file before IG fetches it
  await waitForImageUrl(imageUrlForPost);

  const creationId = await createImageContainer({
  imageUrl: imageUrlForPost,
  caption: captionIG
  });

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