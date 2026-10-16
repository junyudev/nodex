# Agent Backend Behavior

## Execution ownership

New local Sessions execute through Agent Runtime with an explicit configured Provider.
Codex is the default. Enabled Profile-local Claude Code, OpenCode and ACP instances
retain their own account, native history, models and configuration. A Session never
silently falls back to another Provider when its selected instance is unavailable.
Core binds the product Session to its runtime root before execution starts. Native
history imports keep their durable native descriptor and do not open another execution
owner. Real native Codex and remote-host history remain available through their own
Gateway. See [Agent Runtime behavior](agent-runtime-behavior.md).

Observing Sessions does not start the separate native Codex account/catalog endpoint.
Account actions, native catalogs, history searches and explicit remote operations acquire
it on demand. Native account state follows the ready connection; ordinary Session
creation and messaging always use the Session's Runtime binding.

The shared conversation surface provides rich prompts, streamed text and tool activity,
model selection, planning, Tasks, queues, cancellation and genuine information questions.
Selecting a model retains its exact Provider instance identity, even when instances
advertise the same model ID. Unsupported capabilities fail explicitly. Plan conveys
planning intent while retaining full execution and Profile content access. Provider
permission requests are approved automatically.

## Configuration and discovery

Instances are configured per Profile. Executables, native profile directories and
external endpoint credentials remain explicit inputs. Sensitive environment rows use
system secure storage and do not appear as plaintext in ordinary settings reads.
Changing configuration affects new connections; a live native connection retains its
captured identity and environment. An instance can be disabled without redirecting
its Sessions to another Provider.

A Project supplies a default execution folder. Projectless Sessions retain their
captured folder. Managed worktrees and their setup environments remain physical
execution locations; they do not limit content access. Explicit Provider account
variables take precedence over workspace environment changes.

Discovery reads configured model metadata in the selected folder without creating a
chat or submitting a prompt. Attached native descriptors supply their saved instance
and execution directory. Renderer inputs cannot substitute either coordinate. Closing
the consumer cancels its query. Configuration, Project lifecycle or execution-location
changes discard stale discovery results. Cached inventories are bounded and Refresh
bypasses the cache.

Claude discovery uses an SDK metadata query with persistence, hooks, MCP and IDE
integration disabled, and releases its process after initialization. At most two
such queries run concurrently. Its cache includes account configuration and execution
folder and retains at most 64 entries. Native commands and filesystem skills remain
separate catalogs. Nodex does not add Codex instruction files to Claude configuration.
The native executable resolves from explicit configuration or Desktop/login-shell PATH;
credentials are not imported from a login shell. Explicit PATH and profile overrides
remain authoritative. Nodex's Agent SDK and the selected Claude Code executable are
updated independently; updating Nodex does not replace that executable.

OpenCode discovery uses its native HTTP metadata connection and pinned SDK. It offers
models from connected providers and preserves exact provider/model identifiers,
including model IDs containing slashes. Native model variants and primary agents
supply the available controls. Discovery retains at most 32 shared connections with
bounded idle retention and sends no prompt. Local profiles isolate configuration,
authentication, history and cache. An external server uses only explicitly configured
server credentials and retains its own process lifecycle.

ACP instances use trusted local packages and executables. Compatibility checks verify
configured package identity, supported version, entrypoint containment, Node version
and executable-reported version. These checks do not attest package bytes. Credential
profile and proxy inheritance remain separate explicit configuration choices. Runtime
catalog discovery and execution share the same configured Provider.

## Imported native history

Connecting an existing native conversation binds its exact native Session and history
Profile to a Nodex Session. Reading an imported Claude or OpenCode conversation is a
passive, paged observation. It does not acquire a product execution owner, submit a
prompt, create a native conversation, or subscribe to an obsolete execution stack.

Native pages use their real cursor. Claude pages may extend to the owning user prompt
so that continuations remain attached to that prompt. OpenCode pages resolve missing
assistant parents through the exact native Session, with bounded concurrency. Foreign
Session records, changed native descriptors and stale Profile or execution-folder
results are rejected. Native parent identity determines reply placement; timestamps
and proximity cannot reassign a response.

Native history queries request at most 50 messages. Claude reads physical records incrementally in 64 KiB chunks and stops at the requested
prompt boundary, with at most 32 MiB of raw records and 2,048 entries per page, then lets the native SDK project those original
records. Its cursor binds the physical file and exact byte boundary. Replacing or
truncating that file invalidates the cursor; appending preserves earlier windows.
History replies stay within 1 MiB and text previews within 8 KiB. Images remain descriptors and are materialized on
explicit reads from the exact Session and message. Larger tool output is read on
request with its own byte budget and a truncation marker. A page that cannot fit the
record or reply budget fails explicitly. Closing the last history reader releases
resident bodies; native transcripts remain owned by the Provider. Inspection reports
the saved Provider binding, native Session, native home and execution folder without
inventing live process diagnostics.

An imported native Session without a Runtime execution reference opens the shared
transcript as a passive history scene. It has no Composer or execution controls.
Readers of the same Session share one cold page; older pages preserve resident Turn
identities. The renderer retains at most 200 Turns, 500 items and 1 MiB of transcript
bodies, and stops paging when another page would exceed that window. Closing the last
reader clears the window. Starting another conversation uses an explicit new Session
and ordinary Runtime admission.

## Native intake

Raw native message intake retains at most 512 messages with an 8 MiB byte budget for
ordinary ACP/native events, or 32 MiB for Codex, SDK and SSE envelopes that can echo a multi-image
prompt.
Canonical event subscribers allow 1,024 events within the same byte budget because
one native frame can produce several canonical updates. Outbound prompt intake and
SDK user/replay envelopes allow 32 MiB to preserve the supported 20 MiB image attachment
budget after base64 encoding.
Owned NDJSON transports bound unfinished frames before JSON decoding; deferred wake
and replay buffers use their corresponding message limits. Producers never accumulate
waiting offers behind a slow consumer. Overflow fails outstanding work, discards the incomplete buffered stream and
retires that native connection. Stop and connection teardown use independent control
paths; a later prompt resumes through a fresh native incarnation. A normal connection
end preserves its already admitted event prefix. Persisted conversation history is
unaffected by these in-memory limits.

## Application tools and lifecycle

Application tools operate across Projects, Sessions, Pages and Library resources in
the authenticated Profile. Parent, child and background Agents use the same access
model. Every call verifies its captured Session, native incarnation, Profile, Store
and live connection. Codex, Claude and OpenCode calls retain the original Run when
native transport proves it. Standard ACP calls carry their real Session with an
unknown Run left null. Model-authored metadata and later foreground work cannot
supply a missing source identity.

Ordinary Turn settlement preserves live background tools. Cancellation, native
connection retirement, replacement and Session deletion invalidate old callbacks.
Source-less native execution retires its connection and credential before the next
prompt. Stable command identities and durable receipts prevent normal retries from
creating another Session or starting the same task twice. Actual information questions
remain interactive and retain their exact response capability.

## Model preferences and task details

Claude Effort, Off, Speed and Context retain the user's requested preferences across
model changes in drafts and live conversations. The selected model receives supported
native values; an unavailable preference uses the nearest supported effort, thinking
left on, Standard speed or default Context while keeping the original request. Only
an explicit user choice changes that request. Native defaults and policy determine
the effective values. Off appears only when the model can disable thinking; selecting
a regular effort reenables thinking. Context is shown only for distinct supported
choices. Requested values do not pretend to be applied native state.

Read-only task details retain the opening view and parent Thread context when their
trigger unmounts or the selected task changes. They remain observations and do not
acquire a product Session attachment or execution controls.

## Scheduled work

Scheduled work uses ordinary Agent Runtime Session admission, due leases, durable
inboxes and controls. Workspaces are bound before launch. Failed preparation cleans up
unowned allocations; committed execution locations remain attached through uncertain
readback. No automation or imported-history path can create a second local execution
owner. See [Scheduled route behavior](scheduled-route-behavior.md),
[Configuration](../CONFIGURATION.md) and [Security](../SECURITY.md).
