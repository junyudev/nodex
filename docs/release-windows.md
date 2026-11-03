# Windows packaging runbook

Nodex builds Windows 11 installers natively for x64 and arm64. The Windows
workflow and official release pipeline share one native distribution implementation.
Stable releases and Nightly prereleases include both CPUs in the same verified
Release Bundle as macOS arm64. [Application releases](release.md) owns identity,
certification, protected finalization, promotion, Rehearsal, and Recovery.

## Build an installer

Use the [Windows development prerequisites](development.md#windows-11-x64-and-arm64)
and a clean worktree on a matching native Windows host:

```powershell
vp install --frozen-lockfile
vp run package:win:x64
# Or, on native Windows arm64:
vp run package:win:arm64
```

`package:win` selects the host CPU. Packaging builds the application, stages the
native runtime, verifies the prepared output, then invokes electron-builder NSIS.
The reusable Windows distribution runs build, staging, architecture verification,
packaging, and the installed-app probe through one repository-owned Release Module. Its `package:win:prepared <arch>` entrypoint verifies the existing prepared
build and generates the Windows update manifest before packaging; it does not rebuild or restage source.
A target CPU different from the build host is rejected. The artifacts are:

| Architecture | Installer                                  |
| ------------ | ------------------------------------------ |
| x64          | `dist/Nodex-<version>-win-x64-setup.exe`   |
| arm64        | `dist/Nodex-<version>-win-arm64-setup.exe` |

The one-click installer is per-user, includes no elevation helper, and requests no administrator access.
Its application identity is `app.jyu.nodex`. It installs under the user's Programs
directory and registers `nodex://` before first launch at
`HKCU\Software\Classes\nodex`, with the URL Protocol marker and the command
`"<install-directory>\Nodex.exe" "%1"`. NSIS owns packaged Windows registration;
launching the application does not rewrite it. Uninstall removes application files,
Start Menu/Desktop shortcuts and that protocol registration when it still points
to this installation. The installed Profile defaults to `%USERPROFILE%\.nodex`;
uninstall preserves it. `vp run sync:icons` derives `resources/icon.ico` from
the committed PNG icon through the pinned packager's icon tooling.

NSIS runs installation-scoped process shutdown before replacing or removing any
payload files. Before install-over, it refreshes the installed maintenance
uninstaller from the incoming installer, so older process checks cannot run.
It extracts its own maintenance Core and PowerShell script outside the installation
and runs maintenance from the temporary directory, keeping working-directory
handles outside the files being replaced or removed.
The desktop gets a short ordinary-close window, then each detached Core receives
an authenticated shutdown for the PID discovered under that installation. Core
gets eight seconds to drain; a bounded forced pass rechecks each remaining image
path using the same native handle used for termination. No process-name-wide or
descendant-tree termination is used. A sibling directory with the same prefix is
outside the installation. Failure aborts maintenance before file replacement.

## Runtime closure

The Windows payload contains native Core and CLI executables, the locked official
Codex app-server package, separately locked Node, the standalone Agent Runtime,
official Agent Skills, and third-party notices. It omits macOS bridges/helpers,
Sparkle, Browser/Computer Use, and the Python workspace runtime.

Codex archive hashes, file inventories, entrypoint hashes and canonical runtime
metadata digests are pinned separately for both Windows CPUs. Node's executable
hash/size and license hash are pinned in `node-runtime.lock.json`. node-pty's
matching N-API prebuild is copied to a private output and loaded by staged Node;
the root dependency remains Electron's own rebuild. Only each runtime's required
`build/Release` closure ships; fallback prebuilds, PTY debug symbols and application
source maps are excluded.

Both Windows and macOS ship one Claude Code executable, beside the standalone
Agent Runtime's SDK under `app.asar.unpacked/out/agent-runtime/node_modules`.
Main loads that SDK by its explicit unpacked module URL for discovery and isolated
history workers. Source development and tests use the installed SDK. Configured
Agent executables remain authoritative; sharing the SDK does not change executable
or account selection.

The after-pack hook compares the complete standalone dependency tree byte-for-byte,
requires Electron's rebuilt PTY helpers, and rejects a second Claude executable
(including inside ASAR), an extra SDK/platform package, redundant PTY prebuilds,
debug symbols or application source maps. It also scans every PE image in the complete unpacked payload, including renamed images,
for CPU identity and ordinary/delay-load dependency closure. A foreign CPU or
unresolved dependency fails before an installer is emitted. The installed-app
probe repeats the same static inspection.

Manual architecture checks are available independently:

```powershell
vp run verify:runtime:win .generated/codex-runtime x64
vp run verify:runtime:win .generated/node-runtime/win32-x64 x64
vp run verify:runtime:win dist/win-unpacked x64
```

For arm64, use `arm64` and electron-builder's `dist/win-arm64-unpacked` directory.
NSIS's bootstrap is an installer launcher; its own machine type is distinct from
the verified installed payload CPU. The installed probe also recognizes only
the exact NSIS maintenance uninstaller as a bootstrap; an application binary
with a different CPU still fails, regardless of its extension.

## Clean-machine dependency policy

Nodex-built MSVC targets use static CRT through the repository Cargo configuration;
Core and CLI staging additionally require OS-only imports. Do not fix a first-party
CRT dependency by copying a runtime beside it. This policy also applies to future
Nodex-built Windows executables and addons.

`scripts/windows-pe.mjs` reads PE32/PE32+ headers, file-backed section RVAs, import
and delay-import descriptors. Every DLL must be an inbox Windows 11 component in
`scripts/windows-system-dlls.mjs`, an `api-ms-win-*`/`ext-ms-*` API set, or a regular,
matching-CPU file in the importing image's own directory. Every app-local dependency
is itself inspected. Neither PATH, the build host's System32, nor a DLL in a sibling
directory satisfies an import. Unknown DLLs fail with the consumer, DLL name and
table kind. Malformed tables fail closed.

The allowlist is a reviewed list of Windows OS facilities: base process/security,
COM, shell/UI, network, graphics/audio, and tracing APIs. `ucrtbase.dll` and the
UCRT API sets ship with Windows; `vcruntime*`, `msvcp*`, debug CRT, provider DLLs,
and toolchain DLLs do not. Add a name only after checking Microsoft's Windows API
requirements for the supported Windows edition; a successful load on a build
runner is insufficient. OpenConsole's inbox dependencies include IME/Uniscribe,
Direct2D and `d3dcompiler_47.dll`, and [Windows ICU](https://learn.microsoft.com/en-us/windows/win32/intl/international-components-for-unicode--icu-)
(`icu.dll`, present since Windows 10 1903). The pinned terminal payload is scanned
recursively for both CPUs in unit tests, including its nested OpenConsole helper.
The installed native Claude SDK is also checked before packaging; its `WSOCK32.dll`
delay import uses the inbox [Winsock compatibility layer](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-wsaisblocking).
The only non-DLL host binding is node-gyp's `node.exe`
delay import in `.node` addons: its delay-load hook binds the already-loaded
Node/Electron process. Callers must supply and verify the matching-CPU host;
this does not excuse ordinary imports or DLL dependencies.

For third-party binaries, `scripts/windows-vc-runtime.mjs` locates Visual Studio
with `vswhere`, selects the newest retail `VC/Redist/MSVC/<version>/<arch>/Microsoft.VC*.CRT`,
and copies only missing reviewed VC runtime imports beside their consumers,
including transitive runtime dependencies. It never copies from System32 or PATH,
rewrites vendor images, installs a machine-wide prerequisite, or includes debug
runtimes. Architecture is checked before copying. Codex staging supplements its
locked upstream inventory after computing the canonical metadata, so upstream
hashes remain unchanged; supplemental files are regenerated on restaging. The
after-pack hook also closes Electron's third-party payload before the final scan.
Microsoft's license notice is included in `THIRD_PARTY_NOTICES.txt`. App-local
runtime security updates are delivered through new Nodex builds.

This follows Microsoft's [app-local deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/choosing-a-deployment-method)
and [redistributable locations and terms](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files).
PE layout follows the [Microsoft PE specification](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format);
static CRT selection follows the [Rust linkage reference](https://doc.rust-lang.org/reference/linkage.html#static-and-dynamic-c-runtimes).

Hosted runners already have VC++ runtimes installed. Executing the app there
cannot prove clean-machine DLL availability: the static dependency policy is the
deterministic gate, supplemented by the native startup probe and clean VM checks.

### Startup failure evidence

Desktop records startup failure when initialization fails, before waiting for a
restart or quit. Normal incidents remain private under `diagnostics/fatal`. If
Windows cannot execute Core's native private-filesystem helper, Desktop instead
atomically publishes a closed, non-secret record under `diagnostics/startup`,
using inherited Windows permissions. It contains incident ID/time, a categorical
reason, fixed executable name, numeric exit status/hex Windows status, and a
bounded spawn error code where available. It contains no executable path, stderr,
environment, credentials, stack, or content. At most eight records of at most
16 KiB are retained; symlinked directories are rejected. Private incident bytes
are never written with weaker permissions, and macOS private publication remains
unchanged.

The diagnostic path is logged as `recordPath` and is available before Core is ready
through the trusted bootstrap query `app:startup-failure-evidence` (preload
`getStartupFailureEvidence`). The failure window's appearance and actions are unchanged.

## Native CI evidence

The `Windows` workflow runs both native runner types. Application suites retain
command and test timings in `timings-windows-app-<suite>-<arch>-<attempt>`.
Failed suites also retain available test attachments in
`windows-app-<suite>-<arch>-failure-<attempt>`; these uploads exclude Profiles and
databases. Its packaging cells upload:

- `nodex-windows-<arch>-<source-sha>`: the versioned installer,
  `architecture-build.json`, `windows-build-provenance.json`, and installed-app
  probe receipt. It is emitted only after the installed-app probe passes.
- `nodex-windows-probe-<arch>-<source-sha>`: startup logs, probe result JSON, and
  `installed-payload.json` with total installed bytes, physical file count and
  a per-file inventory measured from the clean installation before first launch.
  ASAR counts as one physical file; totals include the NSIS uninstaller.

The installed application must complete both authenticated Core startup and the
Agent Runtime execution handshake using verified standalone Node. The explicit
isolated probe needs no provider credentials; a live Electron process or a Core
descriptor alone does not pass. Its bounded diagnostic excludes endpoints,
provider configuration and secrets.

The startup probe can also run on a disposable clean Windows machine:

```powershell
vp exec tsx scripts/ci/probe-windows-installer.ts --arch x64 --artifacts .generated/windows-probe
```

It refuses to overwrite an existing Nodex installation or `nodex://`
registration. It installs with `/S /currentuser`, verifies the installed payload,
launches with a fresh isolated Profile, and requires the exact host's ready claim
plus a matching, authenticated named-pipe Core generation. A missing descriptor,
Unix-only Core transport, stale digest, or startup exit fails with diagnostic
logs. It first requests normal Electron quit and requires the selected Core to
exit within five seconds and the exact Main PID within 15 seconds. It then
relaunches Desktop and force-terminates only Main, proving the same detached Core
still answers authenticated health requests without Desktop. It installs over
that running generation within three minutes, relaunches the installed app, and
force-terminates Main again before silently uninstalling with Core still running,
with a 30-second budget. Core's idle window is ten minutes so the probe cannot
pass by waiting for idle shutdown. It checks the stopped Core PIDs, installation,
shortcut and protocol cleanup, and preservation of the Profile database and a
content marker through both maintenance operations. Its finally path attempts
uninstall before fallback Core cleanup, including after startup failure. It waits
for the entire NSIS process tree through PowerShell `Start-Process -Wait`, including
the relocated TEMP uninstaller. After process completion it waits for pending
filesystem removal within the same 30-second budget; the installation directory
must actually disappear.
The separate TCP-listener audit queries the local
[CIM provider](https://learn.microsoft.com/en-us/windows/win32/fwp/wmi/nettcpipprov/msft-nettcpconnection) directly, without
networking-module auto-loading. Its provider operation is bounded to 15 seconds
and the whole query to 30 seconds; neither extends the uninstall budget.
Playwright's wrapper/stream cleanup settles after maintenance stops Core; it is
not the Desktop-exit signal and must not stop Core before the uninstall check.
Diagnostic reprobes run the focused real-Core shutdown and process/listener
fixtures before the installed application. They prepare the native test Core
with the pinned Rust toolchain while reusing the existing installer payloads.
The probe retains its disposable Profile locally for diagnosis; CI uploads only
the fresh probe's logs and result. It never uses credentials or a real Profile.

The probe enables logs only for its disposable Profile and excludes build-only
`NODE_OPTIONS` and Electron's Node-mode override from the installed application's
environment. Partial results retain the completed installation checks.

For a diagnostic rerun of an existing installer, dispatch the Windows workflow on
the probe's branch with `installer_run_id` set to the source run ID. It downloads
that run's architecture-qualified installers and skips builds and source suites.
This is diagnostic evidence for those existing artifacts, not proof of a new build.

For branch feedback, push only the intended Windows development branch and read
its run. A failing Rust build or missing named-pipe Core is a dependency failure,
not evidence that the packaged app starts. Only verified installers enter an architecture bundle. A failed build still
uploads available startup diagnostics.

## Signing, updates, and release promotion

`WindowsSigningPolicy` in `scripts/windows-signing.ts` explicitly disables
Authenticode while retaining icon and executable metadata editing. Native Windows
builds use no signing credentials. A future Authenticode implementation belongs
behind this policy and a protected distribution job; it must preserve locked vendor
runtime identities. Windows SmartScreen may warn on first download.

Official assets use the Release Identity's display version:

| Asset                  | Name                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| x64 installer          | `Nodex-<displayVersion>-windows-x64.exe`                         |
| arm64 installer        | `Nodex-<displayVersion>-windows-arm64.exe`                       |
| Stable aliases         | `Nodex-latest-windows-x64.exe`, `Nodex-latest-windows-arm64.exe` |
| Signed appcast         | `Nodex-<displayVersion>-appcast-windows-<arch>.xml`              |
| Closed update manifest | `Nodex-<displayVersion>-update-windows-<arch>.json`              |

Stable aliases have exactly the same bytes as their versioned installer. Nightly
prereleases contain versioned assets only and never change GitHub Latest. The
internal local packager names in the build table above are renamed only after
verification; they are not public asset names.

The source certificate binds the exact Git commit/tree before an official build.
The architecture manifest binds that Release Identity, clean prepared generation,
packaged app version, official Skills identity, runtime lock digests, native runner
versions, installer hash and package provenance. The Windows provenance includes
all unpacked payload file hashes and the successful installed-app probe receipt.
A missing CPU or failed probe blocks the complete release.

A direct job bound to `sparkle-feed-finalization` signs each installer with the
existing Sparkle `sign_update` tool and `SPARKLE_ED25519_PRIVATE_KEY`. It produces
a signed single-item appcast with the monotonic build version, display version,
publication date, release notes, exact byte length and `sparkle:os="windows"`.
The enclosure URL points at the immutable GitHub tag's versioned installer.
There are no Windows deltas. The Release Bundle assembler verifies installer and
final XML signatures against the pinned public key independently before adding
their hashes and stable aliases to `SHA256SUMS` and `release-bundle.json`.

The feeds are:

- `https://nodex.jyu.app/updates/stable/windows-x64/appcast.xml`
- `https://nodex.jyu.app/updates/stable/windows-arm64/appcast.xml`
- `https://nodex.jyu.app/updates/nightly/windows-x64/appcast.xml`
- `https://nodex.jyu.app/updates/nightly/windows-arm64/appcast.xml`

Pages stores only feed snapshots; installer bytes remain GitHub Release assets.
Projection preflights every architecture, rejects lower build versions and
same-build byte drift, and verifies public feed bytes and enclosure availability
after push. Stable and Nightly change only their own subtree. Recovery replays
the verified Bundle's exact bytes without re-signing or rebuilding published assets.

Official package builds pass the same identity/channel environment as macOS:
`NODEX_RELEASE_IDENTITY_PATH`, `NODEX_RELEASE_VERSION`, `NODEX_BUILD_VERSION`, and
`NODEX_SPARKLE_CHANNEL`. The prepared manifest and executable package metadata
carry the Release Identity. Windows CI validation forces the channel to `disabled`;
local packages also default to disabled. The Windows updater owns its packaged
runtime manifest and installer handoff; it does not use the macOS Sparkle bridge.

### Packaged update configuration

Every Windows package includes `resources/native/app-update.json`, generated by
`scripts/windows-update-manifest.ts` through electron-builder’s `beforePack`
hook, including prepared and direct release packaging paths. Its exact schema is:

```json
{
  "schemaVersion": 1,
  "architecture": "x64",
  "buildChannel": "stable",
  "buildVersion": "1.12.1",
  "feedUrls": {
    "stable": "https://nodex.jyu.app/updates/stable/windows-x64/appcast.xml",
    "nightly": "https://nodex.jyu.app/updates/nightly/windows-x64/appcast.xml"
  },
  "publicKey": "YNySLZ74gjVAOpEdMo9OOEPvuTEMZf8fMnI+oQD7Ifs="
}
```

Official packaging supplies it through the shared macOS inputs above:

- `NODEX_SPARKLE_CHANNEL=stable|nightly` selects the initial channel. The name is
  shared with Sparkle intentionally; there is no separate Windows channel input.
- `NODEX_RELEASE_IDENTITY_PATH=<absolute Release Identity JSON path>` supplies
  the monotonic `buildVersion`. Its channel must match the selected channel.
  The existing prepared-build verifier binds this identity to the source checkout.

Omitting the channel defaults to `disabled`, including ordinary CI and local
packages. A disabled manifest has `feedUrls: null`, and retains the identity's
build version when provided, otherwise `0.0.0`. Enabling updates without a
matching identity fails packaging. The Windows release adapter remains
responsible for assigning the Release Identity display version to the installer
and executable metadata. Source packages do not infer build order from semver.

Main strictly checks the schema, CPU, build tuple, exact feed URLs and the pinned
Ed25519 key before acquiring networking. Neither environment variables nor the
manifest can replace the public key or feed family. A disabled package reports
“App updates are disabled in this build.”

### Download verification and installation

`AppUpdateRuntime` owns the same Settings, status, readiness and startup-check
policy on Windows and macOS. Windows uses Electron `net` for system proxy
support. Feed requests and every redirect require HTTPS. The Sparkle-format
RSS appcast is limited to 1 MiB and 100 direct items; DTDs, entity declarations,
malformed XML and conflicting build identities are rejected. Windows full
installers must use immutable Nodex GitHub Release asset URLs named
`Nodex-<displayVersion>-windows-<arch>.exe`. Only the newest matching CPU with a
strictly greater numeric Release Identity build tuple is eligible.

Downloads stream with backpressure into the selected Profile's
`updates/windows-<arch>/prepared-<uuid>.exe.download`, bounded by the appcast's
exact byte count and a 1 GiB ceiling. Main verifies the exact bytes with Node
Ed25519 against the same pinned Sparkle key before renaming to `.exe` and
reporting readiness. Ed25519 is not a streaming prehash signature: Node's final
verification uses one bounded in-memory installer buffer. It repeats verification
before installer handoff. Failed or cancelled downloads are removed; startup
removes owned stale `.download` and prepared `.exe` files, and never restores
readiness from a filename. Requests have a 15-minute operation deadline. Channel
replacement and lease release abort and join in-flight I/O, fencing old events.

“Restart to update” requests ordinary graceful Desktop shutdown. The verified
handoff runs after the complete application Scope closes, including Core release,
then launches NSIS detached with `/S --updated --force-run`, without a shell.
An update ready at ordinary quit uses `/S --updated`, without relaunch. These
flags are verified against electron-builder 26.18's `installSection.nsh` and
`common.nsh`; `--force-run` overrides `runAfterFinish: false` even in silent mode.
Session end, termination signals, startup failure and authority-driven relaunch
do not admit installation. NSIS installs over the per-user application and runs
installation-scoped leftover maintenance. Its update-only relaunch uses direct
`Exec` from the account home directory and exits before the stock ShellExecuteAsUser
path, preserving the selected
`NODEX_HOME` environment and starting exactly one host. This is safe because the
installer is strictly per-user and never elevates. Startup removes any abandoned prepared file.

The native installer probe additionally runs the same silent update command over
a running installed app on both architectures. It requires a new installed host
and authenticated Core generation with the same Profile ID and Core artifact,
Agent Runtime readiness, preserved Profile marker/database and protocol handler,
exactly one installed Desktop, and every previous installation process stopped.
The existing force-termination/install-over and uninstall checks remain in place.
Evidence is recorded as `updateHandoff` in the probe result JSON.

The probe uses only its disposable Profile and existing debugger startup access.
Unit tests inject fetch/installer/session-end ports and ephemeral signing keys
below the packaged parser; no key, HTTP feed, or updater-control override ships
in the application. CI installers keep updates disabled. The installer probe
proves NSIS handoff; it does not exercise the production updater against a local
feed. Acceptance still requires installing a published nightly and receiving a
newer published nightly through the real HTTPS feeds on x64 and arm64.
