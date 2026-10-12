# Effect External Frontier Ledger

## Status

Active. This ledger refines the Electron Main boundary in
[ADR 0048](adr/0048-effect-main-application-kernel.md). It records categories,
not migration exceptions or an inventory of individual functions.

## Invariants

An external frontier may expose a Promise, callback, `AbortSignal`,
EventEmitter, synchronous return, or native handle only because the external
API requires that shape. The Adapter converts the shape exactly once and owns
no product policy, retry loop, durable state, duplicate projection, or
independent lifecycle. Cancellation originates in the caller's Scope, resource
release is registered before admission opens, and external failures enter one
typed Effect error channel.

Effect area APIs such as `effect/process`, `effect/rpc`, `effect/http`, and
`effect/schema` remain unstable or experimental within the stable package.
Their barrel, deep, and type-only imports stay inside dedicated platform or
companion-package Adapters. Application Modules use the Adapter's semantic
capability; the package version and import spelling do not expand the frontier.

Synchronous callbacks that cannot suspend may publish or offer into an already
scoped owner. They may not allocate a second runtime, resource registry, timer,
or detached task. Renderer, preload, shared contracts, generated protocols, and
Rust Core remain Effect-free.

## Permitted frontiers

| Frontier                                                                  | External shape                                                                            | Canonical Effect owner                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Electron bootstrap, app lifecycle, window/session, dialog, shell, and IPC | pre-ready callbacks, synchronous security decisions, Electron Promises                    | `MainApp`, Window/Profile capabilities, and scoped IPC Layers                   |
| Native Core UDS and generated Module clients                              | HTTP/SSE Promises, callback streams, `AbortSignal`                                        | `CoreTransport`, `CoreAuthority`, and the scoped live-delivery Modules          |
| Codex app-server and execution hosts                                      | child stdio, JSON-RPC callbacks, SSH/git/process Promises                                 | the companion session package, `CodexEndpoint`, and `ExecutionHostRuntime`      |
| Terminal and process telemetry                                            | PTY callbacks, signals, native process handles                                            | `TerminalRuntimeMap` and the Terminal platform Adapter                          |
| Browser, CDP, Browser Use, Computer Use, and MCP App                      | Electron guest callbacks, debugger/native-pipe Promises, synchronous attachment admission | Browser Profile/Sidebar/session capabilities and their scoped platform Adapters |
| Git/worktree workers and standalone process entries                       | worker messages, child stdio, process signals                                             | worker request runtimes and their designated `NodeRuntime.runMain` entries      |
| Filesystem, logging, Sentry, updater, credentials, and native helpers     | Node/Electron callbacks or Promises and synchronous native calls                          | the narrow filesystem, observability, updater, credential, or helper capability |

## Enforcement

[`scripts/ci/effect-boundaries.ts`](../scripts/ci/effect-boundaries.ts) defines
the executable application roots, Effect-free roots, runtime entries, unstable
API adapters, and the few synchronous unsafe ingress calls. A new category
requires an architectural decision and an update here; a new call site inside
an existing category should normally fit its existing Adapter and must not
expand this ledger into a per-method allowlist.
