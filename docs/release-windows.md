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
the copied standalone dependency byte-for-byte and scans the complete unpacked
payload's PE Machine fields. A package containing a foreign CPU executable, DLL
or addon fails before an installer is emitted.

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
Diagnostic reprobes run the focused process/listener fixture before the installed
application, so the same native audit boundary is checked without rebuilding.
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
