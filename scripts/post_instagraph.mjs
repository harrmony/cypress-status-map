// scripts/post_instagraph.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const EVENT_FILE = "event.json";

// Hard-code Graph API version (Meta format is usually vXX.X)
const GRAPH_VERSION = "v25.0";

// Fallback image (public) in case screenshots aren’t available yet
const DEFAULT_IMAGE_URL =
  "https://raw.githubusercontent.com/harrmony/cypress-status-map/main/CypressIGPost.png";

// Set via GitHub secrets
const IG_USER_ID = process.env.IG_USER_ID;
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

// Where we’ll save screenshots in-repo
const SCREENSHOT_DIR = "public/posts";

// If you want the script to compute public GitHub raw URLs for screenshots:
const GITHUB_OWNER = process.env.GITHUB_OWNER || "harrmony";
const GITHUB_REPO = process.env.GITHUB_REPO || "cypress-status-map";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

//Designate the mode via env (e.g. MODE=prepare to only generate screenshots + update event.json without posting to IG)
const MODE = process.env.MODE || "post"; // "prepare" | "post"

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
async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function asPublicUrl(s) {
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

function githubRawBase() {
  return `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;
}

// ---------- Graph helpers ----------
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
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    const detail = json?.error ? JSON.stringify(json.error) : text;
    throw new Error(`Graph API ${method} ${pathPart} failed: HTTP ${res.status} ${detail}`);
  }

  return json ?? {};
}

async function createImageContainer({ imageUrl, caption }) {
  const resp = await graph(`${IG_USER_ID}/media`, {
    method: "POST",
    params: { image_url: imageUrl, caption }
  });
  return resp.id; // creation_id
}

async function getContainerStatus(creationId) {
  const resp = await graph(`${creationId}`, {
    method: "GET",
    params: { fields: "status_code" }
  });
  return resp.status_code;
}

async function publishContainer(creationId) {
  const resp = await graph(`${IG_USER_ID}/media_publish`, {
    method: "POST",
    params: { creation_id: creationId }
  });
  return resp.id;
}

async function createCarouselItem({ imageUrl }) {
  const resp = await graph(`${IG_USER_ID}/media`, {
    method: "POST",
    params: {
      image_url: imageUrl,
      is_carousel_item: "true"
    }
  });
  return resp.id; // creation_id
}

async function createCarouselContainer({ childrenIds, caption }) {
  const resp = await graph(`${IG_USER_ID}/media`, {
    method: "POST",
    params: {
      media_type: "CAROUSEL",
      children: childrenIds.join(","),
      caption
    }
  });
  return resp.id; // creation_id
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

// ---------- Screenshot generation ----------
async function generateScreenshotsForEvent(eventKey) {
  // Save into public/posts/<eventKey>/
  const outFolder = path.join(SCREENSHOT_DIR, eventKey);
  await ensureDir(outFolder);

  const fullPath = path.join(outFolder, "full.png");
  const mapOnlyPath = path.join(outFolder, "map-only.png");

  // Use file:// to load index.html (works for your local assets map.jpg / overlays.geojson / curves.json)
  const indexUrl = new URL(`file://${process.cwd()}/../main/index.html`).toString();

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1080, height: 1350 } // IG portrait-friendly
  });

  console.log(`[shot] loading ${indexUrl}`);
  await page.goto(indexUrl, { waitUntil: "load" });

  // Your map fetches status.json from raw.githubusercontent.com.
  // Give it a moment to fetch + render overlays/curves.
  await page.waitForFunction(() => {
  const el = document.getElementById("updated");
  return el && el.textContent && !el.textContent.includes("(unknown)");
  }, { timeout: 15000 });

  // Full-page screenshot (recommended for the IG post)
  await page.screenshot({ path: fullPath, fullPage: true });
  console.log(`[shot] wrote ${fullPath}`);

  // Map-only screenshot (optional)
  const mapEl = await page.$("#map");
  if (mapEl) {
    await mapEl.screenshot({ path: mapOnlyPath });
    console.log(`[shot] wrote ${mapOnlyPath}`);
  } else {
    console.log("[shot] #map not found; skipped map-only screenshot");
  }

  await browser.close();

  return { fullPath, mapOnlyPath };
}

// ---------- Main ----------
async function main() {
  requiredEnv();

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
    console.log(`[skip] Already posted (instagram_post_id=${event.placeholders.instagram_post_id})`);
    return;
  }

  const caption = event.placeholders.caption;
  if (!caption) {
    console.log("[skip] No caption in event.placeholders.caption");
    return;
  }

  // 1) Generate screenshots if screenshot_path isn’t already a public URL
  let imageUrl = asPublicUrl(event.placeholders.screenshot_path);

  if (!imageUrl) {
    console.log("[post] screenshot_path not public; generating screenshots...");
    const { fullPath } = await generateScreenshotsForEvent(event.key);

    // Write the *intended* public URL into event.json.
    // This will only work once the file is actually pushed to GitHub.
    const publicFullUrl = `${githubRawBase()}/${fullPath.replace(/\\/g, "/")}`;
    event.placeholders.screenshot_path = publicFullUrl;

    // Optional: store both URLs
    event.placeholders.screenshots = {
      full: publicFullUrl,
      mapOnly: `${githubRawBase()}/${path.join(SCREENSHOT_DIR, event.key, "map-only.png").replace(/\\/g, "/")}`
    };

    await writeJson(EVENT_FILE, event);
    console.log(`[post] updated ${EVENT_FILE} with screenshot_path=${publicFullUrl}`);

    if (MODE === "prepare") {
    console.log("[mode] prepare: screenshots prepared; not posting to Instagram.");
    return;
    }

    imageUrl = event.placeholders.screenshot_path;
    
  }

  if (MODE === "post" && !asPublicUrl(event.placeholders.screenshot_path)) {
  console.log("[mode] post: screenshot_path not public; using DEFAULT_IMAGE_URL for map slide");
  imageUrl = DEFAULT_IMAGE_URL;
  }

  // 2) If it still isn’t a public URL (or you didn’t push), fall back
  if (!asPublicUrl(imageUrl)) {
    console.log("[post] No public screenshot URL available yet; using DEFAULT_IMAGE_URL");
    imageUrl = DEFAULT_IMAGE_URL;
  }

  // --- Carousel: slide 1 = static image, slide 2 = map screenshot ---
  const staticUrl = DEFAULT_IMAGE_URL;     // your first slide image
  const mapUrl = imageUrl;                // your second slide image (screenshot)

  console.log(`[post] Carousel slide 1 (static): ${staticUrl}`);
  console.log(`[post] Carousel slide 2 (map):    ${mapUrl}`);

  console.log("[post] Creating carousel item containers...");
  const item1 = await createCarouselItem({ imageUrl: staticUrl });
  const item2 = await createCarouselItem({ imageUrl: mapUrl });

  console.log("[post] Polling item status...");
  await waitUntilFinished(item1);
  await waitUntilFinished(item2);

  console.log("[post] Creating carousel container...");
  const carouselId = await createCarouselContainer({
    childrenIds: [item1, item2],
    caption
  });

  console.log("[post] Polling carousel status...");
  await waitUntilFinished(carouselId);

  console.log("[post] Publishing carousel...");
  const mediaId = await publishContainer(carouselId);

  console.log(`[done] Published IG carousel media id: ${mediaId}`);

  event.placeholders.instagram_posted = true;
  event.placeholders.instagram_post_id = mediaId;

  await writeJson(EVENT_FILE, event);
  console.log(`[done] Updated ${EVENT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});