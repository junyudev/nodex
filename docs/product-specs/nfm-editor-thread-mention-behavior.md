# NFM Editor Thread Mention Behavior

Status: Active
Last Updated: 2026-10-17

## Summary

NFM supports an inline chat mention:

```xml
<mention-thread uuid="019..." />
```

The mention references a chat's root Thread id as an opaque string: a native Codex Thread id, or the execution root Thread of a chat that Agent execution runs. It is a document reference and navigation affordance only; it does not embed or send the mentioned thread's transcript.

## Persistence

- The canonical inline NFM form is a self-closing `<mention-thread uuid="..." />` tag.
- `uuid` is required after trimming whitespace. Empty or missing `uuid` tags remain plain text and must not create broken structured inline content.
- The serializer writes only the `uuid` attribute and escapes XML attribute characters.
- The parser stores the mention as `threadMention` inline content with `{ uuid }`.
- Unknown future thread id formats are allowed; the parser does not enforce a UUID regex.
- Core accepts a saved mention only when it names a native Thread or an Agent execution root Thread in the Page's Project or the projectless scope, so a mention written by Send & wrap never makes its Page unreadable.

## Rendering

- Editable Card Stage, Toggle List, projected inline editors, and read-only NFM previews all understand `threadMention` inline content.
- In editable editors, the mention is atomic inline content and is not directly text-editable.
- The inline surface follows a minimal Notion page-mention style: inherited body text color, a small thread icon, medium-weight underlined label, no filled pill background, and no inline status badge.
- The display label resolves in this order:
  1. `threadName`
  2. First non-empty line of `threadPreview`; when transcript history is available, Nodex derives this preview from the thread's first user message.
  3. Shortened thread id
- If the thread cannot be resolved, the mention displays `Missing thread` while preserving the original `uuid`.
- Status text for archived, system-error, approval, waiting, active, idle, loading, and missing states is reserved for hover titles and popovers; it is not rendered inline in the editor body.
- Hovering or keyboard-focusing the mention auto-reveals a tooltip with the resolved label, state/short-id detail, and workspace or raw id. The tooltip is informational only and does not replace the click action.
- The mention is one keyboard-selectable atom: when the caret is directly beside it, `ArrowLeft` or `ArrowRight` selects the complete non-editable token, and plain `Enter` opens the resolved thread or its unavailable-state popover through the same action as a click. The editor keeps selection ownership and renders the compact chip highlight, so the label is not painted with native text-selection blue.
- When a resolved, openable chat mention has keyboard focus, the editor shows the same compact anchored action affordance as Page mentions, labeled `Open chat` with the `↵` Enter hint below the token. Unresolved mentions keep their unavailable-state popover instead.

## Resolution And Navigation

- Card Stage resolves mention metadata from the current project thread summary cache first.
- If a mention is not cached, Nodex asks the main process for `codex:thread:summary:get(threadId)`.
- The main process first reads local `codex_threads`; only a miss calls Codex app-server `thread/read` with `includeTurns: false`.
- An Agent execution root Thread resolves through its Session binding in Core and never reaches Codex app-server. The summary carries the Session's title, archive state and Session id; it is absent unless exactly one Session is bound to that Thread.
- Resolution must not resume a thread, subscribe to a stream, switch the active thread, or fetch transcript turns.
- Clicking a resolved mention opens the referenced thread through the existing Codex-thread navigation callback. An Agent chat opens through its Session; when no Session can be found the action reports that the chat is no longer available.
- If opening is unavailable or the thread is unresolved, the mention popover exposes `Copy UUID`.

## Insertion

- The NFM `@` suggestion menu includes thread mention rows alongside Page mentions.
- Page connection semantics are defined separately in [NFM Editor Page Connection Behavior](nfm-editor-page-reference-behavior.md).
- Thread rows use the same sidebar-wide chat search model as the command palette: non-archived sidebar chats from the current project, other projects, projectless chats, and sessionless chats are eligible.
- The picker treats the editor's own `projectId` as the active project. Matching current-project chats and Pages are rendered first in one `Current project` group, with chats before Pages and each type preserving its selector order. Other chats, including projectless chats, follow in `Chats`; other Pages follow in `Pages`.
- Archived, ephemeral, and side-conversation chats do not appear in the picker.
- Metadata search covers title, preview, branch, project, cwd, and short/id fields with command-palette fuzzy and prefix ranking. Transcript matches use bounded app-server `thread/search` through `codex:threads:palette:search`; server-only chats remain eligible and may add a compact highlighted snippet to the item tooltip.
- Mention rows render only the item title in the picker row and do not show right-side `@thread` or `@` syntax hints. Slash-menu rows show a right-side hint only when it teaches compact, meaningful syntax or a keyboard shortcut; Table, Canvas, Page Mention, Embed Page, Subpage, Thread Section, and Agent Config keep their aliases searchable without echoing those wordy slash queries in the row.
- Mention tooltips show only compact context, such as project, column, actionable state, and an optional search snippet. They do not concatenate raw thread ids, Page ids, cwd paths, or long mixed metadata strings.
- Idle and unknown-state threads do not show `Ready` or `Thread` as row state labels.
- Choosing a thread row inserts `threadMention` inline content and a trailing space.
- Page rows preserve the same final Core Page-search order and typed match evidence as the command palette. Choosing a Page row inserts the current reference Block shape.

## Prompt And Clipboard Behavior

- Plain-text serialization renders a thread mention as `[Thread: <uuid>]`.
- Thread-section prompts use that same text placeholder.
- Thread mentions do not add `promptInput.mentions`, do not attach files or images, and do not inject referenced thread content.
