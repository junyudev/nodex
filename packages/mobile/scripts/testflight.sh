#!/usr/bin/env bash
# Gives internal TestFlight testers this checkout's iOS build, through the same release path a
# stable release takes: a Nightly identity, a verified App Store-signed IPA, then TestFlight.
# Needs a clean checkout, APPLE_API_KEY_ID, APPLE_API_ISSUER and APPLE_API_KEY_B64 (a team key
# with the App Manager or Admin role), and CocoaPods on PATH.
set -euo pipefail

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$root"

vp run release:resolve:source -- --channel nightly --head HEAD --output "$work/release-identity.json"
vp run release:build:ios -- --identity "$work/release-identity.json" --output "$work/ios"
vp run release:publish:testflight -- --build-dir "$work/ios"
