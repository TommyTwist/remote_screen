/* Screen Hub start-up guard (player 1.2.2). Loaded before every other player script.
   If anything goes wrong while the player starts, the TV shows what happened instead of
   a black screen. ES5 only, no dependencies. */
(function () {
  var errs = [], shown = false, t0 = new Date().getTime();
  function add(m) { if (errs.length < 8) errs.push(String(m).slice(0, 300)); if (shown) paint(); }
  var prevErr = window.onerror;
  window.onerror = function (msg, src, line, col) {
    add(msg + (line ? " (line " + line + (col ? ":" + col : "") + ")" : ""));
    if (typeof prevErr === "function") { try { return prevErr.apply(this, arguments); } catch (e) {} }
    return false;
  };
  window.RS_GUARD = { errors: errs, add: add };
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"; }); }
  function paint() {
    shown = true;
    var el = document.getElementById("rs-guard");
    if (!el) {
      el = document.createElement("div");
      el.id = "rs-guard";
      el.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:#05080d;color:#e8edf5;" +
        "font-family:'Samsung One','Tizen Sans',sans-serif;font-size:26px;line-height:1.45;padding:70px 90px;";
      (document.body || document.documentElement).appendChild(el);
    }
    var b = window.RS_BOOT || {}, m = b.manifest || {}, st = null;
    try { st = window.RS_PLAYER && window.RS_PLAYER.state(); } catch (e) {}
    var h = "<div style='font-size:20px;letter-spacing:.12em;color:#5b6676;font-weight:bold'>SCREEN HUB</div>" +
      "<div style='font-size:46px;font-weight:bold;margin:6px 0 24px'>Screen Hub didn't start properly</div>" +
      "<div style='color:#a7b2c1'>Take a photo of this screen and send it to Claude.</div>" +
      "<div style='margin-top:28px;font-size:22px;color:#c9d1dc'>" +
      "Player " + esc(m.version || "?") + " · loaded from " + esc(b.source || "?") + " · loader " + esc(b.loaderVersion || "?") + "<br>" +
      "Started: " + (window.RS_ALIVE ? "yes" : "no") + (st ? " · state " + esc(st.access) + " · Screen ID " + esc(st.screenId || "…") : "") + "<br>" +
      "Browser: " + esc(navigator.userAgent) + "</div>";
    if (errs.length) {
      h += "<div style='margin-top:26px;font-size:22px;color:#f0bd52'>";
      for (var i = 0; i < errs.length; i++) h += "• " + esc(errs[i]) + "<br>";
      h += "</div>";
    } else h += "<div style='margin-top:26px;font-size:22px;color:#f0bd52'>No error was reported; the player stopped before showing anything.</div>";
    el.innerHTML = h;
  }
  // The player calls RS_GUARD.ok() once something is on screen. If that hasn't happened
  // within 25 seconds, show the report.
  window.RS_GUARD.ok = function () { window.RS_GUARD.done = true; var el = document.getElementById("rs-guard"); if (el) el.parentNode.removeChild(el); shown = false; };
  setTimeout(function () { if (!window.RS_GUARD.done) paint(); }, 25000);
})();
