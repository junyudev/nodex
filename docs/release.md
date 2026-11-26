# Application Release Runbook

## Release model

A published Nightly is a release candidate. Stable promotion publishes the same
macOS DMG, full-update archive and Components manifest, Windows installers,
Android APK, and iOS TestFlight build. It signs fresh Stable appcasts and compatible deltas against
Stable history. Stable enclosures and the Homebrew cask point to the Stable
release's own copies.

- **Nightly Release** runs every three hours and on manual dispatch. It selects
  the most recent successful Main CI push on protected `main` whose commit is
  reachable from current `main`. It certifies, builds, probes, finalizes and
  publishes that commit as a GitHub prerelease and in the Nightly feeds.
- **Release** runs on dispatch from `main`. It verifies the selected Nightly and
  its retained artifacts before feed signing. It publishes GitHub Latest, the
  Stable feeds, Agent Skills, Homebrew and TestFlight.
- **Distribution Rehearsal** exercises the native builds and update finalizers
  from an exact protected-main SHA, with no publication or Sentry upload.

Nightly retains the Build Identity, source certificate, architecture bundles,
mobile builds and full Release Bundle for 14 days. Promote within that window.
Published assets include versioned downloads, signed feeds, `release-identity.json`,
`release-bundle.json` and `SHA256SUMS`. Stable also publishes the `latest` aliases.
The private Bundle carries `release-notes.md` and the verified iOS payload in
`testflight/`. The Windows x64 installer is built and probed on a native runner.
See [Windows distribution](release-windows.md).

The macOS app ships the standalone Node runtime. It downloads Desktop Tools
into the Profile as a Component when installed through Settings. The app
release binds the exact published archive URL, size, SHA-256, and manifest
SHA-256 to its tested Codex app-server. Publish the [Desktop Tools runtime
release](#desktop-tool-runtime-releases-and-latest) before the app release that
pins it.

On Apple silicon, Document Tools install on first use. Release provenance binds
the published archive URL, byte count, and archive and manifest SHA-256 digests.
Publish the [Document Tools runtime](#document-tools-runtime-releases) before
the app that pins it.

The macOS app keeps the Agent SDK and installs its matching Claude Code
executable on demand. Release provenance binds the npm archive URL, size, and
SHA-256 and the executable's identity. Distribution checks the archive is
downloadable and rejects an app that contains the native Claude package.

On Apple silicon, Codex installs on first use from the official `openai/codex`
release archive pinned in [the Codex lock](../resources/agent-runtime/codex-app-server.lock.json).
The app ships the license and notice files used by the Component installer. Nodex
does not republish the archive. Distribution checks the upstream URL with HEAD
or a one-byte range request and requires the published size to match the pin,
even when a local cache is available. It then verifies the archive SHA-256 and
staged package before running conformance. If upstream removes the asset, the
build is not releasable until the lock is re-pinned to an available official
release and its conformance checks pass.

The Apple silicon architecture build generates `Nodex-<version>-components-arm64.json`
from the packaged app's Component catalog and stamps it with the Build Identity's
display version and build number. Assembly checks the manifest and includes it in the
Release Bundle allowlist and `SHA256SUMS`. Nightly publishes it with the other certified
assets. Stable promotion copies the same bytes to the Stable release.

After Sparkle has verified and prepared an update, Nodex looks for the manifest beside
the update archive or delta on GitHub. Stable uses `v<version>` and Nightly uses
`v<version>-nightly.<source date>.<build ordinal>`. The installed app verifies all prepared
Components against its own catalog before using them. If the manifest is unavailable
or invalid, or a Component could not be prepared, the updated app installs it normally.

The macOS DMG uses LZMA (`ULMO`) because it is only the first-install download:
every later update goes through Sparkle, whose full-update archive is independent. On
the v0.5.1 App, LZMA cut the DMG from 831 MiB to 618 MiB and added about 40 seconds
of verification and copying on an M4 Max. A 2 MiB/s download saves almost two
minutes; above about 5 MiB/s the first install takes slightly longer overall, once.
bzip2 (`UDBZ`) is both larger and slower to open than LZMA, and LZFSE (`ULFO`) saves
only 13 MiB.

macOS full updates use one `.tar.xz` archive, signed over its exact compressed
bytes with Ed25519. Archive creation preserves bundle files, executable modes,
and symlinks, orders entries deterministically, and excludes AppleDouble metadata
with `COPYFILE_DISABLE=1`. Distribution extracts it with the pinned updater's
piped `/usr/bin/tar -zxC` command before signature, provenance, and runtime checks.
Each new release publishes a single full archive. Verification of published
releases and delta generation use the exact archive name recorded in each
release. Compatible releases with ZIP archives remain delta sources.

Compression uses `xz -9 -T3 --memlimit-compress=4GiB --no-adjust`. Three workers
match the standard hosted Apple silicon runner's three CPUs and fit its 7 GiB
RAM. The memory limit prevents unbounded worker allocation without lowering the
compression preset. Build processes finish before compression starts. The macOS
Distribution job retains GitHub's default six-hour timeout. Allow extra time for
compression in Distribution and background extraction on clients. Measure archive
bytes, encoding time, and updater-equivalent extraction time when the bundle changes.

DMG notarization treats Apple's submission record as the verdict. An upload that
drops before Apple returns a submission ID is submitted again, and a status wait that
drops keeps following the same submission. Each step makes up to three attempts. An
Invalid or Rejected verdict prints Apple's log and fails without retrying.

Distribution executes the stateful packaged runtime
smoke once against the extracted notarized full-update App, including launch and the
symlinked CLI/Core/ripgrep workflow. The mounted DMG receives structural,
signature, notarization, and provenance verification only; matching sealed
provenance proves it contains the same App without repeating stateful smoke.
The launch check owns a verified isolated-run lease, so the extracted App does
not open the interactive move-to-Applications flow or mutate an installed copy.
Success requires the matching Electron host claim to reach full Main-runtime
readiness and the matching Core generation descriptor to exist. Startup has a
bounded CI deadline, captures bounded process and Profile logs on failure, and
terminates the complete Electron process group before releasing the lease.
The Codex smoke seeds first-use demand in the disposable Profile and waits
for the packaged app to download, verify, and activate the Component without
credentials. Add `--launch-app --verify-codex-install --expected-updates disabled`
to `verify-native-runtime.ts` for a local package staged with updates disabled.
Add `--verify-desktop-tools-install` to also wait for Desktop Tools activation.
Runtime-probe teardown uses bounded filesystem retries because a stopped macOS
Browser helper can briefly race recursive removal of its temporary Profile.
The in-process clipboard bridge is built for Apple silicon,
sealed in package provenance, and checked for the required Mach-O architecture,
minimum macOS version, signature and entitlements. Full Main readiness also
requires loading the packaged bridge; a source-only or cross-compiled probe does
not replace these packaged checks.
On arm64 macOS 15 or later, that probe must also complete a real Computer Use
tool call through the vendor-signed `Node -> Codex -> node_repl` ancestry, plus
the materialized plugin, private host-services socket, `sky.node`, and canonical
helper app. The primary app-server is the digest-pinned, unmodified package from
the locked official Codex release; Nodex neither rebuilds it nor publishes a
second copy.
The managed Computer Use service starts with the verified Desktop Tools Codex CLI and
its owning Profile in an explicit process environment. Its short-lived native
launcher preserves the vendor spawn behavior and gives disclaimed descendants
non-pipe stdio; it never depends on another installed app or a PATH lookup.
The probe runner uses a temporary LaunchServices background app so helper stdio
matches an ordinary desktop launch instead of inheriting CI pipe fd guards.
Distribution materializes the pinned Codex and Desktop Tools archives into an
isolated Component store and runs conformance with the extracted notarized full-update
app and its packaged native peer authorization. Codex provenance binds the upstream
URL, archive size and SHA-256, staged metadata and entrypoint digests, and protocol
schema fingerprint. The Desktop Tools tested-pair check uses the app-server
identity in the Codex lock. Both the full-update and DMG checks enforce the
installed-size budget and reject bundled Component payloads.

## Nodex Mobile

The phone app ships in lockstep with the desktop release it was built from, because
a phone and a desktop connect only at the same protocol revision. The Release
Module derives its store versions from the Release Identity
(`scripts/release/mobile.ts`): a stable release keeps `x.y.z`, a Nightly takes the
`x.y.(z+1)` it leads up to, iOS builds use the Apple build version and Android
version codes use the first-parent ordinal, so builds rise across both channels.
`_mobile-distribution.yml` builds both platforms from the exact certified source
for Nightly and Rehearsal:

- **Android** builds on `ubuntu-latest` for 64-bit Arm. The APK must carry the
  Release Identity's versions and exactly one signer, the Nodex release
  certificate pinned as `ANDROID_SIGNING_CERTIFICATE_SHA256`; a debug-signed
  build never enters a bundle. An installed APK accepts updates only from that
  key. A Google Play listing must enroll the same key in Play App Signing, so
  people who installed the APK can update through Play.
- **iOS** builds on `macos-26`. Xcode archives with an ad hoc signature to
  preserve the target entitlements. The App Store Connect key authorizes
  cloud-managed App Store signing during export. The IPA must carry the
  release's versions and the Nodex team for the app and its notification, share,
  and action extensions. The app needs production push, the app and notification
  extension need the shared push keychain group, and the app and both share
  targets need `group.app.jyu.nodex.mobile`. Register that App Group with the
  Nodex team before export. Cloud-managed signing with `-allowProvisioningUpdates`
  provisions the extension App IDs.
  The bundle certifies it under `testflight/` without publishing it.

After a stable release is published, the direct `testflight` job uploads exactly
that certified IPA, waits for Apple to process it, names the desktop release in
its tester notes, adds it to the external **Public beta** group behind the
download page's TestFlight link, and submits it to Beta App Review. Every step is
idempotent: a build App Store Connect already holds is reused, and a repeated promotion can
finish an existing build's group and review steps after the private IPA has
expired, but never uploads a rebuilt one. Nightly and Rehearsal build and verify
both apps without publishing them; internal testers receive every uploaded build.
`vp run ios:testflight` in `packages/mobile` sends a clean checkout's Nightly
build to internal testers through the same path.

Beta App Review covers the first build of each version, usually within a day.
Change the mobile protocol revision only when the phone app can be approved
before the desktop release that requires it reaches people.

## Build Identity and Release Identity

The channel-free **Build Identity** records the source commit and tree, source
date, source `version`, first-parent ordinal and `buildVersion`. The source
certificate, prepared output, packaged provenance and native build manifests
all bind to this identity.

`package.json`, the Cargo workspace and its entries in `Cargo.lock` carry the
next version on `main`. Every binary displays that source `x.y.z`. The encoded
first-parent ordinal is the monotonic update key across both channels (ordinal
842 gives `1.8.42`). Distribution uses `nodex@<version>+<buildVersion>` for Sentry.

The **Release Identity** adds a channel and tag to the Build Identity. Stable
uses `v<x.y.z>`. Nightly uses `v<x.y.z>-nightly.<YYYYMMDD>.<ordinal>` with the
source commit's UTC date. Nodex starts on Stable and honors the update channel
selected in Settings.

## One-time repository configuration

The repository must have these environments, restricted to protected `main`.
They separate deployment policy and audit. Reusable workflows receive only the
explicit repository-secret contract declared by their caller; protected
environment secrets are resolved only by direct jobs.

| Environment                 | Authority                                                                        |
| --------------------------- | -------------------------------------------------------------------------------- |
| `release-source`            | Secret-free protected-main source and candidate verification                     |
| `macos-distribution`        | Apple signing/notarization; Sentry upload from each official Nightly arm64 build |
| `mobile-distribution`       | Sign the Android APK and the App Store iOS build                                 |
| `testflight`                | Upload the certified iOS build and submit it to the public TestFlight beta       |
| `sparkle-feed-finalization` | Sign macOS and Windows appcasts and enclosures after every native build passes   |
| `release-publish`           | Job-scoped repository `contents: write` and the release tag credential           |
| `official-skills-publish`   | Publish the verified artifact to `NodexApp/skills`                               |
| `homebrew-tap`              | Update and smoke-install `junyudev/homebrew-tap`                                 |
| `landing-production`        | Deploy `NodexApp/NodexApp.github.io`                                             |

Configure these repository Action secrets:

| Secret                                                              | Required authority                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                                      | Base64 Developer ID Application `.p12` certificate and its export password                                                                  |
| `APPLE_API_KEY_B64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`         | App Store Connect team key with the App Manager or Admin role: notarization, iOS signing and TestFlight                                     |
| `ANDROID_RELEASE_KEYSTORE_B64`, `ANDROID_RELEASE_KEYSTORE_PASSWORD` | Base64 PKCS12 Android release keystore (alias `nodex`) and its password; keep an offline copy, since no other key can update installed APKs |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`                 | Release/source-map upload for the Nodex project                                                                                             |
| `NODEX_SKILLS_GITHUB_TOKEN`                                         | Fine-grained Contents read/write on `NodexApp/skills` only                                                                                  |
| `HOMEBREW_TAP_GITHUB_TOKEN`                                         | Fine-grained Contents read/write on `junyudev/homebrew-tap` only                                                                            |
| `NODEXAPP_GITHUB_IO_TOKEN`                                          | Fine-grained Contents read/write on `NodexApp/NodexApp.github.io` only                                                                      |

Configure `NODEX_RELEASE_TAG_TOKEN` as an environment secret on
`release-publish`: a fine-grained token with Contents and Workflows read/write
on `junyudev/nodex` only. A release source usually trails `main`, and GitHub
refuses the workflow token any tag whose workflow files differ from `main`'s.
Nightly and Release create the tag in a direct `release-publish` job with this
credential; publication then reuses the tag with the workflow token.

Configure `SPARKLE_ED25519_PRIVATE_KEY` as an environment secret on
`sparkle-feed-finalization`, not as a repository-wide secret and not as a
caller-supplied `workflow_call` secret. `Release`, `Nightly Release`, `Distribution Rehearsal` each own direct finalizer jobs bound to that environment and
pass the value only to the repository-local Sparkle finalization action. The
reusable native-distribution and Bundle-assembly workflows never declare or
receive the key. Repository guards reject reusable-workflow transport and any
reference outside a direct protected finalizer.

Each caller maps the repository secrets above to lowercase
`workflow_call.secrets` aliases. Do
not replace the mappings with broad `secrets: inherit`, and do not reference a
repository secret from PR CI. The Sparkle key is the deliberate exception: it
is resolved only by each top-level protected job and never crosses a reusable
workflow boundary. The alias boundary for all other credentials avoids relying
on implicit secret inheritance or same-name precedence inside nested reusable
workflows. Record PAT expiry dates in release operations and rotate them before
expiry. Remove duplicate credentials from the legacy `release` environment
after rehearsal succeeds.

The official Skills publisher authenticates Git through a GitHub-scoped Basic
extra header and keeps credentials out of remote URLs. Historical mirror inventories
are verified against their own manifest tree digest, file count and byte count;
the current candidate still requires the complete current inventory and exact
Release Bundle hashes. Adding a Skill reference must not make a valid older
mirror impossible to upgrade.

Publishing tools are pinned to the protected workflow commit, separately from
the immutable application source. The GitHub publisher reads one release by
tag, using the draft's database ID when needed. Recovery verifies the exact
Bundle and existing asset digests before reusing a draft. Skills are regenerated and smoke-tested
from the release source, then passed by absolute path to those publishing tools.
Homebrew casks are derived from the verified Bundle using the pinned promotion
tools and keyword-free download URLs; do not emit the deprecated `verified:`
URL parameter. Recovery never changes the release source, tag or asset hashes.

Promotion additionally
configures `gh auth setup-git` as a workflow-owned recovery seam, so an
immutable older release source can still be republished without changing its
tag or checkout. Homebrew promotion registers `junyudev/tap` with `brew tap`
and grants runner trust to the specific `junyudev/tap/nodex` cask before loading
it for audit or smoke installation. Promotion runs Homebrew's own cask
autocorrect inside that registered tap before its exact idempotency comparison,
so recovery can safely normalize derived output from an immutable older release
source without weakening version or checksum conflict rejection. Both
`brew style --cask` and `brew audit --cask` address the registered cask by its
fully qualified tap name so Homebrew resolves it inside `junyudev/tap`.

The Homebrew job supplies its read-only GitHub Actions token through
`HOMEBREW_GITHUB_API_TOKEN` for authenticated API reads during both online audit
and smoke installation. The tap-scoped write token remains the separate
`GH_TOKEN` used by the publish step for Git authentication; Homebrew API reads
must not depend on that token or anonymous rate limits.

Distribution imports the Developer ID certificate into a per-job local
keychain using a random keychain password, grants non-interactive Apple tool
access with that keychain password, masks the generated password before any
security command can log it, and removes both the keychain and decoded
credentials in an `always()` cleanup step. Partial credential-file or job
environment setup failures use the same immediate cleanup boundary as
keychain failures. Command failures report only the failed Security.framework
operation, never its arguments. Electron Builder
discovers the installed identity but does not own credential import or
temporary-keychain creation.

Enable immutable GitHub Releases and keep the Stable app release marked
Latest. Limit protected release environments to `main`. The `main` ruleset
requires linear history and blocks force pushes and deletion. Allow the
workflow token to fast-forward `main` for the release advance. Keep default
Actions permissions read-only. The advance job requests `contents: write`
to push and `actions: write` to dispatch the landing deployment. Maintainers
who dispatch promotion need Actions write permission. The `v*` ruleset must
allow release tag creation and prevent tag moves.

Set `NODEX_NIGHTLY_RELEASES_ENABLED=true` to admit scheduled and manually
dispatched Nightlies. Configure the Sentry credentials for Nightly before
enabling it. Keep artifact retention at 14 days or longer. Pin external
Actions to full commit SHAs.

## Sparkle update signing and feeds

Sparkle 2.9.4 and its command-line tools are pinned by
`resources/sparkle/sparkle.lock.json`. Production apps carry the public key in
both their signed runtime identity and `Info.plist`. macOS clients require a signed
feed and verify the update signature before extraction. The stable feeds are:

```text
https://nodex.jyu.app/updates/stable/arm64/appcast.xml
https://nodex.jyu.app/updates/stable/windows-x64/appcast.xml
```

The isolated Nightly feeds are:

```text
https://nodex.jyu.app/updates/nightly/arm64/appcast.xml
https://nodex.jyu.app/updates/nightly/windows-x64/appcast.xml
```

GitHub Release stores immutable macOS full-update archives, Windows installers,
deltas, update manifests, and signed appcast snapshots. Stable releases are Latest.
Nightly releases are prereleases and never update Homebrew or official Agent Skills.
Stable site deploys replace only `updates/stable/`; Nightly publication stages
and commits only `updates/nightly/`, so neither channel can delete the other.
Every enclosure URL uses its exact tag; no feed
uses `/latest/download`. The finalizer accepts history only from an immutable
Release in the same channel whose tag resolves to the Release Bundle source SHA. Before it signs a
release, it proves the protected private key matches the reviewed public key
and that the extracted App plist/runtime carry that key; the Apple silicon build
must also use the pinned Developer ID Team ID `8HGUT3HC4Z`.

Update targets use the package-provenance module’s current format. History selection
verifies the immutable Release Bundle and update-manifest digests before checking
package-format compatibility. The finalizer skips older package formats before
downloading the full archives and rejects malformed or invalid candidates. An empty
compatible history publishes a full update without deltas. Stable generates
deltas from the three newest compatible Stable builds and Nightly from the two
newest Nightly builds; older installs take the signed full archive. Delta
generation and its round-trip check are the longest part of feed finalization,
so raise these limits only with a measured finalizer time.
A prior build also takes the full archive when a file over 128 MiB differs between
it and the new build, such as a new Codex runtime or Electron Framework. Sparkle
diffs every changed file in memory at about 33 times its size, which the hosted
finalizer cannot hold, and such a delta saves little. The finalizer's log names the
file, and its job stops after two hours.
Each feed contains one release item for its channel and architecture. Prior
archives are inputs to delta generation, and their verified Release Identities
map source build numbers to display versions and archive files for round-trip
verification. The generated feed references only enclosures in the new Bundle.

Compatible history moves between fetch and finalization as a JSON manifest of
absolute directory paths. Task-runner stdout is diagnostic output, never the
machine-readable directory list. Empty history is an empty array; paths do not
depend on shell delimiters or GitHub step-output parsing.

`Distribution Metrics` runs daily on the default branch and reports the change in release downloads
since its latest snapshot. It stores the snapshot as a workflow artifact after Statsig accepts the
report. If the artifact expires or is deleted, the next run with no remaining snapshot records a
baseline.

The same job reports appcast requests for the previous UTC day. Set the repository Actions secret
`CLOUDFLARE_ANALYTICS_TOKEN` to a Cloudflare API token with Zone Analytics Read scoped to `jyu.app`.
The job summary shows whether Cloudflare returned appcast traffic, observed zero appcast requests
alongside other host traffic, or left the result unavailable. See
[Product Analytics Behavior](product-specs/product-analytics-behavior.md#website-and-distribution).

`Nightly Retention` keeps the newest 20 published Nightly releases and every
release younger than 14 days. It also protects every tag referenced by any
live Nightly appcast and deletes only immutable releases whose downloaded
Release Bundle index exactly matches the remote asset digests. A feed fetch or
Bundle verification failure fails closed. Scheduled runs are dry-run only.
Destructive mode is available only through manual dispatch and the protected
`nightly-retention` environment. Deleting an immutable Nightly release is
allowed after promotion because Stable owns its copies and its feeds and cask use the Stable tag.

The key was created with the official tool under Keychain account `NodexApp`.
These commands recover or inspect it without generating a second identity:

```bash
vp run materialize:sparkle:mac
.generated/sparkle-toolchain/2.9.4/bin/generate_keys --account NodexApp -p
.generated/sparkle-toolchain/2.9.4/bin/generate_keys --account NodexApp \
  -x /absolute/path/outside-the-repository/nodex-sparkle-private-key
```

Import an exported backup on a replacement release Mac with:

```bash
.generated/sparkle-toolchain/2.9.4/bin/generate_keys --account NodexApp \
  -f /absolute/path/to/nodex-sparkle-private-key
```

The repository owner may retain a mode-`0600`, gitignored convenience copy in
`notes.local/secrets/private/values.json` under `sparkle.private_key`. Consult
`notes.local/secrets/catalog.json` for credential references without exposing
values. This plaintext store does not replace the required independent
encrypted offline backup. To restore CI, pipe the key into the
environment secret without echoing it:

```bash
security find-generic-password \
  -a NodexApp -s https://sparkle-project.org -w \
  | gh secret set SPARKLE_ED25519_PRIVATE_KEY \
      --repo junyudev/nodex --env sparkle-feed-finalization
```

Never paste the private key into a workflow file, release artifact, command
argument, cache, appcast, issue, or log. If both Keychain and offline copies are
lost, stop ordinary feed publication and follow Sparkle's signed-feed recovery
procedure with a higher-version Developer ID signed and notarized recovery
image; do not upload an unsigned replacement archive or rewrite an immutable
release.

### Windows signed update contract

Windows finalizers use the same pinned Sparkle `sign_update` tool and protected
Ed25519 key as macOS. The direct protected job matrix covers `arm64` and
`windows-x64`; reusable workflows never receive that key.
Each Windows feed has exactly one item with the Release Identity build version,
display version, source publication date, embedded release notes, and one
`application/octet-stream` enclosure marked `sparkle:os="windows"`. Its URL is
the immutable tag's versioned installer, never a Latest alias. The enclosure's
length and Ed25519 signature cover the exact installer bytes. The appcast is
also signed with Sparkle; its closed update manifest records a detached
signature over the final XML bytes. Assembly independently verifies both
signatures against `resources/sparkle/public-key.txt` before accepting the Bundle.
This authenticates update bytes; Windows installers do not yet use Authenticode.

Native distribution passes `NODEX_BUILD_IDENTITY_PATH` and
`NODEX_APP_UPDATES=enabled` through build and packaging. Windows CI validation
uses `NODEX_APP_UPDATES=disabled`. Enabled manifests carry both feed URLs and
disabled manifests use `feedUrls: null`.

## Local gates

Use narrow checks while iterating. Before a release foundation or release
metadata PR is merged, run:

```bash
vp run verify:source
vp run verify:runtime:mac
```

`verify:source` is the platform-independent source gate: types, lint, generated
contracts, authority boundaries, build-resource and notices reproducibility,
Rust, app tests, browser tests, stress contracts, and landing build. Electron
E2E is an opt-in local diagnostic and is not part of source or release
certification. `verify:runtime:mac`
compiles the Clipboard, DeviceCheck, and Notifications bridges against the pinned
Electron headers and checks their real Mach-O architecture and deployment target,
then verifies Agent/Desktop Tool schemas and runtime conformance on macOS. Neither
proves Apple signing or Sparkle finalization; the signed Apple silicon
Distribution is that deeper Implementation.

Prepared Electron Main output must bundle source-only workspace packages. They
are build-time dependencies, not files for Electron's embedded Node runtime to
load from `app.asar/node_modules`; the prepared-build gate rejects any remaining
bare runtime load of such a package before packaging begins.

The application MCP transport is bundled separately at
`out/main/app-tools/server.mjs` and included in the prepared output inventory.
Packaging copies only that bundle to `Resources/app-tools/server.mjs` through
`extraResources` so bundled stock Node can execute it independently of Electron's
archive and a development dependency tree.
The transport bundle test exercises initialization and a complete tool call
from a temporary directory outside the repository.

Every distribution first consumes an exact-source certificate produced without
signing secrets. The certificate binds the full commit SHA and Git tree to the
deterministic source, browser, stress, and macOS runtime gates. Certification
derives its full CI gate plan from the exact source commit. Distribution
verifies both identities before materializing credentials, carries the
certificate in the architecture bundle, and then runs the packaged
process/runtime probes.

Nodex's Clipboard, DeviceCheck, Notifications, and Sparkle bridges target macOS 15.0. Keep their
GYP deployment target in `target_conditions`: Electron header defaults can
override ordinary `xcode_settings` during late condition expansion. After an
Electron upgrade, rebuild the Apple silicon app and inspect the resulting Mach-O
minimum versions; an environment variable alone does not enforce this contract.
Bridge builders verify the compiled minimum before publishing or reusing an output,
so an incompatible local binary cannot reach signing and notarization.

Stock Node runs `agent-runtime/entry.mjs` and the `app-tools/server.mjs` bundle
directly from Resources. Their files stay outside ASAR and its unpacked companion.
Prepared output hashes verify both entrypoints, and the after-pack gate compares
Agent Runtime dependencies byte-for-byte before signing. Electron Main loads its
own PTY dependency through ASAR. The macOS packaged smoke spawns a PTY with
`node-runtime/node` and the detached addon on every run, including headless
runs. The probe requires its output marker and exact exit status within the deadline.

The Mac after-pack gate requires `Contents/Resources/node-runtime` to contain
the locked executable, manifest, and license. It rejects a bundled Codex, Desktop
Tools or Document Tools runtime and enforces the 694,000,000-byte installed-size
budget, counting physical files and skipping framework symlinks. Set the budget from an installed-size
measurement when intentionally adding payload. The signing hook requires the
upstream Node.js Developer ID, hardened runtime, and secure timestamp, then
rechecks the locked binary after signing Nodex. Distribution requires deep
strict `codesign` verification, Gatekeeper assessment, notarization, and
stapling for the app and verifies the upstream Desktop Tools signature closure
in the Component store.
Desktop packages ship the locked [ripgrep runtime](../resources/ripgrep/README.md)
in `Resources/ripgrep-runtime`. The payload gate checks the closed executable and
license set for each architecture. macOS signs the executable with Nodex's
identity and verifies its pinned Mach-O content. Package provenance records the
lock and signed payload hashes. The Windows installer preserves the official
PE bytes. The installed-app probe runs ripgrep and checks its pinned version.

The Codex runtime verifier checks the Component's Mach-O files, including
`codex-path/rg`, against the OpenAI team in the release lock. The app's native
signature and entitlement checks cover the Nodex code objects in the bundle.
The signing hook continues to preserve the upstream standalone Node signature.
The dictation helper build stamp and packaged handshake check use the production
client's protocol version. Packaged conformance checks empty binding replacement,
permission capability reads without prompting, and clean helper exit; an
incompatible ready handshake fails immediately with the observed version.

`vp run test:all` remains a compatibility alias for `verify:source`.

## Nightly source selection

The verified commit supplies the Build and Release Identities, including the
source version and first-parent build ordinal. The run summary identifies the
commit, links its Main CI run, and counts the commits that have landed since it.
Pending and cancelled runs are skipped. The summary also links the newest failed
Main CI push on current `main` when its run is newer than the selected success.
A newer failure leaves the verified commit eligible.

The summary reports `eligible` when a candidate can proceed,
`no-verified-commit` when no successful push run verifies a reachable commit,
or `already-published` when the exact Nightly is already published and its
remote identity and assets verify. A commit that only advances a Stable release
reports `version-advance-only`. Certification independently verifies the exact
source on protected `main` before the build starts.

## Rehearse a candidate

Rehearse the exact protected-main foundation SHA before the first release after
release infrastructure or packaging changes:

```bash
gh workflow run release-rehearsal.yml \
  --repo junyudev/nodex \
  -f source_sha=<full-main-sha>
```

The secret-free `release-source` environment admits only a protected-branch
workflow definition. Inside that boundary, the shared provenance guard requires
the immutable SHA to be reachable from `main` and to have a successful
protected-main `Main CI` push run before any source checkout or execution.
The hosted Apple silicon runner uses that source and the protected signing environment.
The native Windows x64 runner builds and probes the same certified identity. Both
update finalizers and the complete Bundle assembly are required.
Rehearsal also uses the protected Sparkle finalization environment, but it does
not receive `contents: write`, Homebrew/landing credentials, or a Sentry upload
token. It creates no tag, Release, tap commit, feed commit, or production
telemetry release.

Download `nodex-release-bundle-<sha>` and inspect `release-bundle.json` and
`SHA256SUMS`. A rehearsal is required after release workflow, native packaging,
Apple signing, updater, Agent runtime, Browser runtime, or provenance changes.

## Ship a stable release

1. Land the candidate on `main`. Its release notes are the change files under
   `changes/` at that source, as [changes/README.md](../changes/README.md)
   describes. To choose a non-patch version, run
   `vp run release:version -- <x.y.z>` and commit the three version sources
   through the ordinary source workflow. `vp run release:check` validates the
   version sources, `CHANGELOG.md` and every change file.
2. Wait for **Nightly Release** to succeed and test the published Nightly.
3. Read what the Nightly would publish, write the release's headline, and
   dispatch **Release** with both. A blank tag selects the newest published
   Nightly. Without `--headline`, the local command prints the tag, source, age,
   version and entries and stops; with one, it dispatches and returns the run
   URL.

   ```bash
   vp run release:promote -- v0.5.5-nightly.20261111.2531
   vp run release:promote -- v0.5.5-nightly.20261111.2531 --headline "Team Spaces and coordinated Agent work"
   ```

   The headline sums up the one or two changes people will care about most. What's
   new, the changelog page and the release notes lead with it, so write a short
   phrase in product words, about 36 characters and never more than 48, with no
   Markdown and no closing period.

4. Once the stable release is published, create a **Todo** card titled
   `<version> 更新帖` on the growth Project's board in Nodex. Add the release
   headline, the two or three changes worth showing, and links to the release and
   the changelog page. An Agent in the growth Project prepares the post with a
   screenshot or short clip for each change. The person publishes it.

   ```bash
   nodex --project growth page create \
     --parent data_source:5f3bedb5-099b-7cfd-8ebc-f30f5e7bb153 \
     --title 'v0.5.13 更新帖' --set Status=plan --file - <<'EOF'
   Snooze, settle and organize chats

   - Snooze a chat until you're ready to return to it.
   - Settle finished chats to clear them from the sidebar.

   [Release](https://github.com/junyudev/nodex/releases/tag/v0.5.13) · [Changelog](https://nodex.jyu.app/changelog/)
   EOF
   ```

### Promotion path

The Release Module validates the immutable Nightly prerelease, protected-main
source, successful producing run and retained artifacts. Both app and build
versions must advance beyond the latest published Stable. An existing Stable
tag must point to the exact source. Before feed signing, the retained Bundle
and every public asset must match the published Nightly SHA-256 digests.
Assembly checks the Stable native and mobile hashes against that same verified
Nightly, including the private TestFlight payload.

The resolve job checks the headline and renders the release notes once: the
headline, then the source's change files by kind. The two feed finalizers and
the Bundle's `release-notes.md` use those exact bytes. A Nightly built before
any change file landed has nothing to release and is turned away.

The protected finalizers sign the two Stable feeds, using previous Stable
archives for compatible macOS deltas. The assembler uses the retained native
and mobile builds. The publisher reuses or creates the annotated tag and
publishes the immutable release as GitHub Latest. It verifies the public assets
and projects the signed feeds, cask and Agent Skills. TestFlight receives the
retained iOS build. For internal testers, run the mobile package's
`ios:testflight` command with the retained Nightly Bundle's
`release-bundle.json` path. Use the same App Store Connect team credentials.

The advance job reads the notes the published release carries, headline
included, checks them against the source's change files and adds them to
`CHANGELOG.md` under a dated heading using the GitHub publication date. It
deletes the change files the release published; a change file edited on `main`
after the source was cut stays for the next release, as does every change added
since. The job advances the version sources by one patch, or keeps a higher
version already chosen on `main`, and retries on a fresh parent if a push races.
It dispatches **Deploy Landing Site** after the push. A pages-only deploy
preserves both update subtrees. The download page displays the latest dated
changelog release.

### Resume a release

Dispatch **Release** again with the same explicit Nightly tag within the
retention window. If the Stable tag exists, the workflow restores the retained
Stable Bundle, checks its build bytes again and resumes publication and
downstream jobs. If only the advance or landing deployment failed, the advance
job summary prints these commands with the exact tag and repository:

```bash
vp run release:advance -- <stable-tag> --repo junyudev/nodex
gh workflow run deploy-landing-site.yml --repo junyudev/nodex --ref main
```

An advance failure leaves the release available. For a failed Nightly, rerun the
failed jobs in its original run so the certificate and retained artifacts stay
associated with the producing run.

## Desktop Tool runtime releases and Latest

The Desktop Tool release lock selects a separate closure for each target.
Apple silicon includes Browser Use, Computer Use and native PiP. Windows x64
includes Browser Use and Computer Use. Each lock entry pins the archive,
manifest and runtime versions. A local candidate has a null URL and can be
materialized from a supplied archive or the digest-addressed cache. Automated
packaging selects published assets.

The Desktop Tool release must never become the app Latest release. Publish
published-target archives through:

```bash
vp run browser-runtime:publish -- \
  --repo junyudev/nodex \
  --tag browser-runtime-v<build> \
  --lock <reviewed-candidate-lock.json> \
  --arm64 <macos-arm64-archive>
```

Runtime releases are immutable. Use an unused successor tag for a new archive
or target. Keep every macOS archive publicly downloadable for as long as any
supported app release pins it. Distribution checks the exact locked URL and
byte length against the published asset independently of the local cache, and
materializes the digest-verified archive for the packaged conformance gate.
Review the candidate closures and exact app-server pairs, then run from the
reviewed source commit after the owner approves distribution.

```bash
(
  set -euo pipefail
  runtime_lock=resources/browser-runtime/browser-runtime.lock.json
  runtime_cache=/Users/asc/repo/nodex/cache.local/browser-runtime
  runtime_tag='<unused-successor-tag>'
  runtime_candidate=$(mktemp)
  runtime_downloads=$(mktemp -d)
  trap 'rm -f "$runtime_candidate"; rm -rf "$runtime_downloads"' EXIT
  jq --arg tag "$runtime_tag" '
    .tag = $tag
    | .repository as $repo
    | .assets |= map_values(.url = ("https://github.com/" + $repo
        + "/releases/download/" + $tag + "/" + .assetName))
  ' "$runtime_lock" > "$runtime_candidate"
  runtime_archive() {
    jq -r --arg cache "$runtime_cache" --arg target "$1" '
      .assets[$target] | $cache + "/" + .archiveSha256 + "/" + .assetName
    ' "$runtime_candidate"
  }
  git tag "$runtime_tag" HEAD
  git push origin "refs/tags/$runtime_tag"
  vp run browser-runtime:publish -- \
    --repo junyudev/nodex --tag "$runtime_tag" --lock "$runtime_candidate" \
    --arm64 "$(runtime_archive darwin-arm64)" \
    --win32-x64 "$(runtime_archive win32-x64)"
  gh release download "$runtime_tag" --repo junyudev/nodex \
    --dir "$runtime_downloads"
  jq -r --arg dir "$runtime_downloads" \
    '.assets[] | .archiveSha256 + "  " + $dir + "/" + .assetName' \
    "$runtime_candidate" | shasum -a 256 -c -
  cp "$runtime_candidate" "$runtime_lock"
)
```

If publication is interrupted after pushing the tag, confirm it still resolves to
the reviewed source commit and rerun from the publication command with the same
candidate lock. After verifying the downloaded archives, commit the lock and require
conformance on the platforms whose archives it pins. Run macOS conformance
with the downloaded Component and Windows conformance from each native
installer before publishing the app release.

The publication command requires the reviewed release lock, proves the archive's name,
size, hash, manifest, target architecture, and complete artifact closure,
then creates or resumes an exact draft, uploads only missing assets, publishes
only after creating against `--verify-tag`, forces `--latest=false`, and asserts
Latest is unchanged. Create and push the runtime tag at an exact reviewed Nodex
source commit first; do not use a bare `gh release create` for runtime releases.

The primary Agent runtime's canonical lock binds the official Codex tag and
peeled source commit, official checksum manifest, Apple silicon
`codex-app-server-package-*` bytes, legal evidence, stable upstream entrypoint
identity, staged metadata, and generated protocol schema. Nodex does not rebuild,
patch, republish, or re-sign Codex runtime assets: their exact bytes and OpenAI
Developer ID signatures remain intact. The locked app-server entrypoint digest
is the stable Browser compatibility identity; package signing and notarization
seal the containing Nodex application independently.

Generate upgrades from an explicit reviewed base lock and the downloaded
official Apple silicon archive:

```bash
vp run agent-runtime:relock -- \
  --base-lock <base-lock.json> \
  --arm64 <official-arm64-archive> \
  --out <candidate-lock.json>
```

The candidate command verifies the official archive closure and derives the
entrypoint and staged-metadata identities. It never builds source, overwrites the
canonical lock, or publishes assets. Review and install the candidate
deliberately, then stage from an empty cache and run schema plus conformance
probes for Apple silicon. The complete lock, staging, and probe procedure is
owned by
[`resources/agent-runtime/README.md`](../resources/agent-runtime/README.md).

## Document Tools runtime releases

Apple silicon macOS builds pin the Document Tools archive, including managed Python
and document libraries, in `resources/workspace-runtime/workspace-runtime.lock.json`.
The [runtime release procedure](../resources/workspace-runtime/README.md#stage-sign-archive-publish-and-pin)
covers staging, signing, archiving, guarded publication, and pinning. Publish to an
immutable `workspace-runtime-v<distributionId>` tag without changing GitHub Latest.
Keep the archive downloadable while supported Nodex releases pin it.

Distribution checks the pinned asset's URL and byte length independently of the local
cache. It runs the document smoke with signed Python from a fresh extraction of the
digest-verified archive. After-pack and app provenance checks reject a bundled
`Contents/Resources/workspace-runtime`.

## Post-release acceptance

For v0.2.1, run:

```bash
gh release view v0.2.1 --repo junyudev/nodex \
  --json tagName,targetCommitish,isDraft,isImmutable,isPrerelease,assets,url
gh release verify v0.2.1 --repo junyudev/nodex
gh api repos/junyudev/nodex/releases/latest --jq .tag_name
gh release download v0.2.1 --repo junyudev/nodex \
  --pattern release-bundle.json --pattern SHA256SUMS \
  --dir .generated/v0.2.1-remote
vp run release:verify:remote -- \
  --repo junyudev/nodex \
  --bundle .generated/v0.2.1-remote/release-bundle.json
gh api repos/NodexApp/skills/git/ref/tags/v0.2.1 --jq .object.sha
curl --fail --silent https://nodex.jyu.app/updates/stable/arm64/appcast.xml \
  --output .generated/v0.2.1-remote/appcast-arm64.xml
```

The remote verifier needs only `release-bundle.json` and `SHA256SUMS` locally.
It reconstructs the exact asset allowlist from those files, then downloads every
published asset once into a temporary directory and verifies its byte length and
SHA-256 digest before removing the temporary copy.

GitHub may expose published immutable assets before their signed release
attestation is readable. An exact `gh release verify` missing-attestation response
is retried only after the same repository tag is readable at that exact digest
and the raw release-attestation API confirms absence with a specific 404 response
or a valid response without a GitHub-issued attestation. Stable and Nightly
publish jobs receive only `attestations: read` for
this check. Raw authorization, transport, malformed-response, and timeout errors
stop immediately; an attestation that is already present cannot trigger a retry.
Verification allows at most 12 attempts with ten seconds between attempts and a
30-second limit per command. Successful cryptographic verification, tag identity,
remote asset digests, and downloaded bytes are still required before feed
promotion. Exhaustion fails publication.

The 0.2.1 baseline must contain zero deltas because 0.2.0 and earlier are not
compatible history. Also verify the stable Apple silicon DMG URL, a clean Apple Silicon
install/first launch,
`nodex --version`, one Core-backed project operation, one Agent thread, one
Browser operation, a full-only update check from the 0.2.1 baseline,
Homebrew install/upgrade, and the
landing download link. Confirm `npx skills@latest add NodexApp/skills`
discovers exactly the `nodex` Skill. `releases/latest` must be `v0.2.1`, never
a Browser runtime tag.

An incremental rehearsal must consume a compatible published Apple silicon full
archive, record the emitted delta size, prove `BinaryDelta apply` produces the
exact target app, and exercise one real installed update. Corrupt-delta/full-archive
fallback remains a release-candidate/manual check; a unit fixture alone is not
sufficient evidence.
