/* Screen Hub player — runs on Samsung Tizen TVs (2016 Tizen 2.4 WebKit and newer).
   ES5 only. Loaded by the installed loader from player/ in TommyTwist/remote_screen.

   Privacy: the repo is public, but nothing in it is readable without a screen's key.
   Each TV makes its own pairing code on first start. The console holds the codes; the
   sync encrypts each paired screen's playlist (s/<fileId>.json) and media (m/*.bin)
   with AES-256-GCM. Only a TV that holds the matching code can decrypt its file.
   See docs/FORMAT.md for the exact format. */
(function () {
  "use strict";

  var BOOT = window.RS_BOOT || {};
  var MAN = BOOT.manifest || {};
  var CFG = {}, k;
  var BASE_CFG = MAN.config || {};
  for (k in BASE_CFG) if (BASE_CFG.hasOwnProperty(k)) CFG[k] = BASE_CFG[k];
  var VERSION = MAN.version || "dev";
  var REPO_RAW = CFG.REPO_RAW || "https://raw.githubusercontent.com/TommyTwist/remote_screen/main/";
  var MANIFEST_URL = CFG.MANIFEST_URL || REPO_RAW + "player/manifest.json";
  var sjcl = window.sjcl;

  var CHANGELOG = [
    { v: "1.2.1", d: "22 Oct 2026", t: "Fix: some TVs showed a blank screen instead of the pairing card. The card now always shows first with the Screen ID and code; the QR code is added on top only if the TV can draw it, as a plain image." },
    { v: "1.2.0", d: "22 Oct 2026", t: "Pairing by QR code: the pairing card shows a QR code to scan from the Screen Hub console on a phone. The Screen ID and code are still shown underneath for typing in." },
    { v: "1.1.0", d: "22 Oct 2026", t: "Time check: a full-screen clock on the hour and half hour for 15 seconds, skipped while someone is using the remote. On by default; switch per screen in the console." },
    { v: "1.0.0", d: "22 Oct 2026", t: "First release: pairing codes and per-screen encryption; playlists of pictures, videos, YouTube, web pages, apps, messages and a clock; schedules; night mode; remote commands." }
  ];

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function now() { return new Date().getTime(); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hhmm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function longDate(d) { return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; }
  function shortTime(t) { if (!t) return "never"; var d = new Date(t); if (isNaN(d.getTime())) return "unknown"; return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) + " " + hhmm(d); }
  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, v) { try { window.localStorage.setItem(key, v); } catch (e) {} }
  function lsDel(key) { try { window.localStorage.removeItem(key); } catch (e) {} }
  function num(v, lo, hi, dflt) { var n = Number(v); if (v === null || v === undefined || v === "" || isNaN(n)) return dflt; return Math.max(lo, Math.min(hi, Math.round(n))); }
  function bust(url) { return url + (url.indexOf("?") < 0 ? "?" : "&") + "t=" + now(); }

  function request(url, type, timeoutMs, ok, fail) {
    var x = new XMLHttpRequest(), done = false;
    x.open("GET", url, true);
    if (type === "arraybuffer") x.responseType = "arraybuffer";
    x.timeout = timeoutMs;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || done) return;
      done = true;
      var body = type === "arraybuffer" ? x.response : x.responseText;
      if ((x.status >= 200 && x.status < 300) || (x.status === 0 && body)) ok(body);
      else fail(x.status === 404 ? "404" : "HTTP " + x.status);
    };
    x.ontimeout = function () { if (!done) { done = true; fail("timed out"); } };
    try { x.send(); } catch (e) { if (!done) { done = true; fail("network"); } }
  }
  function xhrJSON(url, timeoutMs, ok, fail) {
    request(url, "text", timeoutMs, function (t) { var j; try { j = JSON.parse(t); } catch (e) { fail("not valid JSON"); return; } ok(j); }, fail);
  }

  // ---------- crypto (AES-256-GCM; WebCrypto when the TV has it, SJCL otherwise) ----------
  function bytesToBits(u8) {
    var out = [], i, n = u8.length, tmp = 0;
    for (i = 0; i < n; i++) { tmp = (tmp << 8) | u8[i]; if ((i & 3) === 3) { out.push(tmp | 0); tmp = 0; } }
    if (n & 3) out.push(sjcl.bitArray.partial(8 * (n & 3), tmp));
    return out;
  }
  function bitsToBytes(bits) {
    var bl = sjcl.bitArray.bitLength(bits), n = bl / 8, out = new Uint8Array(n), i, w = 0;
    for (i = 0; i < n; i++) { if ((i & 3) === 0) w = bits[i / 4]; out[i] = (w >>> 24) & 255; w <<= 8; }
    return out;
  }
  function b64ToBytes(s) { return bitsToBytes(sjcl.codec.base64.toBits(s)); }
  function sha256Bytes(str) { return bitsToBytes(sjcl.hash.sha256.hash(str)); }
  function hexOf(u8) { var h = "", i; for (i = 0; i < u8.length; i++) h += (u8[i] < 16 ? "0" : "") + u8[i].toString(16); return h; }
  var subtle = null;
  try { subtle = (window.crypto && (window.crypto.subtle || window.crypto.webkitSubtle)) || null; } catch (e) { subtle = null; }
  var subtleOk = !!subtle;
  // decrypt(key Uint8Array32, iv Uint8Array12, ct Uint8Array (ct||tag), aad Uint8Array|null, cb(err, Uint8Array))
  function decryptGCM(key, iv, ct, aad, cb) {
    function viaSjcl() {
      setTimeout(function () {
        try {
          var pt = sjcl.mode.gcm.decrypt(new sjcl.cipher.aes(bytesToBits(key)), bytesToBits(ct), bytesToBits(iv), aad ? bytesToBits(aad) : [], 128);
          cb(null, bitsToBytes(pt));
        } catch (e) { cb("decrypt failed"); }
      }, 0);
    }
    if (!subtleOk) { viaSjcl(); return; }
    try {
      var alg = { name: "AES-GCM", iv: iv, tagLength: 128 };
      if (aad) alg.additionalData = aad;
      subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]).then(function (ck) {
        return subtle.decrypt(alg, ck, ct);
      }).then(function (buf) { cb(null, new Uint8Array(buf)); }, function () {
        // a wrong key also lands here; check with SJCL before blaming WebCrypto
        viaSjcl();
      });
    } catch (e) { subtleOk = false; viaSjcl(); }
  }
  function utf8Decode(u8) {
    var s = "", i, CH = 8192;
    for (i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.prototype.slice.call(u8.subarray(i, i + CH)));
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  // ---------- stage scaling + burn-in drift ----------
  var scale = 1;
  function placeStage() {
    scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080) || 1;
    var t = Math.abs(scale - 1) > 0.01 ? "scale(" + scale + ")" : "none", st = $("stage");
    st.style.webkitTransform = t; st.style.transform = t;
  }
  window.addEventListener("resize", placeStage);
  function drift() {
    var dx = Math.round(Math.random() * 24 - 12), dy = Math.round(Math.random() * 16 - 8);
    var t = "translate(" + dx + "px," + dy + "px)", ids = ["pill", "info"], i, el;
    for (i = 0; i < ids.length; i++) { el = $(ids[i]); if (el) { el.style.webkitTransform = t; el.style.transform = t; } }
  }

  // ---------- screen identity + pairing code ----------
  var screenId = null, screenModel = "", pairCode = "", screenKey = null, fileId = "";
  var ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function loadScript(src, cb) {
    var sc = document.createElement("script"), done = false;
    function fin() { if (!done) { done = true; cb(); } }
    sc.src = src; sc.onload = fin; sc.onerror = fin;
    document.getElementsByTagName("head")[0].appendChild(sc);
    setTimeout(fin, 4000);
  }
  function randomBytes(n) {
    var a = new Uint8Array(n), i;
    try { window.crypto.getRandomValues(a); return a; } catch (e) {}
    for (i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256) ^ ((now() >> (i % 8)) & 255);
    return a;
  }
  function makeCode() {
    var b = randomBytes(16), s = "", i;
    for (i = 0; i < 16; i++) s += ALPHA.charAt(b[i] & 31);
    return s;
  }
  function prettyCode(c) { return c.slice(0, 4) + "-" + c.slice(4, 8) + "-" + c.slice(8, 12) + "-" + c.slice(12, 16); }
  function resolveId(cb) {
    loadScript("$WEBAPIS/webapis/webapis.js", function () {
      try { screenId = String(window.webapis.productinfo.getDuid() || "").split(/\s+/)[0] || null; } catch (e) {}
      try { screenModel = window.webapis.productinfo.getRealModel() || window.webapis.productinfo.getModel() || ""; } catch (e) {}
      if (screenId) screenId = screenId.toUpperCase().replace(/[^A-Z0-9_\-]/g, "");
      if (!screenId) {
        screenId = lsGet("rs.screenId");
        if (!screenId) { screenId = "WEB-" + makeCode().slice(0, 6); lsSet("rs.screenId", screenId); }
      }
      pairCode = lsGet("rs.pairCode");
      if (!pairCode || !/^[A-Z2-9]{16}$/.test(pairCode)) { pairCode = makeCode(); lsSet("rs.pairCode", pairCode); }
      deriveKeys();
      cb();
    });
  }
  function deriveKeys() {
    screenKey = sha256Bytes("rs1|key|" + screenId + "|" + pairCode);
    fileId = hexOf(sha256Bytes("rs1|file|" + screenId + "|" + pairCode)).slice(0, 32);
  }

  // ---------- settings ----------
  var DEFAULTS = { chime: true, defaultSeconds: 20, nightStart: 23, nightEnd: 6, nightMode: "clock", muted: true, checkMinutes: 3, idleMinutes: 5, fit: "contain" };
  function mergeSettings(defs, own) {
    var o = {}, kk;
    for (kk in DEFAULTS) if (DEFAULTS.hasOwnProperty(kk)) o[kk] = DEFAULTS[kk];
    for (kk in defs || {}) if (defs.hasOwnProperty(kk) && defs[kk] !== null && defs[kk] !== "") o[kk] = defs[kk];
    for (kk in own || {}) if (own.hasOwnProperty(kk) && own[kk] !== null && own[kk] !== "") o[kk] = own[kk];
    o.defaultSeconds = num(o.defaultSeconds, 3, 7200, 20);
    o.nightStart = num(o.nightStart, 0, 23, 23);
    o.nightEnd = num(o.nightEnd, 0, 23, 6);
    o.checkMinutes = num(o.checkMinutes, 1, 60, 3);
    o.idleMinutes = num(o.idleMinutes, 1, 60, 5);
    if (o.nightMode !== "clock" && o.nightMode !== "black" && o.nightMode !== "off") o.nightMode = "clock";
    o.muted = o.muted !== false;
    o.chime = o.chime !== false;
    return o;
  }

  // ---------- this screen's encrypted config ----------
  var payload = null, screenCfg = null, S = mergeSettings({}, {}), contentMap = {}, playlist = [], access = "checking";
  var lastConfigOk = 0, lastConfigErr = "", playlistSig = "", ytPage = "", fromCache = false;

  function resolvePlaylist(list, cmap) {
    var out = [], i, p, c;
    for (i = 0; i < (list || []).length; i++) {
      p = list[i];
      if (typeof p === "string") p = { content: p };
      c = p && cmap[p.content];
      if (!c || c.enabled === false) continue;
      out.push({ key: p.content + "#" + i, id: p.content, c: c, seconds: p.seconds });
    }
    return out;
  }
  function applyPayload(pl) {
    payload = pl;
    screenCfg = pl.screen || {};
    S = mergeSettings(pl.defaults, screenCfg.settings);
    contentMap = pl.content || {};
    ytPage = pl.youtubePage || "";
    var prev = access;
    access = screenCfg.enabled === false ? "blocked" : "registered";
    if (access === "blocked") { showLock(); return; }
    hideLock();
    playlist = resolvePlaylist(screenCfg.playlist, contentMap);
    var sig = JSON.stringify(playlist.map(function (p) { return p.key + ":" + JSON.stringify(p.c) + ":" + (p.seconds || ""); }));
    if (!fromCache) handleCommand(screenCfg.command);
    if (prev !== "registered" || sig !== playlistSig) {
      var changedCurrent = !current || !stillListed(current.p);
      playlistSig = sig;
      if (changedCurrent || prev !== "registered") advance(1, true);
    }
  }
  function stillListed(p) {
    for (var i = 0; i < playlist.length; i++) if (playlist[i].key === p.key && JSON.stringify(playlist[i].c) === JSON.stringify(p.c)) return true;
    return false;
  }
  function toPairing(why) {
    // no file for this code (not paired, removed, or a stale code): show nothing but the pairing card
    payload = null; screenCfg = null; playlist = []; playlistSig = "";
    lsDel("rs.lastConfig");
    access = "pairing"; lastConfigErr = why || "";
    showLock();
  }
  function checkConfig() {
    xhrJSON(bust(REPO_RAW + "s/" + fileId + ".json"), 15000, function (env) {
      if (!env || !env.iv || !env.ct) { toPairing("bad file"); return; }
      var ct, iv;
      try { iv = b64ToBytes(env.iv); ct = b64ToBytes(env.ct); } catch (e) { toPairing("bad file"); return; }
      decryptGCM(screenKey, iv, ct, sha256Bytes("rs1|aad|" + fileId).subarray(0, 16), function (err, pt) {
        if (err) { toPairing("key doesn't match"); return; }
        var pl;
        try { pl = JSON.parse(utf8Decode(pt)); } catch (e) { toPairing("bad file"); return; }
        lastConfigOk = now(); lastConfigErr = ""; fromCache = false;
        lsSet("rs.lastConfig", JSON.stringify(pl));
        applyPayload(pl);
      });
    }, function (err) {
      if (err === "404") { toPairing("not paired"); return; }
      lastConfigErr = err;
      if (access === "checking") {
        var cached = lsGet("rs.lastConfig"), pl = null;
        try { pl = cached ? JSON.parse(cached) : null; } catch (e) {}
        if (pl) { fromCache = true; applyPayload(pl); lastConfigErr = err + " (showing saved copy)"; }
        else { access = "offline"; showLock(); }
      }
    });
  }

  // ---------- remote commands ----------
  function handleCommand(cmd) {
    if (!cmd || !cmd.id) return;
    if (lsGet("rs.lastCmd") === String(cmd.id)) return;
    lsSet("rs.lastCmd", String(cmd.id));
    var at = cmd.at ? new Date(cmd.at).getTime() : 0;
    if (!at || isNaN(at) || now() - at > 3 * 3600 * 1000) return; // too old: record it, don't act
    if (cmd.action === "reload") setTimeout(function () { window.location.reload(); }, 300);
    else if (cmd.action === "identify") identify();
    else if (cmd.action === "next") advance(1);
    else if (cmd.action === "show" && cmd.content) jumpTo(cmd.content);
  }
  var identTimer = null;
  function identify() {
    var el = $("ident");
    el.innerHTML = '<div class="n">' + esc((screenCfg && screenCfg.name) || "Unnamed screen") + '</div><div class="i">' + esc(screenId) + '</div>' +
      '<div class="s">Screen Hub v' + esc(VERSION) + (screenModel ? " · " + esc(screenModel) : "") + '</div>';
    el.className = "on";
    clearTimeout(identTimer);
    identTimer = setTimeout(function () { el.className = ""; }, 30000);
  }

  // ---------- schedules ----------
  function minutesOf(s) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function eligible(c, d) {
    var sc = c.schedule || {}, t = d.getTime();
    if (sc.from) { var f = new Date(sc.from).getTime(); if (!isNaN(f) && t < f) return false; }
    if (sc.until) { var u = new Date(sc.until).getTime(); if (!isNaN(u) && t >= u) return false; }
    if (sc.days && sc.days.length && sc.days.indexOf(d.getDay()) < 0) return false;
    var a = minutesOf(sc.start), b = minutesOf(sc.end);
    if (a !== null && b !== null && a !== b) {
      var m = d.getHours() * 60 + d.getMinutes();
      if (a < b ? (m < a || m >= b) : (m < a && m >= b)) return false;
    }
    return true;
  }
  function inNight(d) {
    if (S.nightMode === "off") return false;
    var a = S.nightStart, b = S.nightEnd, h = d.getHours();
    if (a === b) return false;
    return a < b ? (h >= a && h < b) : (h >= a || h < b);
  }

  // ---------- encrypted media (decrypted on the TV, kept in memory) ----------
  var mediaCache = {}, mediaJobs = {}, cacheBytes = 0, CACHE_MAX = 120 * 1024 * 1024;
  function getMedia(c, cb) {
    if (c.url) { cb(null, c.url); return; }                     // a public link pasted in the console
    if (!c.file || !c.mkey || !c.iv8) { cb("missing file"); return; }
    var hit = mediaCache[c.file];
    if (hit) { hit.used = now(); cb(null, hit.url); return; }
    if (mediaJobs[c.file]) { mediaJobs[c.file].push(cb); return; }
    mediaJobs[c.file] = [cb];
    function finish(err, url) { var l = mediaJobs[c.file] || []; delete mediaJobs[c.file]; for (var i = 0; i < l.length; i++) l[i](err, url); }
    request(REPO_RAW + c.file, "arraybuffer", 180000, function (buf) {
      var all = new Uint8Array(buf), key = b64ToBytes(c.mkey), iv8 = b64ToBytes(c.iv8);
      var chunk = num(c.chunk, 4096, 16777216, 1048576), clen = chunk + 16, parts = [], idx = 0, pos = 0;
      function nextChunk() {
        if (pos >= all.length) {
          var blob, url;
          try { blob = new Blob(parts, { type: c.mime || "application/octet-stream" }); url = (window.URL || window.webkitURL).createObjectURL(blob); }
          catch (e) { finish("can't hold media"); return; }
          mediaCache[c.file] = { url: url, size: blob.size, used: now() };
          cacheBytes += blob.size; trimCache(c.file);
          finish(null, url);
          return;
        }
        var piece = all.subarray(pos, Math.min(pos + clen, all.length));
        var iv = new Uint8Array(12); iv.set(iv8, 0);
        iv[8] = (idx >>> 24) & 255; iv[9] = (idx >>> 16) & 255; iv[10] = (idx >>> 8) & 255; iv[11] = idx & 255;
        decryptGCM(key, iv, piece, null, function (err, pt) {
          if (err) { finish("media key doesn't match"); return; }
          parts.push(pt); pos += clen; idx++;
          setTimeout(nextChunk, 0);
        });
      }
      nextChunk();
    }, function (err) { finish("media " + err); });
  }
  function trimCache(keep) {
    var keys, i, oldest;
    while (cacheBytes > CACHE_MAX) {
      keys = []; for (var f in mediaCache) if (mediaCache.hasOwnProperty(f) && f !== keep && !(current && current.p.c.file === f)) keys.push(f);
      if (!keys.length) return;
      oldest = keys[0];
      for (i = 1; i < keys.length; i++) if (mediaCache[keys[i]].used < mediaCache[oldest].used) oldest = keys[i];
      try { (window.URL || window.webkitURL).revokeObjectURL(mediaCache[oldest].url); } catch (e) {}
      cacheBytes -= mediaCache[oldest].size; delete mediaCache[oldest];
    }
  }
  function prefetchNext() {
    var el = eligibleList(), i, p = null;
    for (i = 0; i < el.length; i++) if (el[i] > posIdx) { p = playlist[el[i]]; break; }
    if (!p && el.length) p = playlist[el[0]];
    if (p && (p.c.type === "image" || p.c.type === "video") && p.c.file) getMedia(p.c, function () {});
  }

  // ---------- playback ----------
  var layers = null, front = 0, current = null, pending = null, failed = {}, posIdx = -1;
  var paused = false, lastKey = 0, nightOn = false, lastError = "";

  function clearLayer(el) {
    var v = el.getElementsByTagName("video"), i, f;
    for (i = 0; i < v.length; i++) { try { v[i].pause(); v[i].removeAttribute("src"); v[i].load(); } catch (e) {} }
    f = el.getElementsByTagName("iframe");
    for (i = 0; i < f.length; i++) { try { f[i].src = "about:blank"; } catch (e) {} }
    el.innerHTML = "";
  }
  function durationOf(p) {
    var c = p.c;
    if (p.seconds) return num(p.seconds, 3, 7200, S.defaultSeconds) * 1000;
    if ((c.type === "video" || c.type === "youtube") && c.untilEnd !== false && !c.seconds) return 30 * 60 * 1000; // ends early on 'ended'
    return num(c.seconds, 3, 7200, S.defaultSeconds) * 1000;
  }
  function makeIframe(src) {
    var f = document.createElement("iframe");
    f.setAttribute("frameborder", "0"); f.setAttribute("scrolling", "no");
    f.setAttribute("allow", "autoplay; encrypted-media");
    f.style.width = "1920px"; f.style.height = "1080px";
    if (src) f.src = src;
    return f;
  }

  function build(p, el, ready, fail) {
    var c = p.c, t = c.type, node, done = false;
    function ok() { if (!done) { done = true; ready(); } }
    function bad(why) { if (!done) { done = true; fail(why); } }
    if (t === "image") {
      node = document.createElement("div");
      node.className = "img" + ((c.fit || S.fit) === "cover" ? " cover" : "");
      el.appendChild(node);
      if (c.caption) { var cp = document.createElement("div"); cp.className = "cap"; cp.textContent = c.caption; el.appendChild(cp); }
      getMedia(c, function (err, url) {
        if (err) { bad(err); return; }
        var im = new Image();
        im.onload = function () { node.style.backgroundImage = 'url("' + String(url).replace(/"/g, "%22") + '")'; ok(); };
        im.onerror = function () { bad("image didn't load"); };
        im.src = url;
        setTimeout(function () { bad("image timed out"); }, 20000);
      });
    } else if (t === "video") {
      getMedia(c, function (err, url) {
        if (err) { bad(err); return; }
        var v = document.createElement("video");
        v.muted = c.muted === false ? false : S.muted;
        if (v.muted) v.setAttribute("muted", "");
        v.setAttribute("autoplay", ""); v.setAttribute("playsinline", "");
        v.preload = "auto";
        if (c.loop) v.loop = true;
        v.oncanplay = function () { try { v.play(); } catch (e) {} ok(); };
        v.onerror = function () { bad("video format not supported"); };
        v.onended = function () { if (current && current.p === p) advance(1); };
        v.src = url;
        el.appendChild(v);
        setTimeout(function () { bad("video timed out"); }, 25000);
      });
    } else if (t === "youtube") {
      var vid = String(c.videoId || "").replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 11);
      if (!vid) { bad("no video id"); return; }
      var mute = (c.muted === false ? false : S.muted) ? 1 : 0, st = c.start ? "&start=" + num(c.start, 0, 86400, 0) : "";
      var src = ytPage ? ytPage + "?v=" + vid + "&mute=" + mute + st :
        "https://www.youtube.com/embed/" + vid + "?autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&rel=0&playsinline=1&enablejsapi=1&mute=" + mute + st;
      node = makeIframe(src);
      node.onload = function () { setTimeout(ok, 1200); };
      el.appendChild(node);
      setTimeout(ok, 8000);
    } else if (t === "web") {
      var z = num(c.zoom, 25, 300, 100) / 100;
      node = makeIframe(c.url);
      node.style.width = Math.round(1920 / z) + "px"; node.style.height = Math.round(1080 / z) + "px";
      if (z !== 1) { node.style.webkitTransformOrigin = "0 0"; node.style.transformOrigin = "0 0"; node.style.webkitTransform = "scale(" + z + ")"; node.style.transform = "scale(" + z + ")"; }
      node.onload = function () { setTimeout(ok, 800); };
      el.appendChild(node);
      setTimeout(ok, 10000);
    } else if (t === "app") {
      // apps are single HTML files in apps/; raw GitHub serves them as text, so the player
      // fetches the file and writes it into an iframe document
      var app = String(c.app || "").replace(/[^a-z0-9_\-]/gi, "");
      if (!app) { bad("no app"); return; }
      node = makeIframe("");
      el.appendChild(node);
      request(bust(REPO_RAW + "apps/" + app + "/index.html"), "text", 15000, function (html) {
        try {
          var params = JSON.stringify({ screenId: screenId, screenName: screenCfg && screenCfg.name, options: c.options || {} }).replace(/</g, "\\u003c");
          html = html.replace(/<head>/i, "<head><script>window.RS_APP=" + params + ";<\/script>");
          var d = node.contentWindow.document;
          d.open(); d.write(html); d.close();
          setTimeout(ok, 2500);
        } catch (e) { bad("app didn't start"); }
      }, function (err) { bad("app " + err); });
      setTimeout(ok, 15000);
    } else if (t === "message") {
      node = document.createElement("div");
      node.className = "msg t-" + (/^(gradient|dark|light|alert)$/.test(c.theme) ? c.theme : "gradient");
      var dx = Math.round(Math.random() * 60 - 30), dy = Math.round(Math.random() * 40 - 20);
      node.innerHTML = '<div class="inner" style="-webkit-transform:translate(' + dx + 'px,' + dy + 'px);transform:translate(' + dx + 'px,' + dy + 'px)">' +
        (c.kicker ? '<div class="kick">' + esc(c.kicker) + '</div>' : "") +
        '<div class="ttl">' + esc(c.title || "") + '</div>' + (c.body ? '<div class="bdy">' + esc(c.body) + '</div>' : "") + '</div>';
      el.appendChild(node);
      ok();
    } else if (t === "clock") {
      node = document.createElement("div");
      node.className = "clock";
      node.innerHTML = '<div class="box"><div class="tm"></div><div class="dt"></div>' + (c.label ? '<div class="lbl">' + esc(c.label) + '</div>' : "") + '</div>';
      el.appendChild(node);
      tickClock(node, true);
      ok();
    } else bad("unknown type " + t);
  }
  function tickClock(node, move) {
    var d = new Date(), box = node && node.querySelector ? node.querySelector(".box") : null;
    if (!box) return;
    box.querySelector(".tm").textContent = hhmm(d);
    box.querySelector(".dt").textContent = longDate(d);
    if (move || d.getSeconds() === 0) {
      box.style.top = (300 + Math.round(Math.random() * 160 - 80)) + "px";
      box.style.left = Math.round(Math.random() * 120 - 60) + "px";
    }
  }

  function eligibleList() {
    var d = new Date(), out = [], i, p;
    for (i = 0; i < playlist.length; i++) {
      p = playlist[i];
      if (failed[p.key] && failed[p.key] > now()) continue;
      if (eligible(p.c, d)) out.push(i);
    }
    return out;
  }
  function advance(dir, fresh) {
    if (access !== "registered" || nightOn) return;
    if (pending && !fresh) return;            // the next item is still loading; keep the current one up
    var el = eligibleList();
    if (!el.length) { showIdle(); return; }
    var pos = -1, i;
    if (fresh) posIdx = -1;
    if (posIdx >= 0) {
      if (dir >= 0) { for (i = 0; i < el.length; i++) if (el[i] > posIdx) { pos = el[i]; break; } if (pos < 0) pos = el[0]; }
      else { for (i = el.length - 1; i >= 0; i--) if (el[i] < posIdx) { pos = el[i]; break; } if (pos < 0) pos = el[el.length - 1]; }
    } else pos = el[0];
    if (el.length === 1 && current && current.p === playlist[pos] && !fresh && current.p.c.type !== "video" && current.p.c.type !== "youtube") { current.startedAt = now(); return; }
    play(pos);
  }
  function jumpTo(contentId) {
    for (var i = 0; i < playlist.length; i++) if (playlist[i].id === contentId) { if (pending) { clearLayer(layers[pending.layer]); pending = null; } play(i); return; }
  }
  function play(pos) {
    var p = playlist[pos], back = 1 - front, el = layers[back], token = {};
    if (pending) clearLayer(layers[pending.layer]);
    pending = { token: token, layer: back };
    clearLayer(el);
    build(p, el, function () {
      if (!pending || pending.token !== token) return;
      pending = null;
      hideIdle();
      var old = layers[front];
      el.className = "layer front"; old.className = "layer";
      front = back;
      setTimeout(function () { if (old !== layers[front]) clearLayer(old); }, 900);
      posIdx = pos; paused = false;
      current = { p: p, startedAt: now(), dur: durationOf(p) };
      updatePill(); if ($("info").className === "on") renderInfo();
      setTimeout(prefetchNext, 1500);
    }, function (why) {
      if (!pending || pending.token !== token) return;
      pending = null;
      clearLayer(el);
      failed[p.key] = now() + 10 * 60 * 1000;
      lastError = (p.c.name || p.id) + ": " + why;
      posIdx = pos;
      setTimeout(function () { advance(1); }, 300);
    });
  }

  // ---------- idle / lock cards ----------
  function card(title, body, showCode) {
    return '<div class="welcome" id="welcome"><div class="t">Screen Hub</div><div class="h">' + esc(title) + '</div>' +
      '<div class="d">Screen ID</div><div class="id sid">' + esc(screenId || "…") + '</div>' +
      (showCode ? '<div class="d">Pairing code</div><div class="id">' + esc(prettyCode(pairCode)) + '</div>' : "") +
      '<div class="f">' + esc(body) + '</div><div class="clk" id="idleClock">' + hhmm(new Date()) + '</div></div>';
  }
  function showIdle() {
    if (current) { clearLayer(layers[front]); layers[front].className = "layer"; current = null; }
    $("idle").innerHTML = card("Nothing to show right now", "This screen's playlist is empty, or nothing in it is scheduled for now. Add content in the Screen Hub console.", false);
    $("idle").className = "on";
    moveCard();
  }
  function moveCard() {
    var w = $("welcome"); if (!w) return;
    w.style.left = (120 + Math.round(Math.random() * 760)) + "px";
    w.style.top = (60 + Math.round(Math.random() * 200)) + "px";
  }
  function hideIdle() { $("idle").className = ""; }
  function showLock() {
    stopAll();
    var el = $("lock");
    if (access === "blocked") el.innerHTML = card("This screen has been switched off", "Switch it back on in the Screen Hub console. It checks again every few minutes.", false);
    else if (access === "offline") el.innerHTML = card("Can't reach the internet", "Screen Hub will keep trying. Check the TV's network connection.", false);
    else {
      // text card first, so the Screen ID and code are always on screen whatever happens next
      el.innerHTML = card("Pair this screen", "In the Screen Hub console, choose Pair a new screen and enter this Screen ID and pairing code. Content appears within a few minutes of the next publish.", true);
      try {
        if (hasQr()) {
          var keep = el.innerHTML;
          el.innerHTML = pairCard();
          if (!drawQr($("pairQr"))) el.innerHTML = keep;
        }
      } catch (e) {
        lastError = "pairing card: " + (e && e.message || e);
        el.innerHTML = card("Pair this screen", "In the Screen Hub console, choose Pair a new screen and enter this Screen ID and pairing code. Content appears within a few minutes of the next publish.", true);
      }
    }
    el.className = "on";
    moveCard2();
  }
  function moveCard2() {
    var w = $("lock").querySelector(".welcome"); if (!w) return;
    if (/\bpair\b/.test(w.className)) {
      // 1280 x 572 card: keep it on the 1920 x 1080 stage with a margin, drifting against burn-in
      w.style.left = (80 + Math.round(Math.random() * 480)) + "px";
      w.style.top = (60 + Math.round(Math.random() * 380)) + "px";
    } else {
      w.style.left = (120 + Math.round(Math.random() * 760)) + "px";
      w.style.top = (60 + Math.round(Math.random() * 140)) + "px";
    }
  }

  // ---------- pairing QR (v1.2.0) ----------
  // The console scans this to add the screen. Payload: SCREENHUB:1:<Screen ID>:<pairing code>
  // It carries the same two values the card prints, nothing else.
  function pairPayload() { return "SCREENHUB:1:" + screenId + ":" + pairCode; }
  function hasQr() { return typeof window.qrcode === "function" && !!screenId && !!pairCode; }
  function drawQr(box) {
    // Plain GIF image from the QR library: no canvas, so it works on the oldest TV browsers.
    if (!box) return false;
    try {
      var q = window.qrcode(0, "M");
      q.addData(pairPayload());
      q.make();
      var n = q.getModuleCount(), quiet = 4, cell = Math.max(2, Math.floor(400 / (n + quiet * 2))), size = cell * (n + quiet * 2);
      var img = document.createElement("img");
      img.src = q.createDataURL(cell, cell * quiet);
      img.width = size; img.height = size;
      img.style.marginTop = img.style.marginLeft = Math.max(0, Math.floor((420 - size) / 2)) + "px";
      box.innerHTML = "";
      box.appendChild(img);
      return true;
    } catch (e) {
      lastError = "QR code: " + (e && e.message || e);
      return false;
    }
  }
  function pairCard() {
    return '<div class="welcome pair" id="welcome">' +
      '<div class="pt"><div class="t">Screen Hub</div><div class="h">Pair this screen</div>' +
      '<div class="f">On your phone, open the Screen Hub console, choose <b>Pair a new screen</b> then <b>Scan QR code</b>, and point the camera at this code.</div>' +
      '<div class="d">Or type these in</div>' +
      '<div class="pk"><span class="k">Screen ID</span><span class="v">' + esc(screenId || "…") + '</span></div>' +
      '<div class="pk"><span class="k">Code</span><span class="v code">' + esc(prettyCode(pairCode)) + '</span></div>' +
      '<div class="clk" id="idleClock">' + hhmm(new Date()) + '</div></div>' +
      '<div class="qr" id="pairQr"></div></div>';
  }
  function hideLock() { $("lock").className = ""; }
  function stopAll() {
    if (pending) { clearLayer(layers[pending.layer]); pending = null; }
    if (current) { clearLayer(layers[front]); layers[front].className = "layer"; current = null; }
    hideIdle();
  }

  // ---------- night ----------
  var nightOverrideUntil = 0;
  function setNight(on) {
    if (on === nightOn) return;
    nightOn = on;
    var n = $("night");
    if (on) { stopAll(); n.className = "on" + (S.nightMode === "black" ? " black" : ""); moveNightClock(); }
    else { n.className = ""; advance(1, true); }
  }
  function moveNightClock() {
    var c = $("nightClock");
    c.textContent = hhmm(new Date());
    c.style.left = (120 + Math.round(Math.random() * 1500)) + "px";
    c.style.top = (80 + Math.round(Math.random() * 860)) + "px";
  }

  // ---------- pill + info ----------
  function updatePill() {
    var p = $("pill");
    if (paused && current) { p.textContent = "⏸ Paused · resumes after " + S.idleMinutes + " min without a button press"; p.className = "on"; }
    else p.className = "";
  }
  function fmtLeft(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? Math.floor(s / 60) + ":" + pad(s % 60) : s + "s"; }
  var TYPE_LABEL = { image: "Picture", video: "Video", youtube: "YouTube", web: "Website", app: "App", message: "Message", clock: "Clock" };
  function renderInfo() {
    var el = $("info"), cur = current, nextName = "", el2 = eligibleList(), i;
    if (cur) {
      for (i = 0; i < el2.length; i++) if (el2[i] > posIdx) { nextName = playlist[el2[i]].c.name; break; }
      if (!nextName && el2.length) nextName = playlist[el2[0]].c.name;
    }
    var accLabel = { registered: '<span class="ok">Paired</span>', pairing: '<span class="warn">Not paired</span>', blocked: '<span class="bad">Switched off</span>', offline: '<span class="bad">Offline</span>', checking: "Checking…" }[access] || access;
    var cfgLine = lastConfigOk ? '<span class="ok">Checked ' + hhmm(new Date(lastConfigOk)) + '</span>' : '<span class="warn">Not loaded' + (lastConfigErr ? " (" + esc(lastConfigErr) + ")" : "") + '</span>';
    el.innerHTML = '<div class="hd"><div class="nm">' + esc((screenCfg && screenCfg.name) || "Unnamed screen") + '</div><div class="vp">v' + esc(VERSION) + '</div></div>' +
      '<div class="row"><div class="k">Screen ID · pairing code</div><div class="v mono">' + esc(screenId) + " · " + esc(prettyCode(pairCode)) + '</div></div>' +
      '<div class="row"><div class="k">Access</div><div class="v">' + accLabel + (screenModel ? " · " + esc(screenModel) : "") + '</div></div>' +
      '<div class="row"><div class="k">Now showing</div><div class="v">' + (cur ? esc(cur.p.c.name || cur.p.id) + " · " + esc(TYPE_LABEL[cur.p.c.type] || cur.p.c.type) + (paused ? " · paused" : " · " + fmtLeft(cur.dur - (now() - cur.startedAt)) + " left") : (nightOn ? "Night mode" : "Nothing")) + '</div></div>' +
      (cur ? '<div class="row"><div class="k">Up next</div><div class="v">' + esc(nextName || "—") + " · " + el2.length + " of " + playlist.length + ' items on now</div></div>' : "") +
      '<div class="row"><div class="k">Settings</div><div class="v">' + cfgLine + (payload ? " · published " + esc(shortTime(payload.updatedAt)) : "") + '</div></div>' +
      '<div class="row"><div class="k">Time check</div><div class="v">' + (S.chime ? "Clock at :00 and :30 for 15s" : "Off") + '</div></div>' +
      '<div class="row"><div class="k">Night mode</div><div class="v">' + (S.nightMode === "off" ? "Off" : pad(S.nightStart) + ":00–" + pad(S.nightEnd) + ":00 · " + (S.nightMode === "black" ? "black screen" : "dim clock")) + '</div></div>' +
      '<div class="row"><div class="k">Player</div><div class="v">Loaded from ' + esc(BOOT.source || "package") + (BOOT.loaderVersion ? " · loader v" + esc(BOOT.loaderVersion) : "") + " · " + (subtleOk ? "fast decrypt" : "software decrypt") + '</div></div>' +
      (lastError ? '<div class="row"><div class="k">Last problem</div><div class="v warn">' + esc(lastError) + '</div></div>' : "") +
      '<div class="keys">◀ ▶ previous / next · OK pause · ▲ or INFO this panel · RED identify · BACK close</div>';
  }
  var infoTimer = null;
  function toggleInfo(force) {
    var el = $("info"), on = force === undefined ? el.className !== "on" : force;
    el.className = on ? "on" : "";
    clearTimeout(infoTimer);
    if (on) { renderInfo(); infoTimer = setTimeout(function () { el.className = ""; }, 20000); }
  }

  // ---------- remote keys ----------
  function registerKeys() {
    var keys = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaFastForward", "MediaRewind", "Info", "ColorF0Red"], i;
    for (i = 0; i < keys.length; i++) { try { window.tizen.tvinputdevice.registerKey(keys[i]); } catch (e) {} }
  }
  function setPaused(v) {
    if (!current || paused === v) return;
    paused = v;
    if (paused) current.pausedFor = now() - current.startedAt;
    else current.startedAt = now() - (current.pausedFor || 0);
    var vid = layers[front].getElementsByTagName("video")[0];
    if (vid) { try { if (paused) vid.pause(); else vid.play(); } catch (e) {} }
    updatePill();
  }
  document.addEventListener("keydown", function (e) {
    lastKey = now();
    var kc = e.keyCode;
    if ($("ident").className === "on") { $("ident").className = ""; e.preventDefault(); return; }
    if (chimeOn) { endChime(); e.preventDefault(); return; }
    if (nightOn && kc !== 10009 && kc !== 38 && kc !== 457) { nightOverrideUntil = now() + 10 * 60 * 1000; setNight(false); e.preventDefault(); return; }
    switch (kc) {
      case 37: case 412: if (pending) { clearLayer(layers[pending.layer]); pending = null; } advance(-1); break;
      case 39: case 417: if (pending) { clearLayer(layers[pending.layer]); pending = null; } advance(1); break;
      case 13: case 10252: setPaused(!paused); break;
      case 415: setPaused(false); break;
      case 19: setPaused(true); break;
      case 38: case 457: toggleInfo(); break;
      case 40: toggleInfo(false); break;
      case 403: identify(); break;
      case 10009:
        if ($("info").className === "on") { toggleInfo(false); break; }
        try { window.tizen.application.getCurrentApplication().exit(); } catch (x) {}
        break;
      default: return;
    }
    e.preventDefault();
  });

  // end/error messages from the YouTube page or a direct YouTube embed
  window.addEventListener("message", function (e) {
    var d = e.data, yt = current && current.p.c.type === "youtube";
    if (typeof d !== "string" || !yt) return;
    if (d === "rs:ended") { if (current.p.c.untilEnd !== false) advance(1); return; }
    if (d === "rs:error") { failed[current.p.key] = now() + 10 * 60 * 1000; lastError = (current.p.c.name || "YouTube") + ": this video can't be embedded"; advance(1); return; }
    if (d.charAt(0) === "{") {
      try {
        var j = JSON.parse(d);
        if (j.event === "onError") { failed[current.p.key] = now() + 10 * 60 * 1000; lastError = (current.p.c.name || "YouTube") + ": this video can't be embedded"; advance(1); return; }
        var st = j.event === "onStateChange" ? j.info : (j.info && j.info.playerState);
        if (st === 0 && current.p.c.untilEnd !== false) advance(1);
      } catch (x) {}
    }
  });

  // ---------- time check: clock on the hour and half hour ----------
  var chimeOn = false, chimeUntil = 0, chimeVideo = null, chimeStarted = 0, chimeDone = "";
  function startChime(d) {
    chimeOn = true; chimeStarted = now(); chimeUntil = chimeStarted + 15000;
    chimeDone = d.getHours() + ":" + d.getMinutes();
    var el = $("chime");
    el.innerHTML = '<div class="clock"><div class="box"><div class="tm"></div><div class="dt"></div></div></div>';
    tickClock(el.firstChild, true);
    el.className = "on";
    chimeVideo = current ? layers[front].getElementsByTagName("video")[0] || null : null;
    if (chimeVideo) { try { chimeVideo.pause(); } catch (e) {} }
  }
  function endChime() {
    if (!chimeOn) return;
    chimeOn = false;
    $("chime").className = ""; $("chime").innerHTML = "";
    if (current) current.startedAt += now() - chimeStarted;   // the item gets its remaining time back
    if (chimeVideo) { try { chimeVideo.play(); } catch (e) {} chimeVideo = null; }
  }
  function maybeChime(d, t) {
    if (chimeOn) { if (t >= chimeUntil) endChime(); else tickClock($("chime").firstChild, false); return; }
    if (!S.chime || access !== "registered" || nightOn || paused) return;
    var m = d.getMinutes();
    if ((m !== 0 && m !== 30) || d.getSeconds() > 5) return;
    if (chimeDone === d.getHours() + ":" + m) return;
    if (t - lastKey < S.idleMinutes * 60000) { chimeDone = d.getHours() + ":" + m; return; }  // someone is using the remote
    if (current && current.p.c.type === "clock") { chimeDone = d.getHours() + ":" + m; return; }
    startChime(d);
  }

  // ---------- main loop ----------
  function tick() {
    var t = now(), d = new Date();
    if (access === "registered") setNight(inNight(d) && t > nightOverrideUntil);
    if (nightOn) { endChime(); if (d.getSeconds() === 0) moveNightClock(); return; }
    maybeChime(d, t);
    if (chimeOn) return;
    if (paused && t - lastKey > S.idleMinutes * 60000) setPaused(false);
    if (current && !paused) {
      if (t - current.startedAt >= current.dur) advance(1);
      else if (!eligible(current.p.c, d)) advance(1);
    }
    if (current && current.p.c.type === "clock") tickClock(layers[front].querySelector(".clock"), false);
    var ic = $("idleClock"); if (ic) ic.textContent = hhmm(d);
    if (d.getSeconds() === 0 && d.getMinutes() % 2 === 0) { try { moveCard(); moveCard2(); } catch (e) {} }
    if ($("idle").className === "on" && d.getSeconds() % 15 === 0 && eligibleList().length) advance(1, true);
    if ($("info").className === "on" && d.getSeconds() % 2 === 0) renderInfo();
  }

  // ---------- remote player updates ----------
  var updateTo = null;
  function checkUpdate() {
    xhrJSON(bust(MANIFEST_URL), 10000, function (m) { if (m && m.version && m.version !== VERSION) updateTo = m.version; }, function () {});
  }

  // ---------- start ----------
  function start() {
    window.RS_ALIVE = true;
    layers = [$("layerA"), $("layerB")];
    placeStage();
    registerKeys();
    if (!sjcl) { document.body.innerHTML = "<p style='color:#fff;font-size:40px;padding:80px'>Screen Hub couldn't load its decryption library.</p>"; return; }
    resolveId(function () {
      checkConfig();
      var lastCfg = now(), lastUpd = now();
      setInterval(function () {
        tick();
        var t = now();
        if (t - lastCfg >= S.checkMinutes * 60000) { lastCfg = t; checkConfig(); }
        if (t - lastUpd >= S.checkMinutes * 60000) { lastUpd = t; checkUpdate(); }
        if (updateTo && t - lastKey >= S.idleMinutes * 60000) window.location.reload();
      }, 1000);
      setInterval(drift, 60000);
    });
  }
  window.RS_PLAYER = {
    version: VERSION, changelog: CHANGELOG,
    state: function () { return { screenId: screenId, fileId: fileId, access: access, playing: current && current.p.id, paused: paused, night: nightOn, items: playlist.length, lastError: lastError, subtle: subtleOk }; }
  };
  start();
})();
