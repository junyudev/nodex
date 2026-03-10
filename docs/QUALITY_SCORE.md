# Quality Score

Last updated: 2026-02-13

## Summary
| Domain | Grade | Trend | Key Issues |
|--------|-------|-------|------------|
| Core Data + History | B+ | -> | Good transactional model; limited fault-injection tests |
| HTTP/API Layer | B | -> | Strong validation; thin auth/network-hardening posture |
| Renderer Board UX | B | -> | Feature-rich; complexity raises regression risk |
| Editor + NFM | B+ | -> | Deep targeted tests; high behavioral complexity |
| Documentation | A- | up | Harness structure now present; needs ongoing freshness discipline |
| Release/Operations | B- | -> | Packaging flow documented; limited automated operational checks |

## Domain Details

### Core Data + History (B+)
Strengths: SQLite transactions, history deltas, project isolation, backup workflow.
Gaps: More explicit default-reset coverage for local renderer persistence would reduce risk.
Action items: Keep expanding tests that verify stale local UI state is ignored and reset to canonical defaults.

### HTTP/API Layer (B)
Strengths: body-size guards, card input validation, read-only SQL escape hatch.
Gaps: No authentication/authorization layer for exposed local HTTP port.
Action items: Add optional local auth token mode and integration tests.

### Renderer Board UX (B)
Strengths: unified hooks, live refresh model, multi-project UX.
Gaps: Complex inter-surface interactions increase behavior drift risk.
Action items: Add focused integration checks for project-switch + card-stage state.

### Editor + NFM (B+)
Strengths: robust parser/adapter tests, captured engineering learnings, explicit custom extensions.
Gaps: BlockNote edge behavior remains a moving target.
Action items: Keep adding regression tests when any keyboard/drag behavior changes.

### Documentation (A-)
Strengths: progressive-disclosure map (`AGENTS.md` -> domain docs -> deep references).
Gaps: Historical docs can drift if not updated with feature work.
Action items: Enforce doc updates in PR checklist.

### Release/Operations (B-)
Strengths: build/package/release commands and backup model documented.
Gaps: No explicit smoke-test matrix for packaged binaries.
Action items: Add post-build smoke checks in CI for CLI + API startup.
