#!/usr/bin/env bash
set -euo pipefail

assets=$(cd "$(dirname "$0")" && pwd)
resources="$assets/../../../resources"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

rsvg-convert -w 1024 -h 1024 "$resources/nodex-icon.svg" -o "$scratch/mark.png"

# iOS composes its icon from these layers, one per appearance in app-icon.icon/icon.json: a solid
# block beneath, and the outline and prompt above it, so a tinted or clear Home Screen keeps its contrast.
layers="$assets/app-icon.icon/Assets"
open='<svg width="800" height="800" viewBox="0 0 800 800" fill="none" xmlns="http://www.w3.org/2000/svg">'
{ echo "$open"; grep 'fill="white"' "$resources/nodex-icon.svg"; echo '</svg>'; } > "$layers/nodex-body.svg"
{
  echo "$open"
  grep '<path' "$resources/nodex-icon.svg" | grep -v 'fill="white"' | sed 's/#262626/#000000/g'
  echo '</svg>'
} > "$layers/nodex-lines.svg"

magick "$scratch/mark.png" -resize 780x780 \
  -background white -gravity center -extent 1024x1024 \
  -alpha remove -alpha off -strip "$assets/icon.png"

# A 440 px canvas keeps the full mark within the central 66 dp adaptive icon circle.
magick "$scratch/mark.png" -resize 440x440 \
  -background none -gravity center -extent 1024x1024 -strip "$assets/adaptive-foreground.png"

# Render the outline and terminal strokes as the system-tinted silhouette.
sed -e '/fill="white"/d' -e 's/#262626/#000000/g' "$resources/nodex-icon.svg" > "$scratch/mono.svg"
rsvg-convert -w 440 -h 440 "$scratch/mono.svg" -o "$scratch/mono.png"
magick "$scratch/mono.png" -background none -gravity center -extent 1024x1024 \
  -strip "$assets/adaptive-monochrome.png"

magick "$scratch/mark.png" -resize 384x384 -strip "$assets/splash.png"
