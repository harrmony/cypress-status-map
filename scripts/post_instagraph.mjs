// post_instagram.mjs
import fs from "node:fs/promises";

const EVENT_FILE = "event.json";

// Set via GitHub secrets
const IG_USER_ID = process.env.IG_USER_ID;
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v25.0";

// If your event.json has a local screenshot_path like "shots/abc.jpg",
// set SCREENSHOT_BASE_URL to your GitHub Pages (or other) base URL:
//   https://<user>.github.io/<repo>/
const SCREENSHOT_BASE_URL = process.env.SCREENSHOT_BASE_URL || null;

function requiredEnv() {
  const missing = [];
  if (!IG_USER_ID) missing.push("IG_USER_ID");
  if (!ACCESS_TOKEN) missing.push("IG_ACCESS_TOKEN");
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}
async function writeJson(path, obj) {
  await fs.writeFile(path, JSON.stringify(obj, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function asPublicUrl(screenshotPathOrUrl) {
  if (!screenshotPathOrUrl) return null;
  // If already looks like a URL, keep it
  if (/^https?:\/\//i.test(screenshotPathOrUrl)) return screenshotPathOrUrl;

  if (!SCREENSHOT_BASE_URL) return null;
  const base = SCREENSHOT_BASE_URL.endsWith("/") ? SCREENSHOT_BASE_URL : SCREENSHOT_BASE_URL + "/";
  return base + screenshotPathOrUrl.replace(/^\//, "");
}

async function graph(path, { method = "GET", params = {}, body = null } = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);

  // access_token can go in query for these endpoints
  url.searchParams.set("access_token", ACCESS_TOKEN);

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    // Meta errors usually come back as { error: { message, type, code, error_subcode, fbtrace_id } }
    const detail = json?.error ? JSON.stringify(json.error) : text;
    throw new Error(`Graph API ${method} ${path} failed: HTTP ${res.status} ${detail}`);
  }

  return json ?? {};
}

async function createImageContainer({ imageUrl, caption }) {
  // For feed photo post: POST /{ig-user-id}/media?image_url=...&caption=...
  const resp = await graph(`${IG_USER_ID}/media`, {
    method: "POST",
    params: {
      image_url: imageUrl,
      caption
    }
  });

  // Returns { id: "<creation_id>" }
  return resp.id;
}

async function getContainerStatus(creationId) {
  // Some guides use fields=status_code
  const resp = await graph(`${creationId}`, {
    method: "GET",
    params: {
      fields: "status_code"
    }
  });
  return resp.status_code; // e.g. FINISHED, IN_PROGRESS, ERROR
}

async function publishContainer(creationId) {
  const resp = await graph(`${IG_USER_ID}/media_publish`, {
    method: "POST",
    params: {
      creation_id: creationId
    }
  });

  // Returns { id: "<ig_media_id>" }
  return resp.id;
}

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

  const screenshot = event.placeholders.screenshot_path;
  const imageUrl = asPublicUrl(screenshot);

  if (!imageUrl) {
    console.log("[skip] No public image URL available (set placeholders.screenshot_path to a URL, or set SCREENSHOT_BASE_URL)");
    return;
  }

  console.log(`[post] Creating container with image_url=${imageUrl}`);
  const creationId = await createImageContainer({ imageUrl, caption });

  // Poll until ready (images are usually fast; videos/reels can take longer)
  console.log(`[post] Container created: ${creationId}. Polling status...`);

  const maxWaitMs = 2 * 60 * 1000; // 2 minutes for image posts
  const start = Date.now();
  while (true) {
    const status = await getContainerStatus(creationId);
    console.log(`[post] status_code=${status}`);

    if (status === "FINISHED") break;
    if (status === "ERROR") throw new Error(`Container ${creationId} status_code=ERROR`);

    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Timed out waiting for container ${creationId} to finish`);
    }
    await sleep(5000);
  }

  console.log("[post] Publishing container...");
  const mediaId = await publishContainer(creationId);

  console.log(`[done] Published IG media id: ${mediaId}`);

  // Persist back to event.json to prevent double-posts
  event.placeholders.instagram_posted = true;
  event.placeholders.instagram_post_id = mediaId;

  await writeJson(EVENT_FILE, event);
  console.log(`[done] Updated ${EVENT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});