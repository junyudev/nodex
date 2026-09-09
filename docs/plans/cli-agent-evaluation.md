# Evaluate CLI task completion in the development app

This living ExecPlan follows `docs/PLANS.md`.

## Purpose / Big Picture

Nodex needs evidence that an Agent can complete ordinary user requests with its CLI and published Skill. The evaluation should be visible in a development Nodex window and behave like an ordinary Agent task, including normal shell commands, pipes, and files. Run one supervised Luna Max read task, inspect its behavior, and use independent state assertions to assess completion.

The current scope excludes a full matrix, recurring automation, and automatic improvement. Stop ends the evaluated task without scheduling another case or retrospective. The development window remains available after the result so the user can inspect it.

## Progress

- [x] (2026-09-07) Implement twelve reusable fixture definitions and independent document, Property, and complete Project Page-set assertions.
- [x] (2026-09-07) Implement report comparison for the compatible batch-report format and verify deterministic oracle regressions.
- [x] (2026-09-07) Implement the supervised runner around a retained Electron scenario Profile and an ordinary visible task with normal shell access.
- [x] (2026-09-07) Complete semantic, build, focused oracle/environment/report tests, and the queued-follow-up Stop E2E.
- [x] (2026-09-07) Complete visible Luna Max `read-detail` variant 0: all seven assertions pass; inspect the screenshot and native shell activity; retain the window.
- [x] (2026-09-07) Record the outcome and prepare the coherent implementation for commit.

## Surprises & Discoveries

A raw Page read can omit its Page ID from stdout. The controlled-tool concurrency oracle recognizes identity in typed selectors or JSON SQL parameters, but that trigger is not yet available for arbitrary shell execution. `concurrent-edit` is therefore disabled in the supervised runner.

A Board row count misses unwanted standalone Pages. The independent Page-preservation oracle now compares the complete authorized Project Page identity set through a public Library read; regression tests cover both extra Source rows and standalone Pages.

Promise-owned cleanup must be joined when an Effect fiber is interrupted. The visible app also has an intentional inspection lifetime: after a task result it stays open until the user closes it or interrupts the runner. Copied authentication is removed when the retained harness closes.

## Decision Log

Use an ordinary task in the visible development app. Normal shell access is part of the behavior being measured, so the controlled CLI/file tool interface is superseded for this workflow. Date: 2026-09-07.

Bind development `NODEX_HOME` and a wrapper selecting the development CLI and fixture Project by default. These are routing defaults, not a security sandbox; an unrestricted shell can bypass them. Date: 2026-09-07.

Create the visible environment with `ElectronScenarioHarness` and retention enabled. This gives the runner an identified temporary Profile and app lifecycle while preserving the content for inspection. The runner has no `--home` option and does not use the standard development-home reopen flow. Date: 2026-09-07.

Run one explicit read case first. Do not schedule feedback, additional cases, a matrix, or an automation after completion or Stop. Retain the existing case and comparison helpers without claiming unsupported cases or formats work in the supervised path. Date: 2026-09-07.

## Outcomes & Retrospective

The first ordinary desktop task completed successfully in 156.7 seconds using Luna Max and native shell tools. All seven independent assertions passed: requested facts and Page identity were correct, all three fixture Pages were unchanged, and the complete Project Page identity set was preserved. The inspected screenshot shows the answer, target Page, Full access, and GPT-5.6 Luna Max. The development window remains open for inspection. Evidence is retained locally at `runs.local/agent-eval/supervised-shell-002/`. No additional task, retrospective, matrix, or automation was started.

The rollout exposed a usability lead: the Agent initially supplied a filesystem path to `--profile`, which expects an identity, and recovered after inspecting CLI help and development configuration. This single successful read is not a formal baseline or evidence of a measured CLI improvement.

Validation passed: `vp run build`; `vp run typecheck` (the shared type/lint gate); 15 Core-client tests covering fixtures, cooperative cancellation, and a real CLI-to-jq-to-Python shell pipeline; 11 Node tests covering reports, comparison, and launch validation; and the focused queued-follow-up interruption E2E (one test). A separate focused subagents Stop E2E failed at its pre-Stop Active-count assertion, before exercising Stop; that workflow was not changed here. The passing queue E2E establishes the exercised Stop boundary, not the unrelated subagent assertion. Broader suites were omitted because the changed runtime is bounded by these focused checks and the actual paid desktop task. `CHANGELOG.md` remains unchanged for this internal evaluation tooling.

## Context and Orientation

`scripts/agent-eval/cases.ts` defines natural requests and independent verification. A case combines a seeded starting state with one request; a variant changes names or fixture shape. Its oracle reads actual Core state without trusting the evaluated task's completion claim.

`scripts/agent-eval/run.ts` creates a retained `ElectronScenarioHarness`, materializes `agent/cli-workflow`, prepares one selected fixture, and opens the visible app. `scripts/agent-eval/desktop-environment.ts` prepares normal development CLI defaults. `scripts/agent-eval/desktop-driver.ts` runs one ordinary Luna Max task. The desktop harness owns the app lifetime, while the driver owns the evaluated task and its Stop behavior.

`scripts/agent-eval/report.ts` and `scripts/agent-eval/compare.ts` retain the batch comparison functionality. The supervised runner instead writes a schema-2 single-result report identified by `executionMode: "supervised-desktop-shell"`; that format is not accepted by the existing batch comparator.

## Plan of Work

First complete the deterministic tests and semantic checks for the new desktop environment and driver. Verify that default CLI calls resolve the seeded Project, normal shell tools are available, and Stop does not queue another task or feedback turn. Keep the existing independent oracle tests as evidence of the assertions themselves.

Then run exactly one `read-detail` case. Observe the ordinary task in the visibly identified development app, inspect its shell commands, and compare its final answer with the independent state assertions. Save the actual result and screenshot. Keep the window open for the user's inspection; do not proceed to another case or a correction loop automatically.

Finally update the outcome with what was actually observed, state any unresolved limitation, complete the final checks, and commit. A defect may justify a later correction, but this single run does not establish a full baseline or authorize a matrix.

## Concrete Steps

Work from the repository root. Run the relevant deterministic checks:

    vp run test:core-client src/main/core-client/agent-eval-cases.node.test.ts
    vp test run --config vitest.node.config.ts scripts/agent-eval/compare.test.ts scripts/agent-eval/report.test.ts
    vp run typecheck

Also run `agent-eval-cancellation.node.test.ts` and `agent-eval-desktop-environment.node.test.ts` with the Core-client script, and `scripts/agent-eval/launch.test.ts` with the Node configuration. The ordinary desktop driver is exercised by the paid task; Stop is additionally covered by the focused queued-follow-up E2E. Then launch the first visible task with:

    vp run agent:eval:paid --case read-detail --variant 0 --out runs.local/agent-eval/supervised-001

Choose a fresh output directory. The runner prints the development Profile and Project, opens a development Nodex window, and starts one ordinary Luna Max task. `--variant` accepts one of `0`, `1`, or `2`; it is not a repetition count. Do not use `--variants`, `--case all`, or a development-home reopen command with this runner.

After the result is saved, inspect the window and `report.md`. Close the window or interrupt the runner when inspection is complete; copied authentication is then removed and the retained Profile stays on disk.

## Validation and Acceptance

The user sees the development Nodex window and the ordinary evaluated task. The task selects `gpt-5.6-luna` with effort `max`, uses normal shell commands, and reaches the fixture Project through development CLI defaults. The read answer contains the requested facts and correct Page identity, while independent assertions confirm that the document and Project Page set are unchanged.

Stop interrupts the active evaluated task and prevents later case or retrospective turns. The window stays open after the result for inspection. The handoff accurately describes the defaults as supervised routing rather than enforced production isolation. Final focused checks and the typecheck/lint gate pass after the final edits.

## Idempotence and Recovery

Each invocation creates a fresh owned temporary Profile and requires a new output directory. Failed or interrupted tasks retain local evidence. Inspect the current window before explicitly starting a new attempt. The runner's finalizer closes the harness and removes copied authentication; retention keeps the development Profile for diagnosis. Do not treat that retained temporary Profile as an initialized standard development home.

## Artifacts and Notes

`manifest.json` records schema version 2, the supervised execution mode, case, variant, model, effort, timeout, commit, artifact fingerprints, and development coordinates. `result.json` records the manifest, prompt, Agent result, independent assertions, and pass status. `report.md` presents the result for inspection, and `desktop.png` captures the development window. Reports stay under ignored `runs.local`. They are single-task evidence and must not be silently converted into compatible batch summaries.

## Interfaces and Dependencies

Fixture preparation and verification use public Core operations. The desktop harness, normal task driver, and CLI environment defaults remain separate owners. Generated protocol contracts are the source of truth for task requests and events. No production renderer or content path depends on the evaluator. The controlled-tool broker and driver are obsolete for the supervised workflow and should not remain as competing execution paths.

Revision note: On 2026-09-07, the plan was aligned with the implemented single-case runner: retained Electron scenario Profile, ordinary visible shell task, schema-2 result artifacts, no automatic feedback, and concurrency evaluation disabled until a deterministic shell observer exists.
