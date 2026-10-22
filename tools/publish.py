#!/usr/bin/env python3
"""Screen Hub publisher.

Turns an export of the Screen Hub console (screens, content, settings) into the encrypted
files the TVs read: s/<fileId>.json per paired screen and m/<name>.bin per media file.
See docs/FORMAT.md. Needs: pip install cryptography pillow

  publish.py plan  EXPORT.json               -> prints {"needAssets": [assetId, ...]}
  publish.py write EXPORT.json --assets DIR  -> writes s/ and m/, prints a JSON summary

The master secret comes from the SCREEN_HUB_SECRET environment variable (never the repo).
"""
import base64, hashlib, hmac, io, json, os, re, sys, datetime

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
S_DIR, M_DIR = os.path.join(ROOT, "s"), os.path.join(ROOT, "m")
CHUNK = 1024 * 1024
ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TYPES = {"image", "video", "youtube", "web", "app", "message", "clock"}
SETTING_KEYS = {"defaultSeconds": (3, 7200), "nightStart": (0, 23), "nightEnd": (0, 23), "checkMinutes": (1, 60), "idleMinutes": (1, 60)}
MAX_MEDIA = 60 * 1024 * 1024


def b64(b): return base64.b64encode(b).decode()
def sha(s): return hashlib.sha256(s.encode()).digest()
def mac(secret, s): return hmac.new(secret, s.encode(), hashlib.sha256).digest()


def norm_code(c):
    c = re.sub(r"[^A-Za-z0-9]", "", str(c or "")).upper()
    return c if re.fullmatch("[%s]{16}" % ALPHA, c) else None


def norm_id(i):
    i = str(i or "").strip().upper()
    return i if re.fullmatch(r"[A-Z0-9_\-]{4,40}", i) else None


def clean_settings(s):
    out = {}
    for k, (lo, hi) in SETTING_KEYS.items():
        v = (s or {}).get(k)
        if v is None or v == "":
            continue
        try:
            out[k] = max(lo, min(hi, int(round(float(v)))))
        except (TypeError, ValueError):
            pass
    nm = (s or {}).get("nightMode")
    if nm in ("clock", "black", "off"):
        out["nightMode"] = nm
    if isinstance((s or {}).get("muted"), bool):
        out["muted"] = s["muted"]
    if isinstance((s or {}).get("chime"), bool):
        out["chime"] = s["chime"]
    if (s or {}).get("fit") in ("contain", "cover"):
        out["fit"] = s["fit"]
    return out


def clean_schedule(sc):
    sc = sc or {}
    out = {}
    days = [d for d in (sc.get("days") or []) if isinstance(d, int) and 0 <= d <= 6]
    if days and len(days) < 7:
        out["days"] = sorted(set(days))
    for k in ("start", "end"):
        v = str(sc.get(k) or "")
        if re.fullmatch(r"\d{1,2}:\d{2}", v):
            out[k] = v
    for k in ("from", "until"):
        v = sc.get(k)
        if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}T", v):
            out[k] = v
    return out


def http_url(u):
    u = str(u or "").strip()
    return u if re.match(r"^https?://[^\s\"'<>]+$", u, re.I) else None


def clean_content(c):
    """Only known fields of known types reach the TVs."""
    t = c.get("type")
    if t not in TYPES:
        return None, "unknown type"
    o = {"type": t, "name": str(c.get("name") or "")[:120]}
    if c.get("seconds") not in (None, ""):
        try:
            o["seconds"] = max(3, min(7200, int(c["seconds"])))
        except (TypeError, ValueError):
            pass
    sc = clean_schedule(c.get("schedule"))
    if sc:
        o["schedule"] = sc
    if t in ("image", "video"):
        if c.get("assetId"):
            if not re.fullmatch(r"[A-Za-z0-9_\-]{6,80}", str(c["assetId"])):
                return None, "bad asset id"
        elif not http_url(c.get("url")):
            return None, "no file or link"
        else:
            o["url"] = http_url(c.get("url"))
        if t == "image":
            if c.get("fit") in ("contain", "cover"):
                o["fit"] = c["fit"]
            if c.get("caption"):
                o["caption"] = str(c["caption"])[:140]
        else:
            o["untilEnd"] = c.get("untilEnd") is not False
            if isinstance(c.get("muted"), bool):
                o["muted"] = c["muted"]
            if c.get("loop"):
                o["loop"] = True
    elif t == "youtube":
        v = re.sub(r"[^A-Za-z0-9_\-]", "", str(c.get("videoId") or ""))[:11]
        if len(v) != 11:
            return None, "bad YouTube id"
        o["videoId"] = v
        o["untilEnd"] = c.get("untilEnd") is not False
        if isinstance(c.get("muted"), bool):
            o["muted"] = c["muted"]
        try:
            if c.get("start"):
                o["start"] = max(0, min(86400, int(c["start"])))
        except (TypeError, ValueError):
            pass
    elif t == "web":
        u = http_url(c.get("url"))
        if not u:
            return None, "bad link"
        o["url"] = u
        try:
            o["zoom"] = max(25, min(300, int(c.get("zoom") or 100)))
        except (TypeError, ValueError):
            o["zoom"] = 100
    elif t == "app":
        a = re.sub(r"[^a-z0-9_\-]", "", str(c.get("app") or "").lower())
        if not a or not os.path.isfile(os.path.join(ROOT, "apps", a, "index.html")):
            return None, "unknown app"
        o["app"] = a
        opts = c.get("options") or {}
        o["options"] = {k: v for k, v in opts.items() if re.fullmatch(r"[A-Za-z0-9_]{1,30}", str(k)) and isinstance(v, (str, int, float, bool))}
    elif t == "message":
        o["title"] = str(c.get("title") or "")[:160]
        o["body"] = str(c.get("body") or "")[:900]
        o["kicker"] = str(c.get("kicker") or "")[:60]
        o["theme"] = c.get("theme") if c.get("theme") in ("gradient", "dark", "light", "alert") else "gradient"
    elif t == "clock":
        o["label"] = str(c.get("label") or "")[:80]
    return o, None


def media_names(secret, asset_id):
    name = mac(secret, "rs1|name|" + asset_id).hex()[:32]
    return "m/%s.bin" % name, mac(secret, "rs1|mkey|" + asset_id), mac(secret, "rs1|iv|" + asset_id)[:8]


def prepare_media(kind, raw):
    """Images are resized for the TV and saved as JPEG. Videos are kept as they are."""
    if kind == "image":
        from PIL import Image, ImageOps
        im = Image.open(io.BytesIO(raw))
        im = ImageOps.exif_transpose(im)
        im.thumbnail((1920, 1080))
        if im.mode != "RGB":
            bg = Image.new("RGB", im.size, (0, 0, 0))
            bg.paste(im, mask=im.convert("RGBA").split()[-1] if "A" in im.getbands() else None)
            im = bg
        out = io.BytesIO()
        im.save(out, "JPEG", quality=85, optimize=True)
        return out.getvalue(), "image/jpeg"
    if raw[4:8] == b"ftyp":
        return raw, "video/mp4"
    if raw[:4] == b"\x1a\x45\xdf\xa3":
        return raw, "video/webm"
    return raw, "video/mp4"


def encrypt_media(key, iv8, data):
    a, out = AESGCM(key), bytearray()
    for i in range(0, max(1, len(data)), CHUNK):
        iv = iv8 + (i // CHUNK).to_bytes(4, "big")
        out += a.encrypt(iv, data[i:i + CHUNK], None)
    return bytes(out)


def load_export(path):
    with open(path) as f:
        e = json.load(f)
    return e


def media_items(export):
    out = {}
    for c in export.get("content") or []:
        if c.get("type") in ("image", "video") and c.get("assetId") and c.get("enabled") is not False:
            out[c["assetId"]] = c["type"]
    return out


def plan(export, secret):
    used = set()
    content = {c.get("id"): c for c in export.get("content") or []}
    for s in export.get("screens") or []:
        if s.get("enabled") is False or not norm_code(s.get("code")):
            continue
        for p in s.get("playlist") or []:
            c = content.get(p.get("content") if isinstance(p, dict) else p)
            if c and c.get("enabled") is not False and c.get("type") in ("image", "video") and c.get("assetId"):
                used.add(c["assetId"])
    need = [a for a in sorted(used) if not os.path.isfile(os.path.join(ROOT, media_names(secret, a)[0]))]
    return {"needAssets": need, "usedAssets": sorted(used)}


def write(export, secret, assets_dir):
    os.makedirs(S_DIR, exist_ok=True)
    os.makedirs(M_DIR, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    summary = {"screens": [], "skipped": [], "mediaAdded": [], "mediaRemoved": [], "contentErrors": {}, "liveContent": [], "changed": False}
    defaults = clean_settings(export.get("defaults"))
    ytp = http_url(export.get("youtubePage")) or ""

    cleaned, meta = {}, {}
    for c in export.get("content") or []:
        cid = str(c.get("id") or "")
        if not re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", cid) or c.get("enabled") is False:
            continue
        o, err = clean_content(c)
        if err:
            summary["contentErrors"][cid] = err
            continue
        cleaned[cid] = o
        meta[cid] = c

    media_info = {}
    def media_for(cid):
        c = meta[cid]
        aid = c.get("assetId")
        if not aid:
            return True
        if aid in media_info:
            return media_info[aid] is not None
        rel, key, iv8 = media_names(secret, aid)
        dest = os.path.join(ROOT, rel)
        if not os.path.isfile(dest):
            src = os.path.join(assets_dir or "", aid)
            if not assets_dir or not os.path.isfile(src):
                summary["contentErrors"][cid] = "file not downloaded"
                media_info[aid] = None
                return False
            raw = open(src, "rb").read()
            try:
                data, mime = prepare_media(c["type"], raw)
            except Exception as ex:  # unreadable image
                summary["contentErrors"][cid] = "couldn't read file (%s)" % type(ex).__name__
                media_info[aid] = None
                return False
            if len(data) > MAX_MEDIA:
                summary["contentErrors"][cid] = "file too large for the TV"
                media_info[aid] = None
                return False
            with open(dest, "wb") as f:
                f.write(encrypt_media(key, iv8, data))
            summary["mediaAdded"].append(aid)
            summary["changed"] = True
            size = len(data)
        else:
            size = os.path.getsize(dest) - 16 * ((os.path.getsize(dest) + CHUNK + 15) // (CHUNK + 16))
            mime = "image/jpeg" if c["type"] == "image" else (c.get("mime") if c.get("mime") in ("video/mp4", "video/webm") else "video/mp4")
        media_info[aid] = {"file": rel, "mkey": b64(key), "iv8": b64(iv8), "chunk": CHUNK, "size": size, "mime": mime}
        return True

    keep_s, keep_m = set(), set()
    seen_ids = set()
    for s in export.get("screens") or []:
        sid, code = norm_id(s.get("id")), norm_code(s.get("code"))
        if not sid or not code:
            summary["skipped"].append({"id": s.get("id"), "why": "bad screen ID or pairing code"})
            continue
        if sid in seen_ids:
            continue
        seen_ids.add(sid)
        file_id = sha("rs1|file|%s|%s" % (sid, code)).hex()[:32]
        key = sha("rs1|key|%s|%s" % (sid, code))
        scr = {"name": str(s.get("name") or "")[:80], "enabled": s.get("enabled") is not False}
        content = {}
        if scr["enabled"]:
            scr["settings"] = clean_settings(s.get("settings"))
            pl = []
            for p in s.get("playlist") or []:
                cid = p.get("content") if isinstance(p, dict) else p
                if cid not in cleaned or not media_for(cid):
                    continue
                item = {"content": cid}
                try:
                    if isinstance(p, dict) and p.get("seconds") not in (None, ""):
                        item["seconds"] = max(3, min(7200, int(p["seconds"])))
                except (TypeError, ValueError):
                    pass
                pl.append(item)
                c = dict(cleaned[cid])
                if meta[cid].get("assetId"):
                    c.update(media_info[meta[cid]["assetId"]])
                    keep_m.add(media_info[meta[cid]["assetId"]]["file"])
                content[cid] = c
            scr["playlist"] = pl
            cmd = s.get("command") or {}
            if cmd.get("id") and cmd.get("action") in ("reload", "identify", "next", "show"):
                scr["command"] = {"id": str(cmd["id"])[:40], "action": cmd["action"], "at": str(cmd.get("at") or "")[:40]}
                if cmd["action"] == "show" and cmd.get("content") in content:
                    scr["command"]["content"] = cmd["content"]
        body = {"v": 1, "screen": scr, "content": content, "defaults": defaults, "youtubePage": ytp}
        canon = json.dumps(body, sort_keys=True, separators=(",", ":"))
        h = mac(secret, "rs1|h|%s|%s" % (file_id, canon)).hex()[:32]
        path = os.path.join(S_DIR, file_id + ".json")
        keep_s.add(path)
        old_h = None
        if os.path.isfile(path):
            try:
                old_h = json.load(open(path)).get("h")
            except Exception:
                old_h = None
        if old_h != h:
            body["updatedAt"] = now
            pt = json.dumps(body, separators=(",", ":")).encode()
            iv = os.urandom(12)
            ct = AESGCM(key).encrypt(iv, pt, sha("rs1|aad|" + file_id)[:16])
            with open(path, "w") as f:
                json.dump({"v": 1, "h": h, "iv": b64(iv), "ct": b64(ct)}, f, separators=(",", ":"))
            summary["changed"] = True
        summary["screens"].append({"id": sid, "enabled": scr["enabled"], "items": len(scr.get("playlist") or []), "updated": old_h != h})
        summary["liveContent"].extend(k for k in content if k not in summary["liveContent"])

    for fn in os.listdir(S_DIR):
        p = os.path.join(S_DIR, fn)
        if fn.endswith(".json") and p not in keep_s:
            os.remove(p)
            summary["changed"] = True
    for fn in os.listdir(M_DIR):
        rel = "m/" + fn
        if fn.endswith(".bin") and rel not in keep_m:
            os.remove(os.path.join(M_DIR, fn))
            summary["mediaRemoved"].append(fn)
            summary["changed"] = True
    return summary


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("plan", "write"):
        print(__doc__)
        sys.exit(2)
    secret_hex = os.environ.get("SCREEN_HUB_SECRET", "")
    if not re.fullmatch(r"[0-9a-f]{64}", secret_hex):
        print(json.dumps({"error": "SCREEN_HUB_SECRET must be 64 hex characters"}))
        sys.exit(3)
    secret = bytes.fromhex(secret_hex)
    export = load_export(sys.argv[2])
    if sys.argv[1] == "plan":
        print(json.dumps(plan(export, secret)))
    else:
        assets = None
        if "--assets" in sys.argv:
            assets = sys.argv[sys.argv.index("--assets") + 1]
        print(json.dumps(write(export, secret, assets)))


if __name__ == "__main__":
    main()
