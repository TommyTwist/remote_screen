# Screen Hub

Remote-managed content for Samsung (Tizen) and LG (webOS) TVs. Install one small app on each TV once; after that,
what every screen shows is set from the **Screen Hub console** (a private claude.ai page) and published
here by an hourly sync.

**Only screens you pair can see anything.** This repo is public, but each screen's playlist and media are
encrypted with that screen's own key (see [docs/FORMAT.md](docs/FORMAT.md)). Switching a screen off or
removing it takes effect at the next publish.

## What a screen can show

| Type | Notes |
|---|---|
| Picture | Uploaded in the console (resized for the TV, encrypted) or a public image link |
| Video | Uploaded MP4 (H.264) up to 20 MB, or a public link; plays to the end |
| YouTube | Frameless, muted by default; plays to the end |
| Website | Any link, with zoom. Some sites refuse to be shown inside other apps; those are skipped |
| App | Fuel Watch, Weather, Local news, Traffic (see below) |
| Message | Headline + text card, four themes |
| Clock | Large drifting clock on a slowly flowing background |

Each item has its own display time and optional schedule (days, time window, start/end dates).
Each screen has its own playlist, night hours (dim clock or black), mute and timings.

### Apps (`apps/<name>/index.html`)

| App | Options |
|---|---|
| `fuel-watch` | `rotateSeconds` |
| `weather` | `place` + `country` (2-letter code, default GB; blank for anywhere), or `lat`+`lon`; `label`; `units` C/F; `wind` mph/kmh (Open-Meteo, no key) |
| `news` | `place` (news mentioning a town or area, via Google News) or `feedUrl` (any RSS; default BBC News Manchester); `filter` all/good (good leaves out crime, deaths, crashes, court cases and similar); `title`, `count`, `rotateSeconds` |
| `traffic` | `title`, `lat`, `lon`, `zoom` (live Waze map) |

An app is one self-contained HTML file; the player writes it into a frame and passes its options as `window.RS_APP`.

## On the TV

- **◀ ▶** previous / next · **OK** pause (resumes after 5 minutes untouched) · **▲ / INFO** status panel
  (name, ID, pairing code, now/next, last check) · **RED** identify · **BACK** close / exit
  (same on LG; the Magic Remote's arrows, OK, BACK and colour keys all work)
- Checks for changes every 3 minutes. Night hours show a dim drifting clock or a black screen; any button wakes it for 10 minutes.
- Remote commands from the console: identify, skip to next, show an item now, reload.

## TV Remote (Samsung, from the PC)

`tools/tvremote.py` controls Samsung TVs straight over the home network, so it is instant but only works at home.
Standard-library Python 3.8+, nothing to install.

```
python tools/tvremote.py find        # find TVs that are switched on and save them
python tools/tvremote.py ui          # control page at http://127.0.0.1:8765
python tools/tvremote.py on --open   # Wake-on-LAN, then start Screen Hub
python tools/tvremote.py say "Dinner's ready" --seconds 90 --theme alert
python tools/tvremote.py --tv all off
```

- Power on (Wake-on-LAN) and off, open Screen Hub, volume and mute, any remote key, list installed apps.
- Playlist: next, previous, pause, identify and the status panel, by sending the same buttons the TV remote has.
- **Show now** (player 1.5.0+): a message, clock, YouTube video or web page for a set time, then the playlist carries on.
  It works by relaunching Screen Hub with a small payload (Samsung `DEEP_LINK` metaTag); the player accepts only these
  display actions and escapes any text. YouTube can also open in the TV's own YouTube app.
- The first connection shows an Allow prompt on the TV. Saved TVs and tokens are kept in `~/.screenhub/tvremote.json`, outside the repo.
- Switching on needs network standby (Samsung Instant On) and is most reliable on a wired connection.
- The control page listens on 127.0.0.1 only and refuses requests from other websites.

## Files

```
loader/         The installed package (config.xml, loader, icon, bundled copy of the player)
loader/webos/   LG extras: appinfo.json and icons (the loader and player are shared)
tools/build-wgt.sh  Builds the Samsung package -> dist/ScreenHub-<v>.wgt
tools/build-ipk.py  Builds the LG package -> dist/ScreenHub-LG-<v>.ipk (no LG SDK needed)
player/         The player the TVs fetch on start: bump player/manifest.json "version" to roll out
apps/           Apps that can go in a playlist
tools/publish.py  Encrypts the console's export into s/ and m/ (run by the hourly sync)
s/  m/          Encrypted screen files and media (written by the sync; don't edit)
youtube.html    YouTube page for when GitHub Pages is switched on (optional)
```

Anything pushed to `main` under `player/` or `apps/` runs on the TVs, so keep pushes to this repo trusted.

## Install (once per TV)

### Samsung

Same route as Fuel Watch: in Apps2Samsung (or ScreenHubInstaller) choose **Custom WGT / TPK**, pick `ScreenHub-<version>.wgt`, **Download & Install**.

### LG (webOS 3 and newer)

LG's own Developer Mode is the supported way to sideload. One-off setup:

1. Make a free LG Developer account at developer.lge.com (it uses an LG account).
2. On the TV, install **Developer Mode** from the LG Content Store, sign in, switch **Dev Mode Status** on (the TV restarts), then reopen it and switch **Key Server** on.
3. On the PC (same network), install **webOS Dev Manager** (github.com/webosbrew/dev-manager-desktop), add the TV by its IP address and accept the passphrase shown in the Developer Mode app. Give the TV a fixed IP on the router so it stays findable.
4. In Dev Manager open **Apps**, choose **Install** and pick `ScreenHub-LG-<version>.ipk`. Or with LG's CLI: `ares-install -d <tv> ScreenHub-LG-<version>.ipk`.

Things to know about LG Developer Mode:

- Dev Mode lasts 1000 hours (about 41 days). When it runs out, sideloaded apps are removed. Open the Developer Mode app and press **Extend** before then (Dev Manager shows the time left).
- The Key Server switches off when the TV restarts; that only matters when you next connect from the PC.
- One developer account can have Dev Mode on one TV at a time.
- Screen IDs on LG start `LG-` and come from the TV's own unique ID, saved on first start so pairing survives restarts.


### Pairing

Open Screen Hub on the TV: it shows a QR code, a Screen ID and a pairing code. In the console choose **Pair a new screen › Scan QR code** and photograph the QR code, or type both codes in.
