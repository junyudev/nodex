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

To enroll a simulator or emulator without a camera, copy a device link from the Space’s settings and use `Paste a device link`. Where the shell cannot reach the clipboard, as on current Android emulators, open it as a link:

```sh
adb shell "am start -a android.intent.action.VIEW -d '<device link>' app.jyu.nodex.mobile.dev"
```

After the first native build, use `vp run start` for JavaScript changes. Keep the phone and Space host on the same network or tailnet. Rebuild after changing native dependencies or app configuration. The build commands regenerate the native projects, so keep native configuration in `app.config.ts` and `plugins/`.

SDK 58 prebuild recreates native directories by default, including the CocoaPods workspace;
`--no-clean` updates an existing project instead. After a clean iOS prebuild with `--no-install`,
run `pod install` in `ios/` before invoking Xcode.

## Production

Build the production variant locally to exercise release-mode bundling. A local release build
keeps debug signing; only the release pipeline holds the Nodex keystore.

```sh
vp run ios:release
vp run android:release
```

## Releases

Every desktop release builds and ships Nodex Mobile with the same version: an APK for Android
beside the desktop downloads, and an App Store-signed build for the public TestFlight beta. See
[Nodex Mobile in the release runbook](../../docs/release.md#nodex-mobile) for versions, signing and
TestFlight publishing.

To give internal testers this checkout's iOS build, run the same path from a clean checkout on a
Mac with Xcode and CocoaPods, using a team API key with the App Manager or Admin role:

```sh
APPLE_API_KEY_ID=KEY_ID APPLE_API_ISSUER=ISSUER_ID \
  APPLE_API_KEY_B64="$(base64 < AuthKey_KEY_ID.p8)" vp run ios:testflight
```

Regenerate the bundled artwork with `bash assets/generate.sh` using ImageMagick and librsvg.

## Pinned TLS capability

`src/runtime/expo-platform.ts` supplies the connection runtime’s only network capability.
Device links enroll over pinned HTTPS; renewable Device sessions authenticate the
phone’s WebSocket on the same Core listener. Credentials remain in SecureStore with
`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. A local catalog and every resource partition
use the Space and Member together. `request` accepts an HTTPS URL, method, headers,
optional `Uint8Array` body, runtime `fingerprint`, and `timeoutMs` (1–60,000; default
15,000). It returns status, headers and body bytes. `openSocket` accepts the same
endpoint options with a WSS URL and returns Effect operations `send`, `take` and
`close`; `send` supports text and bytes. Acquire sockets inside the owning Effect
Scope. Interruption cancels a request; closing the Scope cancels its sockets and
removes native listeners. There is no automatic redirect, retry or cookie store.

The local Expo module in `modules/pinned-tls` trusts only a case-insensitive,
64-hex SHA-256 fingerprint of the complete leaf certificate DER. It checks the
pin during the TLS handshake before HTTP headers, bodies or WebSocket upgrades,
and the pin is its only certificate authority on both platforms: a self-signed
host is reached at a LAN, tailnet or DNS address alike, and system trust never
substitutes for a matching pin. Each operation gets an isolated native TLS
context/session, so pooling and TLS resumption cannot reuse another operation's
pin decision. TLS 1.2 is the minimum, ALPN offers only `http/1.1`, and SNI is
sent for names, never for IP literals. Certificate reissue requires an explicitly
updated pin, even with the same public key.

Requests/responses are limited to 8 MiB, WebSocket messages to 1 MiB, buffered
sends to 8 MiB, native operations to 32 and Effect ingress to 128 events. Overflow
closes the operation. Android's OkHttp delivers a complete incoming message to
its listener before the message-size check; this is not a pre-allocation memory
limit against a malicious authenticated host.

On iOS the module runs on Network.framework, not `URLSession`. App Transport
Security governs the URL Loading System and enforces itself during trust
evaluation, so a `URLSession` delegate cannot accept a self-signed certificate on a
tailnet (100.64.0.0/10) or public IP address or on a DNS name, whatever the pin
says. Network.framework is outside ATS, so its TLS verify block makes the whole
trust decision. Keep Space traffic on this transport rather than adding ATS
exceptions: the app keeps `NSAllowsLocalNetworking` for its other traffic, with no
arbitrary-loads key. Requests are a minimal HTTP/1.1 exchange on the pinned
connection (`Connection: close`, a `Content-Length` body, and a response framed by
`Content-Length`, chunked coding or close, with bounded headers);
`ios/PinnedHttp.swift` holds that framing and the constant-time pin comparison,
which `src/native-tests` compiles and checks on macOS. Connections prefer a direct
path; Network.framework falls back to a configured system proxy only when no
direct path completes, and the TLS session still ends at the pinned host. WebSockets use
`NWProtocolWebSocket` over the same TLS options. The connection tries a link's
local routes first, then its tailnet routes, then the rest (`src/runtime/routes.ts`).
The existing local-network permission text is retained.
Android uses an isolated OkHttp trust manager and hostname verifier; there is no
global TLS, trust-store or cleartext exception. Enrollment and the phone stream use
only this pinned native transport.

### Native transport proof

The `tls-proof` build variant has a separate app identifier and scheme. Metro
selects its diagnostics entry only for that variant; production and development
bundles do not include it, even when built in Release mode. The proof runs the
real Expo bridge and Effect wrapper. It creates a fresh self-signed certificate,
checks request and text/binary WebSocket round-trips at every proof route,
wrong-pin and same-key certificate reissue rejection at every route before any
application bytes, a chunked response, a host's 4403 close code, the request
deadline, explicit socket close and scoped socket/request cancellation.
The routes are host loopback, on iOS a qualified DNS name, and, when
`NODEX_TLS_PROOF_TAILNET` names this host's own 100.64.0.0/10 address, that tailnet
address. Each route must show the expected SNI: the name for the DNS route and none
for IP addresses. Ports 19443 and 19444 must be free. The control server binds
host loopback only; the TLS server binds loopback and the tailnet address if set.

Boot a disposable simulator/emulator, then run from this directory (CocoaPods,
JDK 21, Android SDK and `vp` must be on PATH):

```sh
node scripts/tls-proof.mjs ios <simulator-uuid> <absolute-artifact-directory>
node scripts/tls-proof.mjs android <emulator-serial> <absolute-artifact-directory>
```

The runner prebuilds, compiles, installs, launches the proof variant and records a
screenshot and JSON evidence. Add `--skip-build` to rerun an existing proof
build. iOS connects to host loopback; the Android emulator uses `10.0.2.2`.
Proof results must say `passed: true`, including every route reached, zero
decrypted application bytes, requests and upgrades in both rejection phases and
server-observed closure of `/hang` and `/abandon`. Generated private keys stay in
local artifacts.

For a production bundle check, export both platforms with `APP_VARIANT=production`
and `--source-maps`, then run `node scripts/verify-production-entry.mjs <export-dir>`.
This checks Metro's actual module graph for the product entry and absence of diagnostics.
The isolated proof app starts against the local server on launch; its deep link can
also supply a control URL. Direct launch avoids iOS's first-open URL confirmation.

The iOS DNS case uses `nodex-tls-proof.localhost`, which resolves to loopback on
macOS and the simulator without a hosts-file change. It is a qualified name, which
ATS would enforce for `URLSession`. Set `NODEX_TLS_PROOF_DNS_HOST` to another
qualified hostname mapped exclusively to loopback if needed. The server checks
resolution before launch and requires an observed TLS SNI handshake for the
hostname, so a DNS lookup or connection failure cannot satisfy the proof. The
emulator has no name for its host's loopback, so Android proves the address routes.

## Share to the Inbox

`withShareTargets.cjs` generates the iOS Share extension and **Add to Nodex Inbox**
action, plus the Android intent filters for text, links and images. Both iOS
extensions stage the share in an App Group and open `nodex-mobile-dev://expo-sharing`
in development or `nodex-mobile://expo-sharing` in production.

For a signed build, enable App Groups for the app and both extension App IDs and
assign them to the same group. The app ID is `app.jyu.nodex.mobile.dev` for
development or `app.jyu.nodex.mobile` for production. The extension IDs append
`.expo-sharing-extension` and `.NodexAction` to that ID. The App Group is
`group.<app ID>`.

From the repository root, run the generated-project checks:

```sh
vp test run --config config/vitest.node.config.ts packages/mobile/src/native-tests
```

On a device build, share text, a Safari page and up to six photos. On iOS, try
both the app row and the action row and confirm that each opens the Inbox composer.

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
vp test run --config config/vitest.node.config.ts packages/mobile/src/native-tests
```

The decrypt test compiles `notification-service/PushDecryption.swift` and `tests/main.swift`
with `xcrun swiftc` on macOS, without an Xcode project; it skips on other platforms. It opens
the shared protocol vector, preserves its UTF-8 title, and rejects tampering, wrong keys, and
invalid payloads. The plugin checks run on every platform and cover both bundle identifiers,
signing, matching versions and deployment targets, embedding, and repeated generation.

A real delivery test also requires APNs credentials and a provisioned iPhone. An alert with
`aps.mutable-content: 1` and an encrypted `n` value should show its decrypted title and body,
group by `sessionId`, and carry `sessionId`, `kind` and the sending Space's `hostId` in the tap's
notification data. A missing
key, invalid payload, or expired extension deadline must preserve the original placeholder.
