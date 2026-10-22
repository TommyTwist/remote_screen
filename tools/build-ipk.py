#!/usr/bin/env python3
"""Build the LG webOS package (.ipk) for Screen Hub, without LG's SDK.

Uses the same loader and bundled player as the Samsung .wgt, plus loader/webos/
(appinfo.json and icons). The version comes from loader/config.xml so both TV
packages always match.

    python3 tools/build-ipk.py        ->  dist/ScreenHub-LG-<version>.ipk

The .ipk layout matches what LG's ares-package makes: an ar archive holding
debian-binary, control.tar.gz and data.tar.gz, with the app under
usr/palm/applications/<id>/ and its package info under usr/palm/packages/<id>/.
Install it with webOS Dev Manager or `ares-install`.
"""
import io, json, os, re, shutil, sys, tarfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOADER = os.path.join(ROOT, "loader")
PLAYER = os.path.join(ROOT, "player")
PLAYER_FILES = ["manifest.json", "guard.js", "player.html", "player.css", "sjcl.js", "qrcode.js", "player.js"]
LOADER_FILES = ["index.html", "loader.js"]
WEBOS_FILES = ["icon.png", "largeIcon.png"]
MTIME = int(time.time())


def version():
    xml = open(os.path.join(LOADER, "config.xml"), encoding="utf-8").read()
    return re.search(r'<widget[^>]*version="([0-9.]+)"', xml).group(1)


def tar_gz(entries):
    """entries: list of (path, bytes or None for a directory). Returns gzipped tar bytes."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as t:
        for path, data in entries:
            ti = tarfile.TarInfo(path)
            ti.mtime, ti.uid, ti.gid, ti.uname, ti.gname = MTIME, 0, 0, "root", "root"
            if data is None:
                ti.type, ti.mode = tarfile.DIRTYPE, 0o755
                t.addfile(ti)
            else:
                ti.size, ti.mode = len(data), 0o644
                t.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def ar(members):
    out = io.BytesIO()
    out.write(b"!<arch>\n")
    for name, data in members:
        hdr = "%-16s%-12d%-6d%-6d%-8s%-10d`\n" % (name, MTIME, 0, 0, "100644", len(data))
        out.write(hdr.encode("ascii"))
        out.write(data)
        if len(data) % 2:
            out.write(b"\n")
    return out.getvalue()


def main():
    v = version()
    info = json.load(open(os.path.join(LOADER, "webos", "appinfo.json"), encoding="utf-8"))
    info["version"] = v
    app_id = info["id"]

    # refresh the bundled player copy (same as build-wgt.sh)
    os.makedirs(os.path.join(LOADER, "bundled"), exist_ok=True)
    for f in PLAYER_FILES:
        shutil.copyfile(os.path.join(PLAYER, f), os.path.join(LOADER, "bundled", f))

    app_dir = "./usr/palm/applications/%s/" % app_id
    pkg_dir = "./usr/palm/packages/%s/" % app_id
    files = [(app_dir + "appinfo.json", (json.dumps(info, indent=2) + "\n").encode())]
    for f in LOADER_FILES:
        files.append((app_dir + f, open(os.path.join(LOADER, f), "rb").read()))
    for f in WEBOS_FILES:
        files.append((app_dir + f, open(os.path.join(LOADER, "webos", f), "rb").read()))
    for f in PLAYER_FILES:
        files.append((app_dir + "bundled/" + f, open(os.path.join(LOADER, "bundled", f), "rb").read()))
    packageinfo = {"app": app_id, "id": app_id, "loc_name": info["title"],
                   "package_format_version": 2, "vendor": info["vendor"], "version": v}
    files.append((pkg_dir + "packageinfo.json", (json.dumps(packageinfo, indent=2) + "\n").encode()))

    dirs = set()
    for path, _ in files:
        parts = path.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            dirs.add("/".join(parts[:i]) + "/")
    entries = [(d, None) for d in sorted(dirs)] + files
    data_tgz = tar_gz(entries)

    size_kb = sum(len(d) for _, d in files) // 1024 + 1
    control = ("Package: %s\nVersion: %s\nSection: misc\nPriority: optional\nArchitecture: all\n"
               "Installed-Size: %d\nMaintainer: %s\nDescription: %s\n"
               "webOS-Package-Format-Version: 2\nwebOS-Packager-Version: 1.0.0\n"
               % (app_id, v, size_kb, info["vendor"], info["title"]))
    control_tgz = tar_gz([("./", None), ("./control", control.encode())])

    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", "ScreenHub-LG-%s.ipk" % v)
    with open(out, "wb") as fh:
        fh.write(ar([("debian-binary", b"2.0\n"), ("control.tar.gz", control_tgz), ("data.tar.gz", data_tgz)]))
    print(os.path.relpath(out, ROOT))


if __name__ == "__main__":
    sys.exit(main())
