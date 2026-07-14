// Applied synchronously, before the stylesheet paints anything, so a
// returning visitor's saved preference never flashes the other theme
// first. No preference saved yet -> no data-theme attribute at all,
// which is exactly what css/style.css's plain :root (the dark palette,
// the app's default) already renders - dark isn't tied to OS preference,
// only an explicit "light" choice ever overrides it.
//
// A separate file (not an inline <script> in index.html's <head>) because
// the site's CSP (netlify.toml) is script-src 'self' - no 'unsafe-inline' -
// so an inline script silently fails on the live deployment even though it
// runs fine from a local file:// or dev-server load, where CSP isn't
// enforced. Confirmed on the real live site: this was the one console error
// on an otherwise clean load.
(function () {
  try {
    var saved = localStorage.getItem("eu5-analyzer-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch (e) {}
})();
