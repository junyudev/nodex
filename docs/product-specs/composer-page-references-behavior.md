# Page references in chat

The Composer offers each Page selected and visible beside its Session in the content panel as
message context, and sends none of them until the user includes it. Hidden tabs, collapsed panels,
the bottom panel and split leaves hidden by maximization offer nothing. Several visible tabs of one
Page make one offer; their selected Block identities are combined without duplicates.

An offer is a dashed chip showing the live Page title and the number of selected Blocks. Clicking it
includes the Page in the next message, and the chip then reads as a reference the user added;
clicking it again removes it. The chip is one toggle that keeps its place and leaves the caret in
the prompt. Only a non-empty editor selection contributes Block identities; a caret contributes
none. Focusing the Composer preserves the Page's logical selection until Send to chat or Add to
composer hands those Blocks to a chat, which releases it. Inclusion belongs to this draft and to
that Page: it follows later title, selection and visibility changes, survives Composer remount and
failed send attempts, and resets after successful submission, so every message starts with offers
only.

Included references travel with a message but never make one, so a Composer holding only
references cannot submit.

At submit, Nodex freezes each Page id, title and selected Block ids before asynchronous preparation.
It sends included references, never Page content. Agents read a Page by id with `fetch`; `read_tab_content`
can synchronize and read the live editor of a Page visible beside the chat. `selectedBlockIds`
identifies what the user highlighted. Page references never create Linked chat relationships.

The Composer's `@` menu searches Pages throughout the Library, independently of the Session's
Project. Selecting a Page inserts an inline mention atom that serializes as a titled canonical
`[Title](nodex://pages/ID)` link. These links remain ordinary message text for every provider;
they never become provider-native mention inputs.

Sent messages show beside-Page references as chips above the user's words. The chips retain the
submitted title and Block selection and open the referenced Page beside that chat. Companion text
inputs do not appear in the displayed message.

## Transport and display

`PageReference` contains `pageId`, `titleSnapshot` and `selectedBlockIds`. URLs are derived from the
Page id. Runtime messages carry one `nodex-page-reference` context record per reference, with
payload `{ pageId, title, url, selectedBlockIds }`. Provider projection follows the user's words
with each record's label and JSON payload as data.

Direct Codex input carries one ordinary text companion headed `# Page references:` followed by
an array of the same payloads. The application sidecar `additionalContext["page-references"]`
contains `{ kind: "application", value: JSON.stringify(references) }`. Transcript projection uses
this sidecar to show chips and hide only the corresponding companion text.
