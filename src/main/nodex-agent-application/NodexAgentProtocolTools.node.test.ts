/* oxlint-disable effecttsgo/strict-effect-provide -- The protocol test provides its complete isolated dependency layer at the test entry point. */
import { it, assert } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexConversationContext } from "../codex-application/CodexConversationContext";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexConversations } from "../codex-application/CodexConversations";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "../codex-application/CodexRendererPresentationRegistry";
import {
  NodexAppToolAuthority,
  type BindAppToolAuthority,
} from "../app-tools/NodexAppToolAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { NodexAgentDynamicTools } from "./NodexAgentDynamicTools";
import { live, NodexAgentProtocolTools } from "./NodexAgentProtocolTools";

it.effect(
  "routes authorization to a presented task or its root and retires disposed surfaces",
  () =>
    Effect.gen(function* () {
      const presentation = yield* makePresentationRegistry;
      const targets: Array<BindAppToolAuthority["presentation"]> = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(CodexConversationContext, {
          read: () => Effect.succeed({ projectId: "project-a", rootThreadId: "root-thread" }),
        } as never),
        Layer.succeed(CodexConversations, { latestTurnId: () => "root-turn" } as never),
        Layer.succeed(CodexTurnAuthority, { capture: () => Effect.succeed(null) } as never),
        Layer.succeed(CodexRendererPresentationRegistry, presentation),
        Layer.succeed(
          NodexAppToolAuthority,
          NodexAppToolAuthority.of({
            bind: (input) =>
              Effect.sync(() => {
                targets.push(input.presentation);
                return {
                  authority: null,
                  access: {
                    read: "allowed" as const,
                    write: "unavailable" as const,
                    domains: ["document" as const],
                  },
                  authorize: () => Effect.succeed("unavailable" as const),
                  resolveResourceAccess: () => Effect.die("No resource access requested"),
                };
              }),
          }),
        ),
        Layer.succeed(CoreModules, {
          workspace: {
            read: () =>
              Effect.succeed({
                value: {
                  kind: "execution_context",
                  context: { thread: { dynamic_tool_catalogs: [] } },
                },
              }),
          },
        } as never),
        Layer.succeed(NodexAgentDynamicTools, {
          enabled: true,
          execute: () => Effect.succeed({ success: true, contentItems: [] }),
        }),
      );
      const context = yield* Layer.build(live.pipe(Layer.provide(dependencies)));
      const tools = Context.get(context, NodexAgentProtocolTools);
      const request = {
        namespace: "nodex_app",
        tool: "create_pages",
        arguments: {},
        threadId: "child-thread",
        turnId: "child-turn",
        callId: "call-a",
      };
      presentation.setPresented("root-thread", "root-renderer", "root-surface", true);
      presentation.setPresented("child-thread", "child-renderer", "child-surface", true);
      yield* tools.execute(request);
      presentation.setPresented("child-thread", "child-renderer", "child-surface", false);
      yield* tools.execute(request);
      presentation.handleClientDisposed("root-renderer");
      yield* tools.execute(request);

      assert.deepEqual(targets, [
        { clientId: "child-renderer", threadId: "child-thread", turnId: "child-turn" },
        { clientId: "root-renderer", threadId: "root-thread", turnId: "root-turn" },
        null,
      ]);
    }),
);

it.effect(
  "rejects a restored dynamic call before looking up authority, resources, or presentation",
  () => {
    const untouched = new Proxy(
      {},
      {
        get: () => {
          throw new Error("Disabled calls must not resolve host or Core state");
        },
      },
    );
    const dependencies = Layer.mergeAll(
      Layer.succeed(CodexConversationContext, untouched as never),
      Layer.succeed(CodexConversations, untouched as never),
      Layer.succeed(CodexTurnAuthority, untouched as never),
      Layer.succeed(CodexRendererPresentationRegistry, untouched as never),
      Layer.succeed(NodexAppToolAuthority, untouched as never),
      Layer.succeed(CoreModules, untouched as never),
      Layer.succeed(NodexAgentDynamicTools, {
        enabled: false,
        execute: () => Effect.die("Protocol gate must precede execution"),
      }),
    );
    return Effect.gen(function* () {
      const tools = yield* NodexAgentProtocolTools;
      const result = yield* tools.execute({
        namespace: "nodex_app",
        tool: "create_pages",
        arguments: {},
        threadId: "restored-thread",
        turnId: "current-turn",
        callId: "call",
      });
      assert.isFalse(result.success);
      const content = result.contentItems[0];
      assert.strictEqual(content?.type, "inputText");
      if (content?.type !== "inputText") return;
      assert.strictEqual(
        JSON.parse(content.text).error.details.domainCode,
        "NODEX_DYNAMIC_TOOLS_DISABLED",
      );
    }).pipe(Effect.provide(live.pipe(Layer.provide(dependencies))));
  },
);
