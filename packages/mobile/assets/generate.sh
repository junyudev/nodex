#!/usr/bin/env bash
set -euo pipefail

assets=$(cd "$(dirname "$0")" && pwd)
resources="$assets/../../../resources"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

rsvg-convert -w 1024 -h 1024 "$resources/nodex-icon.svg" -o "$scratch/mark.png"

magick "$resources/nodex-icon_3200x3200.png" -resize 780x780 \
  -background '#eaeaea' -gravity center -extent 1024x1024 \
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
