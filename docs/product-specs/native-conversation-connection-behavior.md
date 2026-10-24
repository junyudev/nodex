# Native Conversation Import Behavior

## Importing native conversations

Settings > Conversations imports Codex and Claude Code conversations as independent Nodex copies.
Conversations saved by ACP Agents are bound to a chat instead of copied; see
[ACP Agent behavior](acp-agent-behavior.md#settings-and-composer).
Browse configured native sources or paste a native conversation ID or a `codex://threads/<id>` link.
A raw ID searches enabled sources; multiple distinct history directories require an explicit source
choice. Profiles sharing the same canonical history directory identify the same source conversation.
Single selection and batch selection use the same import operation. Every selected conversation has
its own retry identity and completion result. A completed copy is offered for opening by default;
an explicit new copy has a new request identity.

Choose a Project or Projectless destination and an existing working directory. A missing source
working directory does not prevent discovery or preview; choose an available replacement for the
copy. Catalog metadata is paginated, including older history. No import silently falls back to a
home directory.
The destination Project may have no configured workspace. The imported chat owns its selected
execution directory; importing does not add or change a Project workspace source.

Import creates a separate Nodex Session and Agent Runtime root Thread. It copies the source's
complete supported visible history into the Runtime's history store and opens an ordinary chat
with a composer and the source Agent selected. The existing model menu can change the Agent.
The next message starts new work through the Runtime and its own native
conversation. Earlier conversation context uses the same bounded portable handoff as changing
Agent; hidden model state, prompt caches, active execution, queued work, pending approvals and
authentication are not transferred. History capture does not replay tool calls or start a model
request. An unsupported item or exceeded capture budget reports a failure rather than claiming
that a partial import is complete.

Readable user images, local images in assistant Markdown and image-view files are copied into
Runtime-owned storage. Relative image references use the source conversation's captured directory.
A historical image whose original file is missing retains an explicit unavailable-image record
in its message or activity. Missing image bytes do not block import; the transcript and
continuation context identify the gap, and Nodex does not claim to recover or display the original
image. Other unsupported media still reports an import failure.

The source retains its identity, history, workspace and lifecycle. Importing, continuing, renaming,
archiving or deleting the Nodex copy does not mutate the source. The imported chat remains readable
and resumable when the source is archived or deleted; it holds no native history-base reference to
that source or its ancestors. A source that was forked from another conversation includes its
visible inherited history in the copy. Import does not connect the source to a Nodex Project.

An import request retains its selected source, destination, directory and request identity for
retry. Retrying that request returns the same destination instead of creating another chat.
An uncertain result retains that request when the user changes selection or leaves Settings. Only
a confirmed rejection before destination admission releases it for corrected parameters; error
wording never determines whether a new attempt is safe.
An interrupted import cannot be recovered as an empty executable chat; it must finish importing
or report that the same request needs retrying. An unfinished import can also be deleted without
affecting its source. To start over after deleting an unfinished copy, reopen the Nodex window.
A changed active history home invalidates preview
and admission. Before creating the destination, Nodex verifies that the Runtime's physical
history home matches the previewed home. Claude capture uses the exact selected native directory
without launching or resuming the source session. A restored Profile using its captured Codex
history cannot import from a different active history home. Completed-import retries remain
independent of that source check. Codex conversations identified as Runtime-owned are not offered
as import sources. Catalog candidates are verified against current native conversation metadata
before they are offered; an incomplete or stale list index does not establish import eligibility.
Filtering a catalog page preserves its continuation cursor, even when no eligible sources remain.
Claude roots use the SDK's native history identity; SDK-created roots can also
be copied. Subagent histories are not independent import sources.

## Existing connected history

Previously connected native conversations retain their saved identity and passive history reader.
They are not silently converted into independent copies or allowed to execute against the source.
New imports use the Runtime copy path; Settings no longer offers a separate read-only Connect action.
Reopening an existing connection follows the bounded presentation rules in
[Agent Backend Behavior](agent-backend-behavior.md) and
[Codex Transcript Behavior](codex-thread-transcript-behavior.md).

## Account and history directories

Codex has one active local account. Its native home defaults to the user's `~/.codex` and owns
shared configuration, hooks and conversation history. Sharing that directory does not add
conversations to the Nodex sidebar; importing a conversation remains an explicit action.
An optional independent account directory owns authentication and the account's model
cache while retaining access to that same history. Saving either directory applies after restarting
Nodex. Selecting another account therefore keeps the saved conversation IDs; it does not move or
duplicate conversations. Simultaneous local accounts for different chats are not supported.

The selected account directory stores its own native authentication file; an empty directory can
be signed into from Nodex or the CLI. Nodex never copies credentials or overwrites conflicting
native files. Shared configuration, skills and transcript directories use validated directory
links, and the native SQLite location retains shared conversation metadata and history.
Native account caches remain private; CLI name indexes are not synchronized between accounts.
Independent account directories are supported on macOS and Linux. Windows uses the direct native
home and rejects account-directory overlays explicitly.

Home changes select the destination's configuration and history without copying conversations.
Connected native conversations remain readable only when they exist in the active home.
Account changes retain the history home. Configuration and launch precedence are defined in
[Configuration](../CONFIGURATION.md).

## Copying Agent setup

Copy setup in Settings > Agent > Codex copies supported configuration, instructions, skills, hooks and related Agent
resources to Codex. It does not offer or import conversations. Conversation
history enters Nodex exclusively through the shared independent-copy workflow.

Codex setup is the native configuration also used by the Codex app and CLI. Copying setup preserves
conflicting destination values and never copies authentication secrets. Setup scanning and applying
cannot acquire a conversation execution owner or add a native conversation to the sidebar.
