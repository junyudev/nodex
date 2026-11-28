# Windows packaging runbook

Nodex builds Windows 11 installers natively for x64 and arm64. Stable releases,
Nightly, and Windows update feeds publish x64 only. The Windows workflow and
official release pipeline share one native packaging and verification path.
[Application releases](release.md) owns identity, certification, protected
finalization, promotion and Rehearsal.

## Build an installer

Use the [Windows development prerequisites](development.md#windows-11)
and a clean worktree on a native Windows host:

```powershell
vp install --frozen-lockfile
vp run package:win
```

Packaging builds the application, stages the
native runtime, verifies the prepared output, then invokes electron-builder NSIS.
The reusable Windows distribution runs build, staging, architecture verification,
packaging, and the installed-app probe through one repository-owned Release Module. Its `package:win:prepared <arch>` entrypoint verifies the existing prepared
build and generates the Windows update manifest before packaging; it does not rebuild or restage source.
`package:win` uses the host CPU. The explicit `package:win:x64` and
`package:win:arm64` commands require the matching host. The installer is
`dist/Nodex-<version>-win-<arch>-setup.exe`.

To get an arm64 installer from CI, dispatch the **Windows** workflow with
`arch=arm64`. Download the `nodex-windows-arm64-<source-sha>` workflow artifact.
The installer has updates disabled.

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

The installer packs its payload as one solid LZMA2 archive. Updates use signed full
installers, so nothing consumes block-level differential downloads, and the archive
settings those need (a 1 MiB dictionary and per-file blocks) would cost 61 MiB on the
v0.5.1 payload. In exchange, compression takes about eight times longer in release
builds and extraction needs a 256 MiB dictionary in memory.
After releasing the previous installation, NSIS uses Windows' native `tar.exe`
to extract the archive directly into the installation directory. This keeps
deeply nested runtime paths out of the temporary extraction directory and
Explorer's copy path. A nonzero extraction result stops installation before
startup registration or relaunch.

NSIS runs installation-scoped process shutdown before replacing or removing any
payload files. Before install-over, it refreshes the installed maintenance
uninstaller from the incoming installer, so older process checks cannot run.
It extracts a small native maintenance executable outside the installation and
runs it from the temporary directory, keeping working-directory handles outside
the files being replaced or removed. Maintenance uses native process enumeration
and image handles; it does not start a shell, compile code, or load management
modules.

Before stopping processes, maintenance prepares each detached Core's shutdown
client from that Core's own executable. The client authenticates the selected
Profile and fences the discovered PID, so it always matches the running Core.
The desktop gets a short ordinary-close window. Maintenance then requests
termination of the installation's other processes together, drains Core through
its authenticated client, and confirms exit on every retained process handle.
Windows can return access denied when a process exits concurrently; that result
still requires confirmation that the same process has exited. A live inaccessible
process blocks installation.

The collective exit wait is bounded at 45 seconds, starting after preparation and
shutdown requests. Slow startup, enumeration, and client copying do not spend the
shutdown budget. Core is never forcibly terminated to satisfy this deadline. If
shutdown cannot complete, the installer stops before replacing payload files and
asks the user to close Nodex and retry. No process-name-wide or descendant-tree
termination is used. A sibling directory with the same prefix is outside the
installation; filesystem aliases resolve to the installation's physical path.

After process shutdown and before removing files, installer maintenance follows
the current user's Chrome and Edge native-messaging defaults to their Profile
receipts. It restores a default only when the receipt names this installation
and the value still matches inside the native registry transaction. The same
step runs on install-over, including a change in the closure location or removal
of Desktop Tools. Profile files are retained. A Profile can register again when
the new Desktop opens, subject to the normal ownership check and takeover consent.

Install-over moves the old installation out of its registered path with one
same-volume directory rename. Maintenance uses Windows paths that support
deep runtime trees, then removes the retired payload. If the rename fails, the
old payload stays in place. If cleanup fails after the rename, the maintenance log
records the retired directory and replacement can continue. A standalone
uninstaller removes its installation in place.

Silent maintenance retains its latest stage and timed maintenance diagnostics in
`%LOCALAPPDATA%\Nodex\installer-maintenance.log`, outside the Profile and installed
payload. It records shutdown errors, the maintenance-uninstaller refresh, nested
uninstaller failures, payload extraction failures, and update relaunch failures
before returning a failed installer status. The installer
probe preserves this log for each operation and includes its failure reason in
the probe result before cleanup can replace it. Probe results also record the
installer's byte size and initial installation time.
`phase.json` records the current probe operation and its start time, allowing
controlled contention to target the running-desktop update operation independently. The probe's process and loopback-listener audits use the same native
installation boundary, avoiding shell startup and management-module loading on
busy machines.
Timed stages distinguish native startup, inventory, matching-client copying,
desktop termination, Core shutdown, and confirmed process exit.
The probe's separate installer wall-clock limit defaults to 180 seconds in CI.
On slower verification machines, `--installer-timeout-ms <milliseconds>` permits
up to 30 minutes for extraction and installation. This does not change the
installer's bounded exit wait; retain the measured install duration with the
verification evidence when using this option.

## Runtime closure

The Windows installer contains native Core and CLI executables, NSIS maintenance,
standalone Node and ripgrep, the Agent Runtime and its stock-Node PTY, the shared Claude
Agent SDK, official Agent Skills, and third-party notices. The Codex Component uses the
installer's `third-party/codex/{LICENSE,NOTICE}` and retail `vcruntime140.dll` in
`resources/codex-crt`.
Windows supports Browser Use and Computer Use through Desktop Tools. Document Tools
are available on Apple silicon.

Desktop Tools installs at startup. Codex and Claude Code install on first use. Both Windows
CPUs download their own pinned archives into the Profile's `components/` directory.
Official distribution checks each public download independently of local caches. The
Desktop Tools closure retains its vendor bytes and signatures. Main verifies the native
Windows trust boundary, manifest, PE machine, signer and issuer, and the tested app-server
pair before activation. Ordinary development builds stage the runtimes for the target.

The separately locked Node executable and its license ship under `resources/node-runtime`.
The standalone Agent Runtime and app tools entrypoints live outside ASAR. Stock Node loads
the detached N-API PTY build. Electron uses its own rebuild. Main loads the shared SDK to
discover Claude providers and read history. Configured Agent executables remain authoritative.

After packaging and after installation, verification rejects any Codex, native Claude Code
or Desktop Tools payload in the resources, ASAR or its unpacked companion. It also checks
the shared runtime dependencies, PTY helpers and clean-machine PE closure. The installed-app
probe creates a disposable Profile, records first use for Codex and Claude Code, and waits
for the app to activate every Component from its exact published pin. The probe checks the
Profile receipts and runs Codex and Claude Code from those roots. It verifies the sealed
Desktop Tools closure, loads Sharp with its Node, and runs a vendor REPL MCP session through
the Windows job launcher. It also spawns a PTY using the installed standalone Node and
checks for a unique marker and exact exit code. The architecture bundle requires these
receipts and the probe's startup, shutdown, upgrade and uninstall evidence.

Manual architecture checks are available independently:

```powershell
vp run verify:runtime:win .generated/codex-runtime/bin x64
vp run verify:runtime:win .generated/node-runtime/win32-x64 x64
vp run verify:runtime:win dist/win-unpacked x64 --packaged
```

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
recursively in unit tests, including its nested OpenConsole helper.
The native Claude Code executable uses the inbox [Winsock compatibility layer](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-wsaisblocking).
Node-gyp's `node.exe` delay import in `.node` addons binds the already-loaded
matching-CPU Node/Electron host. The locked Desktop Tool `native/windows-account.node`
also has a reviewed Electron delay-load host binding for `chrome.dll`.
Ordinary DLL imports still require the normal dependency closure.

For third-party binaries, `scripts/windows-vc-runtime.mjs` locates Visual Studio
with `vswhere`, selects the newest retail `VC/Redist/MSVC/<version>/<arch>/Microsoft.VC*.CRT`,
and copies only missing reviewed VC runtime imports beside their consumers,
including transitive runtime dependencies. It never copies from System32 or PATH,
rewrites vendor images, installs a machine-wide prerequisite, or includes debug
runtimes. Architecture is checked before copying. The after-pack hook also stocks
`resources/codex-crt` and closes Electron's third-party payload before the final scan.
The Codex Component verifies its official metadata and entrypoint before adding
the required CRTs beside the consumers.
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
registration, or an existing Nodex login registration. It installs with `/S /currentuser`, verifies the installed payload,
launches with a fresh isolated Profile, and requires the exact host's ready claim
plus a matching, authenticated named-pipe Core generation. A missing descriptor,
Unix-only Core transport, stale digest, or startup exit fails with diagnostic
logs. The probe checks that a fresh install leaves login startup off and enables
it through Nodex. It then launches with `--startup` and verifies that no window
was created. After interactive activation, closing the last window must retain
that same hidden window and live Core generation. `tray-lifecycle.json` records
this evidence. The probe also verifies the per-user login command, writes a disabled Windows startup
approval before install-over, verifies that it stays disabled, and checks both
owned values are removed by uninstall. It then requests normal Electron quit and requires the
selected Core and exact Main PID to exit within 15 seconds of that request. This covers the full
Main shutdown sequence, including the Core drain, and records the Core exit time separately. It then
relaunches Desktop and force-terminates only Main, proving the same detached Core
still answers authenticated health requests without Desktop. It installs over
that running generation within three minutes, relaunches the installed app, and
force-terminates Main again before silently uninstalling with Core still running,
using the same installer budget. Core's idle window exceeds that budget so the probe cannot
pass by waiting for idle shutdown. It checks the stopped Core PIDs, installation,
shortcut and protocol cleanup, and preservation of the Profile database and a
content marker through both maintenance operations. Its finally path attempts
uninstall before fallback Core cleanup, including after startup failure. After
the uninstall bootstrap returns, the probe requires installation-directory
removal before checking Core exit. A successful bootstrap status alone does not
complete uninstall; both conditions must settle within the same installer budget.
The separate TCP-listener audit reads the native
[process-owned listener tables](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable)
for IPv4 and IPv6. Its read-only inspection uses the same physical installation
boundary as maintenance and is bounded to 60 seconds.
Playwright's wrapper/stream cleanup settles after maintenance stops Core; it is
not the Desktop-exit signal and must not stop Core before the uninstall check.
Diagnostic reprobes run the focused real-Core shutdown and process/listener
fixtures before the installed application. Run the process fixtures with
`vp run test:unit scripts/windows-installation-processes.test.ts`; the wrapper
prepares the native maintenance executable. Diagnostic reprobes prepare the native test Core
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

Official assets use the source version:

| Asset                  | Name                                                 |
| ---------------------- | ---------------------------------------------------- |
| Installer              | `Nodex-<displayVersion>-windows-x64.exe`             |
| Stable alias           | `Nodex-latest-windows-x64.exe`                       |
| Signed appcast         | `Nodex-<displayVersion>-appcast-windows-x64.xml`     |
| Component manifest     | `Nodex-<displayVersion>-components-windows-x64.json` |
| Closed update manifest | `Nodex-<displayVersion>-update-windows-x64.json`     |

The stable alias has exactly the same bytes as the versioned installer. Nightly
prereleases contain versioned assets only and never change GitHub Latest. The
internal local packager names in the build table above are renamed only after
verification; they are not public asset names.

The source certificate binds the exact Git commit/tree before an official build.
The architecture manifest binds that Build Identity, clean prepared generation,
packaged app version, official Skills identity, runtime lock digests, native runner
versions, installer and Component manifest hashes, and package provenance. The Windows provenance includes
all unpacked payload file hashes and the successful installed-app probe receipt.
A missing installer or manifest, unavailable public Component archive, or failed probe blocks the complete release.

A direct job bound to `sparkle-feed-finalization` signs the installer with the
existing Sparkle `sign_update` tool and `SPARKLE_ED25519_PRIVATE_KEY`. It produces
a signed single-item appcast with the monotonic build version, display version,
publication date, release notes, exact byte length and `sparkle:os="windows"`.
The enclosure URL points at the immutable GitHub tag's versioned installer.
There are no Windows deltas. The Release Bundle assembler verifies installer and
final XML signatures against the pinned public key independently before adding
their hashes and stable aliases to `SHA256SUMS` and `release-bundle.json`.

The feeds are:

- `https://nodex.jyu.app/updates/stable/windows-x64/appcast.xml`
- `https://nodex.jyu.app/updates/nightly/windows-x64/appcast.xml`

Pages stores only feed snapshots; installer bytes remain GitHub Release assets.
Projection preflights every architecture, rejects lower build versions and
same-build byte drift, and verifies public feed bytes and enclosure availability
after push. Stable and Nightly update their own subtrees. Stable uses the exact installers from the published Nightly and its own signed appcasts.

Official packages enable updates through `NODEX_APP_UPDATES=enabled`.
The prepared manifest and executable metadata carry the Build Identity.
Windows validation and local packages default to disabled updates.

### Packaged update configuration

Every Windows package includes `resources/native/app-update.json`, generated by
`scripts/windows-update-manifest.ts` through electron-builder’s `beforePack`
hook, including prepared and direct release packaging paths. Its exact schema is:

```json
{
  "schemaVersion": 1,
  "architecture": "x64",
  "updates": "enabled",
  "buildVersion": "1.12.1",
  "feedUrls": {
    "stable": "https://nodex.jyu.app/updates/stable/windows-x64/appcast.xml",
    "nightly": "https://nodex.jyu.app/updates/nightly/windows-x64/appcast.xml"
  },
  "publicKey": "YNySLZ74gjVAOpEdMo9OOEPvuTEMZf8fMnI+oQD7Ifs="
}
```

`NODEX_BUILD_IDENTITY_PATH` supplies the monotonic `buildVersion`.
The prepared-build verifier binds the identity to the checkout. Enabled
updates require this identity and both feed URLs. A disabled manifest
has `feedUrls: null` and uses the supplied build version or `0.0.0`.
The app chooses its update channel in Settings, with Stable as the default.

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
`Nodex-<displayVersion>-windows-x64.exe`. Only the newest matching CPU with a
strictly greater numeric Release Identity build tuple is eligible.

Downloads stream with backpressure into the selected Profile's
`updates/windows-x64/prepared-<uuid>.exe.download`, bounded by the appcast's
exact byte count and a 1 GiB ceiling. Main verifies the exact bytes with Node
Ed25519 against the same pinned Sparkle key before renaming to `.exe` and
reporting readiness. The ready event includes the verified immutable installer URL.
Nodex uses that URL to look for the matching Windows x64 Component manifest and may
prepare new versions of Components already installed in the Profile while the update
waits to install. Ed25519 is not a streaming prehash signature: Node's final
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
a running installed app. It requires a new installed host
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
newer published nightly through the real HTTPS feeds.
