#!/usr/bin/env python3
"""Screen Hub TV Remote — control Samsung TVs on the home network from the PC.

No extra packages: standard-library Python 3.8+ only (Windows, macOS or Linux).

    python tvremote.py find                 find Samsung TVs on the network and save them
    python tvremote.py ui                   open the control page (http://127.0.0.1:8765)
    python tvremote.py status               power state of every saved TV
    python tvremote.py on | off             power (on = Wake-on-LAN)
    python tvremote.py open                 start Screen Hub on the TV
    python tvremote.py next | prev | pause | identify | info | back | home
    python tvremote.py vol up 3 | vol down | mute
    python tvremote.py say "Dinner's ready" --body "Come down please" --seconds 90 --theme alert
    python tvremote.py clock --seconds 60
    python tvremote.py youtube dQw4w9WgXcQ --seconds 300   (inside Screen Hub)
    python tvremote.py youtube dQw4w9WgXcQ --app             (the TV's own YouTube app)
    python tvremote.py web https://example.com --seconds 120 --zoom 80
    python tvremote.py resume               end a live item and carry on with the playlist
    python tvremote.py reload               reload the Screen Hub player
    python tvremote.py apps                 list apps installed on the TV
    python tvremote.py key KEY_VOLUP KEY_VOLUP   send raw remote keys

Add --tv NAME (or --tv all) to pick a screen; otherwise the default TV is used.

Saved TVs and their connection tokens live in ~/.screenhub/tvremote.json (never in the repo).
The first connection from this PC shows an Allow prompt on the TV: press Allow with the remote.
"""
import argparse, base64, json, os, socket, ssl, struct, sys, threading, time, uuid
import urllib.request, urllib.error, ipaddress, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.0"
APP_ID = "RScreenHub.ScreenHub"           # loader/config.xml tizen:application id
YOUTUBE_APP = "111299001912"
REMOTE_NAME = "Screen Hub Remote"
HERE = os.path.dirname(os.path.abspath(__file__))
CONF_PATH = os.path.join(os.path.expanduser("~"), ".screenhub", "tvremote.json")

SHORTCUTS = {  # player.js key handling: ◀ ▶ previous/next, OK pause, INFO panel, RED identify
    "next": ["KEY_RIGHT"], "prev": ["KEY_LEFT"], "pause": ["KEY_ENTER"], "info": ["KEY_INFO"],
    "identify": ["KEY_RED"], "back": ["KEY_RETURN"], "home": ["KEY_HOME"], "mute": ["KEY_MUTE"],
    "up": ["KEY_UP"], "down": ["KEY_DOWN"], "left": ["KEY_LEFT"], "right": ["KEY_RIGHT"], "ok": ["KEY_ENTER"],
}


class TVError(Exception):
    pass


# ---------------------------------------------------------------- config
def load_conf():
    try:
        with open(CONF_PATH, encoding="utf-8") as f:
            c = json.load(f)
    except (OSError, ValueError):
        c = {}
    c.setdefault("tvs", {})
    return c


def save_conf(c):
    os.makedirs(os.path.dirname(CONF_PATH), exist_ok=True)
    tmp = CONF_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(c, f, indent=2)
    os.replace(tmp, CONF_PATH)


CONF_LOCK = threading.Lock()


def pick(conf, name):
    tvs = conf["tvs"]
    if not tvs:
        raise TVError("No TVs saved yet. Run: python tvremote.py find   (or: add NAME IP)")
    if name == "all":
        return list(tvs.keys())
    if name:
        if name not in tvs:
            raise TVError("No saved TV called %r. Saved: %s" % (name, ", ".join(tvs)))
        return [name]
    d = conf.get("default")
    return [d if d in tvs else next(iter(tvs))]


# ---------------------------------------------------------------- tiny WebSocket client
class WS:
    def __init__(self, host, port, path, secure, timeout=6):
        s = socket.create_connection((host, port), timeout=timeout)
        if secure:  # the TV uses a self-signed certificate; this only ever talks to the TV's own LAN address
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            s = ctx.wrap_socket(s, server_hostname=host)
        self.s = s
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n") % (path, host, port, key)
        s.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = s.recv(1024)
            if not chunk:
                raise TVError("TV closed the connection")
            head += chunk
        line = head.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101 " not in line + " ":
            raise TVError("TV refused the connection (%s)" % line)
        self.buf = head.split(b"\r\n\r\n", 1)[1]

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise TVError("TV closed the connection")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _frame(self, op, data):
        hdr = bytes([0x80 | op])
        n = len(data)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send(self, obj):
        self._frame(1, json.dumps(obj).encode())

    def recv(self, timeout):
        self.s.settimeout(timeout)
        while True:
            b1, b2 = self._read(2)
            op, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b2 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 8:
                raise TVError("TV closed the connection")
            if op == 9:
                self._frame(10, data)
                continue
            if op in (1, 2):
                try:
                    return json.loads(data.decode("utf-8", "replace"))
                except ValueError:
                    continue

    def close(self):
        try:
            self._frame(8, b"")
        except OSError:
            pass
        try:
            self.s.close()
        except OSError:
            pass


# ---------------------------------------------------------------- Samsung TV
def http_json(url, timeout=2.5, method="GET"):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
    return json.loads(body) if body.strip().startswith(("{", "[")) else {}


def device_info(ip, timeout=2.5):
    """Samsung TVs from 2016 answer GET http://<ip>:8001/api/v2/ while they're on."""
    j = http_json("http://%s:8001/api/v2/" % ip, timeout)
    d = j.get("device") or {}
    return {
        "name": d.get("name") or j.get("name") or "Samsung TV",
        "model": d.get("modelName") or d.get("model") or j.get("type") or "",
        "mac": d.get("wifiMac") or "",
        "network": d.get("networkType") or "",
        "power": (d.get("PowerState") or "on").lower(),   # 2018+ report standby; 2016 models just stop answering
        "os": d.get("OS") or "",
        "tokenAuth": str(d.get("TokenAuthSupport", "")).lower() == "true",
        "id": d.get("duid") or j.get("id") or "",
    }


class Samsung:
    def __init__(self, name, tv, conf):
        self.name, self.tv, self.conf = name, tv, conf
        self.ws = None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        if self.ws:
            self.ws.close()

    def connect(self, first_timeout=30):
        """Port 8002 (secure, token) on newer TVs, 8001 on 2016-17 models. The TV asks once to Allow this PC."""
        ip = self.tv["ip"]
        name = base64.b64encode(REMOTE_NAME.encode()).decode()
        tries = [(8002, True), (8001, False)]
        if self.tv.get("port") == 8001:
            tries.reverse()
        last = None
        for port, secure in tries:
            path = "/api/v2/channels/samsung.remote.control?name=" + name
            if secure and self.tv.get("token"):
                path += "&token=" + self.tv["token"]
            try:
                ws = WS(ip, port, path, secure)
            except (OSError, TVError) as e:
                last = e
                continue
            try:
                wait = 6 if (self.tv.get("token") or self.tv.get("allowed")) else first_timeout
                end = time.time() + wait
                while True:
                    left = end - time.time()
                    if left <= 0:
                        raise TVError("No answer from the TV. If it shows an Allow prompt, press Allow and try again.")
                    msg = ws.recv(left)
                    ev = msg.get("event")
                    if ev == "ms.channel.connect":
                        tok = (msg.get("data") or {}).get("token")
                        changed = False
                        with CONF_LOCK:
                            if tok and tok != self.tv.get("token"):
                                self.tv["token"] = tok
                                changed = True
                            if self.tv.get("port") != port or not self.tv.get("allowed"):
                                self.tv["port"], self.tv["allowed"] = port, True
                                changed = True
                            if changed:
                                self.conf["tvs"][self.name] = self.tv
                                save_conf(self.conf)
                        self.ws = ws
                        return self
                    if ev == "ms.channel.unauthorized":
                        raise TVError("The TV said no. On the TV open Settings > General > External Device Manager > "
                                      "Device Connection Manager, allow '%s', then try again." % REMOTE_NAME)
                    if ev == "ms.channel.timeOut":
                        raise TVError("The Allow prompt on the TV timed out. Try again and press Allow.")
            except socket.timeout:
                ws.close()
                last = TVError("No answer from the TV. If it shows an Allow prompt, press Allow and try again.")
            except (OSError, TVError) as e:
                ws.close()
                last = e
                if isinstance(e, TVError) and "said no" in str(e):
                    break
        raise TVError("Couldn't connect to %s (%s): %s" % (self.name, ip, last))

    def keys(self, keys, gap=0.35):
        if not self.ws:
            self.connect()
        for i, k in enumerate(keys):
            self.ws.send({"method": "ms.remote.control", "params": {
                "Cmd": "Click", "DataOfCmd": k, "Option": "false", "TypeOfRemote": "SendRemoteKey"}})
            if i < len(keys) - 1:
                time.sleep(gap)
        time.sleep(0.15)

    def emit(self, event, data):
        if not self.ws:
            self.connect()
        self.ws.send({"method": "ms.channel.emit", "params": {"event": event, "to": "host", "data": data}})

    def apps(self):
        self.emit("ed.installedApp.get", "")
        end = time.time() + 8
        while time.time() < end:
            try:
                msg = self.ws.recv(end - time.time())
            except socket.timeout:
                break
            if msg.get("event") == "ed.installedApp.get":
                lst = (msg.get("data") or {}).get("data") or []
                return sorted(({"id": a.get("appId"), "name": a.get("name")} for a in lst), key=lambda a: (a["name"] or "").lower())
        raise TVError("The TV didn't send its app list")

    def launch(self, app_id, meta=None, kind="DEEP_LINK"):
        data = {"appId": app_id, "action_type": kind}
        if meta is not None:
            data["metaTag"] = meta
        self.emit("ed.apps.launch", data)
        time.sleep(0.3)

    def launch_rest(self, app_id):
        try:
            http_json("http://%s:8001/api/v2/applications/%s" % (self.tv["ip"], app_id), 4, "POST")
            return True
        except (OSError, ValueError, urllib.error.URLError):
            return False


# ---------------------------------------------------------------- Wake-on-LAN
def wake(mac, ip=None):
    hexmac = "".join(c for c in mac if c.isalnum())
    if len(hexmac) != 12:
        raise TVError("No MAC address saved for this TV (needed to switch it on). "
                      "Run 'status' while the TV is on, or: python tvremote.py add NAME IP --mac AA:BB:CC:DD:EE:FF")
    pkt = b"\xff" * 6 + bytes.fromhex(hexmac) * 16
    targets = {"255.255.255.255"}
    if ip:
        try:
            targets.add(str(ipaddress.ip_network(ip + "/24", strict=False).broadcast_address))
        except ValueError:
            pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    for _ in range(3):
        for t in targets:
            for port in (9, 7):
                try:
                    s.sendto(pkt, (t, port))
                except OSError:
                    pass
        time.sleep(0.2)
    s.close()


# ---------------------------------------------------------------- discovery
def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ssdp(timeout=3):
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n"
           "ST: urn:samsung.com:device:RemoteControlReceiver:1\r\n\r\n").encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.settimeout(0.5)
    found = set()
    try:
        s.sendto(msg, ("239.255.255.250", 1900))
        end = time.time() + timeout
        while time.time() < end:
            try:
                _, addr = s.recvfrom(4096)
                found.add(addr[0])
            except socket.timeout:
                pass
    except OSError:
        pass
    finally:
        s.close()
    return found


def scan_subnet():
    net = ipaddress.ip_network(local_ip() + "/24", strict=False)
    hits, lock = set(), threading.Lock()

    def probe(ip):
        try:
            c = socket.create_connection((str(ip), 8001), timeout=0.6)
            c.close()
            with lock:
                hits.add(str(ip))
        except OSError:
            pass
    ts = [threading.Thread(target=probe, args=(h,), daemon=True) for h in net.hosts()]
    for i in range(0, len(ts), 64):
        for t in ts[i:i + 64]:
            t.start()
        for t in ts[i:i + 64]:
            t.join()
    return hits


def slug(s):
    out = "".join(c.lower() if c.isalnum() else "-" for c in s).strip("-")
    while "--" in out:
        out = out.replace("--", "-")
    return out or "tv"


def find(conf, log=print):
    log("Looking for Samsung TVs (they need to be switched on)…")
    ips = ssdp() | scan_subnet()
    known = {t["ip"]: n for n, t in conf["tvs"].items()}
    out = []
    for ip in sorted(ips, key=lambda x: tuple(int(p) for p in x.split("."))):
        try:
            info = device_info(ip)
        except Exception:
            continue
        name = known.get(ip) or slug(info["name"])
        base, i = name, 2
        while name in conf["tvs"] and conf["tvs"][name]["ip"] != ip:
            name, i = "%s-%d" % (base, i), i + 1
        tv = conf["tvs"].get(name, {})
        tv.update({"ip": ip, "label": tv.get("label") or info["name"], "model": info["model"]})
        if info["mac"] and not tv.get("macManual"):
            tv["mac"] = info["mac"]
        conf["tvs"][name] = tv
        out.append((name, tv))
        log("  %-16s %-15s %s %s" % (name, ip, info["name"], info["model"]))
    if out and conf.get("default") not in conf["tvs"]:
        conf["default"] = out[0][0]
    save_conf(conf)
    if not out:
        log("None found. Check the TV is on and on the same network, or add it by IP: python tvremote.py add NAME IP")
    return out


# ---------------------------------------------------------------- actions
def live_payload(action, **kw):
    p = {"rs": 1, "id": uuid.uuid4().hex[:12], "action": action, "at": int(time.time())}
    p.update({k: v for k, v in kw.items() if v is not None})
    return json.dumps(p, separators=(",", ":"))


def tv_status(name, tv):
    try:
        info = device_info(tv["ip"], 1.5)
        return {"name": name, "label": tv.get("label") or name, "ip": tv["ip"], "state": "standby" if info["power"] == "standby" else "on",
                "model": info["model"] or tv.get("model", ""), "mac": tv.get("mac", "") or info["mac"]}
    except Exception:
        return {"name": name, "label": tv.get("label") or name, "ip": tv["ip"], "state": "off",
                "model": tv.get("model", ""), "mac": tv.get("mac", "")}


def run(conf, name, action, a):
    """One action on one TV. Returns a short message. a: dict of options."""
    tv = conf["tvs"][name]
    label = tv.get("label") or name
    if action == "on":
        wake(tv.get("mac", ""), tv["ip"])
        if a.get("open"):
            for _ in range(20):
                time.sleep(1.5)
                if tv_status(name, tv)["state"] == "on":
                    time.sleep(4)
                    return run(conf, name, "open", a)
            return "%s: wake signal sent, but it hasn't come online yet" % label
        return "%s: wake signal sent" % label
    if action == "status":
        st = tv_status(name, tv)
        if st["mac"] and not tv.get("mac"):
            with CONF_LOCK:
                tv["mac"] = st["mac"]
                save_conf(conf)
        return "%s (%s): %s%s" % (label, tv["ip"], st["state"], " · " + st["model"] if st["model"] else "")
    if action == "off":
        st = tv_status(name, tv)
        if st["state"] != "on":
            return "%s is already off" % label
        with Samsung(name, tv, conf) as t:
            t.keys(["KEY_POWER"])
        return "%s: switching off" % label

    if tv_status(name, tv)["state"] != "on":
        raise TVError("%s is off or not on the network. Switch it on first (python tvremote.py on)." % label)
    with Samsung(name, tv, conf) as t:
        if action == "open":
            t.launch(APP_ID)
            return "%s: opening Screen Hub" % label
        if action in SHORTCUTS:
            t.keys(SHORTCUTS[action])
            return "%s: %s" % (label, action)
        if action == "key":
            t.keys(a["keys"])
            return "%s: sent %s" % (label, " ".join(a["keys"]))
        if action == "vol":
            n = max(1, min(int(a.get("steps") or 1), 20))
            t.keys(["KEY_VOLUP" if a.get("dir") == "up" else "KEY_VOLDOWN"] * n, gap=0.25)
            return "%s: volume %s %d" % (label, a.get("dir"), n)
        if action == "apps":
            lst = t.apps()
            return lst
        if action == "youtube-app":
            t.launch(YOUTUBE_APP, "v=" + a["video"])
            return "%s: playing in YouTube" % label
        # Screen Hub live actions: relaunch the app with a payload the player reads (player 1.5.0+)
        if action in ("say", "clock", "youtube", "web"):
            item = {"say": lambda: {"type": "message", "title": a.get("title", ""), "body": a.get("body") or "",
                                    "kicker": a.get("kicker") or "", "theme": a.get("theme") or "gradient"},
                    "clock": lambda: {"type": "clock", "label": a.get("label") or ""},
                    "youtube": lambda: {"type": "youtube", "videoId": a["video"], "muted": not a.get("sound"),
                                        "untilEnd": bool(a.get("untilEnd"))},
                    "web": lambda: {"type": "web", "url": a["url"], "zoom": int(a.get("zoom") or 100)}}[action]()
            t.launch(APP_ID, live_payload("live", item=item, seconds=int(a.get("seconds") or 60)))
            return "%s: showing %s for %ss" % (label, {"say": "message", "youtube": "YouTube"}.get(action, action), a.get("seconds") or 60)
        if action in ("resume", "reload"):
            t.launch(APP_ID, live_payload(action))
            return "%s: %s" % (label, "back to the playlist" if action == "resume" else "reloading Screen Hub")
    raise TVError("Unknown action %r" % action)


def run_many(conf, names, action, a):
    results = [None] * len(names)

    def one(i, n):
        try:
            results[i] = {"tv": n, "ok": True, "msg": run(conf, n, action, a)}
        except Exception as e:  # report per TV, keep going with the rest
            results[i] = {"tv": n, "ok": False, "msg": str(e)}
    ts = [threading.Thread(target=one, args=(i, n)) for i, n in enumerate(names)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return results


# ---------------------------------------------------------------- local control page
class UI(BaseHTTPRequestHandler):
    server_version = "ScreenHubRemote/" + VERSION
    conf = None
    port = 8765

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            self._json(403, {"error": "local only"})
            return False
        return True

    def do_GET(self):
        if not self._local_only():
            return
        if self.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "tvremote.html"), "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/api/tvs":
            c = UI.conf
            names = list(c["tvs"].keys())
            sts = [None] * len(names)

            def one(i, n):
                sts[i] = tv_status(n, c["tvs"][n])
            ts = [threading.Thread(target=one, args=(i, n)) for i, n in enumerate(names)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            self._json(200, {"tvs": sts, "default": c.get("default"), "version": VERSION, "checked": int(time.time())})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        # a web page elsewhere can't send this header without a CORS preflight, which we never answer
        if not self._local_only() or self.headers.get("X-Screen-Hub") != "1":
            self._json(403, {"error": "forbidden"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(min(n, 65536)) or b"{}")
        except ValueError:
            self._json(400, {"error": "bad request"})
            return
        c = UI.conf
        try:
            if self.path == "/api/find":
                lines = []
                find(c, lines.append)
                self._json(200, {"ok": True, "msg": "\n".join(lines)})
                return
            if self.path == "/api/add":
                add_tv(c, req.get("name") or "", req.get("ip") or "", req.get("mac") or "")
                self._json(200, {"ok": True, "msg": "Saved"})
                return
            if self.path == "/api/remove":
                with CONF_LOCK:
                    c["tvs"].pop(req.get("name"), None)
                    if c.get("default") not in c["tvs"]:
                        c["default"] = next(iter(c["tvs"]), None)
                    save_conf(c)
                self._json(200, {"ok": True, "msg": "Removed"})
                return
            if self.path == "/api/default":
                with CONF_LOCK:
                    if req.get("name") in c["tvs"]:
                        c["default"] = req["name"]
                        save_conf(c)
                self._json(200, {"ok": True})
                return
            if self.path == "/api/do":
                names = pick(c, req.get("tv"))
                res = run_many(c, names, req.get("action", ""), req.get("args") or {})
                self._json(200, {"results": res})
                return
        except TVError as e:
            self._json(200, {"results": [{"tv": "", "ok": False, "msg": str(e)}]})
            return
        self._json(404, {"error": "not found"})


def add_tv(conf, name, ip, mac=""):
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise TVError("%r isn't an IP address" % ip)
    name = slug(name or ip)
    with CONF_LOCK:
        tv = conf["tvs"].get(name, {})
        tv["ip"] = ip
        if mac:
            tv["mac"], tv["macManual"] = mac.upper().replace("-", ":"), True
        try:
            info = device_info(ip)
            tv.setdefault("label", info["name"])
            tv["model"] = info["model"]
            if info["mac"] and not tv.get("macManual"):
                tv["mac"] = info["mac"]
        except Exception:
            tv.setdefault("label", name)
        conf["tvs"][name] = tv
        conf.setdefault("default", name)
        if conf["default"] not in conf["tvs"]:
            conf["default"] = name
        save_conf(conf)
    return name


def serve(conf, port, open_browser=True):
    UI.conf, UI.port = conf, port
    httpd = ThreadingHTTPServer(("127.0.0.1", port), UI)
    url = "http://127.0.0.1:%d/" % port
    print("Screen Hub TV Remote %s on %s  (Ctrl+C to stop)" % (VERSION, url))
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


# ---------------------------------------------------------------- command line
def main(argv=None):
    ap = argparse.ArgumentParser(prog="tvremote", description="Control Samsung TVs running Screen Hub from this PC.")
    ap.add_argument("--tv", help="saved TV name, or 'all' (default: the default TV)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("find", help="find Samsung TVs on the network and save them")
    p = sub.add_parser("add", help="save a TV by IP address"); p.add_argument("name"); p.add_argument("ip"); p.add_argument("--mac", default="")
    p = sub.add_parser("remove", help="forget a saved TV"); p.add_argument("name")
    p = sub.add_parser("default", help="set the default TV"); p.add_argument("name")
    sub.add_parser("list", help="list saved TVs")
    p = sub.add_parser("ui", help="open the control page"); p.add_argument("--port", type=int, default=8765); p.add_argument("--no-browser", action="store_true")
    sub.add_parser("status", help="power state")
    p = sub.add_parser("on", help="switch on (Wake-on-LAN)"); p.add_argument("--open", action="store_true", help="then start Screen Hub")
    sub.add_parser("off", help="switch off")
    sub.add_parser("open", help="start Screen Hub")
    for s in ("next", "prev", "pause", "identify", "info", "back", "home", "mute", "resume", "reload", "apps"):
        sub.add_parser(s)
    p = sub.add_parser("vol"); p.add_argument("dir", choices=["up", "down"]); p.add_argument("steps", nargs="?", type=int, default=1)
    p = sub.add_parser("key", help="send raw remote keys, e.g. KEY_VOLUP"); p.add_argument("keys", nargs="+")
    p = sub.add_parser("say", help="show a message now"); p.add_argument("title"); p.add_argument("--body"); p.add_argument("--kicker")
    p.add_argument("--theme", choices=["gradient", "dark", "light", "alert"], default="gradient"); p.add_argument("--seconds", type=int, default=60)
    p = sub.add_parser("clock", help="show the clock now"); p.add_argument("--label"); p.add_argument("--seconds", type=int, default=60)
    p = sub.add_parser("youtube", help="play a YouTube video now"); p.add_argument("video"); p.add_argument("--seconds", type=int, default=300)
    p.add_argument("--sound", action="store_true"); p.add_argument("--until-end", action="store_true", dest="untilEnd"); p.add_argument("--app", action="store_true", help="use the TV's YouTube app instead")
    p = sub.add_parser("web", help="show a web page now"); p.add_argument("url"); p.add_argument("--seconds", type=int, default=120); p.add_argument("--zoom", type=int, default=100)
    args = ap.parse_args(argv)
    conf = load_conf()
    try:
        if args.cmd == "find":
            find(conf)
            return 0
        if args.cmd == "add":
            print("Saved as", add_tv(conf, args.name, args.ip, args.mac))
            return 0
        if args.cmd == "remove":
            conf["tvs"].pop(args.name, None)
            if conf.get("default") not in conf["tvs"]:
                conf["default"] = next(iter(conf["tvs"]), None)
            save_conf(conf)
            return 0
        if args.cmd == "default":
            pick(conf, args.name)
            conf["default"] = args.name
            save_conf(conf)
            return 0
        if args.cmd == "list":
            for n, t in conf["tvs"].items():
                print("%s %-16s %-15s %s %s" % ("*" if n == conf.get("default") else " ", n, t["ip"], t.get("label", ""), t.get("model", "")))
            return 0
        if args.cmd == "ui":
            serve(conf, args.port, not args.no_browser)
            return 0
        a = {k: v for k, v in vars(args).items() if k not in ("cmd", "tv")}
        action = args.cmd
        if action == "youtube" and args.app:
            action = "youtube-app"
        res = run_many(conf, pick(conf, args.tv), action, a)
        bad = False
        for r in res:
            if isinstance(r["msg"], list):
                for app in r["msg"]:
                    print("  %-28s %s" % (app["id"], app["name"]))
            else:
                print(("" if r["ok"] else "Problem: ") + r["msg"])
            bad = bad or not r["ok"]
        return 1 if bad else 0
    except TVError as e:
        print("Problem:", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
