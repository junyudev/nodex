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
without depending on a PowerShell runtime. The typed suite owners prepare that Core
executable before either host Node or Electron starts the tests.

## What each layer cannot prove

- **Hosted runners** run as an administrator with UAC disabled and Defender real-time
  protection off, have no GPU, and the x64 image is a Server edition. Permission,
  antivirus, and client-shell behavior must be checked interactively.
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
- Install a CJK input method, set display scaling to 150% or 175%, and add a second
  virtual display.
- Use a PC keyboard layout in the guest; host modifier remapping makes shortcut
  results unreliable.
- Keep snapshots for a clean system, an installed toolchain, and an installed
  previous Nodex build.
- Clone the repository onto the guest's NTFS volume. Never build or run from a host
  shared folder: its case sensitivity, locking, links, and change notifications differ
  from NTFS.
- Enable the OpenSSH server so host tooling can run commands in the guest.
- Download installers through a browser inside the guest so they carry the
  internet zone mark that SmartScreen evaluates.

## Interactive checklist

Run the checklist with both the arm64 and the x64 installer.

1. **Install and first launch**: per-user install without elevation, SmartScreen
   prompt for an unsigned build, Start menu entry, `nodex://` link opens the running
   instance, a second launch focuses the existing window.
2. **Core lifecycle**: Core starts, survives closing the window when work is active,
   restarts after being terminated, and leaves no orphaned `nodex-core.exe`, provider,
   `node.exe`, or terminal processes after quit.
3. **Profile storage**: a Profile under the non-ASCII user directory, long Page and
   attachment paths, backup and restore, and a Store that is briefly locked by
   Defender or the search indexer.
4. **Agents**: Codex, Claude Code, and OpenCode turns in a repository path containing
   spaces and non-ASCII characters; cancellation; worktree creation and removal; the
   agent reaches the bundled `nodex` CLI from PowerShell, cmd, and Git Bash.
5. **Terminal**: PowerShell 7, Windows PowerShell, and cmd; resize; CJK input and
   output; closing a busy terminal ends its process tree.
6. **Editing**: CJK IME composition in Pages, the Composer, and Database cells;
   clipboard round trips with other applications; structural copy and paste between
   Nodex windows; drag and drop.
7. **Window chrome**: caption buttons align with the titlebar at 100%, 150%, and
   200% scaling and after changing Nodex zoom; snap layouts; dark and light themes.
8. **Shortcuts and notifications**: Windows keymap labels, global dictation hotkey,
   notifications attributed to Nodex.
9. **Upgrade and uninstall**: installing over a previous build while Core is running,
   and uninstalling without leaving application files behind (the Profile remains).

## Acceptance before a public Windows release

On a physical x64 PC, repeat checklist items 1, 2, 6, and 7, then verify hardware
accelerated rendering of large Pages and Canvases, startup time with Defender
enabled, sleep and resume with an active agent turn, and a mixed-DPI multi-monitor
setup.
