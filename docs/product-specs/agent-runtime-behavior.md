# Agent Runtime behavior

## Session execution references

A Session may have one external execution reference identifying its runtime and root
Thread. Native Thread binding and external execution binding are mutually exclusive.
The Session's Project is immutable once externally bound. Moving it to another Project
requires an explicit execution migration rather than changing the content actor while
work remains in the old runtime context.

Session creation admits the execution reference, stable launch request identity and
requested Page Linked chats in one Core transaction. The operation checks current
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

Every content tool capture verifies the current live Run and native call, the exact
root binding and the frozen Core record. Model-authored MCP metadata cannot mint this
authority. An old native request cannot borrow a newer Run's credentials.

Closing a connection revokes only its lease. Startup may revoke abandoned leases for
the same runtime. Resuming a stable Run creates a fresh lease without reviving older
provenance; delayed completion from an old lease cannot revoke its replacement.
Admission and revocation change permission records without publishing conversation or
sidebar activity as if execution state had changed.
