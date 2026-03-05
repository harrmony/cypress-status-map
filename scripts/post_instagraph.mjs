// scripts/post_instagraph.mjs
import fs from "node:fs/promises";

const EVENT_FILE = "event.json";
const GRAPH_VERSION = "v25.0";

// Your static image (public)
const IMAGE_URL =
  "https://raw.githubusercontent.com/harrmony/cypress-status-map/main/CypressIGPost.png";

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