// Shared "copy this as an image" helper - used by the Countries/Players/Black
// Death tables and Trends charts (js/app.js) and the map (js/map.js). Two
// capture paths:
//   - elementToCanvas(el): for ordinary DOM (tables, SVG charts), via the
//     vendored html2canvas (js/vendor/html2canvas.min.js - see that folder's
//     README for why: the obvious zero-dependency approach, serializing the
//     DOM into an SVG <foreignObject> and drawing that to a canvas, turns out
//     to be blocked outright - Chromium taints any canvas that ever drew a
//     foreignObject-bearing SVG, unconditionally, confirmed with a minimal
//     "hello world" test case that had zero external resources involved).
//   - compositeCanvases(canvases): for the map, which is already real canvas
//     pixels - just flattens the stacked layers (render canvas + label
//     overlay) into one output canvas.
// Either way the result goes through canvasToClipboard(), with
// downloadCanvas() as the fallback for browsers that don't support writing
// images to the clipboard (Firefox, at time of writing).
(function () {
  "use strict";

  // Browsers cap a single canvas dimension well under what a 2x-oversampled
  // capture of a long table (the Countries table can run to hundreds of rows)
  // would ask for - a raw scale-2 request there would silently produce a
  // blank/failed canvas instead of an error. Scale down (never up) so the
  // longer edge never crosses this regardless of how tall the captured
  // element is.
  const MAX_CANVAS_DIM = 8000;

  async function elementToCanvas(el, opts) {
    opts = opts || {};
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(rect.width));
    const h = Math.max(1, Math.ceil(rect.height));
    const scale = Math.min(opts.scale || 2, MAX_CANVAS_DIM / Math.max(w, h));
    const background = opts.background || getComputedStyle(document.body).backgroundColor || "#000";

    return html2canvas(el, {
      backgroundColor: background,
      scale,
      // This app's tables/panels lean heavily on hotlinked wiki icons
      // (paradoxwikis.com) with no CORS headers - html2canvas would otherwise
      // either fail to fetch them (they're drawn as broken-image boxes) or,
      // worse, taint the canvas if a fetch partially succeeds. Since the
      // numbers/text are what's actually worth sharing to Discord, just skip
      // every <img> rather than have "Copy image" work only sometimes
      // depending on which icons happen to be on screen.
      ignoreElements: (node) => node.tagName === "IMG",
      useCORS: false,
      logging: false,
    });
  }

  function compositeCanvases(canvases, opts) {
    opts = opts || {};
    const real = canvases.filter((c) => c && c.width && c.height);
    if (!real.length) throw new Error("Nothing to capture");
    const w = Math.max(...real.map((c) => c.width));
    const h = Math.max(...real.map((c) => c.height));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, w, h);
    }
    for (const c of real) ctx.drawImage(c, 0, 0);
    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob failed"))), "image/png");
    });
  }

  function clipboardSupported() {
    return !!(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write);
  }

  async function canvasToClipboard(canvas) {
    if (!clipboardSupported()) throw new Error("unsupported");
    const blob = await canvasToBlob(canvas);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }

  async function downloadCanvas(canvas, filename) {
    const blob = await canvasToBlob(canvas);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "llamabeg.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Wires one button to build a canvas (via `buildCanvas`, called fresh on
  // every click so the capture always reflects the current state - a stale
  // cached canvas would show whatever was on screen when the button was
  // first wired up, not what the user is looking at now) and copy it,
  // falling back to a file download when the Clipboard image API isn't
  // available (Firefox, at time of writing). `label` is the button's resting
  // text; feedback messages replace it for 2s the same way the existing
  // "Copy link" button already does.
  function wireCopyImageButton(btn, buildCanvas, opts) {
    opts = opts || {};
    const restLabel = btn.textContent;
    function flash(msg) {
      btn.textContent = msg;
      setTimeout(() => {
        btn.textContent = restLabel;
      }, 2000);
    }
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const canvas = await buildCanvas();
        if (clipboardSupported()) {
          await canvasToClipboard(canvas);
          flash("Copied!");
        } else {
          await downloadCanvas(canvas, opts.filename);
          flash("Downloaded (clipboard images unsupported here)");
        }
      } catch (err) {
        if (typeof console !== "undefined") console.warn("Copy image failed:", err);
        flash("Copy failed");
      } finally {
        btn.disabled = false;
      }
    });
  }

  window.CopyImage = { elementToCanvas, compositeCanvases, canvasToClipboard, downloadCanvas, wireCopyImageButton, clipboardSupported };
})();
