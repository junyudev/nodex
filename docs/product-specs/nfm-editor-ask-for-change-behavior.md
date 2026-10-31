# Page Editor Ask for Change

Status: Active
Last updated: 2026-10-31

## Rewrite backend

Ask for change generates a proposed replacement from a selection snapshot and a user instruction.
The service never applies the replacement, reads the Page, or writes a Document. Accepting a
proposal belongs to the editor's existing document-editing boundary.

The input is `{ markdown, instruction, context? }`. Markdown uses
[Nodex Markdown](../references/nodex-markdown.md); optional context contains `pageTitle`, `before`
and `after`, which inform the rewrite without becoming part of its output. Limits are UTF-8
bytes: selection 64 KiB, instruction 4 KiB, title 1 KiB, and each surrounding fragment 4 KiB.
Empty selections and instructions, unknown fields and larger requests are refused at Main ingress.
The returned Markdown is bounded to 128 KiB and must parse as exact Nodex Markdown. Empty,
malformed or oversized output fails without changing the selection. A whole-answer Markdown
code fence is removed; actual language-tagged code Blocks retain their fences.

Generation is independent of every chat and uses the Runtime's existing ephemeral Codex or
Claude utility execution and configured authentication, including available Nodex Account models.
It prefers the Inbox suggestion Agent and its explicit suggestion model when available. Otherwise
it chooses an available economical model: GPT-6 Luna for Codex, Haiku then Sonnet for Claude,
then the existing Inbox utility default. Unavailable or signed-out providers are excluded; another
usable utility provider may be selected. Reasoning uses the lightest offered `minimal` or `low`
effort. A cold catalog is refreshed once. No usable model returns “Connect a Codex or Claude
Agent to rewrite text”.

The renderer's `pageTextRewrite.start(input)` returns a request handle with `result` and `cancel()`.
The current utility protocol returns one complete result, without partial deltas. Results are
`done` with Markdown, `error` with a short reason, or `cancelled`. Each attempt has its own identity;
late completion cannot replace a cancelled attempt or a retry. The renderer subscribes before
admission and releases the subscription at settlement. Discard, Try again and review-owner disposal
cancel the previous handle.

Main validates and authorizes the window before admission. Cancellation is idempotent, scoped to
that window, and interrupts the Runtime utility and its native process. Closing the window or Main
also releases pending work. At most sixteen requests run concurrently. Each request has a
90-second total deadline, including catalog/model work. Authentication, rate-limit, timeout,
invalid-output and generation failures have short presentation-safe reasons; provider output and
selection content never enter those reasons.
