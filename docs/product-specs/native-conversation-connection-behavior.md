# Native Conversation Connection Behavior

## Importing Codex conversations

Settings > Conversations provides Import from Codex and Connect Claude Code sections.
In Import from Codex, browse individual conversations or paste a `codex://threads/<id>` link or
native Thread ID. Preview resolves that exact local conversation in the active Codex history home.
Choose a Project or Projectless destination and an existing working directory, then import it.
A missing source working directory does not prevent history discovery or preview; choose an
available directory for the imported chat. Catalog metadata is paginated, including older history.
The destination Project may have no configured workspace. The imported chat owns its selected
execution directory; importing does not add or change a Project workspace source.

Import creates a separate Nodex Session and Agent Runtime root Thread. It copies the source's
complete supported visible history into the Runtime's history store and opens an ordinary chat
with a composer. The next message starts new work through the Runtime and its own native
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
An interrupted import cannot be recovered as an empty executable chat; it must finish importing
or report that the same request needs retrying. An unfinished import can also be deleted without
affecting its source. A changed active history home invalidates preview
and admission. Before creating the destination, Nodex verifies that the Runtime's physical
Codex history home matches the previewed home. A restored Profile using its captured Codex
history cannot import from a different active history home. Completed-import retries remain
independent of that source check. Runtime-owned native conversations are not offered as import sources.

## Connecting native history

Claude Code retains the Connect workflow: select an enabled profile, browse native conversations,
choose a Project or Projectless destination, then connect one conversation. Existing connected
Codex conversations also retain their read-only native-history behavior. Connecting does not
submit a prompt, start a model request, replay messages, or fork history.

Codex discovery reads active persistent root conversations from the active native home through the
official app-server. Claude discovery uses the official Agent SDK with the selected profile's
environment. Subagent conversations are not independently admitted as root chats. Connecting
native history requires its original workspace and exact native identity to remain available.

Core admits the Nodex Session, Thread, destination and native identity together. Repeated
connections return the existing chat. Claude profiles that share a canonical native history
directory also share the same conversation identity. Connecting an existing chat to another
Project is rejected; moving an existing chat remains a separate explicit operation.
The chat retains its native working directory as its execution workspace. Connecting it to a
Project records content ownership and the chat's workspace relationship; it does not add or
change a Project workspace source. Every Agent can access the current Profile's content independently
of Project ownership or workspace location.

Codex retains its native Thread ID. Claude retains its native session UUID separately from the
Nodex Thread ID and binds it to the canonical native history directory. Changing a profile's
history directory cannot redirect a saved chat to another conversation with the same UUID.
Existing bindings acquire their native directory when their saved identity is first verified.
Native history remains authoritative; connecting does not create a replacement transcript store.
A connected local conversation opens as read-only history in bounded pages, without a composer:
new work in Nodex starts a Runtime chat, and Nodex never resumes the native conversation locally.
Reopening uses the native recovery and bounded presentation rules in
[Agent Backend Behavior](agent-backend-behavior.md) and
[Codex Transcript Behavior](codex-thread-transcript-behavior.md).

## Account and history directories

Codex has one active local account. Its native home defaults to the user's `~/.codex` and owns
shared configuration, hooks and conversation history. Sharing that directory does not add
conversations to the Nodex sidebar; importing or connecting a conversation remains an explicit action.
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

## Copying agent data

The optional Copy data to Codex workflow is distinct from connecting a native conversation.
It copies supported setup and can convert Claude history into Codex conversations or import
supported history from another Codex home. Its source and conversion destination are explicit.
Same-home Codex association preserves native IDs; supported cross-home copies create independent
native conversations. Unsupported history reports a failure and leaves its source unchanged.
Copying data never supplies Claude native recovery identity or copies authentication secrets.
