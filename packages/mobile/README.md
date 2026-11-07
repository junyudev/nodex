# Nodex Mobile

## Setup

Install the workspace dependencies from the repository root, then run the mobile commands from this directory.

```sh
vp install --frozen-lockfile
cd packages/mobile
EXPO_OFFLINE=1 vp exec expo install --check
```

Dependency validation uses the installed SDK 58 patch and its React Native 0.88.0 version.

For iOS, install Xcode with an iOS Simulator runtime and put CocoaPods on your PATH. For Android, install JDK 21, the Android SDK command-line tools, and an emulator with a system image. Set the SDK and Java paths and install the build tools.

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1"
```

## Development

Boot an iOS simulator or start an Android emulator in Android Studio. Build and install Nodex Dev on the selected platform.

```sh
vp run ios
vp run android
```

If Metro is already using 8081, run `vp run android --port 8082` and use `vp run start --port 8082` for subsequent starts.

For an iPhone, enable Developer Mode, connect it to the Mac, and sign in to your Apple development team in Xcode. For Android, enable USB debugging, connect the phone, and accept the debugging prompt. Select the phone when Expo prompts you.

```sh
APPLE_TEAM_ID=YOUR_TEAM_ID vp run ios --device
vp run android --device
```

To pair a simulator or emulator without a camera, copy the link from Settings > Mobile on the desktop and use `Paste a pairing link`. Where the shell cannot reach the clipboard, as on current Android emulators, open it as a link:

```sh
adb shell "am start -a android.intent.action.VIEW -d '<pairing link>' app.jyu.nodex.mobile.dev"
```

After the first native build, use `vp run start` for JavaScript changes. Keep the phone and Mac on the same network. Rebuild after changing native dependencies or app configuration. The build commands regenerate the native projects, so keep native configuration in `app.config.ts` and `plugins/`.

SDK 58 prebuild recreates native directories by default, including the CocoaPods workspace;
`--no-clean` updates an existing project instead. After a clean iOS prebuild with `--no-install`,
run `pod install` in `ios/` before invoking Xcode.

## Production

Build the production variant locally to exercise release-mode bundling.

```sh
vp run ios:release
vp run android:release
```

For signed store builds with EAS, sign in, link your Expo project, and add the project ID that EAS prints to `extra.eas.projectId` in `app.config.ts`. Run the production profile from this directory.

```sh
vp dlx eas-cli login
APP_VARIANT=production vp dlx eas-cli init
vp dlx eas-cli build --profile production --platform all
```

Supply an Apple Developer team, distribution certificate and provisioning profile for `app.jyu.nodex.mobile`, and an Android upload keystore for Google Play. Set the store build numbers and complete the store privacy and encryption declarations before submission.

## TestFlight

Testers install and update from TestFlight, with no Mac or network shared with the phone. Upload a build from a Mac with Xcode and CocoaPods, using a team API key with the App Manager or Admin role. Signing is managed by Apple, and the build number comes from the commit count.

```sh
APPLE_TEAM_ID=YOUR_TEAM_ID APPLE_API_KEY_ID=KEY_ID APPLE_API_ISSUER=ISSUER_ID \
  APPLE_API_KEY_B64="$(base64 < AuthKey_KEY_ID.p8)" vp run ios:testflight
```

The app must already exist in App Store Connect under `app.jyu.nodex.mobile`, and only the account holder can accept Apple's agreements. A build appears in TestFlight once Apple finishes processing it and its encryption declaration is answered.

Regenerate the bundled artwork with `bash assets/generate.sh` using ImageMagick and librsvg.

## iOS encrypted notifications

`withNotificationDecryption.cjs` recreates the `NotificationService` target and embeds it in the
app on every prebuild. Its identifier is the selected variant's bundle identifier followed by
`.NotificationService`. The extension uses the app's deployment target, version, build number,
and signing team. Provision both identifiers for a device or store build.

Set `APPLE_TEAM_ID` when generating a signed build. `extra.pushKeychainGroup` exposes
`<team>.<variant bundle identifier>.push` to JavaScript, or `null` without a team. Both targets
receive the corresponding `keychain-access-groups` entitlement. The extension resolves the same
group from its built Info.plist, using `AppIdentifierPrefix`.

The app must save the base64url 32-byte key with SecureStore under `push-key`, service `nodex-push`,
that access group, and `AFTER_FIRST_UNLOCK`, without authentication. The extension reads Expo's
`nodex-push:no-auth` service with `Data("push-key".utf8)` as both account and generic attributes.
Changes to SecureStore's native storage format must keep this lookup aligned.

From the repository root, run the CryptoKit interoperability test and generated-project checks:

```sh
vp test run --config vitest.node.config.ts packages/mobile/src/native-tests
```

The decrypt test compiles `notification-service/PushDecryption.swift` and `tests/main.swift`
with `xcrun swiftc` on macOS, without an Xcode project; it skips on other platforms. It opens
the shared protocol vector, preserves its UTF-8 title, and rejects tampering, wrong keys, and
invalid payloads. The plugin checks run on every platform and cover both bundle identifiers,
signing, matching versions and deployment targets, embedding, and repeated generation.

A real delivery test also requires APNs credentials and a provisioned iPhone. An alert with
`aps.mutable-content: 1` and an encrypted `n` value should show its decrypted title and body,
group by `sessionId`, and carry `sessionId` and `kind` in the tap's notification data. A missing
key, invalid payload, or expired extension deadline must preserve the original placeholder.
