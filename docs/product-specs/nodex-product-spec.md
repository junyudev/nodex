# Nodex Product Specification

## Purpose

Nodex is a local-first workspace for shared context and agent work. Pages hold
durable, block-based context that people can shape and coding agents can access
through explicit tools. It combines a Library of Pages, Databases, Views,
Canvases, schedules, and history with Projects, Chats, worktrees, terminals,
Browser, Files, and Review. The product keeps an agent's execution context,
output, and conversation close to the durable work that motivated it without
turning Projects or Chats into content ownership.

This document is the product map. It defines the stable product promise,
capability boundaries, and routes to focused contracts. It does not own detailed
UI interaction, storage schema, migration versions, CLI flags, runtime topology,
or recovery algorithms.

## Product promise

Nodex helps a local builder:

- organize work in durable Pages and Database Views;
- shape, select, and revisit the context a Chat needs;
- start and resume coding-agent Chats in the correct filesystem context;
- use local worktrees and Environments for isolated execution;
- keep Browser, Files, Terminal, Review, and agent output beside the Chat;
- let local agents read and change authorized Nodex content through semantic
  tools rather than raw storage access;
- recover windows, Documents, history, and whole-Store backups without creating
  a second cloud authority.

Nodex is desktop-first. It does not provide cloud content sync, remote multi-
account collaboration, mobile presentation, or a general database/filesystem
server.

## Product model

A local Profile owns one Library. The Library owns durable content: Blocks,
Pages, Documents, Databases, Data Sources, Views, Canvases, assets, schedules,
and history. A Project is an execution context: it owns filesystem sources,
Chats, terminals, approval policy, and one primary Database binding, and it may
receive access to other Library resources.

Project lifecycle never owns or deletes Library content. A Page has one stable
Block identity, one independently synchronized Document, and exactly one
Library, Page, or Data Source parent. References, mentions, relations, Views,
and grants present or authorize content without changing that parent.

Database, Data Source, and View are independent identities. Database is a
placeable Container; Data Source owns schema, row Pages, and values; View owns a
saved presentation over one Data Source.

The canonical vocabulary, invariants, and authority table live in
[CONTEXT.md](../../CONTEXT.md). Runtime owners and dependency directions live in
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Core experiences

### Projects, Library, and Workbench

A fresh Profile opens with one ordinary source-backed Project, its primary
Database and Canvas, and an editable Welcome Page. Projects may also have no
source or no Chat. Removing a Project archives execution context while leaving
its source folders and Library resources intact.

The Workbench presents Project, Session, and Pages Scenes through one
multi-window shell. Each Window Session owns its local navigation, tabs, panel
trees, layout, and previews; all windows share canonical content and execution
state. Pages offers bounded navigation to Library roots that need an entry
outside active Projects and never becomes a second content owner.

Read [Product Foundations](product-foundations.md) for onboarding, Projects,
Library navigation, grants, and lifecycle. Read
[Workbench Shell](workbench-shell.md) for Scenes, sidebar, panels, tabs,
previews, Browser/Files/Terminal placement, navigation history, and multi-window
presentation. Read [Desktop Startup Behavior](desktop-startup-behavior.md) for
the canonical first-window, progress, native-material, and failure-recovery contract.

### Pages, Databases, and Views

Pages combine a rich collaborative title/body Document with optional Data
Source-defined properties. Page Stage opens the Page identity independently of
its current View or parent. A Page outside a Data Source remains complete and
does not acquire synthetic workflow values.

Project work also receives short Database-scoped Page keys such as `LAB-13`.
They make Pages easier to scan, copy, search, and discuss while the stable Page
UUID remains the identity used by Documents, references, links, and mutations.

Database Views provide Board, List, Table, Toggle List, and Calendar-shaped
presentations. Saved filters, sorts, grouping, displayed properties, and manual
positions belong to the exact View. Every growing list is bounded and honest
about continuation and totals.

Creating a Page commits identity, title, body, membership, property values, and
placement as one semantic operation. Moving and drag/drop operate on stable
identities and preserve Documents and history. Source Properties use registered
identity/type rather than display-name matching; Relation remains a non-owning,
authorization-safe reference set.

Read [Database, Pages, and Views Behavior](database-pages-and-views-behavior.md)
for the feature contract, [Board Drag and Drop Behavior](board-drag-and-drop-behavior.md)
for Board movement, and the focused NFM specifications in
[the product-spec index](index.md) for editor interactions.

### Canvas

Canvas is a document-bearing Block with an independently synchronized scene. It
can live at the Library root or inside a Page, open inline or in Canvas Stage,
and appear through a Project's default entry point without becoming a Database
View. Multiple surfaces share scene authority while retaining local camera,
selection, tools, and undo.

Read [Canvas Behavior](canvas-behavior.md).

### Calendar and Scheduled work

Page schedule, recurrence, occurrences, reminders, and notifications are
available independently of the Calendar renderer. Recurring edits require an
explicit occurrence scope and are idempotent semantic operations. Calendar
presentation remains behind its checked-in release gate while preserving all
durable View and scheduling data.

Scheduled tasks are separate Automation definitions and runs managed through
the Workbench Scheduled route. Read
[Calendar and Reminders Behavior](calendar-and-reminders-behavior.md),
[Scheduled Route Behavior](scheduled-route-behavior.md), and
[Desktop Notification Behavior](desktop-notification-behavior.md).

### Chats and agent work

Chats are user-facing interactive conversations. `Session` and `Thread` remain
persistence/protocol terms; ordinary UI does not call a Chat a task. A Project
Chat starts in its Project context. A projectless Chat receives a generated
workspace and never infers Project authority merely from its path.

First submit materializes one Session/Thread and immediately starts the first
Turn. Local, worktree, fork, Side chat, child-agent, Browser Use, Computer Use,
Files, Terminal, model, account, and import behavior all preserve exact Chat and
Project/projectless identity.

Read [Codex Workspace Behavior](codex-workspace-behavior.md) for lifecycle and
runtime integration, [Codex Thread Transcript Behavior](codex-thread-transcript-behavior.md)
for visible turns, tools, requests, composer, search, and history presentation,
and [Codex Owner/Follower Streaming](codex-thread-owner-follower-streaming.md)
for multi-window publication and recovery.

### Review and outputs

Review is a generation-fenced live Git read surface scoped to the current
repository and target. It presents staged, unstaged, branch, commit, and Turn
diff sources; preserves file-level selection and comments; and degrades to a
bounded large-review mode instead of mounting unbounded diff content.

Thread Summary derives compact schedule, environment, plan, output, auxiliary
conversation, process, Browser, source, and PiP rows from their canonical
owners. It is navigation and presentation, not another execution or Git model.

Read [Review Right Panel Behavior](review-right-panel-behavior.md) and
[Thread Summary Panel Behavior](thread-summary-panel-behavior.md).

### Settings and command surfaces

Settings is a full Workbench route with one canonical section catalog and local
search. Each feature page owns its state and mutations. Scheduled, Settings,
command palette, and keyboard navigation remain scoped command surfaces rather
than alternate content authorities.

Read [Settings Route Behavior](settings-route-behavior.md),
[Command Palette Behavior](command-palette-behavior.md), and
[Keyboard Shortcuts](../KEYBOARD_SHORTCUTS.md).

### Agent and automation interfaces

Local shell-capable agents and scripts use the native `nodex` CLI and official
Skill as the default content interface. Eligible local Full access tasks receive
the executable, Skill, Profile, and Project context for each Turn; CLI operations
use Project access. Revisioned `nodex_app` tools retain trusted Project/Turn
authorization behind a default-off development feature. Both interfaces use
bounded semantic Core contracts; neither receives raw SQL, a database path,
renderer state, or caller-forged authority.

Nested Markdown is the default agent bulk-content representation. Stable Block
operations remain available when identity matters. Consent and Full access may
grant authority for an exact operation or scope, but never bypass semantic
preconditions or cross a Profile/Library/store epoch.

Read [Agent Interface Behavior](agent-interface-behavior.md),
[CLI Reference](../CLI.md), and [Nested Markdown](../references/nested-markdown-spec.md).

## Product invariants

1. Library owns durable content; Project owns execution context and access.
2. Stable identity, not a row, title, path coincidence, or renderer object,
   determines the target of an operation.
3. One semantic intent commits atomically or does not change product state.
4. A successful mutation is visible from committed authority; users do not need
   a second save or refresh to make it real.
5. Collaborative content has one Document authority. Summaries, search rows,
   NFM, and UI caches are rebuildable projections.
6. Window layout and local interaction state never become content authority.
7. Authorization is evaluated from trusted current context; presentation,
   references, paths, and cached descriptors do not grant access.
8. User-growing collections are bounded and paginated.
9. Restore and history create forward state and invalidate stale work; they do
   not rewind causal identity.
10. External agents use semantic interfaces and receive no storage escape hatch.

## Documentation ownership

Use the narrowest owner:

| Change                                                      | Owning source                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Product promise or top-level capability boundary            | This document                                                                            |
| Feature behavior, labels, action rules, or acceptance       | Focused document in [Product Specifications](index.md)                                   |
| Domain vocabulary and ownership                             | [CONTEXT.md](../../CONTEXT.md)                                                           |
| Runtime Module, dependency direction, or cross-runtime flow | [ARCHITECTURE.md](../ARCHITECTURE.md) and ADRs                                           |
| Sync, durability, recovery, backup, and operations          | [RELIABILITY.md](../RELIABILITY.md)                                                      |
| Security and trust boundaries                               | [SECURITY.md](../SECURITY.md)                                                            |
| Cross-feature renderer construction                         | [FRONTEND.md](../FRONTEND.md)                                                            |
| Exact CLI flags and command schema                          | Generated `nodex --help` / `--json ... --help`, summarized in [CLI Reference](../CLI.md) |
| Configuration keys and overrides                            | Typed config parser/tests, summarized in [Configuration](../CONFIGURATION.md)            |
| Store schema and migration versions                         | Core schema/migration code and tests                                                     |
| Build, validation, packaging, and release                   | [Development](../development.md) and [macOS Release Runbook](../release-macos.md)        |

Replace stale statements at their owner. Do not append feature chronology,
schema inventories, directory trees, or implementation values to this map.
