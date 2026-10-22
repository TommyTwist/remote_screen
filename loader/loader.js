/* Screen Hub loader v1.0.1 — the only part installed on the TV.
   Fetches the player from player/ in TommyTwist/remote_screen, keeps the last good copy,
   and falls back to the copy bundled in this package. ES5 only. */
(function () {
  "use strict";
  var LOADER_VERSION = "1.0.1";
  var BASE = "https://raw.githubusercontent.com/TommyTwist/remote_screen/main/player/";
  var CACHE_KEY = "rs.playerCache";

  function now() { return new Date().getTime(); }
  function get(url, timeoutMs, ok, fail) {
    var x = new XMLHttpRequest(), done = false;
    x.open("GET", url, true);
    x.timeout = timeoutMs;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || done) return;
      done = true;
      if ((x.status >= 200 && x.status < 300) || (x.status === 0 && x.responseText)) ok(x.responseText);
      else fail("HTTP " + x.status);
    };
    x.ontimeout = function () { if (!done) { done = true; fail("timeout"); } };
    try { x.send(); } catch (e) { if (!done) { done = true; fail("network"); } }
  }
  function status(t) { var s = document.getElementById("boot-status"); if (s) s.textContent = t; }

  // fetch manifest + every file it lists from a base URL
  function fetchPackage(base, bustIt, cb) {
    var q = bustIt ? "?t=" + now() : "";
    get(base + "manifest.json" + q, 10000, function (mt) {
      var man;
      try { man = JSON.parse(mt); } catch (e) { cb("bad manifest"); return; }
      var f = man.files || {}, js = f.js, list = [], pkg = { manifest: man, html: "", css: "", js: [] }, i;
      if (typeof js === "string") js = [js];
      list.push({ k: "html", n: f.html }); list.push({ k: "css", n: f.css });
      for (i = 0; i < (js || []).length; i++) list.push({ k: "js", n: js[i] });
      var left = list.length, failed = false;
      function one(item) {
        get(base + item.n + (bustIt ? "?v=" + encodeURIComponent(man.version) + "&t=" + now() : ""), 20000, function (t) {
          if (failed) return;
          if (item.k === "js") pkg.js[item.i] = t; else pkg[item.k] = t;
          if (--left === 0) cb(null, pkg);
        }, function (e) { if (!failed) { failed = true; cb(item.n + " " + e); } });
      }
      var jsIdx = 0;
      for (i = 0; i < list.length; i++) { if (list[i].k === "js") list[i].i = jsIdx++; one(list[i]); }
    }, function (e) { cb("manifest " + e); });
  }

  function boot(pkg, source) {
    window.RS_BOOT = { manifest: pkg.manifest, source: source, loaderVersion: LOADER_VERSION, loadedAt: new Date().toString() };
    window.RS_ALIVE = false;
    document.body.innerHTML = pkg.html;
    var st = document.createElement("style");
    st.textContent = pkg.css;
    document.getElementsByTagName("head")[0].appendChild(st);
    for (var i = 0; i < pkg.js.length; i++) {
      var sc = document.createElement("script");
      sc.text = pkg.js[i];
      document.body.appendChild(sc);
    }
    return !!window.RS_ALIVE;
  }

  var bootErrs = [];
  window.onerror = function (msg, src, line) { bootErrs.push(msg + (line ? " (line " + line + ")" : "")); return false; };
  function fatal(t) {
    document.body.innerHTML = '<div style="position:absolute;left:90px;right:90px;top:120px;color:#e8edf5;font-size:30px;line-height:1.5">' +
      '<div style="font-size:46px;font-weight:bold;margin-bottom:20px">Screen Hub couldn\'t start</div>' +
      String(t).replace(/</g, "&lt;") + '<br><span style="color:#f0bd52;font-size:22px">' + bootErrs.join("<br>").replace(/<(?!br>)/g, "&lt;") +
      '</span><br><span style="color:#8a95a5;font-size:20px">Loader ' + LOADER_VERSION + ' · ' + String(navigator.userAgent).replace(/</g, "&lt;") + '</span></div>';
  }
  function bootBundled(why) {
    fetchPackage("bundled/", false, function (err, pkg) {
      if (err) { fatal("Couldn't load the player (" + why + "; " + err + ")."); return; }
      if (!boot(pkg, "package (" + why + ")")) fatal("The player didn't start (" + why + ").");
    });
  }

  function newer(a, b) { // true if version string a is newer than b
    var x = String(a || "0").split("."), y = String(b || "0").split("."), i;
    for (i = 0; i < 3; i++) { var p = parseInt(x[i] || 0, 10), q = parseInt(y[i] || 0, 10); if (p !== q) return p > q; }
    return false;
  }
  function start() {
    status("Starting Screen Hub… (loader " + LOADER_VERSION + ")");
    fetchPackage(BASE, true, function (err, pkg) {
      if (!err) {
        try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(pkg)); } catch (e) {}
        if (boot(pkg, "GitHub")) return;
        bootBundled("update didn't start");
        return;
      }
      // GitHub unreachable: use whichever of the saved copy and the built-in copy is newer
      status("Couldn't reach GitHub (" + err + "). Using the copy on this TV…");
      var cached = null;
      try { cached = JSON.parse(window.localStorage.getItem(CACHE_KEY) || "null"); } catch (e) {}
      fetchPackage("bundled/", false, function (berr, bpkg) {
        var cv = cached && cached.manifest && cached.manifest.version, bv = bpkg && bpkg.manifest && bpkg.manifest.version;
        if (cached && (berr || newer(cv, bv))) {
          if (boot(cached, "saved copy " + cv + " (GitHub: " + err + ")")) return;
        }
        if (berr) { fatal("Couldn't reach GitHub (" + err + ") and couldn't load the built-in player (" + berr + ")."); return; }
        if (!boot(bpkg, "built-in copy " + bv + " (GitHub: " + err + ")")) fatal("Couldn't reach GitHub (" + err + ") and the built-in player didn't start.");
      });
    });
  }
  window.onload = start;
})();
