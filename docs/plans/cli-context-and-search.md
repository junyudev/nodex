# Make CLI context reliable and search evidence concise

This living ExecPlan follows `docs/PLANS.md`.

## Purpose / Big Picture

A task should execute its host-supplied Nodex command successfully on the first call and find Pages without reading repeated UI highlighting records. Separate the Profile directory used to connect from the identity returned by Core, and publish concise search hits with bounded, merged evidence. Verify real native commands, then run a fresh visible Luna Max read task and analyze its conversation rather than judging only the final answer.

## Progress

- [x] (2026-09-07) Trace the saved conversation and production code: bootstrap assigns a directory to `MainConfig.profileId`; search serializes UI-oriented hits.
- [x] (2026-09-07) Replace the misleading Profile selector with an explicit expected-identity assertion sourced from Core.
- [x] (2026-09-07) Merge and select search evidence in Core, then publish a concise CLI result.
- [x] (2026-09-07) Complete focused regression checks, docs, semantic/build checks and real Desktop prefix execution.
- [x] (2026-09-07) Run and archive a fresh Luna Max task, inspect its actual path, and record the outcome.

## Surprises & Discoveries

The failed Profile argument came from the host's injected command, not from the evaluated Agent inventing a selector. The existing native bootstrap test supplies a correct Profile identity manually, while production `src/main/bootstrap.ts` supplies the directory. The CLI flag advertises names but only compares the connected Core identity.

Search already has common ranking and evidence owners in Rust Core. Evidence is currently deduplicated by query term and source, so several words in one block produce repeated snippets. The existing Agent projection takes three records before merging and can therefore spend its evidence budget repeating one title.

## Decision Log

Keep `NODEX_HOME` and existing configuration selection. Rename `--profile` to `--expect-profile <ID>` with no legacy alias; its sole meaning is to assert the connected identity. Remove runtime identity from `MainConfig`; supply `CoreAuthority.identity` to the host command builder. A mismatch is explicit and prevents content execution, never recommending removal of the assertion.

Keep search ranking and authorization in Core. Merge evidence by source and excerpt, preserving separate windows within long blocks. Select bounded non-title snippets by query coverage and source diversity, with deterministic ties; UI, CLI, and Agent projections reuse that selection. The CLI owns its small output shape, retaining identity, location and evidence without UI highlight records or unrelated properties. Do not add output modes or a second search engine.

## Outcomes & Retrospective

The real Desktop regression passes: its first injected command returns the current Core Profile and seeded task Project even under an unrelated inherited home. The queue interruption/restart test also passes after extending its fake runtime to acknowledge permission configuration writes. All 125 CLI unit/integration tests, 14 Core search tests, and 9 Core-client bootstrap/automation tests passed. The build and semantic gate passed. A concurrent Rust build caused one rustdoc stale-dependency failure; the isolated `cargo test -p nodex-cli --doc` rerun passed. Strict Clippy stops at two existing large-enum warnings in unchanged Core contracts; an advisory run completes and reports the existing `large_enum_variant` and `result_large_err` categories. The successful fresh read task passed all seven assertions in 63.8 seconds, versus 156.7 seconds for the prior variant. Native shell invocations fell from 14 to 6, structured CLI errors from 1 to 0, and the six Profile-recovery invocations disappeared. The new Agent chose two SQL reads after discovering the Skill and query reference; search was therefore measured separately, with a one-Page native sample shrinking from 1,965 to 547 characters. These are observations from one task pair, not a statistical latency claim or evidence that search caused the duration reduction.

## Context and Orientation

`src/main/bootstrap.ts` builds startup configuration. `src/main/core-runtime/CoreAuthority.ts` owns the connected Profile identity. `src/main/platform/node/NodexCliBootstrap.ts` supplies executable and context to normal and scheduled Codex turns. `crates/nodex-cli/src/runtime.rs` resolves the directory, connects, and validates scope before content operations. `crates/nodex-core/src/library/page_search.rs` ranks Pages and constructs evidence; `crates/nodex-cli/src/search.rs` currently exposes the entire Core result. `scripts/agent-eval/run.ts` creates an owned temporary development Profile and one visible Luna Max task, independently verifies it, archives its native JSONL, and retains the window.

## Plan of Work

First remove `MainConfig.profileId`, route authoritative identity through both turn-start callers, and migrate CLI parsing, help and fixtures to `--expect-profile`. Return a structured mismatch with expected/actual identity and selected home. Extend native bootstrap coverage to execute the actual prefix under an unrelated cwd/home, and prove wrong identity rejects a content operation.

Then replace per-term duplicate evidence with merged source windows and bounded representative selection in Core. Preserve highlights for UI consumers, identity/key evidence for alias discovery, and block/property provenance. Project CLI hits to a dedicated serializable result. Exercise repeated terms, split blocks, long snippets, same-title Pages and historical keys without changing authorization or ranking.

Finally update owning CLI and Agent interface docs. Run targeted Rust and Core-client tests, the semantic gate, and the build needed for the actual Desktop run. Launch one new `read-detail` variant in a fresh output directory; inspect native calls, failures, repeated discovery, captured output size and timing against the saved prior attempt. Keep conclusions bounded by the observations.

## Concrete Steps

From `/Users/asc/repo/nodex`, use `cargo test -p nodex-cli` and focused `cargo test -p nodex-core page_search` while iterating. Use `vp run test:core-client src/main/platform/node/NodexCliBootstrap.node.test.ts` for the native host prefix. Run `vp run typecheck` and `vp run build` after the final edit set is stable. Generated contracts, if affected, must follow the repository generator rather than hand edits.

Run `vp run agent:eval:paid --case read-detail --variant 1 --out runs.local/agent-eval/context-search-001` only after the CLI/Core artifacts are rebuilt. This command uses a fresh disposable development Profile, full native shell, and one paid task. Do not interact with any existing production window or schedule a matrix.

## Validation and Acceptance

The real host prefix selects its own Profile and Project despite another inherited home or cwd. A wrong expected identity yields a specific structured error before any content mutation. Help describes an assertion, not name/path selection. One Page matching multiple query terms has no repeated same-window evidence. Search keeps enough provenance to identify and read the candidate, while terminal JSON contains no UI highlighting or unrelated properties. Actual task assertions pass and the report explains its execution path, including any remaining detours.

## Idempotence and Recovery

Tests and paid attempts use fresh writable Profiles. Choose a new output directory for retries; never reuse live production data. Preserve completed conversation archives. The evaluation window remains open until inspection is complete; closing the runner removes copied authentication. Commit only source and docs, leaving local logs and Profiles ignored.

## Artifacts and Notes

The prior read-task archive is `runs.local/agent-eval/supervised-shell-002/conversation.jsonl`. Its search returned 1,965 characters for one Page. The injected command incorrectly repeated the Profile path as `--profile`. The completed evidence is at `runs.local/agent-eval/context-search-002/`: `execution-path.md`, extracted command ordinals and metrics in `execution-path.json`, raw `conversation.jsonl`, and a separately labeled `search-sample.json`. A preceding startup attempt stopped before any paid task because pointer movement closed the model submenu; the shared driver now selects the focused menu item with Enter. The window for the successful task remains available for inspection.

## Interfaces and Dependencies

Startup configuration owns paths; Core authority owns identity. The CLI assertion consumes the same identity returned by `nodex context`. Core search retains authorized Page ranking and derives reusable bounded evidence. CLI presentation is a projection, not an alternate domain search. No production path depends on the evaluator and no new runtime dependencies are required.

Revision note: Completed native, Desktop and paid-task verification on 2026-09-07. The CLI feature is already described under Unreleased, so no duplicate changelog fix entry was added. Broader application/release suites were omitted in favor of the changed runtime tests and the real task.
