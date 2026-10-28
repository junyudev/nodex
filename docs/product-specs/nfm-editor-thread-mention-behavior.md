# Page Editor Chat Mention Behavior

Status: Active
Last Updated: 2026-10-28

## Summary

The Page editor supports an inline chat mention:

```text
<nodex://sessions/019...>
```

A chat mention names its Session, the identity used by chat links and the sidebar.
It is a reference and navigation affordance; it does not embed or send a transcript.

## Persistence

- Exact text is `<nodex://sessions/ID>`.
- Stored inline content remains `threadMention` with `props.uuid` holding the Session id.
- Newly written mentions must name an existing Session in the current Profile;
  projectless Sessions and Sessions in other Projects are valid.
- Sessionless native conversations are imported before they can be mentioned.
  A plain link to `codex://threads/ID` remains available for such conversations.
- [Nodex Markdown](../references/nodex-markdown.md) owns syntax and exact refusal rules.

## Rendering

- Editable Card Stage, Toggle List, projected inline editors, and read-only Page editor previews all understand `threadMention` inline content.
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

The editor resolves the Session through its current Core detail, then uses its
current execution binding for chat presentation and navigation. The mention's
identity never changes when that binding or the chat title changes. Resolution
reads metadata without resuming execution, subscribing to a transcript or
fetching turns. Missing Sessions keep their original identity and offer copying
it from the unavailable-state popover.

## Insertion

- The Page editor `@` suggestion menu includes thread mention rows alongside Page mentions.
- Page connection semantics are defined separately in [Page Connections](nfm-editor-page-reference-behavior.md).
- Thread rows use the same sidebar-wide chat search model as the command palette: non-archived sidebar chats from the current project, other projects, projectless chats, are eligible when they have a Session.
- The picker treats the editor's own `projectId` as the active project. Matching current-project chats and Pages are rendered first in one `Current project` group, with chats before Pages and each type preserving its selector order. Other chats, including projectless chats, follow in `Chats`; other Pages follow in `Pages`.
- Archived, ephemeral, and side-conversation chats do not appear in the picker.
- Metadata search covers title, preview, branch, project, cwd, and short/id fields with command-palette fuzzy and prefix ranking. Transcript matches use bounded app-server `thread/search` through `codex:threads:palette:search`; server-only chats are excluded until imported and may add a compact highlighted snippet to the item tooltip.
- Mention rows render only the item title in the picker row and do not show right-side `@thread` or `@` syntax hints. Slash-menu rows show a right-side hint only when it teaches compact, meaningful syntax or a keyboard shortcut; Table, Canvas, Page Mention, Embed Page, Subpage, and Agent Config keep their aliases searchable without echoing those wordy slash queries in the row.
- Mention tooltips show only compact context, such as project, column, actionable state, and an optional search snippet. They do not concatenate raw thread ids, Page ids, cwd paths, or long mixed metadata strings.
- Idle and unknown-state threads do not show `Ready` or `Thread` as row state labels.
- Choosing a thread row inserts `threadMention` inline content and a trailing space.
- Page rows preserve the same final Core Page-search order and typed match evidence as the command palette. Choosing a Page row inserts the current reference Block shape.

## Prompt And Clipboard Behavior

- Portable clipboard Markdown renders a chat mention as `[Thread](nodex://sessions/ID)`.
- Exact Page prompt text keeps the `<nodex://sessions/ID>` mention.
- Thread mentions do not add `promptInput.mentions`, do not attach files or images, and do not inject referenced thread content.
