#!/usr/bin/env python3
"""Copy the console's outbox into s/ and m/.

The Screen Hub console encrypts everything in the browser when you press Publish now and
leaves the finished files in its database ("outbox" collection) and asset store. This script
only copies them into the repo: it never sees the master secret or any pairing code.

  apply_outbox.py plan  OUTBOX_DIR                -> {"needAssets": [encrypted asset id, ...]}
  apply_outbox.py write OUTBOX_DIR --assets DIR   -> writes s/ and m/, prints a JSON summary

OUTBOX_DIR is an ArtifactData out_dir dump of the "outbox" collection (OUTBOX_DIR/outbox/*.json).
DIR holds the encrypted media downloaded from the asset store, one file per asset id.
"""
import base64, json, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
S_DIR, M_DIR = os.path.join(ROOT, "s"), os.path.join(ROOT, "m")
HEADER = b"SHUBENC1"
HEX32 = re.compile(r"^[0-9a-f]{32}$")
ASSET = re.compile(r"^[A-Za-z0-9_\-]{6,80}$")
B64 = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
MAX_FILE = 200 * 1024
MAX_MEDIA = 64 * 1024 * 1024


def fail(msg):
    print(json.dumps({"error": msg}))
    sys.exit(3)


def load(outbox):
    d = os.path.join(outbox, "outbox")
    try:
        man = json.load(open(os.path.join(d, "manifest.json")))
    except Exception:
        fail("outbox has no manifest: press Publish now on the console first")
    files, media = {}, {}
    for fid in man.get("files") or []:
        if not isinstance(fid, str) or not HEX32.match(fid):
            fail("bad screen file id in manifest")
        try:
            doc = json.load(open(os.path.join(d, "s-%s.json" % fid)))
        except Exception:
            fail("outbox is missing a screen file")
        text = doc.get("file")
        if not isinstance(text, str) or len(text) > MAX_FILE:
            fail("bad screen file in outbox")
        try:
            body = json.loads(text)
        except ValueError:
            fail("screen file is not JSON")
        if (not isinstance(body, dict) or set(body) != {"v", "h", "iv", "ct"} or body["v"] != 1
                or not isinstance(body["h"], str) or not HEX32.match(body["h"])
                or not all(isinstance(body[k], str) and B64.match(body[k]) for k in ("iv", "ct"))):
            fail("screen file in outbox is not an encrypted Screen Hub file")
        files[fid] = json.dumps(body, separators=(",", ":"))
    for m in man.get("media") or []:
        name, enc = m.get("name"), m.get("enc")
        if not isinstance(name, str) or not HEX32.match(name) or not isinstance(enc, str) or not ASSET.match(enc):
            fail("bad media entry in manifest")
        media[name] = enc
    return man, files, media


def plan(outbox):
    _, _, media = load(outbox)
    need = sorted({enc for name, enc in media.items() if not os.path.isfile(os.path.join(M_DIR, name + ".bin"))})
    return {"needAssets": need}


def write(outbox, assets):
    man, files, media = load(outbox)
    os.makedirs(S_DIR, exist_ok=True)
    os.makedirs(M_DIR, exist_ok=True)
    out = {"changed": False, "screensWritten": 0, "screensRemoved": 0, "mediaAdded": 0, "mediaRemoved": 0,
           "missingMedia": [], "builtAt": man.get("builtAt")}
    for fid, text in files.items():
        p = os.path.join(S_DIR, fid + ".json")
        old = open(p).read() if os.path.isfile(p) else None
        if old != text:
            with open(p, "w") as f:
                f.write(text)
            out["screensWritten"] += 1
            out["changed"] = True
    for name, enc in media.items():
        p = os.path.join(M_DIR, name + ".bin")
        if os.path.isfile(p):
            continue
        src = os.path.join(assets or "", enc)
        if not assets or not os.path.isfile(src):
            out["missingMedia"].append(name)
            continue
        raw = open(src, "rb").read()
        if not raw.startswith(HEADER) or len(raw) <= len(HEADER) + 16 or len(raw) > MAX_MEDIA:
            out["missingMedia"].append(name)
            continue
        with open(p, "wb") as f:
            f.write(raw[len(HEADER):])
        out["mediaAdded"] += 1
        out["changed"] = True
    for fn in os.listdir(S_DIR):
        if fn.endswith(".json") and fn[:-5] not in files:
            os.remove(os.path.join(S_DIR, fn))
            out["screensRemoved"] += 1
            out["changed"] = True
    for fn in os.listdir(M_DIR):
        if fn.endswith(".bin") and fn[:-4] not in media:
            os.remove(os.path.join(M_DIR, fn))
            out["mediaRemoved"] += 1
            out["changed"] = True
    return out


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("plan", "write"):
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == "plan":
        print(json.dumps(plan(sys.argv[2])))
    else:
        assets = sys.argv[sys.argv.index("--assets") + 1] if "--assets" in sys.argv else None
        print(json.dumps(write(sys.argv[2], assets)))


if __name__ == "__main__":
    main()
