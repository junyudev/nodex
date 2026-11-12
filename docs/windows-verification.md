# Windows verification

Nodex supports Windows 11 on x64 (primary) and arm64. Windows evidence comes from
three layers. Each layer proves what the cheaper layer cannot; none substitutes for
another.

| Layer       | Environment                                                                            | Proves                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automated   | GitHub `windows-latest` (Windows Server, x64) and `windows-11-arm` (Windows 11, arm64) | Native builds, Rust and application suites, per-architecture packaging and closure, silent install, packaged Core and Agent Runtime startup, uninstall |
| Interactive | Windows 11 arm64 virtual machine on an Apple silicon Mac                               | Windows semantics under a standard user: UI, input, shell integration, installer and upgrade flows, both architecture builds                           |
| Acceptance  | Physical x64 Windows 11 PC                                                             | GPU rendering, representative performance, power and session lifecycle, physical peripherals                                                           |

The automated layer is defined in [`.github/workflows/windows.yml`](../.github/workflows/windows.yml)
and runs the full `unit`, `core-client`, `main`, `renderer`, and `integration` suites
on each CPU. Core-client exercises the real Rust Core over named pipes under host
Node; Main and integration use Electron's ABI. It is described in [CI](CI.md); packaging and artifacts are described in
[the Windows release runbook](release-windows.md).

Main's private files use the bundled Core's one-shot native filesystem command.
Content backups and online execution clones use the native platform filesystem
boundary, including private destination files and reparse-point rejection. The suites verify the actual owner and protected permissions,
without depending on a PowerShell runtime. Desktop's bounded non-secret startup
fallback remains writable when that executable cannot load; normal private data
still requires the native permission boundary. The typed suite owners prepare that Core
executable before either host Node or Electron starts the tests.

For Desktop Tools, both native CI architectures exercise the Windows pipe peer
checks, registry transactions, WinVerifyTrust, the REPL launcher's closed
environment and job shutdown, and supervised helper stdio. With published
assets, the staged Electron test and the installed-app probe verify the sealed
closure with the production verifier and load the matching Sharp addon with
the vendor Node. Each starts the actual vendor REPL
through the Nodex launcher, negotiates MCP, lists tools, calls `js`, and checks
that the launcher and observed job processes exit. The installed receipt records
the number of verified vendor signatures and closed processes. A candidate
without a download URL reports `skipped: candidate assets` in the job summary.
A null Windows asset entry reports that no conformance-tested runtime is available.
Neither case exercises the vendor runtime.

Before publishing a Windows archive or admitting a new app-server pair, run
the same staged vendor check on each matching Windows worker with the approved
local archive. In a disposable checkout, substitute the native CPU and archive
path below. When using a Windows VM, run the probe from the signed-in console.
Use an interactive-logon scheduled task when connecting over SSH.

```powershell
$arch = 'x64' # Use 'arm64' on the native arm64 worker.
$archive = 'C:\path\to\the\locked\archive.tar.gz'
vp exec tsx scripts/desktop-build.ts stage-codex win32 $arch
vp exec tsx scripts/materialize-browser-runtime.ts --target-platform win32 --target-arch $arch --archive $archive --out .generated/desktop-tool-candidate
vp exec tsx scripts/stage-codex-runtime.ts --target-platform win32 --target-arch $arch --out .generated/codex-runtime --reuse-existing --browser-runtime-source .generated/desktop-tool-candidate
$env:NODEX_REQUIRE_STAGED_DESKTOP_TOOLS = '1'
vp run test:integration src/main/platform/node/WindowsDesktopTools.integration.ts -t 'initializes the staged vendor Windows REPL'
Remove-Item Env:NODEX_REQUIRE_STAGED_DESKTOP_TOOLS
```

The staged probe can verify the exact candidate pair in the release lock before
it is recorded. After the native probes pass on both architectures, add both
pairs to `src/shared/browser-app-server-compatibility.mjs`. The installed probe
requires the same conformance record as the application.

The interactive layer covers the published extensions, Browser routing and
Computer Use under a standard user on Windows 11. Use a native arm64 VM and a
native x64 Windows session. The physical x64 gate additionally covers mixed
DPI, multiple monitors, GPU capture, Defender, and sleep or session transitions.

## Deterministic suite contracts

Windows runners are slower and coarser than macOS hosts, so a test that only passes on
timing luck fails there first. Suites follow these rules on every platform:

- **Production deadlines are not debug-build benchmarks.** Bulk fixture setup runs under
  an explicit test budget (Core's `with_test_request_budget`) or in its own serial CI
  step; production defaults and the dedicated deadline and cancellation tests stay
  unchanged. The Windows Core-client phase runs at most two files concurrently so
  independent debug Core processes, fixture setup, and Agent Runtime subprocesses
  can share the runner without exhausting interactive request deadlines. Scalability
  is asserted by counted work such as SQLite VM steps, with latency recorded only
  as evidence.
- **Order is set explicitly.** Rapid commands can share a Windows clock tick, so
  timestamp-ordering tests seed distinct and tied values; keyset pagination must return
  every row exactly once when timestamps tie.
- **Readiness is an event.** Tests wait for a published process ID, a validated port, or
  a writer's readiness line, never for a sleep or a poll that can fall through.
- **Streams are accumulated.** Terminal output is matched against everything received
  so far, never against a single chunk.
- **Only cleanup retries.** After a child's exit is asserted, removing its temporary
  files may back off while NTFS releases handles; startup, shutdown, and assertions are
  never retried.

## What each layer cannot prove

- **Hosted runners** run as an administrator with UAC disabled and Defender real-time
  protection off, have no GPU, and the x64 image is a Server edition. Permission,
  antivirus, and client-shell behavior must be checked interactively. They also have
  the VC++ Redistributable installed globally. Clean-machine DLL availability is
  therefore checked statically, including delay imports and transitive app-local
  dependencies, by the [runtime closure policy](release-windows.md#clean-machine-dependency-policy).
- **An arm64 virtual machine** runs x64 builds through emulation. It cannot reveal an
  arm64 executable accidentally packaged into an x64 build, and its timing is not
  representative. The x64 package is therefore always proven on a native x64 runner.
  The machine also has no nested virtualization, so WSL 2, Windows Sandbox, and
  virtualization-based security are unavailable.
- **Only physical hardware** exercises real GPU drivers, mixed-DPI monitors,
  sleep/hibernate resume, touch and pen, and low-end storage under Defender scanning.

## Interactive machine setup

Use Windows 11 Pro or Enterprise for arm64 in a hypervisor with snapshot support.

- Allocate 6–8 virtual CPUs, 12–16 GB of memory, and about 150 GB of disk.
- Create a **standard (non-administrator)** account whose name contains a space and
  non-ASCII characters, for example `测试 用户`. Keep UAC and Defender real-time
  protection at their defaults.
  Never add a Defender exclusion: scanning makes installation several times slower,
  which is what users experience, so the installed file count is a real cost.
- Install a CJK input method, set display scaling to 150% or 175%, and add a second
  virtual display.
- Use a PC keyboard layout in the guest; host modifier remapping makes shortcut
  results unreliable.
- Keep the clean snapshot free of Visual C++ Redistributables and development tools.
  The build toolchain installs the Visual C++ runtime system-wide, which hides a missing
  app-local DLL from every account; prove first launch from the clean snapshot.
- Keep snapshots for a clean system, an installed toolchain, and an installed
  previous Nodex build.
- Clone the repository onto the guest's NTFS volume. Never build or run from a host
  shared folder: its case sensitivity, locking, links, and change notifications differ
  from NTFS.
- Turn off the hypervisor's user-folder sharing. It redirects the guest's Documents,
  Desktop, and Downloads to the host, so Projects created at their default location
  silently land on a host share.
- Enable the OpenSSH server so host tooling can run commands in the guest, and keep the
  guest network on the Private firewall profile; a feature update can reset it to
  Public and block SSH. SSH commands run outside the signed-in desktop, so start Nodex
  through a scheduled task with an interactive logon and reach its renderer over a
  loopback debugging port forwarded through SSH.
- Download installers through a browser inside the guest so they carry the
  internet zone mark that SmartScreen evaluates.

## Interactive checklist

Run the checklist with both the arm64 and the x64 installer.

1. **Install and first launch**: per-user install without elevation, SmartScreen
   prompt for an unsigned build, Start menu entry, `nodex://` link opens the running
   instance, a second launch focuses the existing window. First launch must work
   without a globally installed Visual C++ runtime. Verify Core, CLI, and bundled
   search; a loader failure must leave bounded evidence under the isolated
   Profile's `diagnostics/startup` even with logging disabled.
2. **Core lifecycle**: Core starts, survives closing the last window both idle and while work is active,
   restarts after being terminated, and leaves no orphaned `nodex-core.exe`, provider,
   `node.exe`, or terminal processes after quit.
3. **Profile storage**: a Profile under the non-ASCII user directory, long Page and
   attachment paths, backup and restore, and a Store that is briefly locked by
   Defender or the search indexer.
4. **Agents**: Codex, Claude Code, and OpenCode turns in a repository path containing
   spaces and non-ASCII characters; cancellation; worktree creation and removal; the
   agent reaches the bundled `nodex` CLI from PowerShell, cmd, and Git Bash.
5. **Terminal**: PowerShell 7 (also when installed outside PATH), Windows PowerShell,
   and cmd; resize; CJK input and
   output; closing a busy terminal ends its process tree.
   Launch Nodex with a mixed-case PATH override and inherited Electron/debug variables;
   a terminal must run ordinary Node without entering Electron or opening an inspector.
   Verify Git paths and arguments containing spaces, non-ASCII characters and shell
   metacharacters with native Git and a batch launcher.
6. **Editing**: CJK IME composition in Pages, the Composer, and Database cells;
   clipboard round trips with other applications; structural copy and paste between
   Nodex windows; drag and drop.
7. **Window chrome**: caption buttons align with the titlebar at 100%, 150%, and
   200% scaling and after changing Nodex zoom; snap layouts; dark and light themes.
   Restore several Workbench windows and verify one taskbar group with the Nodex
   icon. On a development VM with an older Electron Start Menu shortcut, check
   that `Get-StartApps` resolves `app.jyu.nodex` to Nodex. A legacy development
   shortcut pointing to the Nodex development runtime can claim the installed
   identity. Move that shortcut out of the Start Menu before verifying.
8. **Shortcuts and notifications**: Windows keymap labels, global dictation hotkey,
   notifications attributed to Nodex.
9. **Upgrade and uninstall**: installing over a previous build while Core is running,
   and uninstalling without leaving application files behind (the Profile remains).
10. **Notification area and login**: close the last window during a live Agent turn,
    let it finish, then left-click the tray and verify the same chat and completed
    result. Right-click for Running, Unread, Pinned, Recent, New chat and Quit;
    verify empty sections, More, projectless chats, Unicode titles and navigation.
    Test Quit/Cancel during a local turn and with a clock Automation enabled; accepted
    Quit must drain Core and Agent children and remove the tray. Switch Windows'
    system light/dark appearance while Nodex uses the opposite app appearance,
    restart Explorer, and check icon visibility, refresh and stable placement.
    Sign out/in with Launch at login On: the tray appears without a visible or
    focused window; ordinary launch and deep links then reveal the retained window.
    Toggle Nodex Off in Windows Startup Apps, reopen General to verify Off, upgrade
    and sign in again to verify it remains Off. Re-enable it, repeat sign-in and
    uninstall; confirm Startup Apps and the notification area no longer list Nodex.

## Desktop Tools

Before enabling Desktop Tools for a Windows release, check the in-app Browser
on both native architectures in a standard-user interactive session. Open a
local test page through Codex and through each local Agent provider, then
interrupt a running call and verify that the Browser remains usable on the next
Turn. Repeat with another Nodex Profile and a co-installed desktop host that
uses the Browser pipe namespace. Confirm each Session discovers only its
own backend, and repeat from a WSL workspace to confirm local desktop control
is absent. Verify the signed REPL can start its sandboxed kernel using the
installed CLI and sibling helpers on the clean machine.

### Computer Use

With a clean Windows 11 standard-user desktop, run the following on
native x64 and native arm64. Start with the Codex desktop app absent and without a
separately installed Visual C++ runtime. Repeat the capture and interruption steps
with Codex installed to check isolation.

- In **Settings → Computer use**, verify **Available**, the enable switch, and the
  always-allowed app list. Confirm the helper starts only after an Agent makes its
  first Computer Use call. Record the REPL and helper image paths, machine type,
  signer, and the helper process tree. On arm64, both executables must run natively.
- In a local Codex chat and a local non-Codex chat, list apps, select a Notepad window,
  capture it, and enter disposable text using keyboard and pointer. Check capture
  and coordinate accuracy on the physical x64 machine at mixed DPI and with two
  monitors, including a window moved between monitors. Confirm the capture used the
  verified Windows helper. Record any attempt to load the separate Swift capture
  helper or an app-local DLL, including the exact module path or loader error.
- Decline the Notepad prompt and verify no action occurs. Accept for the session
  and verify the request resumes. If the active approval policy offers **Always**,
  accept it, open a new chat, confirm the saved app appears in Settings, remove it,
  and confirm the next request prompts again. Record the offered choices per provider.
- During an active request, check the native indicator, press physical Escape, and
  verify the request ends and further Computer Use calls in that Turn are refused.
  Start a fresh Turn and verify Computer Use works again. Repeat with Nodex's Stop
  action, then with normal Turn completion. Verify indicators and capture clear.
- While a request is in progress, turn Computer Use off. Verify the connection and
  helper process tree close, and a previously configured chat cannot use the old
  endpoint. Restart Nodex, verify the switch stays off, then turn it back on and
  confirm a new chat can make a fresh request. Quit during a request and confirm
  the helper and its job children exit.
- Lock and unlock Windows during capture and check indicators and recovery. On a
  test machine, have an administrator open a benign elevated app on the same desktop.
  From the standard-user Nodex session, verify control of the elevated window is
  refused and ordinary Notepad control still works.

## Acceptance before a public Windows release

On a physical x64 PC, repeat checklist items 1, 2, 6, and 7, then verify hardware
accelerated rendering of large Pages and Canvases, startup time with Defender
enabled, sleep and resume with an active agent turn, and a mixed-DPI multi-monitor
setup.

## Existing-browser control

Run in an interactive standard-user Windows 11 session on x64 and arm64 with the installed app's default Nodex Profile in a disposable Windows account and disposable browser profiles. Record the architecture, Nodex build, browser and extension versions, Settings states, and the before/after HKCU default values. For the production extension host, query both of these keys with `/ve /reg:32` and `/ve /reg:64`.

- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.openai.codexextension`
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.openai.codexextension`

- **Clean install.** Start with the other desktop app absent. Install the published ChatGPT extension in Chrome and Edge. Test Edge with the Edge Add-ons ID and Chrome with the Chrome Web Store ID. Confirm **Waiting for extension** before connection and **Ready** after connection. From a local Agent, read a test page and select its exact tab. Repeat with two browser profiles and confirm commands reach the selected extension instance. On arm64, verify routing when optional browser-profile names are absent.
- **Repair.** Close both browsers, remove the Profile's native-messaging manifest and reopen Nodex. If it reports **Needs repair**, choose **Repair**. Verify the manifest is regenerated with the exact extension origins and the verified host path. Restart both browsers and repeat the handshake. Test the 32-bit and 64-bit registry queries and confirm they see the same HKCU default.
- **Co-install and take over.** Install and connect the other desktop app first. Record its Chrome registration and any Edge-specific registration. Open Nodex and confirm **In use by another app**, the original manifest path and unchanged values. Choose **Use with Nodex**, reconnect both browsers, and repeat the handshake. Confirm an alternate installed Profile and a development launch without opt-in leave HKCU unchanged. Run `vp run dev --register-browser-host` from a separate development Profile and confirm it reports **In use by another Nodex Profile** while the installed Profile owns the values.
- **Temporary development registration.** With the installed Profile’s registration off, opt in from a development Profile. Verify that quitting returns any previous values, including after an approved takeover. Replace one default while the development instance is running and verify quitting preserves that replacement.
- **Give back and turn off.** Choose **Give back** in the owning Profile. Verify the original default values return and keys previously absent lose Nodex's default. Restart Nodex and confirm control stays **Off**. Reconnect both browsers to the original app. Repeat **Turn off** from a clean install, and repeat **Give back** after independently changing one default value to verify the stale receipt leaves that value in place.
- **Upgrade and uninstall.** Take over again and upgrade while Nodex owns the
  keys. Verify that installer maintenance gives back the old defaults before
  removing files, including when the incoming build omits Desktop Tools or
  changes the closure location. If another app owns the restored defaults,
  confirm that the new Nodex build asks for takeover again. Reconnect and
  uninstall. Repeat with no previous owner and with a default independently
  replaced after Nodex registered. Confirm unrelated
  values and machine-wide registrations are unchanged. Start a REPL and
  Computer Use request before each operation and check that all installed REPL
  and helper processes exit before files are replaced or removed.
