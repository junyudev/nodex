/* oxlint-disable effecttsgo/strict-effect-provide -- The protocol test provides its complete isolated dependency layer at the test entry point. */
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexConversationContext } from "../codex-application/CodexConversationContext";
import { CodexConversations } from "../codex-application/CodexConversations";
import { CodexRendererConversationRegistry } from "../codex-application/CodexRendererConversationRegistry";
import { NodexAgentAuthorizationRuntime } from "../codex-application/NodexAgentAuthorizationRuntime";
import { CoreModules } from "../core-runtime/CoreModules";
import { NodexAgentResourceAccess } from "./NodexAgentResourceAccess";
import { NodexAgentDynamicTools } from "./NodexAgentDynamicTools";
import { live, NodexAgentProtocolTools } from "./NodexAgentProtocolTools";

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
      Layer.succeed(CodexRendererConversationRegistry, untouched as never),
      Layer.succeed(NodexAgentAuthorizationRuntime, untouched as never),
      Layer.succeed(CoreModules, untouched as never),
      Layer.succeed(NodexAgentResourceAccess, untouched as never),
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
