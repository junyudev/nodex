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

Background service installation, automatic app updates, Browser control,
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

Main's application menu owns commands and their current enabled state. Windows
presents a window-scoped snapshot through the renderer menubar and removes the
per-window native menu surface after that presentation connects. Invocation rechecks
snapshot membership, enabled and visible ancestry, and the requesting window's focused
content. A refreshed menu or snapshot revokes old item IDs. Navigate remains under
View; Settings is under Edit, Quit (`Ctrl+Q`) ends File, and About is under Help.

Alt alone reveals mnemonics and focuses the first menu on release. F10 toggles menu
focus; Alt plus a menu mnemonic opens it, and a focused bar accepts mnemonics without
Alt. Arrows navigate menus and items. Escape closes the menu and restores prior focus.
Pointer input toggles a menu or moves between open menus; window blur exits menu mode.
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
