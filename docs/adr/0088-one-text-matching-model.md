# ADR 0088: One text-matching model

- Status: Accepted
- Date: 2026-11-17
- Owners: Nodex maintainers

## Context

A person can remember a few characters from a Page or chat without remembering
its title or exact spelling. The same query should work in the palette, in a
picker, and when an Agent searches. A result should take the person to the text
they recognized.

## Decision

One search kernel owns folding, segmentation, matching, and original-text
ranges. Core links it natively. Desktop and Agent Runtime use its WebAssembly
binding. Ranked discovery surfaces select their eligible fields and order results
using the shared match classes. Find uses the same folding and matches literal
text, with punctuation and spacing significant.

Index long text as sequences of folded segments. Consecutive-segment queries
use positional postings. Prefix, stem, typo, and inside-segment queries can use
dictionary expansion over distinct segments. Trigrams miss short queries such
as two-character Chinese words and make tolerance for typos difficult.
Dictionary-based Chinese or Japanese word segmentation can hide visible text
when the dictionary chooses a different boundary than the person typing.

Store migrations change shape. Core and Agent Runtime rebuild derived search
indexes in the background when the analyzer version changes. Search stays
available during a rebuild and reports coverage alongside results.

The index proposes candidates within the authorized scope. The kernel judges how
the query matches and derives evidence from original text. Results carry Block
or chat-message locations alongside excerpts and highlights, so a result can
open where it matched. Search ranks before limiting its response and reports
when coverage is partial or results were truncated.

## Consequences

Core retains authority for Page scope and content, and the Agent Runtime
retains authority for its history. Both can index efficiently without making
their index or tokenizer a second definition of a match. A Provider that offers
its own history search retains its native coverage and query behavior.
