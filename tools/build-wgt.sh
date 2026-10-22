#!/bin/sh
# Build the installable TV package: refreshes the bundled player copy, then zips the loader.
set -e
cd "$(dirname "$0")/.."
V=$(python3 -c "import re;print(re.search(r'<widget[^>]*version=\"([0-9.]+)\"',open('loader/config.xml').read()).group(1))")
mkdir -p loader/bundled dist
cp player/manifest.json player/player.html player/player.css player/sjcl.js player/player.js loader/bundled/
rm -f dist/ScreenHub-$V.wgt
(cd loader && zip -qrX ../dist/ScreenHub-$V.wgt config.xml index.html loader.js icon.png bundled)
echo dist/ScreenHub-$V.wgt
