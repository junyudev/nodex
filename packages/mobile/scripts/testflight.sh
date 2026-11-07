#!/usr/bin/env bash
# Builds the production app and uploads it to TestFlight, signed by Apple's managed certificates.
# Needs APPLE_TEAM_ID, APPLE_API_KEY_ID, APPLE_API_ISSUER and APPLE_API_KEY_B64 (a team key with the
# App Manager or Admin role), and CocoaPods on PATH.
set -euo pipefail

: "${APPLE_TEAM_ID:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}" "${APPLE_API_KEY_B64:?}"

cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

key="$work/AuthKey.p8"
(umask 077 && printf '%s' "$APPLE_API_KEY_B64" | base64 -d > "$key")
signing=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$key"
  -authenticationKeyID "$APPLE_API_KEY_ID"
  -authenticationKeyIssuerID "$APPLE_API_ISSUER"
)

export APP_VARIANT=production EXPO_NO_GIT_STATUS=1
# Commits only accumulate on main, so this keeps rising without anything to remember.
export MOBILE_BUILD_NUMBER="${MOBILE_BUILD_NUMBER:-$(git rev-list --count HEAD)}"
echo "Build $MOBILE_BUILD_NUMBER"

vp exec expo prebuild --clean --no-install --platform ios
(cd ios && pod install)

xcodebuild archive \
  -workspace ios/Nodex.xcworkspace -scheme Nodex -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$work/Nodex.xcarchive" \
  "${signing[@]}" DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic

cat > "$work/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$work/Nodex.xcarchive" -exportOptionsPlist "$work/export.plist" \
  -exportPath "$work/export" "${signing[@]}"
