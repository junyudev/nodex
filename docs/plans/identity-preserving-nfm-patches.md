# Preserve Block identity during exact body patches

This ExecPlan follows `docs/PLANS.md` and remains a living document.

## Purpose / Big Picture

An Agent changing one line in a Page must keep the Page's other Blocks and their collaborative nodes intact. A Block ID is its persistent identity, used by references and document operations. Exact Nested Markdown (NFM) patches compile to structural operations in Core so CLI, drafts, and other semantic callers receive the same identity-preserving behavior. Whole-body replacement remains an explicit replacement operation.

## Progress

- [x] (2026-09-07) Trace the failure to `prepare_exact_nfm_patch_update` delegating to whole-body replacement.
- [x] (2026-09-07) Inspect structural operations, canonical NFM serialization/parsing, and evaluation assertions.
- [x] (2026-09-07) Implement the source-position-aware patch compiler and Core regressions, including peer updates and multi-Block insertion.
- [x] (2026-09-07) Strengthen exact-edit and append assertions to compare the complete original Block tree.
- [x] (2026-09-07) Verify CLI receipts, idempotent retries, Core behavior, and independent oracle regressions.
- [x] (2026-09-07) Run the supervised exact-edit retest (7/7), then append-section (7/7) after inspecting the successful edit receipt.
- [x] (2026-09-07) Update owning behavior documentation and complete source checks.
- [x] (2026-09-07) Commit source change `315d3e806` and record the supervised acceptance evidence.

## Surprises & Discoveries

The observed one-line patch returned seven deleted and seven created Block IDs. All six existing evaluation assertions passed because they checked canonical content and Page identities only.

Parsing serialized NFM can normalize structure and properties. For example, the parser flattens children of ordinary headings while serialization includes their indentation. Identity must originate from the authoritative source tree, and a patch must not apply unrelated normalization to untouched Blocks.

## Decision Log

Core checks the idempotent receipt before current patch matches. Remove CLI-side content preflight, which rejected a successful retry after its original text disappeared; input syntax validation remains local and Core errors retain hunk/line attribution.

Use the existing structural mutation executor after compiling the patch in Core. It preserves unchanged collaborative nodes and retains a Block container when updating its content. Do not repair this by rewriting IDs after whole-body replacement, because that still deletes live document nodes.

Use resolved source positions, not global equal-text matching, to distinguish repeated Blocks. Preserve original properties that NFM does not represent. Treat ambiguous format correspondence conservatively rather than silently reallocating unrelated identities. Splits and merges retain proven positional matches and allocate new identities for unresolved content. Lossy groups that cannot preserve both the requested projection and authoritative Blocks fail before commit.

## Outcomes & Retrospective

The compiler uses opt-in NFM source locations, bounded line/character alignment, and the existing structural executor. Ordinary parser and serializer calls do not allocate location metadata. Existing sibling anchors take priority over inserted Blocks so insertions do not recreate untouched collaborative nodes. Allocated identities cannot reuse any source identity, including a deleted Block.

Core document tests pass: 164 passed and one explicit Canvas pressure test ignored. NFM tests pass: 17 passed. The complete TypeScript semantic gate passes. All 13 independent oracle tests pass through the public Core boundary. Native CLI integration proves a one-Block receipt, stable search references, and exact idempotent retries. Supervised exact-edit passes all seven assertions in 84.605 seconds: zero created/deleted/moved Blocks and one updated Block, with all eight original identities retained. After that pass, append-section passes all seven assertions in 77.780 seconds: one created Block and zero updated/deleted/moved Blocks. Both tasks use direct `nodex` commands, with no CLI errors or recovery steps. Native JSONL archives, fingerprints, checked hashes, screenshots, and command analyses remain local under ignored `runs.local/agent-eval/identity-patch-001` and `identity-append-001`. Both development windows remain available for inspection.

## Context and Orientation

`crates/nodex-core/src/document/operations.rs` owns isolated Yrs updates, the encoded collaborative document format. `prepare_exact_nfm_patch_update` matches text in a canonical NFM observation, while `prepare_document_operation_update` already supports Block insert, update, delete, and move operations. `crates/nodex-core/src/domain/nfm.rs` serializes materialized Blocks; `nfm_parser.rs` parses the editable projection. A materialized Block includes its ID, type, properties, content, and children. Only Core commits these changes and derives receipts and write fences.

`scripts/agent-eval/cases.ts` compares actual seeded Core state after a real Agent task. Its exact-edit fixture must check Block identities and topology as well as content. Tests in `src/main/core-client/agent-eval-cases.node.test.ts` verify the oracle using public Core commands.

## Plan of Work

First add source locations at the NFM conversion seam so the compiler can retain provenance across exact replacements. Compile the difference against the original tree, preserving unchanged fields and child relationships rather than round-tripping the whole document. Apply the plan through the existing structural executor. Test duplicate text, Unicode, nested content, insertions/deletions, no-op and conflict behavior, receipts, and an independent peer editing an untouched node.

Then strengthen the evaluation assertions and prove that a body-equivalent whole replacement fails them. Update the narrow Agent content contract and evaluation documentation. Finally rerun the exact-edit task in a fresh disposable development Profile with Luna Max and retain its native transcript and visible window. Only after that case passes, run the authorized next case, append-section, in another fresh Profile.

## Concrete Steps

Work from `/Users/asc/repo/nodex`. Run focused Rust tests while implementing, then the complete relevant Core document and CLI suites. Use `vp run test:core-client src/main/core-client/agent-eval-cases.node.test.ts` for the Electron-aware oracle tests. Run `vp run typecheck` after the TypeScript edits stabilize. Build the native artifacts before the supervised task:

    vp run agent:eval:paid --case exact-edit --variant 1 --out runs.local/agent-eval/identity-patch-001

Choose a fresh output directory if retrying. Never reuse a live writable Profile or target a production window.

## Validation and Acceptance

A one-line edit must preserve every existing Block ID, create/delete no Blocks, and report only the edited Block as updated. Unchanged nested nodes and properties omitted from NFM must survive. A concurrent update from a peer to an untouched node must still merge, proving the original Yrs node survived. Structural patches must preserve proven surviving Blocks and allocate only new content. Conflicts and invalid patches must produce no committed partial mutation. The strengthened six-check content test must additionally reject identity or topology loss.

## Idempotence and Recovery

Compilation and validation happen on an isolated document before the normal atomic Core commit. Existing idempotency keys and conflict guards remain authoritative. Tests use fresh disposable Profiles. Retain failed supervised artifacts; do not run feedback loops or cases beyond the authorized exact-edit retest and subsequent append-section case.

## Artifacts and Notes

Validation commands: `cargo test -p nodex-core --lib document::`, `cargo test -p nodex-core --lib domain::nfm`, `cargo test -p nodex-cli`, `vp run test:core-client src/main/core-client/agent-eval-cases.node.test.ts`, and `vp run typecheck`. Strict Clippy reaches pre-existing large-enum diagnostics in `nodex-core-contracts`; the follow-up `cargo clippy -p nodex-core -p nodex-cli --all-targets -- -D warnings -A clippy::large_enum_variant -A clippy::result_large_err` passes. CLI validation passed 125 unit/integration tests; the empty doctest phase was rerun successfully in isolation after overlapping native preparation invalidated its dependency artifact. Avoid concurrent Cargo preparation in final validation. Native Core/CLI build passes. The focused behavioral suites bound this change; no full release or unrelated UI suite is required.

Local original evidence is under ignored `runs.local/agent-eval/exact-edit-001`; it is diagnostic evidence, not a checked-in fixture. Add deterministic regressions at the Core semantic interface. Record final commands and outcomes here after validation.

## Interfaces and Dependencies

Keep public semantic command shapes unchanged. The new internal compiler takes a current materialized document, exact patch spans, and the existing ID allocator, and returns a bounded structural update plan. Serialization and parsing locations are byte ranges over UTF-8 text, never character indexes or identities. Existing structural operations remain the only mutation executor; no renderer or CLI identity repair is introduced.

Plan completed after source validation and the two sequential supervised acceptance checks. No additional case or feedback loop was started. The strengthened fixture/oracle makes the old content-only run unsuitable as a formal performance comparison.
