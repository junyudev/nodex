# ADR 0016: Agent interface budgets the common path

- Status: Accepted (amended 2026-08-21)
- Date: 2026-07-16
- Owners: Nodex maintainers
- Extends: ADR 0015
- Follow-up: ADR 0020's Source-scoped identity cutover publishes the current
  `nodex_app@5` catalog; `@3` below names the historical budgeted revision and
  `@4` is the preceding Page/Data Source contract.
- Refined by: [ADR 0073](0073-one-text-language-for-blocks.md), where Agents
  read, patch and write Pages in one text language, Nodex Markdown.

## Context

`nodex_app@2` removed storage-topology revisions, made reads validator-free by default, added sparse mutation results, and documented a Code Mode pipeline that keeps intermediate values inside JavaScript. Those changes reduced a representative thirteen-row Database query from 18,801 characters to 1,895 bytes. They did not, however, put a budget around the tool catalog itself or distinguish the different places where Agent context is spent.

The current catalog was measured from the same Zod input schemas, descriptions, namespace description, names, and deferred-loading flags that the dynamic-tool registry publishes. UTF-8 byte counts are deterministic; token estimates are deliberately not used as an acceptance criterion because they depend on the model tokenizer. Size is only one quality dimension. An interface that saves 500 bytes but causes the Agent to choose the wrong tool, omit required wrappers, or need a correction call is a regression.

| Surface                                              | Current size |
| ---------------------------------------------------- | -----------: |
| Eager catalog (`get_context`, `get_block`, `search`) |  6,459 bytes |
| Complete published catalog                           | 40,594 bytes |
| `query_database`                                     |  3,778 bytes |
| `create`                                             |  7,345 bytes |
| `edit_document`                                      |  9,938 bytes |
| `transfer_blocks`                                    |  9,494 bytes |
| `edit_database`                                      |  3,575 bytes |

The complete catalog is approximately 10,149 tokens under a rough four-bytes-per-token estimate, but this number is directional only. Deferred loading means the complete catalog is not necessarily model-visible on every turn, so the eager budget and each commonly loaded deferred tool matter more than one undifferentiated total.

The largest schemas expose three kinds of avoidable complexity:

- `TextInput` teaches every title-bearing tool a 2,615-byte recursive rich-text JSON language even though Nested Markdown already has an inline rich-text language.
- `edit_document` always loads the uncommon stable-Block operation tree together with the common Nested Markdown create/insert/patch/replace path.
- `transfer_blocks` expresses `move` and `copy` as two complete object variants, duplicating the same destination schema in generated JSON Schema.

Small isolated schema prototypes provide directional evidence. Replacing the rich-title JSON union with a bounded inline Markdown string and removing transport wrappers reduced the `create` input schema from 7,109 to 4,286 bytes. Keeping only title plus Nested Markdown body operations reduced `edit_document` from 9,663 to 2,499 bytes; advanced stable-Block updates can be loaded separately. Representing transfer as one object with a runtime conditional reduced it from 9,200 to 5,124 bytes. These are prototype counts, not committed contract sizes.

Notion's current Agent API evolution supports the same architectural direction, with important limits:

- The [official supported-tools guide](https://developers.notion.com/guides/mcp/mcp-supported-tools) keeps search, fetch, create, update, move, query, schema, View, comment, identity, and asynchronous-task operations as separate intent tools. Their combination forms a workflow; they are not collapsed into one universal mutation union.
- The [official Markdown guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content) uses one enhanced-Markdown representation for whole-page create, read, exact search-and-replace, and complete replacement. Exact `old_str` matching is the local semantic precondition, and destructive removal of child pages or databases requires an explicit flag.
- The [official enhanced-Markdown reference](https://developers.notion.com/guides/data-apis/enhanced-markdown) requires one tab per child-Block level. [CommonMark](https://spec.commonmark.org/spec#tabs), by contrast, treats tabs like tab-stop-expanded spaces in structural contexts. Nodex must therefore state its tab nesting signal explicitly instead of assuming generic Markdown knowledge.
- The [official changelog](https://developers.notion.com/page/changelog) attributes an approximately 91% context-token reduction specifically to `notion-create-database` and `notion-update-data-source` switching to SQL DDL schema definitions. It separately records flattened `notion-update-page` parameters and removal of the full Notion-flavored Markdown specification from `notion-create-pages` because the specification is available through an on-demand MCP Resource. The 91% figure is not a claim about the entire Notion MCP catalog or ordinary result payloads.
- Notion's public `makenotion/notion-mcp-server` repository was inspected at commit `d7e3bbd62890f9efca2cd54449ac072f3bd1a4ba`. Its README explicitly says the actively supported remote Notion MCP is separate and the repository is the older local OpenAPI-derived server. The repository still demonstrates one useful boundary—transport-managed headers are omitted and JSON request-body properties are merged into top-level tool inputs—but it is not treated as the source for the remote tool schemas.

Nodex has a stronger content representation than ordinary Markdown. Nested Markdown is the lossless textual projection of Nodex's Block tree, not an importer that drops unsupported Blocks. The name is intentionally descriptive rather than an unexplained acronym, but it is not an external standard; the namespace must define the dialect in one short sentence. Stable Block IDs remain available when identity matters. The interface should therefore make Nested Markdown the default high-bandwidth path without forcing the common path to load the low-level Block protocol. Familiar Agent verbs and useful defaults matter here: `search → fetch` is easier to select than `search → get_block`, while a tool called `query_database_view` must actually query a saved View rather than silently including a second ad-hoc Database mode.

## Decision

### Budget cost and misunderstanding independently

Nodex will measure and constrain three different costs:

1. **Catalog budget:** namespace description, tool descriptions, and published input JSON Schemas. It is divided into the always-eager catalog, each deferred tool when selected, and the complete published catalog.
2. **Call budget:** actual arguments and results. Nested Markdown authored by the Agent is high-value payload, while duplicated metadata, default ETags, complete post-write documents, and internal receipts are low-value payload.
3. **Workflow budget:** values that return to the model between reasoning steps. Code Mode should retain search rows, Nested Markdown, cursors, and ETags inside JavaScript and emit only a bounded final summary.
   Tests use UTF-8 bytes and deterministic behavior fixtures. Token estimates may be printed in a developer report but never serve as the stable CI boundary. Contract tests prove the accepted inputs, outputs, loading boundaries, and semantic behavior without starting an Agent session or contacting a model provider.

### Keep intent tools; split default updates from advanced updates

The catalog remains intent-oriented. Search, fetch/read, saved-View query, advanced ad-hoc query, Card creation, default Card update, advanced identity-sensitive Card update, Card movement, and Card duplication keep separate names because they have different authority, effect classification, result shapes, and transcript meaning.

`fetch` replaces `get_block`. Nodex is Block-first internally, but an Agent's intent is to fetch the resource identified by a stable Block ID. `fetch` defaults to canonical Nested Markdown: an owning Card returns its complete Document body, a Document child returns its canonical subtree, and a Database Block returns its Database/View definition. Callers may explicitly request a compact summary or stable-ID Block representation. This makes the familiar `search → fetch` workflow useful without a second corrective call while preserving explicit compact and identity-sensitive projections.

The existing `query_database` union is split. `query_database_view` accepts one saved `viewId` and is the small common query tool. `query_data_source` accepts one `dataSourceId` plus ad-hoc typed filter/sort intent. Naming the second tool for its exact schema-and-row authority makes clear that it does not execute or inherit a saved View. A simple rename is rejected because a tool named for a View must not also hide a non-View mode.

`create_cards` replaces singular `create` and accepts one to sixteen complete Card drafts for one shared destination. Each item carries a direct inline Markdown title, optional complete body Nested Markdown, and any destination-specific initial values. Public destinations are `space`, parent `card`, or `database`; they do not expose a derived destination Document ID. The call is all-or-nothing, preserves input order at the shared insertion anchor, and has a bounded aggregate body budget. A one-item call remains the ordinary create path; the plural name advertises bulk authoring without requiring a second tool.

`update_card` replaces `edit_document`, accepts `cardId` rather than the derived `documentId`, and is the default tool for title and body changes. Its Nested Markdown body variants are insertion, exact simultaneous patches, and complete replacement. The Adapter resolves the Card's owned Document and keeps title/body guards separate internally. Stable-ID Block insert/update/delete/move operations move into separately deferred `advanced_update_card`, which also accepts the owning `cardId` and is selected only after a stable-Block read. The `advanced_` prefix warns that the caller must reason about Block identity and ETags. This is a loading boundary, not a second Document kernel: both tools compile through the same authoritative Document mutation service and receipts.

The generic `transfer_blocks` union is removed. `move_cards` accepts an ordered bounded `cardIds` list plus one shared destination. It only accepts existing Card roots, infers current source authority for each Card, and may group mixed sources internally; the Agent does not provide a fragile `from` assertion. When Cards enter a different Database, that destination may carry one common set of initial property values; a same-Database move rejects values and changes placement only. `duplicate_card` accepts one `cardId` and one destination, copies the complete owned Card subtree with fresh identities, lets a Database destination supply the new membership's initial values, and optionally returns a detailed identity map. Non-Card cross-container Block transfer is intentionally absent from v3; intra-Card structural work remains in `advanced_update_card`, and a future `move_blocks` requires its own demonstrated use cases.

`edit_database` is removed from v3 rather than renamed or folded into `update_card`. Per-Card initial values remain available during `create_cards`; entering or duplicating into a Database can initialize the new membership; and `move_cards` can change View placement. Saved Views and ad-hoc queries remain readable. Updating values on an existing same-Database membership without relocating it is deliberately deferred to a later intent design. This avoids reintroducing one broad mutation union before the product vocabulary for Card property edits is settled.

The resulting catalog is:

    get_context
    search
    fetch
    query_database_view
    query_data_source
    create_cards
    update_card
    advanced_update_card
    move_cards
    duplicate_card

`get_context`, `search`, and `fetch` remain eager. Both query tools and every mutation tool remain deferred. Actual dynamic tool identifiers use underscores so Code Mode can call `tools.nodex_app__query_database_view(...)` with ordinary JavaScript property syntax; transcript/UI labels may render `query-database-view`. A universal `change` tool is rejected because it would reload all uncommon variants together and make authorization and transcripts less specific.

### Make Nested Markdown self-explaining and the default text protocol

All v3 Agent-visible terminology uses **Nested Markdown**, never the unexplained `NFM` acronym. Prose uses the full format name, while the wire contract uses familiar, compact `markdown` names: `markdown`, `oldMarkdown`, `newMarkdown`, `format: "markdown"`, `return: ["markdown"]`, and `get_context.include.markdownGuide`. `nestedMarkdown` is rejected as redundant once the namespace defines the dialect. Historical v2 raw transcript values such as `nfm` remain byte-exact and renderable, but they are never emitted by v3.

The namespace always includes exactly one compact syntax hint, shared from the format guide rather than duplicated across tools:

    Nested Markdown is Markdown with Nodex tags and tab-nested Blocks. Use one literal tab per child level. Example string: "▶ Toggle title\n\tChild paragraph\n\t- [ ] Child task".

The escaped string form makes the required tab visible in JSON/JavaScript tool-call context; a visually indented example could accidentally contain spaces while claiming the opposite. The hint has a 200-byte UTF-8 budget. The complete grammar, extensions, and additional examples remain opt-in through `get_context({ include: { markdownGuide: true } })` and do not appear in individual tool descriptions.

Agent-facing rich titles use a bounded canonical inline Markdown string instead of the recursive `TextInput` JSON union. A plain title is therefore just `title: "Launch plan"`, not `{ kind: "plain", text: "Launch plan" }`; formatting, links, thread mentions, and date mentions use Nested Markdown's title-safe inline syntax. Page mentions remain body Blocks because canonical rich-title storage and UI do not define a Page-reference atom. Title remains a separate semantic unit with its own ETag and is never implicitly extracted from the first body heading.

Each `create_cards.cards[]` item accepts `title`, optional `markdown`, and optional initial Database values. The shared semantic `destination` sits once at the call level. The tool does not wrap each only-supported resource in `resource`, nor the canonical content language in `{ format: "markdown", content }`. One call creates every Card identity, title, complete many-Block body, membership, values, and optional View placement atomically.

Nested Markdown is the implicit content format throughout the common path. `create_cards.cards[].markdown`, `fetch`'s default content, and `update_card` body strings do not carry `format: "markdown"`. `format` remains only where the caller deliberately selects a non-default representation such as `summary` or `blocks`.

`update_card` retains semantic groups for `title`, `body`, and result projection. Nested Markdown body variants use short local discriminators such as `insert`, `patch`, and `replace`; the surrounding `body` already states that they edit the Card body. Exact `oldMarkdown` text is the semantic guard, whole replacement uses a body ETag, and stable anchors identify insertion positions. A generic Document update can never delete an owning Page, Canvas, or Database shell or place a child beneath any document-bearing owner shell; those intents require typed ownership operations with complete authority and causal heads.

Canonical serialization always uses tabs for Block nesting. Parsing never guesses that leading spaces were intended as nesting and never rejects them merely because they occur at line start; they retain the format's ordinary authored-content semantics. The namespace hint teaches callers how to express structure without claiming to infer their intent. A future first-class dynamic resource can replace the opt-in guide only when the pinned Codex app-server supports it without adding another always-visible tool.

### Flatten transport structure, preserve domain structure

Meaningless wrappers such as an only-variant `resource` object, an only-format `body.format` object, `title.kind: plain|rich`, and duplicated search filter containers are removed. A shared batch destination is expressed once. Mutually exclusive intents become separate tools instead of a `mode` union: `move_cards` has no copy branch and `duplicate_card` has no move branch.

Semantic groups remain nested:

- `destination` binds parent authority, placement anchor, and optional Database View placement; Database values stay beside the Card draft or new membership they initialize.
- separate query tools eliminate the old `source` union entirely.
- `title` keeps its replacement ETag beside the title value.
- `body` contains one atomic body-edit intent.
- `prepareFor` plans operation-scoped validators.
- owner lifecycle uses separate typed operations bound to complete authority and causal heads.
- `return` is an opt-in projection, not a diagnostic dump.

Simple set-valued projections use a bounded unique string list such as `return: ["markdown", "etags"]`. For three selectors its generated schema is 152 bytes versus 205 for the equivalent optional-boolean object; for two selectors it is 141 versus 175. Duplicate selectors reject at validation, and Zod retains a typed enum result.

### Use a DSL only where a recursive schema is the actual cost center

Nodex will not turn ordinary value writes into SQL or accept raw SQL against SQLite. The deferred v3 catalog contains no standalone Database value-write tool. Future typed property values, stable IDs, ETags, authorization previews, and kernel commands remain structured when that capability is designed.

Future Database schema and View-definition tools will start with a compact, parsed configuration language rather than exposing every property/View variant as recursive JSON Schema. The parser produces a typed AST, validates names and stable identities against current authority, and renders a semantic authorization preview before compilation. Its full grammar is loaded on demand.

The existing ad-hoc Data Source filter/sort input is only 3,518 schema bytes before tool metadata. `query_data_source` retains that typed input in v3. A throwaway parsed query-language prototype reduced the complete tool from 2,796 to 665 bytes and canonical corpus arguments by 51.8%, but accepted only four of ten plausible grammar variants. The prototype was deleted because schema savings alone do not justify a brittle custom grammar; a later revision requires broader deterministic grammar coverage, concrete user demand, and an on-demand grammar design.

### Keep outputs sparse and make Code Mode the orchestration layer

Default reads continue to omit ETags and default writes continue to return identity plus bounded effect counts. Search remains discovery-only; `fetch` returns useful canonical Nested Markdown by default, while title/body/Block validators and non-default representations remain explicit. Both Database query tools return no value/placement ETags because v3 has no consumer for them. `query_database_view` returns saved-View rows without making the Agent construct a `source` union. Transcript Details and Raw continue to use canonical call items rather than inflating Agent outputs.

The current dynamic-tool transport returns one JSON text item. The namespace keeps one compact parser/recovery instruction, and Code Mode parses inside the JavaScript workflow, filters values, and passes exact derived arguments to later calls without returning intermediates to the model. Nodex does not add a durable workflow language or task handle merely because JavaScript can orchestrate calls.

As implemented, the pinned Codex dynamic-tool declaration has no `outputSchema`, its call response has no `structuredContent`, and Code Mode receives its text content as a string. The current upstream Codex router has the same three missing seams even though MCP results have a separate structured path. When all three dynamic-tool seams exist, Nodex can adopt native objects in a later toolset revision. It will not send ignored fields or create a parallel Nodex-only transport.

### Version the breaking contract once

The familiar fetch/query names, text-title representation, default Nested Markdown behavior, plural Card creation, default/advanced Card updates, separate move/duplicate intents, and removal of the premature Database mutation tool ship together as `nodex_app@3`. Because the feature is unreleased and Nodex has no real user data, v2 is not maintained as a permanent compatibility layer. Persisted v2 transcript items remain renderable; a task pinned to retired execution receives `tool_catalog_stale` and starts a new task.

## Consequences

The common authoring path becomes smaller and more native to what models already generate. Rich titles and bodies share one default textual language, while stable IDs remain available for the minority of identity-sensitive edits. Familiar `search`, `fetch`, `query_database_view`, `create_cards`, `update_card`, `move_cards`, and `duplicate_card` verbs reduce tool-selection translation. A Code Mode workflow can create or patch complete Cards without constructing rich-text or Block trees in JSON.

The v3 catalog has ten tools, like v2, but its boundaries are narrower: one advanced Card-update tool and one split query intent are added, generic create/transfer/Database-edit unions are removed, and Card movement and duplication are independent. Tool count is not the optimization target; the objective is minimal relevant context and fewer invalid calls for one intent. `advanced_update_card` and `query_data_source` remain deferred without taxing ordinary Card updates or saved-View queries.

Schema budgets become explicit engineering constraints. The activated v3 production catalog measures 547 shared namespace bytes, 4,427 eager bytes, and 29,021 complete bytes, down from the production v2 baseline of 529, 6,524, and 40,558 bytes respectively; every selected tool remains below its individual cap. Adding a recursive union, a new eager option, or verbose default output requires evidence and an intentional budget update instead of silently consuming context.

The Adapter becomes deeper. It must parse and serialize inline Markdown titles, preserve the distinction between tab nesting and authored spaces, resolve Card IDs to owned Documents, coordinate bounded multi-Card creation, infer and group Card move sources, and route `update_card`/`advanced_update_card` into the same Document kernel. These are appropriate boundary responsibilities and do not leak into storage kernels.

V3 intentionally cannot update Database values on an existing same-Database membership as an independent operation. Card creation and entry into a different Database can initialize values, duplication can initialize the copied membership, and `move_cards` can change View placement. The remaining gap is visible and deliberate, not an accidental omission. A future proposal should begin with user intents such as setting Card properties or transitioning workflow state, rather than restoring `edit_database` by default.

The Database query DSL is rejected for v3. This prevents a smaller but under-evidenced custom grammar from replacing the typed query contract before usability evidence exists.

## Alternatives considered

Only shortening field names would save a small number of argument bytes while leaving recursive schemas, misleading defaults, and duplicated branches intact. It is rejected as the main strategy.

Keeping `NFM` in the v3 public contract would preserve an internal abbreviation at the cost of every unfamiliar Agent having to infer or fetch its meaning. Calling fields `nestedMarkdown` would be self-describing but repeats information already carried by the namespace and tool descriptions. V3 therefore uses “Nested Markdown” in prose and `markdown` on the wire.

Keeping `get_block` is precise from the storage model's perspective but asks the Agent to translate a familiar fetch intent into an implementation noun. The stable Block identity remains the input authority; only the intent-facing verb changes.

Renaming the current two-mode `query_database` directly to `query_database_view` would make half of its accepted calls contradict the tool name. Splitting `query_database_view` and `query_data_source` costs one deferred tool declaration but reduces each schema and error surface.

Flattening every semantic object would produce ambiguous parameter lists and separate preconditions from the values they guard. Only transport wrappers and generated-schema duplication are removed.

Keeping stable-Block operations inside `update_card` preserves one tool name but forces every Nested Markdown edit to load an uncommon recursive protocol. It is rejected because deferred loading cannot currently target one union branch.

Keeping `transfer_blocks` preserves non-Card promotion/wrapping and one internal service, but asks the Agent to select a generic mode union for two familiar Card intents. V3 favors `move_cards` and `duplicate_card`; generic cross-container Block transfer can return later as an independently justified advanced tool.

Folding Database value edits into `update_card` would avoid a visible capability gap but would combine Document and Database concurrency, authorization, and result semantics in the common authoring schema. It is rejected until concrete property-edit workflows justify a focused interface.

Returning complete Nested Markdown after every write would simplify some direct clients but spends result context even when the next action needs only identity or counts. Nested Markdown remains opt-in, and Code Mode can issue a narrow read when required.

Copying Notion's asynchronous write task now would add polling, persistence, cancellation, and failure-lifecycle concepts without evidence that local Nested Markdown writes exceed practical timeouts. Profiling, not catalog imitation, will trigger that feature.
