# ADR 0021: The local user works with Library authority

- Status: Superseded by [ADR 0068](0068-agent-runtime-execution-authority.md)
- Date: 2026-07-18
- Owners: Nodex maintainers
- Extends: ADR 0017, ADR 0018, and ADR 0019

Current contract: the user and all Agents have full access to the current Profile.
Project and Library routes select presentation and execution provenance, never
resource permissions. Profile/Library identity, Store epoch, resource lifecycle
and exact captured execution identity remain enforced. See
[Agent Runtime behavior](../product-specs/agent-runtime-behavior.md).

The access-context and grant rules below describe the superseded decision.

## Historical context

Nodex stores durable Pages and Databases in the local Profile's one Library.
Projects are execution contexts bound to one Database; they are not ownership
containers. Requiring a selected Project to open or edit every Library resource
would make archived Projects accidentally hide durable content and would turn a
Project's resource grants into the local user's own permission system.

At the same time, Project sessions and Agents must not gain Library-wide access
merely because the desktop user can browse the Library.

## Historical decision

Every content boundary receives an explicit access context:

- `{ kind: "library" }` means a trusted local human surface. The boundary derives
  the one Profile and Library from the open store; callers cannot submit a
  `libraryId`. The authority is fenced by Profile identity, Library identity, and
  store epoch.
- `{ kind: "project", projectId }` means a Project-scoped workflow. Existing
  Project binding, recursive grants, lifecycle, consent, and Full Access rules
  remain authoritative.

Library authority may read active or archived resources and mutate active
resources anywhere in its own Library. Deleted resources are absent. Archived
resource restoration remains a typed lifecycle operation rather than an
ordinary content write.

Library UI routes use Library authority. Project sessions, scheduled execution,
and Agent tools use Project authority. Moving or linking a Library resource into
a Project workflow never transfers ownership; it creates or requests an
explicit Project resource grant.

## Historical consequences

- Library content remains reachable after its former active Project is archived.
- Project coordinates retained by receipts, change logs, recovery records, or
  delivery ledgers describe actor/execution/delivery provenance. They are
  resolved by Core and are never a Library caller credential or a content
  lifetime owner. Project lifecycle cannot gate trusted local Library
  mutations.
- A Project cannot inherit access from the currently visible Library UI.
- The loopback HTTP boundary and Electron app window can expose Library routes
  only after deriving identity from the local store.
- Restoring or replacing the store invalidates captured authorities through the
  store epoch fence.
- New content APIs must accept `ContentAccessContext` instead of treating a
  `projectId` as both navigation state and content authority.
- Renderer-local Document scope identifiers are never Project credentials.
  Project-only Workspace and Codex capabilities derive a real Project ID from
  `ContentAccessContext` and remain unavailable for Library authority.
- Nested Page, Database View, and owned-Document reads inherit the containing
  surface's `ContentAccessContext`; adapter choice, query identity, and
  projection subscriptions must preserve that authority through every level.
- App-window sender trust admits a local caller; it does not choose that
  caller's authority. Main validates the explicit context carried by each
  content request and never derives it from the window's current Scene.
