# Frontend Engineering Conventions

This document defines stable, cross-feature construction rules for Nodex's
sandboxed React renderer. It answers three questions:

1. Which frontend owner should hold a piece of state or behavior?
2. Which boundary should a renderer feature use to read or mutate product data?
3. Which shared composition, editor, UI, and Storybook conventions should new
   frontend work follow?

It is an engineering guide and routing layer, not a product specification,
component inventory, visual snapshot, reliability protocol, or regression
ledger. Follow the links below for feature behavior and subsystem contracts.

## Admission rule

A rule belongs here only when all of these are true:

1. It changes how code is constructed across multiple independent frontend
   features.
2. It is expected to survive ordinary product, dependency, and visual changes.
3. It is not already authoritative in a product spec, ADR, reliability document,
   code contract, or test.
4. A type, helper, lint rule, component API, local comment, focused test, or
   Storybook story cannot make the rule sufficiently obvious by itself.

Prefer the narrowest enforceable seam. Route information as follows:

| Information                                                               | Source of truth                                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| User-visible feature behavior, labels, action order, and acceptance rules | [Product specifications](product-specs/index.md)                                  |
| Runtime ownership, dependency direction, and cross-runtime flows          | [Architecture](ARCHITECTURE.md) and ADRs                                          |
| Projection delivery, collaborative sync, recovery, and durability         | [Reliability](RELIABILITY.md)                                                     |
| Detailed renderer state inventory and migration decisions                 | [Renderer view-state ownership](renderer-view-state-ownership.md)                 |
| Reusable visual direction for agent-built UI                              | [General design guidelines](../.agents/skills/general-design-guidelines/SKILL.md) |
| Exact dimensions, classes, timings, layer values, and component states    | Shared code, focused tests, and the nearest visual surface                        |
| Test runtime selection and handoff commands                               | [AGENTS.md](../AGENTS.md) and [Development](development.md)                       |
| A local dependency or lifecycle caveat                                    | The owning Adapter/component plus its behavioral test                             |

When a convention changes, replace the old statement. Do not append a historical
layer; git history already preserves it.

## Renderer boundary

The renderer is sandboxed presentation. Durable product operations enter an
owning renderer Module through a semantic Interface, then cross a named typed
query, control, or command Adapter and the typed preload/Main boundary. Shared
operations may expose a narrow facade from
[`src/renderer/lib/api.ts`](../src/renderer/lib/api.ts), but the renderer has no
general channel-invocation facade. Renderer modules do not open Core sockets,
access SQLite, use arbitrary filesystem paths, or call Electron channels
directly.

Keep the dependency direction simple:

```text
component -> owning feature Module -> typed renderer Adapter -> preload/Main Adapter
pure renderer helper -> transport-neutral shared contract
```

- Put feature workflows and deep feature-owned state under
  `src/renderer/features/`.
- Put reusable surface composition and UI primitives under
  `src/renderer/components/`; common facades belong in `components/ui/`.
- Put pure renderer helpers, query definitions, stores, and transport facades
  under `src/renderer/lib/`.
- Put transport-neutral contracts and validation in `src/shared/`. Shared code
  must not import Electron Main or renderer presentation.
- Keep protocol-facing Codex shapes sourced from
  `packages/codex-app-server-protocol`; derive view models rather than writing a
  parallel raw protocol model.

The environment is the current inventory. Read the relevant directory,
`package.json`, and nearby tests instead of adding dependency versions or file
lists here.

## State ownership

### Interactive search latency

Interactive Page search uses the shared `InteractivePageSearch` interface. A keystroke queries the prewarmed Core-stamped metadata projection synchronously in render; it must not clear rows, wait for a deferred query or Effect, or introduce a skeleton. Async Core enrichment may add body-only results and evidence, represented by one stable trailing status row. Empty state is valid only after enrichment for the live query has settled. Store epoch, authorization scope, and commit revision fence every accepted projection and response.

One state has one writable owner. Caches, descriptors, and projections may
mirror an authority for presentation, but they must not become a second place
that decides truth.

| Owner                                   | Use it for                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| React component                         | One mounted interaction: disclosure, hover, menu state, gesture geometry, upload progress, or confirmation UI                             |
| Maitai App/Thread/Route/Composer atom   | Renderer-local presentation shared for that exact semantic scope                                                                          |
| Maitai persisted atom                   | Authored drafts or preferences that require restart persistence and have a versioned codec plus synchronization policy                    |
| TanStack Query                          | Bounded, low-frequency Main/Core read models and mutation cache coordination                                                              |
| Focused feature store or runtime Module | High-frequency, optimistic, streaming, or lifecycle-bearing state such as conversations, Board projections, Browser guests, and Terminals |
| Document or Canvas session              | Collaborative content, sync, presence, and mounted surface lifecycle                                                                      |
| Window Session aggregate                | Owner-scoped Scenes, surface descriptors, panel trees, navigation, and settled layout state                                               |

The exhaustive inventory lives in
[Renderer view-state ownership](renderer-view-state-ownership.md). Apply these
rules when choosing among the owners:

- Keep disposable interaction state component-local. Promote it only when its
  semantic lifetime outlives that mounted subtree or another independent
  surface must consume it.
- Store intent when the rendered value can be derived from current inputs. Do
  not synchronize derivable highlights, selections, filtered options, or
  presentation mirrors through Effects.
- Keep live objects with their runtime Module. Atoms and Window Session
  snapshots may retain stable identities and serializable descriptors, not DOM
  nodes, refs, editors, Y.Docs, Promises, Query observers, Browser guests, PTYs,
  or native handles.
- Keep continuous pointer, resize, scroll, and observer samples outside broad
  React owners. Project only guarded semantic changes such as a breakpoint,
  settled size, or selected target into application state.
- Treat component lifetime as presentation lifetime. Browser guests, Terminals,
  conversation streams, Document sessions, and other resources follow their
  explicit owner lifecycle rather than assuming React unmount is a durable
  close operation.

An ordinary dialog stays with its mounted interaction. A modal that must
survive its trigger row or route subtree uses the renderer-window application
modal registry and root host. The registry stores component/props presentation
descriptors rather than domain or runtime authority; the feature still owns the
action and product semantics.

## Data, projections, and mutations

- Queries use named typed query Adapters; subscription bookkeeping uses typed
  control Adapters; writes enter the Module that owns presentation, ordering,
  retry, and settlement. React presentation modules (`.tsx`, regardless of
  directory) do not import renderer transport capabilities or the preload
  bridge; they call semantic owner Interfaces exposed by non-visual Adapter
  modules. Centralize query keys, query options, and IPC subscriptions in
  `src/renderer/lib/` so features do not invent transport or invalidation paths
  in components.
- Every transport-crossing write has a semantic command definition naming its
  authority, owning Module, and visibility protocol. The endpoint contract
  constrains acknowledgement evidence; it does not replace the owner's local
  presentation or materialization rules.
- Treat Main/Core reads as bounded projections. Preserve pagination and group
  scope; do not hydrate complete Documents or unbounded collections to render a
  list, picker, sidebar, Board, or search result.
- A successful durable mutation response is authoritative. Admit its committed
  effect through the shared projection path immediately; the later event stream
  is recovery and fanout, not a second completion condition. Exact sequencing
  and repair rules live in [Reliability](RELIABILITY.md).
- An acknowledged optimistic transform remains composed over canonical base
  until the affected projection actually materializes it. Promise fulfillment
  or an unrelated cursor floor alone is not proof that a bounded view contains
  the result. Installing canonical data in an external-store cache is also not
  a render acknowledgement: keep the overlay until the subscribed React owner
  has committed props that contain the result, and fence settlement by operation
  identity so an older completion cannot clear newer intent.
- Update a narrow Query cache when a mutation returns its complete next value;
  otherwise invalidate the exact affected projection. Preserve unaffected
  sibling/detail caches and let each projection owner decide canonical repair.
- Use typed mutation outcomes for expected domain branches such as conflict,
  missing identity, or validation failure. Reserve thrown exceptions for
  transport and programming failures.
- Validate external data at transport, persistence, and protocol boundaries.
  Keep normalized renderer state strongly typed rather than repeatedly parsing
  it inside leaf components.
- Search and picker acceptance must be query-fresh at the action seam. Rendering
  a stale batch while a new request loads is acceptable; executing an item that
  is no longer valid is not. Never implement product search by scraping rendered
  DOM text.

## Projection and component composition

Start from semantics, not JSX.

- Derive renderer-facing models in pure projectors, normalizers, bucketizers,
  or controllers before rendering. These models own ordering, grouping,
  visibility, stable identity, and action eligibility.
- Keep leaf renderers declarative. They consume already-derived labels, states,
  lane membership, and actions instead of rescanning protocol or domain data.
- Give each semantic role one canonical projection and one render lane. Avoid
  rendering the same request, final content, diff, activity, or pending action
  through several condition trees.
- Use discriminated unions for closed surface, request, activity, and policy
  families. Make unsupported variants explicit instead of falling through to a
  generic UI that accidentally acquires new semantics.
- Keep genuinely distinct transcript or system concepts in dedicated leaf
  components. Reuse shared chrome around them without erasing their domain
  identity.
- Use stable semantic keys. Presentation state such as “currently trailing,”
  “selected,” or “action target” may join the key only when that state change
  intentionally resets the mounted interaction.
- Keep high-frequency updates behind focused subscriptions and selectors. A
  broad shell, Context provider, or route owner should not rerender for every
  stream delta, pointer sample, terminal chunk, or editor transaction.

Forms with structural validation, coercion, or multi-field constraints use
TanStack Form with a colocated Zod schema. A simple single-field interaction
uses local state and a submit-time guard.

## Commands, overlays, and gestures

- Register application keyboard actions once at the active window in bubble
  phase. Editors, inputs, dialogs, menus, terminals, and other local scopes get
  first ownership of the event.
- Resolve the active surface capability before executing an app action. Call
  `preventDefault()` only after the command accepts the event, and respect
  composition, repeat, editable ownership, and local keyboard scopes.
- A contextual surface registers one narrow capability/execution port for its
  mounted lifetime and updates the reactive target behind that port. It does not
  install a second global shortcut listener.
- Treat imperative focus as a one-shot interaction intent. Roving active or
  selected state may determine the next tab stop, but data/projection refreshes
  must not replay an already handled focus request. Async focus that waits for
  mounting, virtualization, or a portal target carries request identity and is
  consumed only after the target receives focus.
- Model drag and drop with one semantic target policy and one owning controller
  per gesture family. Nested providers or parallel native/synthetic paths must
  not split registration and dispatch authority.
- Portalled interactive surfaces keep their normal body portal unless a real
  local clipping or ownership boundary requires otherwise. Fix pointer/focus
  ownership at the responsible DOM layer; do not mask it with arbitrary z-index
  escalation or full-surface pointer overlays.
- Shared dialogs own the named modal layer above editor chrome and establish a
  `NodexFloatingLayerProvider` for their content. Their portalled Dropdown,
  Popover, ContextMenu, HoverCard, and Tooltip descendants derive the next
  layer from that owner; feature dialogs and editor extensions do not compete
  with the modal using one-off z-index values.
- A floating owner above the ordinary app-shell floating layer establishes a
  `NodexFloatingLayerProvider`. Shared Dropdown and Popover primitives derive
  each portalled descendant's next layer through React context, including
  recursively nested surfaces. Feature callers do not assign child-menu
  z-indexes or move them into clipping ancestors.
- Content-owned context menus are constructed only through the deep module in
  `src/renderer/components/ui/context-menu.tsx`; feature code does not compose
  third-party context-menu parts directly. That module owns immediate pointer
  activation, same-level submenu coordination, pointer grace, lazy content
  mounting, collision geometry, and the sole visual surface. Feature bodies
  supply lightweight semantic rows and `renderContent` thunks, not eager editor trees.
  Repeated data surfaces mount one menu host around the surface and resolve the
  target from the context-menu event; they do not mount a complete Root and
  binding tree per row or card. Content or SubContent owns overflow, ring,
  radius, and shadow, so feature content never nests a second fixed-width
  dropdown Surface inside it. OS-integrated app-shell menus instead define one
  typed declarative action model and pass it through the shared native menu
  bridge. Existing app-owned overflow menus remain browser fallbacks instead of
  being deleted. Renderer features never import Electron APIs directly, and row
  context-click plus overflow triggers must share the same action builder and
  execution path.
- Use the named layer constants in `src/renderer/lib/app-shell-layers.ts` and
  shared portal primitives. Exact layer values are executable code, not prose.
- Base UI is the interaction engine behind Nodex-owned buttons, menus, dialogs,
  popovers, tooltips, tabs, collapsibles, scroll areas, and sliders. Feature code
  imports the app-owned modules under `src/renderer/components/ui/`, not
  `@base-ui/react`; those modules translate library events and state into stable
  Nodex props, `data-slot` hooks, CSS variables, focus rules, and layer ownership.
- Floating UI is a geometry dependency, not a second component system. Direct
  imports are limited to the small set of editor positioning controllers and UI
  adapters audited by `verify:renderer-ui-boundaries`. A feature that only needs
  a menu, popover, tooltip, or hover surface uses the Nodex primitive instead.
- First-party and vendored editor source must not depend on Radix or its DOM/CSS
  implementation tokens. The remaining Radix lockfile graph is an explicit
  Excalidraw transitive exception and is not an app UI seam.

## Editors and collaborative surfaces

- A mounted primary Page/Card/Canvas surface renders from its owned Document
  session. Metadata summaries and read-model caches never seed or overwrite the
  collaborative title, body, or scene authority.
- Key shared Document sessions and durable client queues by the Core-authored
  `libraryId + accessContext + documentId` identity. Renderer-local scope IDs
  and arbitrary routable Projects are presentation or navigation state, never
  substitutes for content authority.
- Keep each editor source explicit and discriminated. Legacy serialized content,
  collaborative Documents, templates, and read-only projections have different
  hydration, replacement, and save rules.
- Keep schemas, extensions, parsing, and serialization composed in focused
  editor modules. Preserve NFM round trips when changing any parser, serializer,
  clipboard, mention, or adapter path.
- Treat ProseMirror/Tiptap view objects as mounted APIs. Attach browser-managed
  editable DOM behavior through the owning editor lifecycle, and keep callback
  refs stable when they write registration state.
- Separate content authority from surface-local interaction. Editors that share
  one Document may still own independent selection, undo, caret, camera, tool,
  and presence contributions.
- Bind collaborative history through the registered typed editor capability,
  before any view exists. Feature commands use the surface history owner,
  never a plugin-key scan or a second keyboard-priority stack. Structural
  gestures enter that owner before asynchronous preparation; retain its
  cleanup until committed results and their inverse tokens have been handed off.
- Preserve semantic inverse evidence when Core rebuilds collaborative addresses.
  Subscribe through the canonical Document fence seam, not DOM inspection, and
  use guarded Core history replay. Feature code must not mutate Yjs private
  items/delete sets or clear another surface's retained history.
- Flush a mounted Document through its typed mutation barrier before a
  structural command consumes collaborative shape. The durability contract is
  defined in [Reliability](RELIABILITY.md), not reconstructed in renderer code.
- Large text or diff sources use bounded or virtualized viewers. CSS clipping
  and scroll containers do not reduce mounted DOM, parsing, or accessibility
  work.

Feature-specific editor behavior belongs in the focused specifications listed
in [Product specifications](product-specs/index.md). Rich-editor performance
work follows [Page Stage rich-editor performance](product-specs/card-stage-rich-editor-performance.md).

## Shared UI system

- Prefer Tailwind utilities and existing semantic token families. Keep global
  CSS for theme sources, reset/base behavior, third-party integration, and
  selectors that utilities cannot express.
- Consume shared buttons, inputs, dialogs, dropdowns, popovers, tooltips,
  toasts, floating surfaces, settings rows, and related controls through
  `src/renderer/components/ui/`. Extend the facade or add a shared preset when a
  shape recurs; do not grow feature-local clones.
- Keep app-owned icons in the shared icon modules. Choose icons by product
  meaning and normalize geometry at that boundary instead of scattering inline
  SVG paths or compensating classes through features. Search the other shared
  icon modules first; `generic-icons` and Lucide fallback icons are last resorts.
- Give each reusable glyph one geometry owner. Distinct product meanings may
  keep semantic wrappers, but those wrappers share the glyph instead of copying
  SVG paths. Cross-runtime consumers share transport-neutral geometry data and
  keep runtime-specific render adapters.
- Keep diagrams, data marks, favicons, brand artwork, and rendering fixtures at
  their owning boundary. Treat them as reviewed exceptions rather than forcing
  them into the app-icon API.
- Give visual roles an explicit semantic class or data attribute at their owning
  module. Do not style controls through localized accessibility copy such as
  `aria-label`, or through interaction mechanics such as `draggable`.
- Let shared primitives own ordinary radius, padding, focus treatment,
  collision behavior, motion, and overlay chrome. A feature should provide
  content and semantic variants, not a second visual system.
- Keep hidden action chrome keyboard-reachable only when its controls are
  revealed by hover, focus-within, open state, or another explicit accessible
  state. Visual opacity alone must not leave concealed controls in sequential
  focus order.
- Honor reduced motion at the shared motion boundary. Animate semantic presence,
  disclosure, and geometry continuity; avoid animation that creates a second
  state owner or delays authoritative text updates.
- Treat rendered CSS and browser behavior as the evidence. Put reusable numeric
  or state rules in helpers with boundary tests, and preserve visual contracts
  with focused stories instead of long class-string assertions.

### Theme token ownership

Renderer color and motion vocabulary has three layers. Choose the highest layer
that accurately describes the UI role:

1. Semantic roles are the component-facing contract for shared task and
   conversation UI. Use `text-info`, `text-danger`, `text-tertiary`,
   `semantic-text-secondary`, `border-default`, `bg-text/10`, and
   `bg-text-info` to express lifecycle status and hierarchy. Icons inherit the
   same role through `currentColor`.
2. Product compatibility aliases (`--color-token-*` and their Tailwind
   utilities) support established or feature-native surfaces. They are an
   adapter during surface-level migration, not the default vocabulary for new
   agent-task UI.
3. Host/editor variables (`--vscode-*`) are theme inputs. Components must not
   consume them directly; generated contracts and product adapters translate
   them into stable roles.

Do not mix layers to express one role inside a component—for example, a failure
row must not combine a semantic error utility, a host variable, and a legacy
token for its icon and label. Migrate by coherent surface, validate light/dark
and lifecycle states in the seeded real app or an isolated story, and leave
feature-native Database, Board, Canvas, and editor semantics alone unless the
roles are truly shared.

The build-time owner is `scripts/semantic-theme/`. Generated artifacts are
committed, deterministic inputs to the renderer build; ordinary builds do not
need the temporary extraction source. `vp run semantic-theme:verify` checks
artifact provenance, per-window/per-scheme transitive dependency closure,
cycles, collision ownership, required utilities, and migration ratchets. A
conditional declaration is not a global fallback, and a host variable is not a
provider outside the targets where the host actually supplies it. Product
foundation values such as radius scale remain product-owned. Never hand-edit a
generated theme artifact.

Shared activity primitives require an explicit semantic lifecycle status. The
primitive owns the status color for its icon and summary; feature call sites
translate their protocol/view state into `pending`, `running`, `completed`,
`skipped`, or `failed` instead of relying on a default. Validate foundation and
surface contracts with computed-style browser tests: source presence alone
cannot prove that a `var(...)` chain resolves after Tailwind and cascade.

For new or substantially redesigned surfaces, also follow the
[general design guidelines](../.agents/skills/general-design-guidelines/SKILL.md).

## Feature routing

Load the narrow contract only for the branch being changed:

| Feature branch                                                              | Read first                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Workbench Scenes, sidebar, panels, tabs, navigation, and shell presentation | [Workbench shell](product-specs/workbench-shell.md) and the Scene ADRs             |
| Database Views, Page creation, Page Stage, and Properties                   | [Database, Pages, and Views](product-specs/database-pages-and-views-behavior.md)   |
| Canvas inline and Stage presentation                                        | [Canvas](product-specs/canvas-behavior.md)                                         |
| Chat lifecycle, workspaces, worktrees, forks, and runtime integrations      | [Codex workspace](product-specs/codex-workspace-behavior.md)                       |
| Renderer scope and persistence ownership                                    | [Renderer view-state ownership](renderer-view-state-ownership.md)                  |
| Codex transcript, requests, tools, composer, and turn/activity projection   | [Codex transcript behavior](product-specs/codex-thread-transcript-behavior.md)     |
| Codex owner/follower publication and recovery                               | [Owner/follower streaming](product-specs/codex-thread-owner-follower-streaming.md) |
| Thread Summary sections, rows, artifacts, Git actions, Browser, and PiP     | [Thread Summary panel](product-specs/thread-summary-panel-behavior.md)             |
| Scheduled task/template route and editor                                    | [Scheduled route](product-specs/scheduled-route-behavior.md)                       |
| Settings navigation, catalog, search, page composition, and deep links      | [Settings route](product-specs/settings-route-behavior.md)                         |
| Review and Git diff presentation                                            | [Review right panel](product-specs/review-right-panel-behavior.md)                 |
| Command palette ranking and execution                                       | [Command palette](product-specs/command-palette-behavior.md)                       |
| Board and cross-surface drag behavior                                       | [Board drag and drop](product-specs/board-drag-and-drop-behavior.md)               |
| NFM editor interactions                                                     | The matching `nfm-*` document in [Product specifications](product-specs/index.md)  |

These documents own feature behavior. Keep this file limited to conventions
that remain useful when those features change.

## Seeded runs, Storybook, and frontend tests

Testing commands, runtime selection, and handoff gates are authoritative in
[AGENTS.md](../AGENTS.md) and [Development](development.md). Frontend work adds
evidence at the seam that owns the behavior:

- Follow [AGENTS.md](../AGENTS.md)'s seeded-first UI evidence boundary. Use or
  extend an authoritative scenario before creating feature-level stories or
  parallel fake view models.
- Use an authoritative isolated scenario when the behavior depends on an integrated Project, Database projection, Page lifecycle, document authority, preload/Main transport, or Window Session.
  The same domain recipe should serve Core integration and Electron/UI consumers through runtime-specific adapters; keep DOM navigation and observation in the optional UI projection.
- Use `vp run dev --home <dir> --seed <scenario-id>` for a persistent,
  mutable real-app environment with HMR. The catalog initializes a new home but
  does not constrain later manual edits. Deterministic UI facts and navigation
  belong in the scenario's dedicated Electron E2E spec.
  Scenario manifests map stable logical keys to canonical IDs, so UI tests must
  not find authority by title when an identity is available.
- Reserve Storybook for reusable primitives, transient or intentionally
  synthetic states, focused behavioral contracts, and pressure fixtures that
  do not need the product runtime. A user-visible change alone does not require
  a story.
- Stories use production components with injected runtime boundaries. Keep them
  canvas-first and focused; render menu-driven states open by default.
- Remove an integrated story after a real scenario or behavior test provides
  equivalent observable evidence, and delete its orphaned fake state in the
  same change.
- Assert visible structure, accessibility, and behavior. Raw class checks,
  serialized markup, test IDs, and source inspection are fallback tools only
  when those representations are the real contract.
- Keep pure renderer logic in ordinary `.test.ts` files so it runs in Node.
  Name non-TSX tests that require browser globals `.jsdom.test.ts`; ordinary
  `.test.tsx` remains the React/jsdom path, while pure TSX uses
  `.node.test.tsx` explicitly.
- Renderer DOM tests and their testkits import the owning
  `shared/block-documents/*` module directly. Importing its aggregate entry
  point pulls unrelated schemas and editors into every isolated test file.
- Keep `test/dom.tsx` independent of feature Providers. Use
  `test/app-maitai.tsx` for application atoms and `test/thread-maitai.tsx` only
  when thread/route owners are part of the behavior. Both create a fresh Store
  and dispose it on unmount; a generic DOM helper must not import the workbench
  scope graph on behalf of every component test.
- Renderer behavior tests make Motion timelines instant by default without
  impersonating a user's accessibility preference, so transition timers and
  exit trees do not distort settled-state assertions. Tests that own full-
  motion or reduced-motion contracts set that state explicitly through the
  shared adapter and restore it during cleanup.
- Parent composition tests may replace an independently covered heavy child
  surface with a type-checked adapter that preserves the child's semantic
  ports. Keep the child's own interaction and rendering behavior in its focused
  suite rather than paying for the full subtree in every parent case.

Before adding prose here, confirm that every affected feature branch needs the
same convention and that the nearest executable seam cannot carry it. That is
the completion condition for keeping this document compact.
