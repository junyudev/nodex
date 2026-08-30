# Product Foundations

## Product boundary

Nodex is a local-first workspace for durable content and agent work. A local
Profile owns one Library. The Library owns Pages, Databases, Blocks, Documents,
Canvases, assets, schedules, and durable history. Projects organize execution:
they own source folders, Chats, terminals, worktrees, approval policy, and one
primary Database binding, and they may receive access to other Library content.

Project lifecycle never owns or deletes Library content. The canonical domain
language and complete ownership invariants live in [CONTEXT.md](../../CONTEXT.md).
System Modules and runtime boundaries live in
[ARCHITECTURE.md](../ARCHITECTURE.md).

User-facing interactive conversations are **Chats**. `Session` and `Thread` are
persistence and protocol terms. **Task** names real work items, scheduled tasks,
and external contracts that already use that noun; ordinary navigation does not
rename a Chat to a task.

Nodex is desktop-first and supports the macOS versions and architectures named
by the current release metadata. It does not provide cloud content sync,
multi-account remote collaboration, or mobile presentation.

## First run

A fresh Profile creates one ordinary Project named `My Project`; there is no
separate setup-wizard product mode. Its source is a collision-free directory
under the user's Documents/Nodex directory. Core creates the Project, primary
Database, default View, primary Canvas, and one editable `Welcome to Nodex`
Page as one idempotent bootstrap intent. It creates no Chat.

The first Window Session opens that Project Scene, retains the default Database
View as its protected root, and opens the Welcome Page beside it. The starter
Project and Page are normal user-owned objects: they may be renamed, moved,
archived, or deleted and are never recreated merely because active Projects
later become empty.

A Project with no configured source remains valid as a Nodex data and Chat
context. Work-locally Chats use a generated workspace; Git worktree and local
environment workflows remain unavailable until a primary source exists.

## Projects

A Project has a stable identity, constrained appearance, ordered filesystem
sources, lifecycle, primary Database binding, Chats, and execution settings.
The first source is the default Git, Files, Review, local-Chat, and worktree
root. Renaming a Project never renames its existing Database, Canvas, source
folders, or Library content.

Creating or editing a Project treats name, appearance, and ordered sources as
one draft. If a new Project is submitted without a source, the Desktop Host
creates a collision-free source directory under the user's Documents/Nodex
directory and initializes Git when available.
Removing a Project archives the execution context only after active Turns,
requests, terminals, and background processes are proved absent. It leaves
source folders and all Library content intact. Removed Projects can be restored
with their stable identity, sources, Chats, and current content access.

Project access to Library content comes from the primary Database binding or
explicit recursive Page/Database grants. `Read` and `Read & write` are
capabilities, not ownership. Inherited access is shown as an effective floor;
editing a direct grant does not claim to remove access inherited from a parent
or primary binding.

## Library and Pages navigation

`Pages` is a bounded navigation projection of top-level Page, Database, and
Canvas roots that need an entry outside active Projects. It is not a second
Library, a complete ownership tree, or a Library Home route. Primary Project
roots are omitted while the Project represents them and become eligible if the
Project is archived.

Selecting a Pages row opens or focuses that resource in the window's singleton
Pages Scene. It never chooses a Project or creates a Chat. The Pages Scene may
hold ordinary Library-authorized Page, Database, View, and Canvas surfaces; it
cannot own execution-only Terminal, Browser, Review, or Files-tree surfaces.
Opening a resource in a Project is a separate explicit access-and-navigation
action.

Moving a Page, Database, or Canvas within the Library changes exclusive
ownership while preserving stable identity and owned Documents. References,
mentions, relations, Views, and grants never move content. Page movement is
specified by [Page Relocation](page-relocation-behavior.md); the compact
Database-resource destination behavior is specified in
[Library Move Destination Picker Behavior](library-move-destination-picker-behavior.md).

## Workbench presentation

Projects, Sessions, and Pages are presented through owner-scoped Scenes. Scene
layout is per Window Session; durable content and execution state remain shared.
Selecting or closing a presentation never changes content ownership.

The complete shell, sidebar, Scene, panel, tab, preview, Browser, Files,
Terminal, Side chat, navigation-history, and multi-window contract lives in
[Workbench Shell](workbench-shell.md). Settings and Scheduled are separate
Workbench routes described by [Settings Route Behavior](settings-route-behavior.md)
and [Scheduled Route Behavior](scheduled-route-behavior.md).

## Product principles

- Content survives Project reorganization.
- Every operation resolves one stable semantic identity rather than a visible
  row, title, filesystem coincidence, or renderer cache entry.
- Bounded views are honest about pagination and totals; absence from one window
  never proves an object does not exist.
- User-visible mutation success follows committed Core authority and converges
  across windows without requiring manual refresh.
- Presentation state stays local to the Window or surface unless the user is
  authoring durable content or an explicit preference.
