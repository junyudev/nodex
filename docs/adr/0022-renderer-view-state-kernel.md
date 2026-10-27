# ADR 0022: Renderer view state uses scoped atoms

- Status: Accepted
- Date: 2026-07-19
- Owners: Nodex maintainers
- Extends: ADR 0013

## Context

Nodex currently keeps several complete Project-session React trees under
`Activity`. A retained tree owns transcript components, composer components,
panel attachments, subscriptions, lifecycle effects, and a portal into one
shared application header. This makes React mount lifetime an accidental owner
of task-local state. Switching tasks can briefly expose two header owners and
can reactivate a large hidden tree with many independent subscriptions and
deferred transcript work.

Renderer-local state is also spread across broad Context providers, component
state, module-level Maps, external-store listeners, and local persistence
helpers. These mechanisms are valid for distinct deep runtime Modules, but they
do not provide one explicit identity and disposal model for ordinary app,
thread, route, and composer presentation state.

Durable data and live execution already have deeper owners. Rust Core owns
Project Session domain data and Thread links. A Main-persisted Window Session
owns each window's Workbench layout, including its Session tabs and panels.
TanStack Query owns renderer server-data caching. `CodexAppServerManager` owns
conversation and execution state. Browser, Terminal, and collaborative editor
Modules own their runtime objects. The renderer needs a view-state kernel
without duplicating those authorities.

## Decision

Nodex uses Jotai 3 as the renderer atom engine and an internal Module named
Maitai as the scoped renderer-state kernel. Maitai uses only Jotai's public
`atom`, `createStore`, `Provider`, store `get`/`set`/`sub`, and React hooks.
Maitai owns family identity and cleanup.

Each Electron renderer window creates exactly one Jotai store. A stable
`MaitaiProvider` binds that store once at renderer bootstrap. Scope providers
carry only a Maitai scope-node pointer; they never create nested Jotai stores.
TanStack Query remains a separate authority, and the stable renderer
`QueryClient` may be inherited as environment data without copying its cache.

The renderer scope hierarchy is:

```text
AppScope                       renderer-window lifetime
└── ThreadScope                retain 20 per AppScope
    └── RouteScope             retain 20 per ThreadScope
        └── ComposerScope      retain 100 per RouteScope
```

Scope keys are immutable and parent-relative. A Thread scope uses a stable
session or client identity and enriches its descriptor when a server Thread is
attached; it never changes its key to the server Thread ID. Route identity is
the Workbench equivalent of path plus search. Composer identity distinguishes
new-thread, panel-new-thread, preview, stable task, and explicit fresh-composer
variants.

A logical scoped atom declares its owning scope. Maitai resolves it to one
ordinary concrete Jotai atom in the nearest matching scope node. The same
logical atom in two Thread or Route nodes therefore has isolated concrete
identity, while descendants can resolve parent-scoped values without copying
them.

Scope render preparation is restartable and has no externally observable side
effects. Retained-entry publication, descriptor invalidation, mount ownership,
and LRU trimming occur in layout commit. Every committed provider owns a unique
lease token; mounted count is the active-lease set size. This makes StrictMode
setup, cleanup, and setup replay idempotent and prevents stale cleanup from
releasing another mount.

Retention is nested per parent and child scope definition. Only unmounted nodes
are eviction candidates. LRU order comes from a renderer-local monotonic
sequence rather than wall-clock time. Disposal removes the parent entry first,
recursively disposes retained children, releases Maitai-owned subscriptions and
family bindings, and makes existing handles final. Cleanup errors are reported
after all cleanup has been attempted; they cannot resurrect the node.

Same-key descriptor updates preserve primitive signal bindings, retained
descendants, and signal-family state. Descriptor-dependent cached bindings are
recreated, and a context-version atom invalidates mounted derived readers only
after layout commit. A different key or parent selects a different state graph;
Maitai never implicitly merges populated graphs.

Maitai families normalize explicit keys, primitive values, ordered arrays, and
sorted plain-object fields deterministically. Non-plain objects use identity.
Scoped family entries dispose with their node. App-scoped conversation view
families have explicit deletion by conversation ID rather than an unrelated
time or count cap.

Persistence is an Adapter with explicit storage key, codec/default, hydration
mode, optimistic-write policy, synchronization policy, and error behavior.
Persisted reads are synchronous loadable snapshots with `loading`, `ready`, or
`error` status. Hydration, acknowledgements, and broadcasts carry ordering
evidence so an older event cannot overwrite a newer authored value. Policies
are separate:

- `cross-window` applies ordered events from every renderer;
- `same-window` shares local writes in one renderer but ignores live writes from
  other windows;
- `none` hydrates and writes without a live subscription.

The renderer `persisted-atom-store` remains the shared persistence substrate
below that Adapter. It owns main synchronization, ordered mutation delivery,
and the imperative read/write/subscribe API needed by bootstrap, migration,
fixtures, and non-React runtime Modules. Ordinary React-facing drafts and
preferences consume the Maitai persisted Adapter instead of rebuilding local
`useState` hydration and subscription controllers over that substrate.

Maitai may adapt an existing external store into a read-only atom when atom
composition materially helps a view. The external Module remains the only
writable authority and owns its runtime lifecycle.

After task-lifecycle cutover, Workbench renders only the selected task page.
Task switching synchronously unmounts the old keyed page and mounts the new
Thread/Route scope path. Explicit atoms restore supported composer, transcript,
collapse, and route-presentation state. The application header reads one value
from the selected RouteScope. Header actions remain a separate plural keyed
registry.

The detailed field disposition is maintained in
`docs/renderer-view-state-ownership.md`.

## Authority boundaries

Maitai is authoritative only for renderer-local UI and view state. It does not
become a writable mirror of:

- Rust Core Project and Session domain data or Thread links;
- another Window Session's tabs, panels, selection, or layout;
- TanStack Query snapshots, freshness, retries, or invalidation;
- Codex conversation, Turn, request, stream, or execution state;
- Browser webContents, host claims, navigation runtime, cookies, or sessions;
- Terminal PTYs, buffers, xterm instances, or process lifecycle;
- Y.Doc, provider, editor, EditorView, UndoManager, or relocation runtime;
- drag gestures, approval authority, native handles, or transport requests.

Atoms may store stable identifiers and presentation intent for those Modules.
They may not store DOM nodes, React roots, refs, `File`, Promise,
AbortController, mutable editor objects, webview elements, webContents handles,
xterm instances, PTYs, Yjs runtime objects, or authority snapshots that create a
second writable owner.

The surface-session invariant remains intact: a remounted editor surface receives fresh surface-local
view identity, while editor and collaboration lifecycle remains with its owning
Module. Maitai retained scopes never retain an editor instance, DOM, Y.Doc,
UndoManager, provider, or relocation participant. A durable PageTab may instead
own those non-DOM model objects through its dedicated deep runtime registry;
Maitai and React carry only its stable identity and short-lived view lease.

Block disclosure keeps stable occurrence identity,
restart persistence, same-renderer duplicate synchronization, and no live
application of another window's changes. Sharing a persistence transport does
not imply `cross-window` policy.

ADR 0013 remains intact: Thread/session/Codex runtime owns live Agent execution.
Maitai owns only the renderer presentation of that execution.

## Consequences

- Task continuity no longer depends on hidden React trees.
- Singular route-owned surfaces cannot accumulate multiple mounted owners.
- State retention has explicit identity, limits, cleanup, and diagnostics.
- Renderer persistence exposes hydration and ordering instead of relying on
  timing between async IPC and local baseline writes.
- Deep runtime Modules keep their existing interfaces and lifetimes.
- Scope and atom definitions require stable debug labels, and development
  diagnostics expose bounded read-only paths, counts, retention state, and
  disposal reasons without exposing internal Maps.
- Migration must delete each old writable owner when its replacement lands;
  dual writable state is not an acceptable transitional contract.

## Alternatives rejected

Keeping React `Activity` as the task state owner was rejected because it retains
DOM and component state, reconnects effects on reveal, and permits multiple
task trees to compete for app-shell surfaces.

One Jotai store per task was rejected because parent-scope inheritance,
app-shell imperative access, and one renderer-local state universe would be
lost.

A standalone retained `Map<string, unknown>` was rejected because it would
reimplement typed atoms, derived dependencies, subscriptions, and imperative
store access while still needing the same scope and disposal kernel.

Mirroring Query, Codex, Browser, Terminal, or Yjs state into writable atoms was
rejected because it creates competing authorities and weakens the lifecycle
Modules that already own those domains.

Using Jotai private internals or unbounded raw `atomFamily` caches was rejected
because upgrades and cleanup would depend on unstable implementation details.
