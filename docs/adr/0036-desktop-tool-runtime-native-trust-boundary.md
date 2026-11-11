# ADR 0036: Desktop Tool runtime owns native presentation and trust

## Status

Accepted

## Context

Browser Use already depended on a sealed runtime closure, a private native pipe,
and retained Electron guests. Computer Use adds two native boundaries that
cannot be modeled as renderer features: an operating-system PiP window and a
signed helper service that authenticates the process ancestry of its sender.

Treating those concerns as Browser-panel state creates false visibility: a
background Browser request can accidentally select or expand a panel, while a
renderer-derived PiP can outlive the turn that authorized it. Launching the
Computer Use REPL directly from Nodex's independently built app-server also
breaks the native sender-authentication chain even when every individual
artifact is signed.

The product therefore needs one architecture-aware Desktop Tool closure and an
explicit authority boundary for Browser presentation, native PiP, and Computer
Use service discovery.

## Decision

### One verified Desktop Tool closure

The sealed runtime contains the signed Codex CLI, Node, Node REPL, Browser and
Chrome plugins, their shared client and service, the Browser peer authorizer,
Chrome native-messaging host, native PiP bridge, and, when the target supports
it, the Computer Use plugin, `sky.node`, and signed helper app. The release lock
and inner manifest bind every file, backend, capability, architecture,
artifact and product operating-system minimum, signing-team expectation, and
the exact sorted native-addon export set. Runtime loading requires that complete
set, not only a compatible subset. Verification runs asynchronously with bounded
file and native-process concurrency; it does not reuse trust from an earlier launch.
Startup cancellation waits for opened files and native inspectors to close before
releasing the verification operation.

Browser, Chrome, native PiP, and Computer Use remain independently gated.
The macOS Desktop Tool runtime supports Apple Silicon. Chrome is
advertised only while its attested native host and an allowed exact extension
instance are ready. Computer Use is installed and configured only when its
architecture and operating-system capability verifies. One unavailable
capability does not weaken another, and a failed native host cannot leave its
skill or backend advertised.

Packaging signs Nodex-owned artifacts, restores the entire vendor-signed Desktop
Tool closure, refreshes the enclosing manifests, and reseals the outer app. It
does not replace nested Desktop Tool signing identities with Nodex's team.

Windows x64 and arm64 each have their own sealed closure. Main verifies every
manifest digest, rejects reparse points and untrusted owners or write grants,
and requires embedded Authenticode signatures with a trusted code-signing
chain, revocation evidence, and the manifest's subject and issuer. Windows
verification runs in a bounded background task. The Browser backend becomes
eligible only after the native process and pipe provider can start.

### Windows Desktop Tool launch and Browser transport

On Windows, Codex and Agent Runtime use the same Nodex-owned native launch
command. It starts the verified REPL executable in a kill-on-close job with a
complete environment supplied as launch arguments. Codex's persisted MCP
configuration may add environment variables to the launcher. The launcher
constructs the REPL's environment from Nodex's declarations, checks names
case-insensitively, and passes stdio directly. The launcher checks the suspended
child’s image before resuming it. The same job launcher can relay helper stdio
after acknowledging the child’s identity. The sandbox CLI uses a
Profile-owned Codex home so it cannot reintroduce shared shell policy. The
job ends when the launcher, its parent, or the REPL exits. Agent Runtime closes the job after an
unacknowledged cancellation and starts a fresh REPL for subsequent work.

Main binds each Browser route to a native named pipe in the vendor discovery
namespace, with a Profile identifier and a random suffix. Windows restricts the
pipe to the current logon SID and rejects remote clients. Main checks the
OS-reported process instance and the verified REPL or kernel path before
reading requests, and requires ancestry through the owned launcher to this
host. A separate development opt-in can admit a detached verified REPL.
Discovery uses the active Session and Profile identity. Session and Turn
authorization continue above the transport. Native PiP remains macOS-only.

### macOS requires a three-process signed REPL ancestry

The primary app-server is Nodex's separately locked native Codex app-server.
The shared `node_repl` command is launched through a persistent vendor-signed
Node process and the signed Codex CLI by using `codex sandbox`, producing
`node_repl -> codex -> node` as the three nearest processes. This is a trust
requirement, not a binary preference: Browser authenticates the peer, parent,
and grandparent, while Computer Use authenticates its sender ancestry. A
differently signed process at either checked depth invalidates an otherwise
correct request. The app-server and Desktop Tool have independent release
identities; their exact artifact pair is accepted only after the Browser and
Computer Use conformance contract passes.

Main atomically materializes the helper at the canonical Codex-home path after
deep strict signature, bundle-ID, team-ID, and executable checks. A private
serialized writer atomically publishes the helper's locale, text direction,
accent, and product overlay strings at `computer-use/config.json`. A private
host-services UDS accepts only `ensureService` for `computer-use`. The service
manager serializes starts and reuses a PID only when it is live, non-zombie, and
its native-resolved executable equals the canonical helper. Ordinary runtime
disposal closes the pipe without killing the shared helper; an isolated probe
may terminate only the exact process it started before deleting its temporary
state.

The REPL uses form elicitation for site and app access. Codex and Agent Runtime
answer it under the chat's permission policy. The native host returns denials
and execution failures as typed tool errors.

### Agent Runtime owns the REPL for local non-Codex Threads

Each Thread has one lazily launched signed REPL. Local providers connect to the
Runtime's `node_repl` MCP server on its loopback listener, using the Thread's
existing MCP credential. The server hides lifecycle tools, removes read-only
hints, and stamps calls with the Thread's Desktop session and active Run attempt.
Main treats those ids as opaque when routing the Browser to its owning window.

On macOS and Linux, a watchdog above the signed launcher leads the REPL process
group. It ends the group when the Runtime's private IPC channel closes, including
when the Runtime is killed. The launcher receives only MCP stdio. The Runtime
records the group and its watchdog's start time and launch token before launch. A
replacement holding the Runtime home lease waits for the recorded groups to
drain and removes their stale active-execution records before opening the store
and listener. Only the watchdog signals its own group, so recovery never signals
a PID from disk.

Agent Runtime answers the REPL's elicitations and handles permission to run
JavaScript. Cancellation goes upstream through MCP so the REPL can reset its
kernel. The REPL survives provider session replacement. Thread archive, deletion,
and Runtime shutdown close its process group on macOS or job on Windows.

### Presentation intent does not imply panel selection

Browser runtime tabs always materialize in their owning Session Scene. A
visible request may select the owning task and Browser surface. A background or
hide request may create or retain the shell, but cannot expand a panel, replace
the active tab, change split/maximized state, or perturb global MRU ordering.

Main and the operating-system native bridge own Browser, Chrome, and Computer
Use PiP. Main admits activity from the current local Codex connection or the live Agent
Runtime lease and authorized Run attempt. Both sources address the chat’s
execution root Thread. Main retains bounded latest Browser presentations and
connects only a verified Computer Use service. A native Browser presentation can focus its
exact in-app tab or exact Chrome extension instance and numeric tab. PiP is
suppressed while the same Browser surface is visibly presented without changing
the user's visibility preference.

All renderer windows read one bounded, revisioned Main snapshot. Renderer IPC
can submit visibility intent and observed host geometry, but cannot replace the
active-task set, hidden-task map, window registry, or native callback state.
Per-task visibility, maximum display size, and global always-hide are
Profile-local durable preferences. Archiving or closing a task preserves its
visibility choice; permanent deletion removes it. Activity sources,
presentations, suppression, placement, and window attachments are ephemeral.
Turn completion, connection-generation retirement, Browser or Chrome release,
window teardown, and app shutdown are idempotent teardown boundaries.

`WindowRuntime` is the physical-window registry. Primary windows keep their
Window Session identity; the avatar overlay is a restricted, non-restorable
auxiliary window. Native hosts use Main-owned window handles plus renderer-
observed anchors, obstacles, Home availability, and passthrough geometry. The
verified native Platform owns callback registration and loads no addon from an
ambient candidate path.

Computer Use operating-system settings remain Main-owned. A typed service reads
and revokes the helper's App and Messages approvals, controls its declared click
sound modes, and runs the verified Locked Use installer only when app-server
config requirements allow it. Native TCC prompts, Escape cancellation, and user
intervention stay inside the signed helper/plugin contract instead of being
reimplemented as renderer state.

## Consequences

- Browser `visible: false` means retained background availability, not hidden
  navigation to a newly selected right-panel tab.
- Browser and Computer Use have one fail-closed native trust chain from plugin
  through signed Node/Codex/REPL ancestry and the host-services pipe to the
  canonical helper.
- Chrome reuses the attested Browser client and service but has an independent
  plugin descriptor, readiness lifecycle, native-messaging installation, and
  exact extension-instance focus boundary.
- Native PiP can remain visible independently of React panel mount state but
  cannot become durable task or Scene authority.
- Local provider execution shares the verified Desktop Tool runtime. Native PiP
  admits activity from a live local execution generation.
- Release verification must validate mixed signing identities and exercise the
  actual plugin/host/helper chain and exact native-addon ABI, not only file
  presence.

## Rejected alternatives

### Re-sign every nested runtime artifact with Nodex's identity

This destroys the vendor trust relationships consumed by native peer and sender
authentication and makes a structurally valid package fail at runtime.

### Launch the Desktop Tool REPL directly from the ordinary app-server

The unsigned app-server becomes a checked REPL ancestor. Signing only the
helper and `sky.node` cannot repair Browser or Computer Use authentication.

### Launch the primary app-server through the bundled signed Codex CLI

This would couple app-server lifecycle and protocol identity to a binary whose
role is native Browser/Computer Use ancestry. Keeping the signed Node and Codex
processes only in the REPL launch chain preserves independent upgrades while
still satisfying native sender authentication.

### Let providers launch the REPL directly

Nodex owns Run attempts and Browser routes. A REPL tied to a provider process
loses its JavaScript state when that process restarts.

### Derive PiP from renderer Browser-tab state

Renderer mount and panel visibility are presentation observations, not the
native stream lifecycle. They cannot reliably own privacy teardown, window
movement, or turn-finalization races.

### Open a panel whenever a Browser shell is created

Shell materialization and user-visible selection are separate intents. Coupling
them makes background work steal focus and corrupts the persisted Scene.
