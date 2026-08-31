# ADR 0055: ACP sessions are isolated scoped backend resources

## Status

Accepted — 2026-09-02

## Context

Nodex can support agent backends that speak stable Agent Client Protocol v1 without making ACP
the product's durable conversation model. An ACP process owns protocol negotiation and ephemeral
turn execution, and the Agent's ACP session owns its protocol history. Rust Core remains
authoritative for Projects, Threads, durable backend/session identity, authorization, and UI
projection authority; it does not become an alternative owner of the Agent's transcript. Electron
Main owns child-process lifetime and live projections.

The protocol is bidirectional. Agents can stream session updates and request privileged client
operations while a prompt is in flight. Those callbacks, child exit, transport failure, cancel,
backpressure, and application shutdown must share one lifecycle. Treating the SDK connection as a
Promise utility would create an unscoped process owner and an unbounded event path.

## Decision

ACP support is an isolated Electron Main backend family with two deep Modules:

- a Node platform adapter owns one stdio child and one official stable-v1 SDK connection inside an
  Effect `Scope`;
- an ACP session runtime owns negotiation, one root protocol session, serialized prompts,
  cancellation convergence, and a bounded semantic event stream.

The platform adapter bounds NDJSON record size, concurrent callback execution, update ingress, and
diagnostic stderr retention.
Scope release closes the protocol connection, sends `SIGTERM`, and escalates to `SIGKILL` after a
bounded grace period. Child exit and protocol closure become typed session failures.

The session runtime accepts updates only for its exact root session id. It drains accepted updates
before emitting the turn-stop event, continues accepting late updates after cancel, and requires a
cancelled prompt to finish with ACP's `cancelled` stop reason. Queue overflow is a terminal session
failure rather than silent data loss.

Client filesystem, terminal, authentication, and elicitation capabilities are advertised only when
their product authorities exist. The first real Agent uses typed workspace-file and supervised-
terminal adapters: paths are canonicalized beneath the Thread's Project workspace, symlink escape
fails closed, files and terminal output are bounded, and terminals belong to the session Scope.
Permission requests are derived in Main from the Thread's Project permission mode; Renderer cannot
provide a workspace root or permission policy. Adding another client capability requires a typed
adapter to its existing Nodex owner and a reviewed product permission path; it may not grant an ACP
child direct ambient access.

Ordinary JSON-RPC request rejection is recoverable and does not terminate the child. Framing,
process loss, event pressure, violated response invariants, and an explicitly configured request
deadline that leaves prompt state indeterminate are terminal. Prompts have no default wall-clock
deadline: long-running work is stopped through ACP cancellation. If session creation requires
authentication and exactly one non-terminal authentication method was negotiated, Main completes
that Agent-owned method and retries session creation once. It never retries or replays a user
prompt.

Only the SDK's stable package root is allowed in this backend. Experimental protocol entrypoints
require a separate decision and cannot be mixed into a stable-v1 session.

Core stores an explicit backend binding on every Thread and stores the ACP protocol session id in a
separate binding-checked record. Electron Main resolves that authority, derives the workspace and
permission policy, owns the live process, and resumes only through negotiated `session/load`.
Missing remote sessions clear the stale protocol id and surface a recovery error; Nodex never
reconstructs them by replaying the previous prompt. Renderer can request lifecycle operations only
by durable Thread id and receives a bounded typed canonical projection, not wire updates or raw
metadata. Opening returns the first snapshot; Main then sends exact consecutive revision deltas
only to the renderer observing that Thread. A revision gap or protocol-session change forces a
snapshot read instead of applying an ambiguous patch. The projection bounds turns, updates per
turn, bytes per turn (including one oversized update), bytes per session, and bytes per transport
delta.

Starting a new ACP task durably creates the Thread and binds the opened protocol session before Main
admits the first prompt. The start command then returns the Thread and initial snapshot immediately;
the prompt continues in the application Scope and publishes through the same revision-delta path as
later prompts. That in-memory admission is intentionally not crash-replayed: process loss may leave
the new Thread without a completed first turn, but recovery never risks submitting the user's prompt
twice.

Renderer observation is a bounded, reference-counted lease on live residency, not ownership of the
conversation. The first observer cancels pending eviction, and losing the final observer starts a
bounded idle grace. Idle sessions close after the grace while running turns remain resident and are
rechecked later. Per-Thread command lanes are reference-counted resources as well, so neither route
churn nor historical Thread count leaves an unbounded synchronization map in Main. Core retains the
durable identities needed to open the Agent-owned session again. The process set also has an explicit
capacity bound; pressure rejects a new open rather than selecting an observed session for surprise
eviction.

Codex remains a native, richer application Module. The shared registry selects lifecycle ownership
without flattening Codex history, review, approval, Browser, or subagent semantics into ACP's
lowest common denominator.

## Consequences

ACP agents can be exercised deterministically at the real process and stdio boundary without model
API use. New tasks select an enabled Profile-local Agent instance; attached tasks resolve their
backend exclusively from Core's durable binding. Backend-specific UI renders negotiated modes,
configuration, authentication, transcript, tools, plans, cancellation, and unsupported features
without routing the Thread through Codex-only owners.

Every live ACP session has a lexical owner, bounded memory and passive retention, an exact root
routing rule, a durable recovery identity, and one terminal failure channel. Future capability
adapters can be added independently while preserving fail-closed behavior for capabilities that
remain unavailable.
