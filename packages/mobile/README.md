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

Regenerate the bundled artwork with `bash assets/generate.sh` using ImageMagick and librsvg.
