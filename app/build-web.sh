#!/bin/sh
# Builds the web package the hub and the Worker serve (dist/web/noop; machines download a release's
# instead, see src/webclient.ts, and leave one built here alone), then adds what
# `nsh package` has no place for: the push service worker at the site's root (its scope is the
# whole app), a stable icon URL for notifications, and the manifest's colors (the gallery's page).
set -e
cd "$(dirname "$0")"
NSH="${NSH:-$HOME/work/nsh/target/debug/nsh}"
# The package directory is named after the display name (Noop), but the Worker serves dist/web/noop.
OUT="dist/web/noop"
TMP="dist/.web-build"
rm -rf "$TMP"
"$NSH" package --target web -o "$TMP" "$@"
rm -rf "$OUT" dist/web/.release
mkdir -p dist/web
mv "$TMP"/* "$OUT"
rmdir "$TMP"
cp web/sw.js "$OUT/sw.js"
cp "$OUT"/icons/192.*.png "$OUT/icons/192.png"
# -i.bak: BSD sed (macOS) needs a suffix where GNU sed doesn't
sed -i.bak 's/"background_color": "[^"]*"/"background_color": "#f7f7f4"/; s/"theme_color": "[^"]*"/"theme_color": "#f7f7f4"/' "$OUT/manifest.webmanifest"
rm "$OUT/manifest.webmanifest.bak"
echo "✓ added sw.js, icons/192.png, manifest colors"
