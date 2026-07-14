// Regenerates assets/home-hero-map.jpg - the static political-map backdrop
// behind the Home tab's title card.
//
// This used to be rendered live in the browser (drawHomeMapBackdrop() in
// js/app.js), recoloring map_data/location_ids.png per-pixel from
// assets/home-political-snapshot.json on every page load. That's exactly
// why it could never ship to a public deployment: map_data/ is Paradox's
// copyrighted map bitmap, excluded from version control (see map_data/README.md)
// and never bundled into dist/ (scripts/build-netlify-site.js). A visitor to
// the real site would only ever see the flat-navy fallback.
//
// The fix: this is a purely decorative backdrop (it never reflected
// whichever save a visitor has loaded - it always used one fixed reference
// campaign), so there's nothing lost by baking it ONCE into a flattened JPG
// and shipping that static image instead of the raw per-pixel data. This
// script reproduces the exact same crop/colorize/boundary-line algorithm the
// old drawHomeMapBackdrop() used, via a real browser (so there's no risk of
// a from-scratch reimplementation drifting from what it used to look like),
// and writes the result to assets/home-hero-map.jpg - which IS safe to
// commit/ship: a flattened picture, not per-pixel location-id data or any of
// Paradox's original map art.
//
// Requires local map_data/ (see map_data/README.md) and
// assets/home-political-snapshot.json (see scripts/build-home-political-snapshot.js)
// - exactly the same local-only setup the interactive Map tab needs.
//
// Usage (needs playwright-core; not a repo dependency - install ad hoc):
//   npm install --no-save playwright-core
//   npx --yes playwright install chromium   # only if not already cached
//   node tools/bake-home-hero.js
//
// Re-run whenever you want a different campaign/crop featured on the Home
// tab; commit the resulting assets/home-hero-map.jpg.

const http = require("http");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const outPath = path.join(rootDir, "assets", "home-hero-map.jpg");
const PORT = 8973;

// Same crop as the original drawHomeMapBackdrop() - centered on Europe/the
// Mediterranean, the region most likely to be recognizable/populated in an
// early-to-mid-game save regardless of which one is used as the source.
const CROP_CENTER_X = 8350;
const CROP_CENTER_Y = 1880;
const CROP_H = 3150;
const OUT_WIDTH = 2200;
const OUT_HEIGHT = 1080;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };

function serveStatic() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = path.join(rootDir, reqPath === "/" ? "/index.html" : reqPath);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

// Reimplements drawHomeMapBackdrop()'s per-pixel pass, run inside the page
// against the real map_data/location_ids.png + assets/home-political-snapshot.json.
async function renderInPage(page) {
  return page.evaluate(
    async ({ cropCenterX, cropCenterY, cropH, outWidth, outHeight }) => {
      function loadImg(src) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("failed to load " + src));
          img.src = src;
        });
      }
      function parseRgb(s) {
        const m = s && s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
      }

      const [idMap, snapshot] = await Promise.all([
        loadImg("map_data/location_ids.png"),
        fetch("assets/home-political-snapshot.json", { cache: "no-store" }).then((r) => r.json()),
      ]);

      const countryMax = Math.max(0, ...(snapshot.countries || []).map((e) => Number(e[0]) || 0));
      const locationMax = Math.max(
        0,
        ...(snapshot.locations || []).map((e) => Number(e[0]) || 0),
        ...(snapshot.landLocations || []).map((id) => Number(id) || 0)
      );
      const countryColors = new Array(countryMax + 1);
      const locationOwners = new Uint32Array(locationMax + 1);
      const isLand = new Uint8Array(locationMax + 1);
      (snapshot.countries || []).forEach(([n, color]) => {
        const rgb = parseRgb(color);
        if (rgb) countryColors[n] = rgb;
      });
      (snapshot.landLocations || []).forEach((n) => {
        if (n >= 0 && n < isLand.length) isLand[n] = 1;
      });
      (snapshot.locations || []).forEach(([n, owner]) => {
        if (n >= 0 && n < locationOwners.length && owner > 0) locationOwners[n] = owner;
      });

      const destAspect = outWidth / outHeight;
      const cropW = Math.min(idMap.width, Math.max(6200, Math.round(cropH * destAspect)));
      const sx = Math.max(0, Math.min(idMap.width - cropW, Math.round(cropCenterX - cropW / 2)));
      const sy = Math.max(0, Math.min(idMap.height - cropH, Math.round(cropCenterY - cropH / 2)));

      const idCanvas = document.createElement("canvas");
      idCanvas.width = outWidth;
      idCanvas.height = outHeight;
      const idCtx = idCanvas.getContext("2d", { willReadFrequently: true });
      idCtx.imageSmoothingEnabled = false;
      idCtx.drawImage(idMap, sx, sy, cropW, cropH, 0, 0, outWidth, outHeight);

      const idData = idCtx.getImageData(0, 0, outWidth, outHeight);
      const src = idData.data;
      const outCanvas = document.createElement("canvas");
      outCanvas.width = outWidth;
      outCanvas.height = outHeight;
      const ctx = outCanvas.getContext("2d");
      const out = ctx.createImageData(outWidth, outHeight);
      const dst = out.data;
      const sea = [25, 54, 83];
      const neutralLand = [78, 73, 62];
      const border = [22, 17, 13];

      for (let p = 0, i = 0; p < outWidth * outHeight; p++, i += 4) {
        const id = src[i] | (src[i + 1] << 8);
        const land = id < isLand.length && isLand[id];
        if (!land) {
          dst[i] = sea[0];
          dst[i + 1] = sea[1];
          dst[i + 2] = sea[2];
          dst[i + 3] = 255;
          continue;
        }
        const owner = id < locationOwners.length ? locationOwners[id] : 0;
        const rgb = owner < countryColors.length && countryColors[owner] ? countryColors[owner] : neutralLand;
        const left = p % outWidth ? src[i - 4] | (src[i - 3] << 8) : id;
        const up = p >= outWidth ? src[i - outWidth * 4] | (src[i - outWidth * 4 + 1] << 8) : id;
        const isBoundary = left !== id || up !== id;
        const color = isBoundary ? border : rgb;
        dst[i] = color[0];
        dst[i + 1] = color[1];
        dst[i + 2] = color[2];
        dst[i + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
      return outCanvas.toDataURL("image/jpeg", 0.92);
    },
    { cropCenterX: CROP_CENTER_X, cropCenterY: CROP_CENTER_Y, cropH: CROP_H, outWidth: OUT_WIDTH, outHeight: OUT_HEIGHT }
  );
}

(async () => {
  if (!fs.existsSync(path.join(rootDir, "map_data", "location_ids.png"))) {
    console.error("map_data/location_ids.png not found - run tools/build-location-data.js + bake-location-id-map.py first (see map_data/README.md).");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(rootDir, "assets", "home-political-snapshot.json"))) {
    console.error("assets/home-political-snapshot.json not found - run: node scripts/build-home-political-snapshot.js");
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch (e) {
    console.error("playwright-core not installed. Run: npm install --no-save playwright-core");
    process.exit(1);
  }

  const server = await serveStatic();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: OUT_WIDTH, height: OUT_HEIGHT } });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });
    const dataUrl = await renderInPage(page);
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    fs.writeFileSync(outPath, Buffer.from(base64, "base64"));
    console.log(`Wrote ${path.relative(rootDir, outPath)} (${fs.statSync(outPath).size} bytes)`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error("Bake failed:", e);
  process.exit(1);
});
