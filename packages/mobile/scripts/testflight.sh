#!/usr/bin/env bash
# Give internal testers the exact iOS build retained in a published Nightly's Release Bundle.
set -euo pipefail

if [[ "$#" != 1 ]]; then
  echo "Usage: ios:testflight <retained-nightly-release-bundle.json>" >&2
  exit 2
fi
bundle="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"

vp run release:publish:testflight -- --bundle "$bundle" --channel nightly
