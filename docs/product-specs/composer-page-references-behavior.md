# Page references in chat

The Composer offers each Page selected and visible beside its Session in the content panel as
removable message context. Hidden tabs, collapsed panels, the bottom panel and split leaves hidden
by maximization contribute no context. Several visible tabs of one Page contribute one reference;
their selected Block identities are combined without duplicates.

A reference shows the live Page title and the number of selected Blocks. Only a non-empty editor
selection contributes Block identities; a caret contributes none. Focusing the Composer preserves
the Page's logical selection until Send to chat or Add to composer hands those Blocks to a chat,
which releases it. Removing a reference excludes that Page for this draft, including
later title, selection and visibility changes. The exclusion survives Composer remount and failed
send attempts and resets after successful submission.

Beside-Page references are ambient: they travel with a message but never make one, so a
Composer holding only references cannot submit.

At submit, Nodex freezes each Page id, title and selected Block ids before asynchronous preparation.
It sends references, never Page content. Agents read a Page by id with `fetch`; `read_tab_content`
can synchronize and read the live editor of a Page visible beside the chat. `selectedBlockIds`
identifies what the user highlighted. Page references never create Linked chat relationships.

The Composer's `@` menu searches Pages throughout the Library, independently of the Session's
Project. Selecting a Page inserts an inline mention atom that serializes as a titled canonical
`[Title](nodex://pages/ID)` link. These links remain ordinary message text for every provider;
they never become provider-native mention inputs.

Sent messages show beside-Page references as chips above the user's words. The chips retain the
submitted title and Block selection and open the referenced Page beside that chat. Internal context markers and
companion text inputs do not appear in the displayed message.

## Transport and display

`PageReference` contains `pageId`, `titleSnapshot` and `selectedBlockIds`. URLs are derived from the
Page id. Runtime messages carry one version-1 `nodex-page-reference` context record per reference,
with payload `{ pageId, title, url, selectedBlockIds }`. A typed context link binds the record to
the user message; provider projection emits its readable marker and JSON payload as data.

Direct Codex input carries one ordinary text companion headed `# Page references:` followed by
an array of the same payloads. The application sidecar `additionalContext["page-references"]`
contains `{ kind: "application", value: JSON.stringify(references) }`. Transcript projection uses
this sidecar to show chips and hide only the corresponding companion text.
