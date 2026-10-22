# Screen Hub

Remote-managed content for Samsung (Tizen) TVs. Install one small app on each TV once; after that,
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
| Clock | Large drifting clock |

Each item has its own display time and optional schedule (days, time window, start/end dates).
Each screen has its own playlist, night hours (dim clock or black), mute and timings.

### Apps (`apps/<name>/index.html`)

| App | Options |
|---|---|
| `fuel-watch` | `rotateSeconds` |
| `weather` | `place`, or `lat`+`lon`; `label`; `units` C/F; `wind` mph/kmh (Open-Meteo, no key) |
| `news` | `feedUrl` (any RSS; default BBC News Manchester), `title`, `count`, `rotateSeconds` |
| `traffic` | `title`, `lat`, `lon`, `zoom` (live Waze map) |

An app is one self-contained HTML file; the player writes it into a frame and passes its options as `window.RS_APP`.

## On the TV

- **◀ ▶** previous / next · **OK** pause (resumes after 5 minutes untouched) · **▲ / INFO** status panel
  (name, ID, pairing code, now/next, last check) · **RED** identify · **BACK** close / exit
- Checks for changes every 3 minutes. Night hours show a dim drifting clock or a black screen; any button wakes it for 10 minutes.
- Remote commands from the console: identify, skip to next, show an item now, reload.

## Files

```
loader/         The installed package (config.xml, loader, icon, bundled copy of the player)
player/         The player the TVs fetch on start: bump player/manifest.json "version" to roll out
apps/           Apps that can go in a playlist
tools/publish.py  Encrypts the console's export into s/ and m/ (run by the hourly sync)
s/  m/          Encrypted screen files and media (written by the sync; don't edit)
youtube.html    YouTube page for when GitHub Pages is switched on (optional)
```

Anything pushed to `main` under `player/` or `apps/` runs on the TVs, so keep pushes to this repo trusted.

## Install (once per TV)

Same route as Fuel Watch: in Apps2Samsung choose **Custom WGT / TPK**, pick `ScreenHub-1.0.0.wgt`, **Download & Install**.
Open Screen Hub on the TV: it shows a QR code, a Screen ID and a pairing code. In the console choose **Pair a new screen › Scan QR code** and photograph the QR code, or type both codes in.
