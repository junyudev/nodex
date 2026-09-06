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

Use this layer for Agent request/response sequencing, real tool execution,
Browser Use, subagent lifecycle, Thread completion, and Electron projection.
The loopback server disables system-proxy routing and adds explicit localhost
proxy bypasses so a developer's proxy configuration cannot make a local test
reconnect before falling back to another transport.

The scripted server has a focused contract suite:

```bash
vp test run --config vitest.node.config.ts scripts/scenarios/runtime/scripted-model-server.test.ts
```

That suite owns HTTP, server-sent event, Responses WebSocket, compression,
request matching, and bounded unexpected/unused-exchange diagnostics. Keep
wire-level edge cases there unless their outcome depends on the complete
Electron composition.

## Agent runtime conformance probes

Release-lock tests verify that the committed Agent and Browser artifacts form an
exact tested pair on each supported architecture. Use the shared compatibility
matcher with both complete identities: either artifact can have several tested
partners, and matrix ordering has no meaning. These tests verify admission to
the recorded relation; they do not replace the runtime probes that establish it.

Run all runtime probes with:

```bash
vp run test:agent-runtime-conformance
```

The probes also use the scripted model server with a real staged app-server,
but stop below the Electron product workflow. They are the faster owner for
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
