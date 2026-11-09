# Hosting a team Space

`nodex serve` runs one Space's Core and execution host on your machine. Install
the Nodex application, then use its bundled native `nodex` CLI. The host starts
the bundled Electron executable with `ELECTRON_RUN_AS_NODE=1`; this keeps native
addons such as `node-pty` on the ABI they were built for without opening windows.
The installed application must retain Electron's RunAsNode fuse.

## Create and run a Space

Use an absolute, short path for the private Space home. On macOS, the complete
Core Unix socket path must fit the operating system's socket path limit.

```sh
nodex serve init --home /srv/nodex/team --name Platform --address 127.0.0.1:8443 \
  --project-name Platform --repository https://github.com/acme/platform \
  --clone /srv/nodex/repos/platform
nodex serve start --home /srv/nodex/team --foreground
nodex serve status --home /srv/nodex/team
```

without opening a network listener. It prints the Space ID and certificate
fingerprint. Members see the local Owner by the name the host's OS account gives
its person; `init --owner-name NAME` chooses another, and `nodex serve
display-name --home /srv/nodex/team NAME` changes it later. The Space name belongs to Core, defaults to “Team Space”, and never
comes from its address. A local Owner can run `nodex serve rename --home
/srv/nodex/team "Platform Engineering"` while the host is running; connected
desktops show the new name at once, and others pick it up on their next successful
connection, including host restart recovery.
The default execution home is a separate sibling,
`/srv/nodex/team-execution`; `init --execution-home` can choose another disjoint
absolute directory. Core administration files stay in the private Space home;
workspaces, conversation execution state and Agent working files use the execution
home. Keep both directories on persistent local storage and back them up together.

Without `--foreground`, start detaches and waits for readiness. Its private log is
`<home>/logs/host.log`. Status checks the native lifetime lease and exact Core
generation; reading status never starts Core. Use a fixed listening port for
enrolled desktops; port `0` chooses a new ephemeral port after a Core restart. Stop a foreground host with SIGTERM
or its service manager. Shutdown releases producers and execution before the Core
generation and host lease, logs that the host stopped and exits 0; a teardown
failure is logged and exits non-zero so the service manager can restart it. A
second host for the same home is refused.

```sh
nodex serve invite --home /srv/nodex/team
nodex serve members --home /srv/nodex/team
nodex serve devices --home /srv/nodex/team
nodex serve revoke --home /srv/nodex/team DEVICE_ID
```

Invitations use the same one-time enrollment and fingerprint pinning as
`nodex space invite`. Give the invite URL, code and printed certificate
fingerprint to the member through an authenticated channel. The desktop's Join
Space dialog enrolls that device. Revocation invalidates its existing sessions.

## Repository workspaces

Clone repositories on the host before initialization. `--repository` names the
canonical HTTPS Git remote without credentials, a trailing slash or `.git` suffix;
`--clone` names its existing absolute clone root. The clone's Git remote may use
SSH. Nodex verifies that both forms identify the same repository without fetching
it. Omitting both options creates an initial Project without a repository.

Team Projects publish repository identities, never executable clone paths. The
owner-only `host.json` stores a `repositories` object mapping each canonical
remote to its clone root. Preserve these mappings while Pages still own
workspaces from those repositories. Each additional Project's declared remote
must have a matching mapping before the host starts. Host admission refuses
missing mappings, mismatched remotes, clones overlapping private Core state, and
team Projects that still declare desktop directories. Convert those Project
sources to canonical repository identities before hosting them.

Page workspaces and worktrees are created on the host. A chat started from an
Inbox message, on a desktop or a phone, runs where the same Project's Page work
runs. Work without a Project uses the execution home's `tasks` directory. A member's desktop never interprets
a shared repository identity as a local executable path.

## Credentials and execution identity

Agent provider authentication belongs to the host machine. Authenticate Codex in
the host account's own `~/.codex` home, or set its explicit `CODEX_HOME`. Configure
Claude's credentials for the account running the provider. Desktop provider
credentials are never uploaded when a member joins. With a separate Runner,
provider authentication and execution files must be accessible to that Runner;
administration files must remain inaccessible.

The Space home, Core bearer, TLS private key, configuration and Store containing
credential hashes must retain owner-only native permissions. Startup refuses
broader permissions and aliases before opening the listener. Agent processes get
a restricted environment and scoped per-turn content credentials. These
credentials cannot run administration, issuer, backup or service commands.
Core binds hosted person actions to their authenticated Member and Agent work to
its Session and Run on behalf of the requesting Member captured from the
Runtime-verified input message. Host producers
use Service identities. A member can answer their own pending questions; execution
approvals belong to the Page Owner. Chat and Inbox reads retain each Member's
personal attention state.
Headless Agent shells do not load the host account's shell startup files.
Configured shell environment variables are filtered before the native policy is
installed, so they cannot restore administration variables.

Owner-only files and environment scrubbing do not isolate two processes with the
same OS identity. Such an Agent can discover and read other files owned by that
account. Loopback listening permits this mode and reports the warning in logs
and status. Listening beyond loopback requires an `agentRunner` configuration or
an explicit `serve start --allow-same-user-agents` acknowledgement. The
acknowledgement appears in status. Restrict network access with your firewall.

For a server deployment, provision a dedicated host account with no unrelated
personal files. An administrator can additionally provision a distinct Agent
Runner account, with a private provider home and access only to execution state
and repository clones. On Linux, account provisioning can use
`useradd --system --create-home nodex-agent`; on macOS, create a standard account
in System Settings or your organization's account management system. Nodex never
creates accounts or changes users itself.

While the host is stopped, edit its owner-only `<home>/host.json`. Preserve its
generated identity fields and add, for example:

```json
{
  "agentRunner": {
    "user": "nodex-agent",
    "launcher": ["/usr/bin/sudo", "-n", "-u", "nodex-agent", "--"]
  }
}
```

This is an excerpt, not a replacement for the generated configuration. The
launcher is an executable and literal argument array, never shell text. Linux
operators can use an appropriately authorized `runuser` launcher instead. Grant
only the specific non-interactive launch permission required by your deployment.
Verify access restrictions independently before exposing an untrusted network.
The Runner wrapper applies to the supervised Agent Runtime and its provider
descendants. Host workspace workers still run as the host account; repository
hooks and host-side tool integrations therefore remain trusted host inputs.

## Agent tools and desktop access

The host runs content, Inbox, Work, Automation assessment, Source follow and Session
tools through its own MCP host. Session creation, reads, messages and questions
use the same Runtime writer as managed work. Browser, Computer Use, windows and
other desktop-only tools are unavailable on a headless host and are not advertised.

Members can start assigned work, open Nodex, read and reply to hosted chats
(including Queue, Steer and queued-reply controls, the chats' images, and the
images, files and Page references a reply attaches), edit their own messages,
fork them and open side chats, answer Inbox questions, accept ready work and pause
or resume execution. A chat's owner, the Member who started it, and the Space Owners
rename, archive, restore and move it to another Project, compact or clear it and merge
it back; they and the Member who asked for a Run stop that Run, its background tasks
and its subagents. The host runs each change with the Member's authority and Core
refuses it from anyone else. Transcript
views refresh bounded snapshots from Session invalidations, with a fifteen-second
repair while visible. Members start new chats, with or without a Project, from a
team desktop or a phone; the host runs each with its starter's authority. Full live
streaming and native filesystem panels are not yet available from a team desktop.

## launchd on macOS

Install the app in a fixed location and use the bundled CLI's absolute path. A
LaunchAgent runs under its owning login account. Save a plist such as
`~/Library/LaunchAgents/app.nodex.team.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.nodex.team</string>
  <key>ProgramArguments</key><array>
    <string>/Applications/Nodex.app/Contents/Resources/bin/nodex</string>
    <string>serve</string><string>start</string>
    <string>--home</string><string>/Users/nodex/Spaces/team</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/nodex/Logs/team.log</string>
  <key>StandardErrorPath</key><string>/Users/nodex/Logs/team.log</string>
</dict></plist>
```

Create the log directory privately first. Use `launchctl bootstrap gui/UID PATH`
to load it and `launchctl bootout gui/UID/app.nodex.team` to stop it, substituting
the host account's numeric UID and absolute plist path. A system LaunchDaemon
requires administrator installation and an explicit dedicated `UserName`.
Service environments do not inherit interactive shell configuration; supply
provider configuration through the host's supported settings and credential homes.

Sensitive host settings use the private `<home>/settings.key`; include it in
private backups. A missing, damaged or overly permissive existing key is not
replaced to make settings readable. Image attachments are decoded and fitted by
the host's native image codec; no desktop window is required.

## systemd on Linux

Have an administrator install the application and provision the dedicated host
account and directories. A system service can use:

```ini
[Unit]
Description=Nodex team Space
After=network.target

[Service]
Type=simple
User=nodex
Group=nodex
UMask=0077
ExecStart=/opt/Nodex/resources/bin/nodex serve start --home /srv/nodex/team --foreground
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
KillMode=mixed

[Install]
WantedBy=multi-user.target
```

Adjust the installed path, then use `systemctl enable --now nodex-team` and
`journalctl -u nodex-team` through your normal administration workflow. `KillMode`
allows the foreground host to stop its supervised children before systemd's final
cleanup. Do not put provider secrets or Core capabilities in unit arguments.

Read [Security](SECURITY.md) before opening the listener beyond loopback and
[Reliability](RELIABILITY.md) for the execution and Core recovery boundaries.
