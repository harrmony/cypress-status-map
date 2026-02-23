// post_instagraph.mjs
import fs from "node:fs/promises";

const EVENT_FILE = "event.json";

// Hard-code Graph API version (Meta format is usually vXX.X)
const GRAPH_VERSION = "v25.0";

// Your default image (fallback) hosted on raw.githubusercontent.com
const DEFAULT_IMAGE_URL =
  "https://raw.githubusercontent.com/harrmony/cypress-status-map/main/CypressIGPost.png";

// Set via GitHub secrets
const IG_USER_ID = process.env.IG_USER_ID;
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

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
  if (/^https?:\/\//i.test(screenshotPathOrUrl)) return screenshotPathOrUrl;
  return null; // (for now) only accept explicit URLs
}

async function graph(path, { method = "GET", params = {} } = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
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
    throw new Error(`Graph API ${method} ${path} failed: HTTP ${res.status} ${detail}`);
  }

  return json ?? {};
}

async function createImageContainer({ imageUrl, caption }) {
  const resp = await graph(`${IG_USER_ID}/media`, {
    method: "POST",
    params: {
      image_url: imageUrl,
      caption
    }
  });
  return resp.id; // creation_id
}

async function getContainerStatus(creationId) {
  const resp = await graph(`${creationId}`, {
    method: "GET",
    params: { fields: "status_code" }
  });
  return resp.status_code; // FINISHED | IN_PROGRESS | ERROR
}

async function publishContainer(creationId) {
  const resp = await graph(`${IG_USER_ID}/media_publish`, {
    method: "POST",
    params: { creation_id: creationId }
  });
  return resp.id; // ig media id
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

  // Prefer screenshot_path if it’s already a full URL; else fallback to DEFAULT_IMAGE_URL
  const imageUrl =
    asPublicUrl(event.placeholders.screenshot_path) || DEFAULT_IMAGE_URL;

  console.log(`[post] Using image_url=${imageUrl}`);
  console.log(`[post] Creating container...`);

  const creationId = await createImageContainer({ imageUrl, caption });

  console.log(`[post] Container created: ${creationId}. Polling status...`);

  // Images usually process fast; keep polling gentle
  const maxWaitMs = 2 * 60 * 1000;
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

  console.log("[post] Publishing...");
  const mediaId = await publishContainer(creationId);

  console.log(`[done] Published IG media id: ${mediaId}`);

  // Persist so you don’t repost
  event.placeholders.instagram_posted = true;
  event.placeholders.instagram_post_id = mediaId;

  await writeJson(EVENT_FILE, event);
  console.log(`[done] Updated ${EVENT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});