# NFM Editor Autolink Behavior

Status: Active
Last Updated: 2026-03-10

This document describes the current automatic link-recognition behavior inside the NFM / BlockNote editor.

It is the detailed source of truth for editor autolinking. The main product spec should stay high-level and defer to this document for exact rules and examples.

## Scope

Included:
- Link recognition while typing in the NFM editor
- Link recognition when pasting plain text into the NFM editor
- User-configurable autolink settings
- Protocol-less domain recognition rules
- Separator-aware paste rules that prevent repo paths and file-like text from being partially linkified

Not included:
- Explicit Markdown links such as `[label](url)`
- Read-only markdown rendering outside the editor
- Clipboard copy serialization rules
- HTML import behavior outside the editor's text autolink pipeline

## Settings

Autolink behavior is renderer-local and configurable from Settings -> Editor.

Available settings:
- `Auto-link while typing`
- `Auto-link on paste`
- `Recognize bare domains`

Default values:
- `Auto-link while typing`: on
- `Auto-link on paste`: on
- `Recognize bare domains`: on

These settings affect autolinking only. They do not change explicit Markdown link parsing or existing stored link marks.

## Behavior Model

Autolink uses two layers of checks:

1. Value-level eligibility
   - Decides whether a candidate token is link-like on its own.
   - Examples: `https://example.com`, `www.example.com`, `example.co.uk`

2. Context-level eligibility
   - Decides whether a candidate token should be auto-linked in the text around it.
   - This mainly matters for paste, where a link-like tail can appear inside a slash-separated path.

This split is intentional:
- value-level checks decide whether text looks like a real web target
- context-level checks decide whether that text is being used as a URL or as part of a repo path / local path / filename

## Value-Level Eligibility

### Explicit protocols

Values with an explicit protocol are auto-linked only when they:
- parse as a URL successfully
- use an allowed protocol

Allowed protocols:
- `http:`
- `https:`
- `ftp:`
- `ftps:`
- `mailto:`
- `tel:`
- `callto:`
- `sms:`
- `cid:`
- `xmpp:`

Examples that should auto-link:
- `https://example.com/docs`
- `mailto:test@example.com`
- `tel:+123456789`

Examples that should not auto-link:
- `javascript:alert(1)`
- malformed explicit URLs that fail URL parsing

### `www.` values

Values beginning with `www.` are treated as web-like only when:
- they can be parsed as a host after applying the default `https://` protocol
- the hostname resolves to an ICANN registrable domain
- the hostname is not an IP literal

Examples that should auto-link:
- `www.example.com`
- `www.example.com/docs`

### Bare domains

Bare-domain recognition is used only when `Recognize bare domains` is on.

Bare-domain recognition is intentionally stricter than upstream BlockNote / Tiptap defaults:
- it uses PSL-aware registrable-domain detection
- it rejects obvious local-path and file-like inputs before domain parsing

Examples that should auto-link:
- `example.com`
- `example.co.uk`
- `example.com/docs`

Examples that should not auto-link:
- `localhost`
- `foo.internal`
- bare IP addresses without protocol
- file-like values such as `nfm-editor-copy-behavior.md`

## Path And File Guards

Before a protocol-less value is considered a bare domain, the editor rejects inputs that clearly look like paths or local files.

Rejected patterns include:
- relative paths such as `./foo`, `../foo`
- home-relative paths such as `~/repo/file.md`
- absolute Unix paths such as `/workspace/repo/file.md`
- Windows paths such as `C:\repo\file.md`
- common code, document, and asset file suffixes such as `.md`, `.ts`, `.tsx`, `.js`, `.json`, `.yaml`, `.yml`, `.png`
- slash-separated text where the slash appears before the first dot, such as `docs/product-specs/foo.md`

This is a product decision, not a generic URL standard. The goal is to reduce false positives in code- and repo-heavy text.

## Typing Behavior

While typing, autolink only applies when:
- `Auto-link while typing` is on
- the token passes value-level eligibility
- the editor's typing autolink pipeline decides the typed token is a complete link structure

Typing is naturally less aggressive than paste because it operates on the last whitespace-delimited token, not arbitrary substrings inside a larger pasted string.

Examples that should auto-link while typing:
- `https://example.com `
- `www.example.com `
- `example.com `

Examples that should stay plain while typing:
- `nfm-editor-copy-behavior.md `
- `docs/product-specs/nfm-editor-copy-behavior.md `

## Paste Behavior

Paste behavior is more complex because Linkify/Tiptap can detect protocol-less link-like substrings inside longer pasted strings.

When `Auto-link on paste` is on, pasted candidates must pass both:
- value-level eligibility
- context-level boundary checks

This second layer exists specifically to prevent partial tail-linking inside pasted paths.

### Separator-aware boundary rule

For protocol-less matches, the editor refuses to auto-link when the candidate is embedded in a path segment rather than standing alone as a link token.

The current implementation rejects a protocol-less match when:
- the character immediately before the match is `/` or `\`
- the left boundary is not whitespace, start-of-text, or an opening delimiter
- the right boundary is not whitespace, end-of-text, or a closing / punctuation delimiter

In practice, this means slash-separated path tails stay plain by default.

Examples that should stay plain on paste:
- `docs/example.com`
- `local/code-block-mock-ui/action-menu-popper.com`
- `docs/product-specs/nfm-editor-copy-behavior.md`

Examples that should auto-link on paste:
- `example.com`
- `(example.com)`
- `example.com,`
- ` https://example.com/docs `

## Interaction Between Settings

`Recognize bare domains` only affects protocol-less hosts such as:
- `example.com`
- `www.example.com`

It does not disable explicit-protocol URLs such as:
- `https://example.com`
- `mailto:test@example.com`

Behavior by setting combination:
- typing off, paste on: autolink happens only during paste flows
- typing on, paste off: autolink happens only during typing flows
- bare domains off: only explicit-protocol URLs and `www.`-style values can autolink
- all off: no automatic linking occurs; explicit Markdown links still work

## Examples

### Should auto-link

```text
https://example.com/docs
www.example.com/docs
example.com
example.co.uk
mailto:test@example.com
```

### Should stay plain

```text
nfm-editor-copy-behavior.md
docs/product-specs/nfm-editor-copy-behavior.md
local/code-block-mock-ui/action-menu-popper.com
./docs/product-specs/nfm-editor-copy-behavior.md
C:\repo\docs\nfm-editor-copy-behavior.md
localhost
foo.internal
javascript:alert(1)
```

## Design Rationale

The editor is optimized for code, repo paths, local file references, and technical notes. In that environment, false-positive autolinks are worse than slightly conservative detection.

The intended behavior is:
- explicit URLs should feel reliable
- normal public domains should still autolink
- repo paths and filename tails should not unexpectedly become links
- paste should not be more aggressive than the user's likely intent

## Implementation Notes

The current implementation uses:
- Tiptap / BlockNote link infrastructure for editor marks
- a renderer-local autolink settings store
- PSL-aware registrable-domain detection for bare domains
- an extra paste-time context filter for protocol-less matches embedded in slash-separated text

This document describes user-visible behavior, not API guarantees for third-party callers. Internal implementation may change as long as the behavior above remains true.
