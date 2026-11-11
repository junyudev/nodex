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

## Acceptance before a public Windows release

On a physical x64 PC, repeat checklist items 1, 2, 6, and 7, then verify hardware
accelerated rendering of large Pages and Canvases, startup time with Defender
enabled, sleep and resume with an active agent turn, and a mixed-DPI multi-monitor
setup.
