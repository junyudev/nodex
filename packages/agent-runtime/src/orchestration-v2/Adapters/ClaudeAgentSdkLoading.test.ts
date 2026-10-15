import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ClaudeAgentSdkQueryRunner, layerQueryRunner } from "./ClaudeAdapterV2.ts";

const sdk = vi.hoisted(() => ({
  loads: 0,
  query: vi.fn(() => ({})),
  forkSession: vi.fn(async () => ({ sessionId: "forked-native-session" })),
  getSubagentMessages: vi.fn(async () => [{ parent_tool_use_id: "launch-tool" }]),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  sdk.loads += 1;
  return {
    query: sdk.query,
    forkSession: sdk.forkSession,
    getSubagentMessages: sdk.getSubagentMessages,
  };
});

it.effect(
  "defers SDK acquisition until Claude is used and shares it across execution operations",
  () =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      yield* runner.allocateSessionId;
      yield* runner.assertComplete;
      assert.equal(sdk.loads, 0);
      const binding = {
        threadId: ThreadId.make("thread-lazy-sdk"),
        providerSessionId: ProviderSessionId.make("provider-session-lazy-sdk"),
      };
      const forked = yield* runner.forkSession({
        ...binding,
        sessionId: "native-session",
        options: {},
      });
      assert.equal(forked.sessionId, "forked-native-session");
      assert.equal(sdk.loads, 1);
      assert.deepEqual(sdk.forkSession.mock.calls, [["native-session", {}]]);
      const launch = yield* runner.subagentLaunchToolUseId({
        ...binding,
        sessionId: "native-session",
        agentId: "native-child",
        dir: null,
      });
      assert.equal(launch, "launch-tool");
      assert.deepEqual(sdk.getSubagentMessages.mock.calls, [
        ["native-session", "native-child", { limit: 1 }],
      ]);
      yield* runner.open({
        ...binding,
        options: {
          sessionId: "native-session",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      assert.equal(sdk.query.mock.calls.length, 1);
      assert.equal(sdk.loads, 1);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
          ),
        ),
      ),
      Effect.provide(NodeServices.layer),
    ),
);
