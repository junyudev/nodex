# Windows packaging runbook

Nodex builds Windows 11 installers natively for x64 and arm64. The Windows
workflow produces unsigned validation artifacts. Windows artifacts do not yet
participate in the protected macOS Release Bundle or public release promotion.

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
CI exposes build, staging, architecture verification and packaging as separate
steps. Its `package:win:prepared <arch>` entrypoint verifies the existing prepared
build before packaging; it does not rebuild or restage source.
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
It extracts its own maintenance Core and PowerShell script outside the installation.
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
the root dependency remains Electron's own rebuild. The after-pack hook compares
the copied standalone dependency byte-for-byte and scans every PE image in the complete unpacked payload, including renamed images,
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

The `Windows` workflow runs both native runner types. Its packaging cells upload:

- `nodex-windows-<arch>-<source-sha>`: the architecture-qualified installer.
- `nodex-windows-probe-<arch>-<source-sha>`: startup logs and probe result JSON.

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
logs. It requests normal Electron quit, waits up to 15 seconds for the exact Main
PID to exit, and proves detached Core still answers authenticated
health requests, installs over that running generation within three minutes, and
relaunches the installed app. It quits again and silently uninstalls with Core
still running, with a 30-second budget. Core's idle window is ten minutes so the
probe cannot pass by waiting for idle shutdown. The probe checks installation,
shortcut and protocol cleanup, and Profile preservation. Its finally path attempts
uninstall before fallback Core cleanup, including after startup failure. It waits
for the entire NSIS process tree through PowerShell `Start-Process -Wait`, including
the relocated TEMP uninstaller; directory removal alone is not uninstall completion.
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
not evidence that the packaged app starts. Installer artifacts are uploaded before
the startup probe so failed startup evidence can be investigated with the exact
installer.

## Signing, updates, and release promotion

`WindowsSigningPolicy` in `scripts/windows-signing.ts` is the typed distribution
policy boundary. Its current `unsigned` variant explicitly disables Authenticode
while retaining icon and executable metadata editing. There are no signing
secrets in this workflow. A future Azure Artifact Signing implementation belongs
behind this policy and a protected distribution job; it must sign and verify all
first-party executables and the final installer without rewriting locked vendor
runtime identities. The source certificate and Release Bundle also need a
Windows architecture owner before public promotion is enabled.

Windows update discovery, signed update metadata, rollback/recovery, release
publication and a Windows download surface remain separate work. Sparkle is
macOS-only and is not a Windows update implementation. Until these seams are
completed, download the CI installer explicitly; no automatic Windows update
channel is advertised.
