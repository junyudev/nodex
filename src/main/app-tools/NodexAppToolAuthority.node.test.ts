import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { NodexAgentAuthorizationRuntime } from "../codex-application/NodexAgentAuthorizationRuntime";
import { NodexAgentResourceAccess } from "../nodex-agent-application/NodexAgentResourceAccess";
import { make } from "./NodexAppToolAuthority";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "thread",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  frozenAtMs: 1,
  readOnly: false,
  scope: "project",
  source: "project_turn",
};
const intent = { target: { kind: "page" as const, pageId: "page" }, action: "write" as const };
const request = {
  threadId: "thread",
  callId: "call",
  projectId: "project",
  tool: "update_page" as const,
  effect: "write" as const,
  preview: { title: "Update", summary: "Edit Page", details: [] },
  requirements: [],
  inspectionAccess: {
    kind: "inspection" as const,
    ...authority,
    scope: "call" as const,
    callId: "call",
    grants: [],
  },
};

it.effect("rechecks revocation before planning, approval, or extending task grants", () =>
  Effect.gen(function* () {
    let active = true;
    let planned = 0;
    let approved = 0;
    let extended = 0;
    const owner = yield* make.pipe(
      Effect.provideService(NodexAgentAuthorizationRuntime, {
        revokeRoot: () => Effect.void,
        getTaskAccess: () => Effect.succeed(undefined),
        authorize: () =>
          Effect.sync(() => {
            approved += 1;
            return { decision: "allow_once" as const };
          }),
        extendTaskAccess: () =>
          Effect.sync(() => {
            extended += 1;
          }),
      }),
      Effect.provideService(NodexAgentResourceAccess, {
        plan: () =>
          Effect.sync(() => {
            planned += 1;
            return { kind: "denied" as const, intent, reason: "authority_stale" as const };
          }),
        persistProjectGrants: () => Effect.void,
      }),
    );
    const context = yield* owner.bind({
      authority,
      callId: "call",
      presentation: null,
      isCurrent: Effect.sync(() => active),
    });
    yield* context.resolveResourceAccess([intent]);
    yield* context.authorize(request);
    yield* context.recordTaskResourceAccess!([]);
    assert.deepStrictEqual([planned, approved, extended], [1, 1, 1]);
    const readOnly = yield* owner.bind({
      authority: { ...authority, readOnly: true, scope: "library" },
      callId: "read-only",
      presentation: null,
      isCurrent: Effect.succeed(true),
    });
    assert.strictEqual(readOnly.access.write, "unavailable");
    assert.strictEqual(yield* readOnly.authorize(request), "deny");
    assert.deepStrictEqual(yield* readOnly.authorize({ ...request, effect: "read" }), {
      decision: "allow_once",
    });
    active = false;
    assert.deepStrictEqual(yield* context.resolveResourceAccess([intent]), {
      kind: "denied",
      intent,
      reason: "authority_stale",
    });
    assert.strictEqual(yield* context.authorize(request), "unavailable");
    yield* context.recordTaskResourceAccess!([]);
    assert.deepStrictEqual([planned, approved, extended], [1, 1, 1]);
    const rejected = yield* owner.bind({
      authority,
      callId: "call",
      presentation: null,
      isCurrent: Effect.sync(() => active),
    });
    active = true;
    assert.strictEqual(rejected.authority, null);
    assert.strictEqual(rejected.access.write, "unavailable");
    assert.strictEqual(yield* rejected.authorize(request), "unavailable");
  }),
);
