# Screen Hub file format (v1)

The repo is public. Everything a screen shows is encrypted per screen, so only a TV that
holds the matching pairing code can read it.

## Pairing

On first start each TV makes a 16-character pairing code (alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`)
and keeps it in its own storage. Its Screen ID is the TV's Samsung DUID (first word, upper case), or on LG webOS `LG-` plus the first 16 characters of the TV's LGUDID (letters and digits only, upper case; saved on first start).

    key    = SHA-256("rs1|key|"  + ID + "|" + CODE)                 32 bytes, AES-256 key
    fileId = hex(SHA-256("rs1|file|" + ID + "|" + CODE))[0:32]
    aad    = SHA-256("rs1|aad|"  + fileId)[0:16]

An unpaired TV's pairing card also shows a QR code (player 1.2.0+) holding the same two values as text:

    SCREENHUB:1:<Screen ID>:<CODE>

The console reads it from a photo and fills in the Screen ID and code. It is no more secret than the printed
code beside it: anyone who can see the TV's pairing card can read both.

## `s/<fileId>.json` — one per paired screen

    {"v":1, "h":"<change hash>", "iv":"<base64 12 bytes>", "ct":"<base64 AES-GCM ciphertext+tag>"}

Plaintext (UTF-8 JSON):

    {"v":1, "updatedAt":"…", "defaults":{…settings}, "youtubePage":"",
     "screen":{"name", "enabled", "settings":{…}, "playlist":[{"content":"<id>","seconds":n?}], "command":{"id","action","at","content"?}},
     "content":{"<id>":{"type", "name", "seconds"?, "schedule"?, …type fields}}}

Only the content this screen's playlist uses is included. A switched-off screen gets
`{"screen":{"name","enabled":false}}` and no content. A removed screen's file is deleted, so the
TV falls back to its pairing card.

Settings: `defaultSeconds`, `nightStart`, `nightEnd` (hours), `nightMode` (`clock`|`black`|`off`),
`muted`, `checkMinutes`, `idleMinutes`, `fit` (`contain`|`cover`).

Schedule: `days` (0 = Sunday … 6), `start`/`end` (`HH:MM`, may wrap past midnight), `from`/`until` (ISO).

Types: `image` (`file`… or `url`, `fit`, `caption`), `video` (`file`… or `url`, `untilEnd`, `muted`, `loop`),
`youtube` (`videoId`, `start`, `untilEnd`, `muted`), `web` (`url`, `zoom` %), `app` (`app`, `options`),
`message` (`kicker`, `title`, `body`, `theme`), `clock` (`label`).

Commands: `reload`, `identify`, `next`, `show` (+`content`). A TV acts on each command id once,
and ignores commands older than 3 hours.

## `m/<name>.bin` — encrypted media

Media entries carry `file`, `mkey` (base64 32 bytes), `iv8` (base64 8 bytes), `chunk`, `mime`, `size`.
The file is the media split into `chunk`-byte pieces (1 MiB), each sealed with AES-256-GCM using
IV = `iv8` + 4-byte big-endian chunk index, no AAD, concatenated. Names and keys come from the
master secret, which lives only in the console's private database:

    name = hex(HMAC(secret, "rs1|name|" + assetId))[0:32]
    mkey = HMAC(secret, "rs1|mkey|" + assetId)
    iv8  = HMAC(secret, "rs1|iv|" + assetId)[0:8]

## Publishing

The console encrypts in the browser: **Publish now** reads the master secret (owner only),
builds every `s/` file and encrypted media file, and leaves them in the console's database
(`outbox/manifest`, `outbox/s-<fileId>`) and asset store (media prefixed with the 8 bytes
`SHUBENC1`). The scheduled task then runs `tools/apply_outbox.py`, which only copies those
ready-made files into `s/` and `m/` and deletes ones the manifest no longer lists. It never
sees the master secret, pairing codes or media keys. `tools/publish.py` does the same
encryption from the command line and is kept as a manual fallback.
