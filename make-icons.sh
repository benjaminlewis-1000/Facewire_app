#!/usr/bin/env bash
#
# Regenerate the app icons in assets/ from the FaceWires favicon.
# Needs ImageMagick (`convert`). Run from the project root: ./make-icons.sh
#
set -euo pipefail
cd "$(dirname "$0")"

SRC="/home/benjamin/git_repos/facewires_frontend/public/favicon.jpg" # 728x512, icon centered
BLUE="#0d56a3"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v convert >/dev/null || { echo "ImageMagick 'convert' not found" >&2; exit 1; }
[[ -f "$SRC" ]] || { echo "Source not found: $SRC" >&2; exit 1; }

# 1. Crop the centered rounded-square icon out of the source banner.
convert "$SRC" -crop 512x512+108+0 +repage "$TMP/crop.png"
convert "$TMP/crop.png" -resize '1024x1024!' "$TMP/ic.png"

# 2. Replace the checkerboard corners (baked into the JPEG) with the icon's
#    own blue, using a rounded-rect mask that sits just inside the artwork.
convert -size 1024x1024 xc:"$BLUE" "$TMP/base.png"
convert -size 1024x1024 xc:black -fill white \
  -draw 'roundrectangle 52,52,971,971,140,140' "$TMP/mask.png"
convert "$TMP/base.png" "$TMP/ic.png" "$TMP/mask.png" -composite "$TMP/icon.png"

mkdir -p assets
convert "$TMP/icon.png" -strip                       assets/icon.png            # iOS + fallback
convert "$TMP/icon.png" -strip                       assets/adaptive-icon.png   # Android foreground (bg = $BLUE in app.json)
convert "$TMP/icon.png" -strip                       assets/splash-icon.png     # splash (bg = $BLUE in app.json)
convert "$TMP/icon.png" -strip -resize 48x48         assets/favicon.png         # web

echo "Wrote: assets/{icon,adaptive-icon,splash-icon,favicon}.png"
