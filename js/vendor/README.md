# Vendored dependencies

This project has no build step, so third-party JS is vendored directly rather
than installed via npm.

## html2canvas.min.js

- Version: 1.4.1
- Source: https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
- License: MIT (c) Niklas von Hertzen - https://html2canvas.hertzen.com
- Why: `js/copy-image.js`'s "Copy image" buttons need to rasterize arbitrary
  DOM (tables, chart panels) into a canvas for clipboard/download. The
  straightforward zero-dependency approach (serialize the DOM into an SVG
  `<foreignObject>`, draw that to a canvas) turns out to be blocked by a
  browser security restriction: Chromium taints any canvas that ever drew an
  SVG containing `<foreignObject>`, unconditionally, even with zero external
  resources involved - confirmed with a minimal "hello world" test case.
  html2canvas walks the DOM/CSSOM itself and paints with canvas primitives
  instead of going through the browser's native SVG renderer, so it doesn't
  hit that restriction, and it already handles the gradient/badge/border
  cases this app's tables need.
- To upgrade: replace this file with a newer `html2canvas.min.js` from the
  same CDN URL (bump the version number above and in the URL).
