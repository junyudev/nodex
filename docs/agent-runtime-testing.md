# Agent runtime testing

Nodex separates Agent tests by the production boundary they exercise. Choose
the narrowest layer that can prove the behavior under review; a passing test at
one layer must not be treated as evidence for a deeper layer it replaces with a
fake.

## Deterministic model-boundary smoke

Run the ordinary end-to-end Agent workflows with:

```bash
vp run agent:smoke:scripted
```

This suite starts Nodex in a disposable Profile, stages the production Agent
and Browser runtimes, and runs the real app-server process. The app-server sends
model requests to a loopback scripted server in
`scripts/scenarios/runtime/scripted-model-server.ts`. Each script matches a
semantic request, returns a deterministic model response, and verifies the
subsequent tool result. Shell, Browser, and collaboration actions therefore run
through their production runtime and are projected through the production
Thread and UI paths without consuming subscription quota.

Model choices come from the real app-server through the Runtime provider catalog, not
from the scripted server's replies. Use `setAgentExecutionProfile` to select an advertised
model through the Composer and compare model requests with its returned `modelId`. The
helper uses the Composer's display-name formatter; native names and model IDs need not
match the labels shown in the picker.

Use this layer for Agent request/response sequencing, real tool execution,
Browser Use, subagent lifecycle, Thread completion, and Electron projection.
The loopback server disables system-proxy routing and adds explicit localhost
proxy bypasses so a developer's proxy configuration cannot make a local test
reconnect before falling back to another transport.

The scripted server has a focused contract suite:

```bash
vp test run --config config/vitest.node.config.ts scripts/scenarios/runtime/scripted-model-server.test.ts
```

That suite owns HTTP, server-sent event, Responses WebSocket, compression,
request matching, and bounded unexpected/unused-exchange diagnostics. Keep
wire-level edge cases there unless their outcome depends on the complete
Electron composition.

## Claude Desktop Tool smoke

Run the real bundled Claude CLI against a loopback Anthropic Messages server:

```bash
vp run stage:codex-runtime:mac:cached
vp run test:e2e tests/e2e/claude-desktop-tools.spec.ts
vp run test:agent-runtime packages/agent-runtime/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
```

This exercises the CLI's SDK MCP handling, the signed Desktop Tool process chain,
and the Session Browser surface in a disposable Profile without provider charges.
The Messages server never forwards traffic; unexpected requests fail closed.
The test loads the Browser skill through the CLI and resolves its bootstrap path
from the skill result. Title-generation requests share the Messages endpoint and
must be handled separately from the first Session request. Browser verification
captures the actual page; synthetic images prove only image transport. Computer
Use is checked only for capability advertisement;
no desktop applications are controlled.

Set `NODEX_CDT_EVIDENCE_DIR` to an absolute local artifacts directory to retain
model requests, tool results, approval cards, and screenshots after Profile cleanup.
The separate CLI output-limit case measures persistence and tool metadata with
text pressure fixtures; it does not claim to exercise Browser execution.

## OpenCode and ACP Desktop Tool smokes

On macOS Apple Silicon, run the two focused Electron specs after staging the
signed Desktop Tool runtime:

```bash
vp run stage:codex-runtime:mac:cached
vp run test:e2e tests/e2e/opencode-desktop-tools.spec.ts
vp run test:e2e tests/e2e/acp-desktop-tools.spec.ts
```

OpenCode uses the production adapter and a SHA-256-pinned OpenCode 2.1.4
executable in the shared development cache. Its disposable Profile enables the
loopback model through Model Settings before the first Composer submission. A
Chat Completions server scripts the model and rejects unexpected requests. The spec skips when
the executable is uncached and the registry cannot be reached. ACP uses a
scripted stdio peer that opens the advertised MCP descriptor, asks for native
permission and records the results returned by the actual tools. Both run in
disposable Profiles without subscription credentials.

Each spec isolates Browser navigation and screenshot attachments, approval
and Session cleanup, and a chat without the Desktop Tool bundle in separate
Profiles. The Browser case also verifies REPL memory across Turns and handles
site consent if the Browser requests it. Set
`NODEX_DTAA_EVIDENCE_DIR` to an absolute local artifacts directory to keep
provider observations and screenshots. The specs compare the real Chrome
native messaging registration before and after each launch using SHA-256.

The Chat Completions wire fixture has a focused check:

```bash
vp test run --config vitest.node.config.ts scripts/scenarios/runtime/scripted-chat-completions-server.test.ts
```

## Agent runtime conformance probes

Release-lock tests verify that the committed Agent and Browser artifacts form an
exact tested pair on each supported architecture. Use the shared compatibility
matcher with both complete identities: either artifact can have several tested
partners, and matrix ordering has no meaning. These tests verify admission to
the recorded relation; they do not replace the runtime probes that establish it.

For Browser-only artifact pairing, run `tsx scripts/probe-browser-runtime.ts --conformance --browser-only`.
It exercises the real Node REPL and Browser adapter against a disposable Profile and synthetic
native pipe, and records Computer Use as `not-requested`. It never inspects the user's desktop.
It runs under foreign launch bindings and a shared Codex home that persists another host's
`node_repl` server, and requires the Browser to stay on Nodex's own host without contacting that
host's live access endpoint; the scripted Browser smoke covers the same contamination, plus a
foreign shell policy, through an Agent Turn.
This establishes Browser pairing without claiming Computer Use conformance; the full Computer Use
probe remains a separate explicitly selected check.

Run all runtime probes with:

```bash
vp run test:agent-runtime-conformance
```

The probes use the scripted model server with a real staged app-server,
but stop below the Electron product workflow. Configure the scripted provider in
the disposable `CODEX_HOME/config.toml` before launch; Thread overrides do not
change the app-server's selected provider. The probes are the faster owner for
provider wire formats, transport selection, tool round trips, multi-agent tool
advertising, resume behavior, and worktree handoff protocol. A probe should not
duplicate a user workflow already owned by the deterministic Electron smoke.

## Fake app-server peers

Fixtures such as `tests/e2e/fixtures/codex-queue-app-server.mjs` replace the
entire app-server process with a controlled JSON-RPC peer. They are appropriate
when the behavior under test is the desktop application's handling of protocol
state: pagination, queued follow-ups, restart recovery, malformed messages,
disconnects, or deliberately impossible event orderings.

A fake peer does not run a model request, the Agent runtime, or a tool. It must
not synthesize a successful shell, Browser, or collaboration item as proof that
the corresponding production capability works. When a test needs one of those
capabilities, move it to the scripted model boundary instead.

## Orchestrator replay recovery

Replay tests that recreate a runtime over an existing database must enable
`recoverOnStartup` in `ProviderReplayHarness`. This runs the production
process-loss reconciliation before the new outbox worker starts. A completed
Run does not imply that its checkpoint effect has settled its durable claim;
an interrupted claim still blocks later effects on that Thread until recovery
requeues it. Advancing the test clock or waiting longer does not replace this
startup boundary.

Use the harness's `afterEffectExecution` hook to hold an effect between its
committed result and claim settlement when testing restart races. Coordinate
the hold with a Deferred and the scenario's `afterSteps` boundary, then close
the first runtime. Assert the durable claim and the resumed behavior instead
of relying on scheduling delays or repeated runs.

## Persistence migrations

Seed the immediate predecessor with `runMigrations({ toMigrationInclusive: id - 1 })`,
then run only the migration under test and assert its stored result before later
migrations can change it. If the test also uses a current Runtime reader, upgrade
to the current schema afterward and verify that reader's behavior. Do not make a
historical migration test enumerate unrelated later migrations; their addition
must not require rewriting the historical contract.

## Paid provider canaries

The explicit commands in [Paid Agent smoke tests](./paid-agent-smoke.md) add the
one boundary deterministic tests cannot provide: a signed-in subscription
account talking to the real provider. They verify provider availability,
catalog/profile negotiation, production network transport, and whether a live
model can complete the same owned workflows.

Paid canaries are local diagnostic evidence, not deterministic correctness
tests. They do not run in CI, never retry a prompt automatically, and should not
be used while developing logic that the scripted model boundary can prove.

## Choosing a layer

- If the claim is about pure decoding, matching, or state reduction, use a unit
  or focused Main/renderer test.
- If the claim requires a real app-server or a real Agent tool, use the
  conformance probe or deterministic model-boundary smoke.
- If the claim is about how Nodex survives an app-server protocol condition,
  use a fake app-server peer.
- If the claim specifically requires a live subscription/provider interaction,
  run exactly one paid canary case.

Keep one authoritative owner for each claim. More expensive layers may provide
additional confidence, but they do not justify preserving a lower-layer oracle
that fakes the very capability it claims to verify.
