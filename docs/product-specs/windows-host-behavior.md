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
