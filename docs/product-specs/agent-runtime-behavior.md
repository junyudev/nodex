# Agent Runtime behavior

## Session execution references

A Session may have one external execution reference identifying its runtime and root
Thread. Native Thread binding and external execution binding are mutually exclusive.
The Session's Project is immutable once externally bound. Moving it to another Project
requires an explicit execution migration rather than changing the content actor while
work remains in the old runtime context.

Launching promotes an unstarted Session without changing its identity or existing
Page links. If it was the default draft, Core creates its replacement in the same
transaction. A fresh programmatic Session can be created by the same operation.
The transaction admits the execution reference, stable launch request identity and
requested Page Linked chats. The operation checks current
Project lifecycle, Page access and ambient Agent authority. Repeating the same request
returns the original Session. Reusing its identity with different immutable launch
content fails before native execution admission.

Page links and sidebar placement refer to Session identity. They do not own its Thread
history, title, model selection, queue, Run status or delegated tasks. Delegated Threads
remain within the bound root's lineage and do not implicitly create ordinary sidebar
Sessions.

## Content authority

Host preparation admits content authority for an exact runtime, Thread, Run and
connection lease. The bound root and Core Project must match the observed execution.
Archived Projects cannot admit or capture live content authority. Runtime workspace
paths and projectless execution workspaces never imply a Core actor Project.

Core freezes the available scope and read-only restriction at admission. A fresh lease
for the same stable Run may narrow that ceiling and cannot broaden it. A new Run may
use newly selected permissions. A delegated
Run inherits its verified parent's frozen restrictions. The latest immutable parent
admission may be read after restart or revocation solely to establish inheritance;
revoked provenance cannot authorize a content operation.

An Agent with Project scope cannot create an independent Session or select execution
modes that elevate it to Library scope, even when the human's Project default allows
full access. A delegated Run and an independent Session both respect the caller's
frozen ceiling; only the Desktop Host can change Project permission settings.

Every content tool capture verifies the current live Run and native call, the exact
root binding and the frozen Core record. Model-authored MCP metadata cannot mint this
authority. An old native request cannot borrow a newer Run's credentials.

Closing a connection revokes only its lease. Startup may revoke abandoned leases for
the same runtime. Resuming a stable Run creates a fresh lease without reviving older
provenance; delayed completion from an old lease cannot revoke its replacement.
Admission and revocation change permission records without publishing conversation or
sidebar activity as if execution state had changed.

## Conversation interface

Page Chat and Workbench use one Session interface for Agent launch, follow-up messages,
steering, selected-Run stop, approval responses, model selection and execution modes.
Every command resolves the Session's immutable root before accessing an engine Thread;
delegated targets remain inside that root. Responses carry the exact pending request
and Run, so a stale card cannot answer a newer request.

Launch returns execution identity without transcript bodies. The retained conversation
reader opens one bounded history window and publishes canonical items into the keyed
transcript cache. Text changes notify only the affected item. Older windows preserve
resident items, and releasing the last reader clears body caches and the engine event
subscription. Captured fork ancestry authorizes read-only item details; it does not
expand the Session's execution targets.

Images are materialized from explicit attachments, then persisted by the runtime under
the admitted Thread and message before dispatch. Workspace creation and environment
setup use the same scoped filesystem owner as other native capabilities. The workspace
is retained when remote creation may have committed without acknowledgement, and its
managed-worktree ownership is attached only after the durable execution is verified.

## Application tools

Application tools receive the product Session and exact engine Thread and Run from the
verified Host invocation. Core execution coordinates remain authority evidence; they
never stand in for a product Session or native Thread. Caller copies, cancelled calls,
and expired native generations cannot reuse that context. Each operation recaptures
Core authority before accessing content or changing application state.

Session observation uses bounded metadata and only loads conversation items for an
explicit history read. Session waits acquire their metadata subscription before the
initial inspection. Completed results repeat only when their observation cursor changes.
Workbench, sidebar, terminal, account, plugin and Automation commands use their existing
application owners with the same caller checks. Session messages, launches and forks
use the canonical Runtime writer and stable immutable request identities.

An independent Session fork creates a new execution root in the source Project and
keeps only the captured conversation prefix as read ancestry. Internal delegated forks
remain in their parent root. Neither history inheritance nor a managed worktree permits
the forked execution to exceed the caller's frozen access or read-only ceiling.

## Metadata catalogs

Session titles and placement come from Core Session overview. Runtime status and child
metadata come from bounded engine readers. A task overview admits four active and ten
terminal tasks initially, with independent continuation cursors. It omits prompts,
results, item bodies and native workflow payloads. Native task observations without an
application-owned child Thread never acquire Thread navigation or command authority.

Sidebar refreshes read stored Core metadata. They never scan native history, create or
link Sessions, or reconcile missing native Threads implicitly. Provider history and
imports remain explicit operations. Registering the local account/catalog endpoint or
Profile snapshot control leaves its process cold; its first real request acquires one
supervised connection. An unused endpoint snapshot does not start a provider.
