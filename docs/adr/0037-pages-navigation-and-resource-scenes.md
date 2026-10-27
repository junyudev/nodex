# ADR 0037: Pages navigation and Resource Scenes

## Status

Superseded by ADR 0038

## Context

Library is Nodex's durable content authority. It owns Pages, Databases,
Canvases, Documents, Data Sources, and Views independently of Project
lifecycle. The first desktop navigation for that authority exposed a complete
Library workspace: a recursive ownership tree in the sidebar, a searchable
Library Home, Library-only Page/Database/Canvas routes, and separate route
presentation state.

That product structure was larger than the user task. Standalone content is a
small, low-frequency set—typically a few notes, prompt snippets, or a Database
that does not belong to an active execution context. The full workspace also
duplicated resources already represented by Projects, and a Library Database
could either jump to a Project or use a second controller that only resembled a
normal DB View tab. Navigation authority, content authority, and presentation
ownership were conflated.

Nodex needs a lightweight entry to durable non-Project content while preserving
its execution-first product model. It does not need a second knowledge-browser
workspace, a synthetic Project or Session, or a parallel tab store.

## Decision

### Pages is a navigation projection, not a new aggregate

The sidebar exposes a `Pages` section alongside Projects. It reads the Library
Module's bounded `standalone_roots` projection and displays only active
top-level Page, Database, and Canvas roots.

Eligibility is evaluated in Core before count, cursor, or force-include logic:

- a root is omitted when it is the canonical primary Database of a
  non-archived Project;
- a deterministic Project primary Canvas is omitted under the same lifecycle
  predicate;
- archived Project resources become eligible again and disappear again after
  restore;
- ordinary Project grants do not affect eligibility because access is not
  navigation ownership.

The complete Library `children`, `path`, and `catalog` reads retain their domain
semantics. Pages does not change ownership, hide nested resources from Core, or
become an authorization source.

Pages uses the same sidebar section, row, action, and pager primitives as
Projects. It is flat: nested Pages, Database Views, and row Pages are opened in
the selected content surface, not expanded in the sidebar. The section has no
Library Home action. A pager appears only when a real hidden item or source
continuation exists.

### Each top-level root owns a Resource Scene

`WorkbenchSceneSnapshot` version 4 adds the owner
`{ kind: "resource", root }`, where `root` is one top-level Page, Database, or
Canvas. `WorkbenchLocation` layout version 6 selects that owner directly.

The root is the Scene's protected primary surface. It uses the same right and
bottom split tree, tab strip, preview promotion, durable surfaces, cloning,
persistence, and global Back/Forward transitions as Project and Session Scenes.
Opening a child first resolves the authoritative Library path:

- a target under the current root opens in the current Resource Scene;
- a target under another root selects that root's retained Resource Scene;
- the Pages sidebar remains active on the owning root while child tabs change.

Resource Scene materialization and live title updates are presentation
maintenance and do not create navigation-history entries. Settings,
Automations, and pending routes may retain a Resource location as their
`returnTo`. Legacy layout v5 Library routes migrate to their stored `returnTo`;
there is no compatibility Library Home or dual-written route.

### Access context stays explicit

Scene ownership does not grant content access. Database, Page, and Canvas
surface descriptors carry the existing explicit
`{ kind: "project", projectId } | { kind: "library" }` access context.
Resource Scenes use trusted local-human Library authority. Ordinary row
activation never selects a Project or infers one from a primary binding or
grant. `Open in Project` is an explicit transition and remains separate.

Database resources render through the shared Database View controller and
presenter used by DB View tabs. Page resources use the shared Page Stage with
the Library Document/detail adapter and no fake Project label. Canvas resources
use the shared Canvas Stage. Resource Scenes do not expose Project-only
Terminal, Files, Review, or Agent capabilities.

The fixed App Header publishes a breadcrumb beginning with `Pages`, followed by
the root and active child title. `Pages` is context, not a link to a nonexistent
home. Database entry points and DB View consistently use the Board glyph rather
than a table or cylinder icon.

## Authority boundaries

- Core Library owns resource identity, placement, lifecycle, canonical path,
  standalone-root eligibility, and content access evaluation.
- Workspace owns Project lifecycle and canonical primary Database bindings.
- A Window Session owns Resource Scene location, tab/split presentation, and
  Back/Forward history.
- Renderer Query adapters choose Project or trusted-Library transports from the
  descriptor's explicit access context; they never derive authority from the
  selected Scene.
- Sidebar state presents a Core projection and cannot filter against its
  currently loaded Project window.

## Consequences

- A few durable standalone resources remain one click away without introducing
  another workspace or catalog page.
- Project primary resources have one obvious navigation entry while archived
  Projects do not make their Library content unreachable.
- Database, Page, and Canvas behavior has one Workbench surface implementation
  per resource type instead of Library-only renderers.
- Back/Forward can move between Projects, Sessions, and standalone resources
  while restoring each owner Scene atomically.
- The word Library remains correct in domain, protocol, and authority code but
  is no longer a desktop route or sidebar destination.
- Inbox remains a separate future product decision; Pages does not encode
  capture, unread, or triage state.

This ADR supersedes ADR 0032 where it models Library as an auxiliary route and
extends ADR 0034's Scene owner algebra with Resource owners. ADR 0035's
Project-focused root and Agent Dock decisions remain unchanged.

## Rejected alternatives

### Keep Library Home and rename only the sidebar section

This preserves the duplicate route, presentation state, and renderer split
while hiding the architectural problem behind different copy.

### Filter roots in React from the loaded Projects sidebar

The Projects window is bounded, collapsible, and asynchronously loaded. It
cannot decide global eligibility, pagination totals, archived lifecycle, or
force-include behavior without flicker and incorrect duplicates.

### Use one global Pages Scene

A Scene requires one protected primary. A global owner would need a synthetic
Pages Home or make an arbitrary first resource special, and tabs from unrelated
roots would contaminate one another's retained context.

### Open bound Databases in their Project automatically

This makes an ordinary content click mutate execution context and prevents a
stable standalone history location. Explicit `Open in Project` communicates
that transition without surprising navigation.

### Create Library-specific Database, Page, or Canvas views

Parallel controllers inevitably drift in features and behavior. Explicit
access-context adapters let the normal Workbench surfaces use the correct
transport without duplicating their UI.
