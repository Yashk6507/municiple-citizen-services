/**
 * Map tile proxy.
 *
 * Leaflet asks for a batch of tiles for every pan and zoom gesture. The public
 * OpenStreetMap tile server answers those bursts with HTTP 200 and a ~320-byte
 * blank placeholder instead of imagery, which is what made the map look
 * "access blocked" part-way through zooming. Serving tiles from the portal puts
 * the request rate under our control:
 *   - tiles are fetched at most TILE_CONCURRENCY at a time, never as a burst,
 *   - each tile is cached in memory, so re-zooming costs no upstream traffic,
 *   - an upstream blank/throttled reply is retried rather than drawn as empty.
 *
 * A municipality running real traffic should set TILE_UPSTREAM_URL to its own
 * tile server (or tile provider account). Nothing else has to change.
 */
const express = require("express");

const router = express.Router();

// Tried in turn, so a provider that is throttling this server is not asked again
// straight away and the map still fills in. Both serve OpenStreetMap-based
// imagery; TILE_UPSTREAM_URL / TILE_FALLBACK_URL point them at another server.
const UPSTREAM_TILE_URLS = [
  process.env.TILE_UPSTREAM_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  process.env.TILE_FALLBACK_URL || "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
];
const MAX_ZOOM = 19;
// Real imagery is several kilobytes; the placeholder sent while a client is
// being throttled is a few hundred bytes.
const MIN_REAL_TILE_BYTES = 700;
const MAX_CACHE_ENTRIES = Math.max(50, Number(process.env.TILE_CACHE_SIZE || 800));
const CONCURRENCY = Math.max(1, Number(process.env.TILE_CONCURRENCY || 2));
const MAX_ATTEMPTS = 4;

const cache = new Map(); // "z/x/y" -> Buffer, insertion-ordered
const inFlight = new Map(); // "z/x/y" -> Promise<Buffer>

let active = 0;
const queue = [];

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active += 1;
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function withSlot(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remember(key, buffer) {
  cache.set(key, buffer);
  if (cache.size > MAX_CACHE_ENTRIES) {
    // A Map iterates in insertion order, so the first key is the oldest entry.
    cache.delete(cache.keys().next().value);
  }
}

async function fetchTile(z, x, y) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const template = UPSTREAM_TILE_URLS[(attempt - 1) % UPSTREAM_TILE_URLS.length];
    const url = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "MunicipalCitizenPortal/1.0 (self-hosted; map tile proxy)",
          Accept: "image/png,image/*"
        }
      });
      if (!response.ok) {
        lastError = new Error(`Upstream responded ${response.status}`);
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length >= MIN_REAL_TILE_BYTES) return buffer;
        lastError = new Error("Upstream returned a placeholder tile");
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) await delay(400 * attempt);
  }
  throw lastError || new Error("Tile could not be retrieved");
}

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = withSlot(() => fetchTile(z, x, y))
    .then((buffer) => {
      remember(key, buffer);
      return buffer;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

router.get("/:z/:x/:y", async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const span = 2 ** z;
  const valid =
    Number.isInteger(z) &&
    z >= 0 &&
    z <= MAX_ZOOM &&
    Number.isInteger(x) &&
    x >= 0 &&
    x < span &&
    Number.isInteger(y) &&
    y >= 0 &&
    y < span;

  if (!valid) {
    return res.status(400).json({ error: "Invalid tile coordinates" });
  }

  try {
    const buffer = await loadTile(z, x, y);
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch (err) {
    // Never answer with an empty image: Leaflet keeps the tile on error and can
    // retry, whereas a blank 200 would simply look like a broken map.
    console.error(`Tile ${z}/${x}/${y} unavailable: ${err.message}`);
    res.set("Cache-Control", "no-store");
    return res.status(503).json({ error: "Map tiles are temporarily unavailable" });
  }
});

module.exports = router;
