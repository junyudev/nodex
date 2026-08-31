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

The sealed runtime contains the signed Codex CLI, Node, Node REPL, Browser
plugin and client, native peer authorizer, native PiP bridge, and, when the
target supports it, the Computer Use plugin, `sky.node`, and signed helper app.
The release lock and schema-v4 inner manifest bind every file, capability,
architecture, minimum operating-system version, and signing-team expectation.

Browser and Computer Use remain independently gated. Browser is available on
supported arm64 and x64 macOS closures. Computer Use is installed and configured
only when its architecture and operating-system capability verifies. A missing
Computer Use capability does not degrade Browser Use, and a failed native host
cannot leave a visible Computer Use skill behind.

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

### Presentation intent does not imply panel selection

Browser runtime tabs always materialize in their owning Session Scene. A
visible request may select the owning task and Browser surface. A background or
hide request may create or retain the shell, but cannot expand a panel, replace
the active tab, change split/maximized state, or perturb global MRU ordering.

Main and the operating-system native bridge own Computer Use PiP. It may present
the active completed Computer Use output while the Browser surface stays
backgrounded, and it is suppressed while that surface is visibly presented.
Turn completion, privacy termination, Browser release, window teardown, and app
shutdown are idempotent teardown boundaries. Only maximum display size and the
global always-hide setting are durable user preferences; per-task hiding,
placement, active content, and activity are ephemeral projections.

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
- Intel builds can ship complete Browser support without carrying or advertising
  an unsupported Computer Use implementation.
- Native PiP can remain visible independently of React panel mount state but
  cannot become durable task or Scene authority.
- Release verification must validate mixed signing identities and exercise the
  actual plugin/host/helper chain, not only file presence.

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

### Derive PiP from renderer Browser-tab state

Renderer mount and panel visibility are presentation observations, not the
native stream lifecycle. They cannot reliably own privacy teardown, window
movement, or turn-finalization races.

### Open a panel whenever a Browser shell is created

Shell materialization and user-visible selection are separate intents. Coupling
them makes background work steal focus and corrupts the persisted Scene.
