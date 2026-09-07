# CLI Agent evaluation

Evaluate ordinary Nodex work in a visible development app, using an ordinary Agent task with **gpt-5.6-luna / max** and normal shell tools. Start with one supervised read case:

    vp run agent:eval:paid --case read-detail --variant 0 --out runs.local/agent-eval/supervised-001

Run this from the repository root and choose a new output directory for each attempt. `--variant` selects one fixture variant, `0`, `1`, or `2`; it does not schedule a batch. Paid evaluation is excluded from CI and standard tests.

## Development instance and task

The runner creates an owned temporary Profile through `ElectronScenarioHarness` with retention enabled, seeds it through public Core operations, and opens a visibly identified development Nodex window. The terminal prints its Profile and Project coordinates. The development Profile is separate from every already-running Nodex instance.

The evaluated task receives the published Nodex Skill and one natural request from the selected fixture. It uses ordinary command execution, files, pipes, and scripts. The standard Desktop host supplies the same task-bound `nodex` shell entrypoint used in packaged execution, selecting the development CLI, Profile and fixture Project. The runner does not install an evaluation-only wrapper or a second workspace Skill. It checks the seeded Core and Project before starting the task.

These defaults provide routing, **not strong production isolation**. An unrestricted shell can override the environment, invoke another binary, or access other host paths. This workflow depends on supervision and explicit development coordinates; it must not be described as a kernel sandbox or as making production access impossible.

The runner schedules one task. It does not start another case, an automatic retrospective, a matrix, an automation, or an automatic repair loop. Use Stop in the development task to interrupt it. No later evaluation turn is queued after Stop.

After a result, the development window stays open for inspection. Close that window, or interrupt the runner, when inspection is finished. The harness then closes and removes copied Agent authentication; the retained development Profile remains on disk. The runner owns this temporary Profile lifecycle; it does not accept a development-home reopen command.

## Fixtures and independent verification

The existing twelve-case library covers reading, filtered summaries, precise edits, appending, renaming, bulk Properties, file export, schema changes, View creation, empty results, ambiguous titles, and concurrent changes. Those definitions do not imply that all cases are enabled or verified through unrestricted shell execution. `concurrent-edit` is explicitly disabled in the supervised runner until it has a deterministic shell-observation trigger.

Each invocation runs one selected case. Supervised evidence covers `read-detail`, `review-summary`, `exact-edit`, `append-section`, `rename-page`, `bulk-priority`, `export-file`, `create-risk-property`, `create-review-view`, `empty-search`, and `ambiguous-title`; this is not full-library validation. Independent oracles read actual Core state, including complete documents and the authorized Project Page identity set. Page-preservation assertions include standalone Pages and Data Source rows. Expected answers and oracle execution remain outside the evaluated task's prompt; the Agent claiming completion cannot override an assertion.

The latest supervised `create-review-view` attempt passed all eight assertions
and checksum-bound CLI route review without user intervention. It created one
named List View whose actual results contained exactly the Review task, while
preserving existing Views and Pages. This is one successful paid attempt for
variant 1; the earlier stopped attempt remains failed. Preserved existing data
does not count as completing the requested View.

The supervised `empty-search` attempt passed all five assertions and CLI route
review without intervention. It queried Page titles and bodies, reported zero
matches, and preserved all fixture Pages. An empty-result case alone does not
establish search recall; review the actual query and use positive-match cases
when assessing broader retrieval coverage.

The supervised `ambiguous-title` attempt passed all six assertions and CLI route
review without intervention. It distinguished the two matching Pages by their
Page keys and current release dates, asked which to edit, and preserved all
Pages. The clarification keyword assertion alone does not verify candidate
accuracy; review the referenced identities and distinguishing details.

The `exact-edit` oracle compares the complete Block tree, allowing only the requested date text to change. This includes Block IDs, nesting, properties, and rich content, alongside the canonical body, Page title, Properties, other fixture Pages, and Project Page identity set. A body-equivalent wholesale replacement must fail. The `append-section` oracle requires the original Block forest to remain intact with exactly one additional root paragraph; unchanged-Page assertions also compare their full Block trees.

Review the visible command transcript and resulting content before choosing another task or changing the CLI. Feedback is supporting evidence. There is no automatic feedback turn in this runner.

CLI evaluation must stay within the published Skill, its references, CLI help, and CLI operations. Repository implementation inspection, internal API workarounds, and computer-use are outside that evaluation boundary. An unsupported operation should end with the specific missing capability. Available tools do not authorize switching interfaces. Record any human intervention or route violation separately from the state assertions; an interrupted task with an unmet objective is a failed evaluation. Selecting a Nodex window by application name does not prove it belongs to the disposable development Profile. Keep archives containing unverified window content local and do not publish them.

The runner writes this scope into the evaluated workspace's `AGENTS.md`, alongside
the expected Project. These instructions constrain the task, not the operating
system: ordinary shell tools remain available, with no evaluation-only command
wrapper or tool whitelist. Strong production isolation requires a separate
execution environment without production data or desktop access.

## Evidence

The output directory contains `manifest.json`, `result.json`, `report.md`,
`assessment.md`, `route-evidence.json`, and `desktop.png`. The manifest uses
`schemaVersion: 3` and `executionMode: "supervised-desktop-shell"`. It identifies
the case, variant, model, effort, timeout, source commit, CLI/Core/Agent/Skill/
evaluator and workspace-instruction fingerprints, and the development Profile
and Project. The result retains the task response and independent assertions;
the screenshot records the development window.

Assessment separates runtime status, objective assertions, preservation assertions,
CLI route compliance and user intervention. A failed objective, preservation
failure, non-completed runtime, observed route violation or user intervention
prevents an unaided pass. Runtime `interrupted` remains visible even when the
evaluation outcome is `failed`.

Route evidence indexes native command/tool inputs and subsequent user messages
with exact archive line numbers. Executed repository reads are explicit violations;
external tool events are review signals whose actual purpose must be checked.
MCP transport alone cannot distinguish computation from an alternate content
interface or computer-use. Tool output and quoted content are not executable evidence.
Static indexing cannot prove arbitrary shell or script compliance. An otherwise
successful attempt stays `needs_review` until a supervisor checks the archived
inputs and records a decision against the exact conversation checksum:

    vp run agent:eval:review --out runs.local/agent-eval/NAME --sha256 HASH --decision compliant --note 'Reviewed the complete execution route; only public CLI and shell processing were used.'

Use `--decision violated` with a specific note for workarounds visible in shell or
script inputs. Review updates the derived assessment in `result.json` and
`assessment.md`, preserving original observations and the archived bytes. It never
restarts the Agent, overrides detected violations, erases interventions, or turns
damaged evidence into a pass. Read the checksum from `conversation.metadata.json`;
a mismatched checksum rejects review. This command accepts schema-3 results only;
historical attempts remain unchanged.

The task has a five-minute timeout. Any available command and cost evidence must be interpreted as ordinary shell-task evidence, not as measurements from the earlier controlled-tool interface. Artifacts stay local under ignored `runs.local`.

The existing comparison helpers are retained for compatible batch reports. `agent:eval:compare` does not accept this runner's schema-3 single-result format. A supervised result is diagnostic evidence, not a formal baseline or a complete improvement evaluation. Do not start holdouts or a matrix automatically to manufacture comparison eligibility.

## Checks and recovery

Run the relevant deterministic fixture, desktop-driver, and report tests after implementation changes. TypeScript changes also require `vp run typecheck`, which covers lint. Inspect the actual development task when assessing shell ergonomics; deterministic tests alone do not prove that experience.

If a task fails or is stopped, retain its evidence and inspect the same development window. Start another explicit single-case invocation only when a fresh attempt is wanted. Never launch evaluation against the production home or copy production data into a fixture by hand.

Each started task archives its exact native rollout as `conversation.jsonl` beside the report, before independent verification. `conversation.metadata.json` records the task ID, source path, capture time, byte count, and SHA-256. The archive preserves all native records and is independent of the retained temporary Profile; it does not reconstruct messages from the diagnostic summary. Failed or interrupted attempts also attempt an archive and write `conversation-error.txt` if the native log is unavailable. Archives are local analysis artifacts under the ignored output directory. A completed archive captures the evaluated attempt; later manual conversation in the retained window is not appended.
