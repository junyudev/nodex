// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest";
import { connectAppToolsPipe } from "@nodex/app-tools-mcp/pipe";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModules } from "../core-runtime/CoreModules";
import { AppToolInvocationInbox, type AppToolInvocation } from "./AppToolInvocationInbox";
import { captureAppToolAuthority } from "./AppToolCaller";
import { make } from "./NativeAppToolSession";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "native",
  turnId: "turn",
  rootThreadId: "native",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  frozenAtMs: 1,
  readOnly: false,
  scope: "project",
  source: "project_turn",
};

it.effect(
  "private native MCP ignores forged coordinates and revokes authority with its admitted Turn",
  () =>
    Effect.gen(function* () {
      const calls: AppToolInvocation[] = [];
      let persisted = true;
      let current = true;
      const owner = yield* make.pipe(
        Effect.provideService(CoreModules, {
          workspace: {
            read: () =>
              Effect.succeed({
                value: {
                  kind: "turn_authority",
                  resolution: {
                    persisted,
                    frozen_at_ms: 1,
                    read_only: false,
                    authority: toCoreAgentTurnProvenance("", authority).authority,
                  },
                },
              }),
          },
        } as never),
        Effect.provideService(AppToolInvocationInbox, {
          invoke: (call: AppToolInvocation) =>
            Effect.gen(function* () {
              const captured = yield* captureAppToolAuthority(call.caller, {
                capture: () => Effect.die("Unexpected Codex caller"),
              });
              calls.push(call);
              return { content: [], isError: captured === null };
            }),
        } as never),
      );
      const scope = yield* Scope.make();
      const lease = yield* owner
        .acquire({
          threadId: "native",
          hostId: "local",
          generation: 7,
          isCurrent: Effect.sync(() => current),
          runtime: {
            runtime: { paths: { node: "/bundled/node" } },
            entrypoint: "/app/out/main/app-tools/server.mjs",
          },
        })
        .pipe(Scope.provide(scope));
      const server = lease.launchContext.mcpServers!.nodex_app;
      assert.equal(server.type, "stdio");
      if (server.type !== "stdio") return yield* Effect.die("Expected stdio server");
      const env = server.env!;
      const client = yield* Effect.acquireRelease(
        Effect.promise(() =>
          connectAppToolsPipe({
            path: env.NODEX_APP_TOOLS_PIPE!,
            instanceId: env.NODEX_APP_TOOLS_INSTANCE!,
            token: env.NODEX_APP_TOOLS_TOKEN!,
          }),
        ),
        (client) => Effect.sync(() => client.close()),
      );
      const signal = new AbortController().signal;
      const tools = yield* Effect.promise(() => client.listTools(signal));
      assert.isTrue(tools.some((tool) => tool.name === "query_content"));
      assert.isFalse(tools.some((tool) => tool.name === "consume_usage_reset"));
      const request = {
        name: "get_app_capabilities",
        arguments: {},
        metadata: { callId: "fake", thread_id: "other", turn_id: "other" },
        signal,
      };
      assert.isTrue((yield* Effect.promise(() => client.callTool(request))).isError);
      assert.isTrue(yield* lease.beginTurn(authority));
      assert.isFalse((yield* Effect.promise(() => client.callTool(request))).isError);
      assert.equal(calls[0]?.caller.threadId, "native");
      assert.equal(calls[0]?.caller.turnId, "turn");
      assert.notEqual(calls[0]?.caller.callId, "fake");
      lease.setBackgroundTasks(["child"]);
      assert.isFalse(calls[0]!.caller.isActive());
      assert.isTrue((yield* Effect.promise(() => client.callTool(request))).isError);
      lease.setBackgroundTasks([]);
      assert.isFalse(calls[0]!.caller.isActive());
      assert.isFalse((yield* Effect.promise(() => client.callTool(request))).isError);
      current = false;
      const beforeRebind = calls.length;
      assert.isTrue((yield* Effect.promise(() => client.callTool(request))).isError);
      assert.lengthOf(calls, beforeRebind);
      current = true;
      persisted = false;
      assert.isTrue((yield* Effect.promise(() => client.callTool(request))).isError);
      lease.endTurn("turn");
      assert.isFalse(calls[0]!.caller.isActive());
      assert.isTrue((yield* Effect.promise(() => client.callTool(request))).isError);
      assert.lengthOf(calls, 3);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(callbackLayer)),
);
