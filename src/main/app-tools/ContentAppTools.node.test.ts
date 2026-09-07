import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./ContentAppTools";

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
const input: AppToolInvocation = {
  name: "get_context",
  arguments: {},
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};
const output = {
  data: { project: null, access: { read: "allowed", write: "consent_required", domains: [] } },
};

it.effect("uses frozen native-call authority and validates the semantic result", () =>
  Effect.gen(function* () {
    let reads = 0;
    let stale = false;
    let invalidOutput = false;
    let conflict = false;
    const execute = yield* make.pipe(
      Effect.provideService(CodexTurnAuthority, {
        capture: () => Effect.sync(() => (stale ? null : authority)),
      } as unknown as CodexTurnAuthority["Service"]),
      Effect.provideService(NodexAppToolAuthority, {
        bind: (binding) =>
          Effect.gen(function* () {
            assert.strictEqual(binding.callId, "call");
            assert.strictEqual(yield* binding.isCurrent, true);
            return {
              authority: binding.authority,
              access: { read: "allowed" as const, write: "consent_required" as const, domains: [] },
              authorize: () => Effect.succeed("unavailable" as const),
              resolveResourceAccess: () => Effect.die("unexpected resource request"),
            };
          }),
      }),
      Effect.provideService(NodexAgentApplication, {
        read: (request: Parameters<NodexAgentApplication["Service"]["read"]>[0]) =>
          Effect.sync(() => {
            reads += 1;
            assert.deepStrictEqual(request.authority, authority);
            assert.strictEqual(request.projectId, "project");
            assert.strictEqual(request.callId, "call");
            if (conflict)
              return {
                result: {
                  ok: false,
                  error: {
                    code: "conflict",
                    message: "Body changed",
                    recovery: "fetch_again",
                    retryable: false,
                  },
                },
                events: [],
                metrics: {},
              };
            return {
              result: { ok: true, tool: "get_context", output: invalidOutput ? {} : output },
              events: [],
              metrics: {},
            };
          }),
      } as unknown as NodexAgentApplication["Service"]),
    );
    assert.deepStrictEqual((yield* execute(input)).structuredContent, output);
    invalidOutput = true;
    assert.strictEqual((yield* execute(input)).isError, true);
    conflict = true;
    const rejected = yield* execute(input);
    assert.strictEqual(rejected.isError, true);
    assert.strictEqual((rejected.structuredContent?.error as { code: string }).code, "conflict");
    stale = true;
    assert.deepStrictEqual((yield* execute(input)).structuredContent, {
      error: { code: "authority_unavailable" },
    });
    assert.strictEqual(
      (yield* execute({ ...input, arguments: { projectId: "substituted" } })).isError,
      true,
    );
    assert.strictEqual(reads, 3);
  }),
);
