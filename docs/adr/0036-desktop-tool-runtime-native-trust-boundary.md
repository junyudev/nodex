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

### A three-process signed REPL ancestry is part of Desktop Tool capability

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

App-server form elicitation remains the sole action-approval authority. The
native host does not invent a second approval model and returns denials or
execution failures as typed tool errors.

### Claude Code reaches the REPL through Agent Runtime

The runtime's contract is richer than a stdio MCP client provides. Each call must
carry its conversation and Turn in request metadata, approvals need response
metadata, and the `turn_ended` lifecycle tool must not reach a model. The Claude
CLI's client offers none of these controls, and the process it launches would end
with each CLI process, taking REPL state with it.

Agent Runtime therefore owns one signed REPL per Claude conversation as an MCP
client, launched with the unchanged chain above, and gives each Claude process a
fresh in-process MCP server that forwards to it. That facade stamps identity, hides
host-only tools, and removes read-only hints from tools that run arbitrary code.
Elicitations are answered in Agent Runtime under the app-server's rules, which keeps
form elicitation the sole action-approval authority. Cancelling a call goes through
MCP, and the REPL resets the kernel itself, so this path needs no separate process
cleanup. The Turn identity is Nodex's own attempt identity, because Claude exposes
no stable native Turn id before tools run. Browser routing treats it as opaque.

### Presentation intent does not imply panel selection

Browser runtime tabs always materialize in their owning Session Scene. A
visible request may select the owning task and Browser surface. A background or
hide request may create or retain the shell, but cannot expand a panel, replace
the active tab, change split/maximized state, or perturb global MRU ordering.

Main and the operating-system native bridge own Browser, Chrome, and Computer
Use PiP. Main derives activity from the admitted local Codex notification
generation, retains bounded latest Browser presentations, and connects only a
verified Computer Use service. A native Browser presentation can focus its
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
- ACP and remote Codex execution do not acquire local native control surfaces
  without an explicitly negotiated, independently verified capability.
- Claude Code gets Browser, Chrome, and Computer Use control under the same trust
  chain and consent rules. Native PiP still derives activity from the local Codex
  notification generation, so it does not follow Agent Runtime chats.
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

### Register the REPL with the Claude CLI as a stdio server

This needs no bridge code, but the REPL would receive no conversation identity, so
Browser requests would fail, and the model would see `turn_ended`. Approval metadata
would pass through a client that does not preserve it, and REPL state would end with
every CLI process.

### Put a stdio proxy between the Claude CLI and the REPL

A proxy could add identity, but it would need its own private channel to learn the
current Turn and answer approvals, and it would still die with the CLI process. The
in-process facade gets all of that from the process that already owns the Turn.

### Derive PiP from renderer Browser-tab state

Renderer mount and panel visibility are presentation observations, not the
native stream lifecycle. They cannot reliably own privacy teardown, window
movement, or turn-finalization races.

### Open a panel whenever a Browser shell is created

Shell materialization and user-visible selection are separate intents. Coupling
them makes background work steal focus and corrupts the persisted Scene.
