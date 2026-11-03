# Windows host behavior

Nodex uses the operating-system account's home directory for the default Profile:
`%USERPROFILE%\.nodex` on Windows. An explicit Profile setting or `NODEX_HOME`
retains precedence. Paths may contain spaces and non-ASCII characters; drive and
UNC paths retain Windows path semantics.

Desktop notifications, clipboard, `nodex://` links, single-instance routing,
menus, dictation, Terminals and local Agents use Windows host integrations.
Notifications use the application identity `app.jyu.nodex`.

The per-user installer registers `nodex://` before first launch under
`HKCU\Software\Classes\nodex`, with a URL Protocol marker and the installed
`"Nodex.exe" "%1"` command. Packaged launches leave this installer-owned handler
unchanged. Uninstall removes application files and Start Menu/Desktop shortcuts,
and removes the protocol key only if its command still points to that installation.
The Profile is preserved.

Ordinary Desktop quit gracefully shuts down its selected Core generation within
a five-second Scope-release bound. A crash or force-termination can leave detached
Core running; the CLI and other clients can also start Core without Desktop.

Install-over and uninstall first close processes whose executable image is inside
that installation directory. Detached Core receives an authenticated shutdown
request for its exact process and has eight seconds to drain. Remaining Core,
CLI, Agent, standalone Node and search processes are forcibly stopped with a
bounded wait after their image path is checked again. Other installations,
system runtimes and the Profile are left intact. If those files cannot be
released, maintenance fails before replacing or removing them.

Background service installation, Browser control,
Computer control, Appshot and Apple DeviceCheck are unavailable on Windows.
Main's host capability policy gates native acquisition. Existing typed feature
availability observations govern renderer actions; an unavailable integration
cannot load a macOS native bridge or prevent local startup.

Windows clipboard reads and writes use Electron. Claimed text/HTML enhancements
retain the observed private structural MIME descriptor and other formats. The
host checks the observed clipboard contents before enhancement and verifies the
committed text/HTML afterward. Structural authority still belongs to Core; native
clipboard data supplies only its bounded descriptor.

Terminals discover PowerShell 7, Windows PowerShell and cmd from the captured
host environment. Windows executable discovery honors case-insensitive PATH and
PATHEXT without launching a login shell. Owned child-process cancellation ends
the complete Windows process tree. ConPTY owns Terminal process-tree release.

Task-bound `nodex` shell commands select the current build, Profile and Project
in PowerShell, cmd and Git Bash. A child task can inherit its parent's binding;
an explicit revoked child binding always denies access. Other local Agents
receive a PowerShell command prefix with the same explicit Profile context.
Remote execution hosts do not acquire local shell bindings.

Agent execution uses the release-locked standalone Node runtime independently of
Browser tooling. Both packaged and ordinary development launches verify its
manifest, host architecture and executable bytes; they never substitute host Node.

OpenCode setup downloads the official Windows standalone executable for the host
architecture into the account's `.opencode\bin` directory. It verifies the version
before selecting it, refuses to replace an existing installation and cleans up a
cancelled or failed download.

## Window chrome

Each Workbench window has a 36 logical pixel application row above its workspace.
The row scales with app zoom and contains one sidebar/back/forward navigation group,
File, Edit, View and Help, and a native drag surface. Measured Window Controls Overlay
geometry reserves the native minimize, maximize and close buttons only in this row.
Workspace tabs, Page and chat headers, right and bottom panels, and content full view
remain below it, with ordinary content padding. Content full view and OS fullscreen
are distinct; OS fullscreen clears native-control exclusions.

The rail and pinned or floating sidebar begin immediately below the application row.
The workspace header spans the content column only. Full pages without workspace
header content, including Settings, use an 8 pixel page-surface gutter instead of
reserving a blank workspace header.

Main's application menu owns commands and their current enabled state. Windows
presents a window-scoped snapshot through the renderer menubar and removes the
per-window native menu surface after that presentation connects. Invocation rechecks
snapshot membership, enabled and visible ancestry, and the requesting window's focused
content. A refreshed menu or snapshot revokes old item IDs. Navigate remains under
View; Settings is under Edit, Quit (`Ctrl+Q`) ends File, and Check for Updates and
About are under Help.

Alt alone reveals mnemonics and focuses the first menu on release. F10 toggles menu
focus; Alt plus a menu mnemonic opens it, and a focused bar accepts mnemonics without
Alt. Arrows navigate menus and items. Escape closes the menu and restores prior focus.
Pointer input toggles a menu or moves between open menus; window blur exits menu mode.
Keyboard opening and switching focus the first enabled item. Focused menu triggers
remain highlighted in light, dark and forced-colors appearances; popups have no
container focus outline.
Popups scroll within the viewport with a 6 pixel margin and a 220 pixel preferred
minimum width. Menu accelerators use Win, Alt, Ctrl, Shift order with `+` separators.

Native caption height is `round(36 × combined app zoom)`. Caption symbols follow
the selected Light, Dark or System appearance, including later native theme changes.
The native window title stays Nodex. Native double-click maximize/restore and Snap
Layouts retain operating-system ownership.

Windows keeps Mica while unfocused. Windows versions without supported Mica, or
without GPU compositing, use an opaque themed surface. Full-window image previews
clear native captions vertically for their content and top-right actions. Ordinary
dialogs do not acquire caption padding.

## Settings

Settings navigation and search omit Computer use on Windows, including direct links.
Browser keeps the built-in Browser's history, downloads, credentials, extensions,
permissions and link preferences. Profile import and control of external browsers
are absent because their host integrations are unavailable. General retains the
running Nodex version and the shared app-update status, preferences and actions.
Packaged x64 and arm64 builds support updates when their distribution channel is
enabled; local and CI packages report that updates are disabled in that build.
Unpackaged builds report that updates require a packaged build. Host capability policy determines this presentation; temporary readiness
of a supported feature remains visible within its owning page.

## App updates

Windows uses the same Main-owned update states and renderer controls as macOS.
Stable and Nightly feeds are specific to x64 or arm64, and only strictly newer
Release Identity build versions are eligible. Feed and download errors are
recoverable. A staged installer becomes ready only after its byte length and
pinned Ed25519 signature are verified.

Restart to update finishes graceful Desktop and Core shutdown before handing
the verified installer to silent per-user NSIS maintenance and relaunch. A ready
update at ordinary quit installs without relaunch. OS session end never installs
an update. The selected Profile and installer-owned protocol registration survive;
the installer relaunches one installed Desktop. See the
[Windows packaging runbook](../release-windows.md#packaged-update-configuration).
