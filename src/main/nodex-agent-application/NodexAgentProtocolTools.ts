import type { DynamicToolCallParams } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallResponse";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import { NODEX_APP_TOOL_NAMESPACE } from "../../shared/nodex-agent-tools/identity";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexConversations } from "../codex-application/CodexConversations";
import { CodexConversationContext } from "../codex-application/CodexConversationContext";
import type { NodexAgentAuthorizationPresentationTarget } from "../codex-application/NodexAgentAuthorizationRuntime";
import { NodexAppToolAuthority } from "../app-tools/NodexAppToolAuthority";
import { CodexRendererConversationRegistry } from "../codex-application/CodexRendererConversationRegistry";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  NodexAgentDynamicTools,
  nodexDynamicToolsDisabledResponse,
} from "./NodexAgentDynamicTools";

export class NodexAgentProtocolTools extends Context.Service<
  NodexAgentProtocolTools,
  {
    readonly execute: (params: DynamicToolCallParams) => Effect.Effect<DynamicToolCallResponse>;
  }
>()("nodex/main/nodex-agent-application/NodexAgentProtocolTools") {}

/**
 * Executes Nodex Agent calls from their frozen Core Turn authority. Model-controlled arguments
 * never select Project, root Thread, toolset revision, resource grants, or presentation target.
 */
export const live: Layer.Layer<
  NodexAgentProtocolTools,
  never,
  | CodexConversationContext
  | CodexConversations
  | CodexTurnAuthority
  | CodexRendererConversationRegistry
  | CoreModules
  | NodexAppToolAuthority
  | NodexAgentDynamicTools
> = Layer.effect(
  NodexAgentProtocolTools,
  Effect.gen(function* () {
    const conversationContext = yield* CodexConversationContext;
    const conversations = yield* CodexConversations;
    const turnAuthority = yield* CodexTurnAuthority;
    const renderer = yield* CodexRendererConversationRegistry;
    const core = yield* CoreModules;
    const appAuthority = yield* NodexAppToolAuthority;
    const tools = yield* NodexAgentDynamicTools;

    const capture = (params: DynamicToolCallParams) =>
      turnAuthority.capture(params.threadId, params.turnId);

    const toolsetRevision = Effect.fn("NodexAgentProtocolTools.toolsetRevision")(function* (
      params: DynamicToolCallParams,
      projectId: string | null,
    ) {
      const snapshot = yield* core.workspace.read(
        { kind: "execution_context", thread_id: params.threadId },
        undefined,
        projectId,
      );
      if (snapshot.value.kind !== "execution_context") {
        return yield* Effect.die(new Error("Core returned the wrong execution context variant"));
      }
      return (
        snapshot.value.context.thread.dynamic_tool_catalogs.find(
          (catalog) => catalog.namespace === NODEX_APP_TOOL_NAMESPACE,
        )?.toolset_revision ?? null
      );
    });

    const presentation = (
      params: DynamicToolCallParams,
      rootThreadId: string,
    ): NodexAgentAuthorizationPresentationTarget | null => {
      const direct = renderer.resolvePresentationClient(params.threadId);
      if (direct) return { clientId: direct, threadId: params.threadId, turnId: params.turnId };
      if (rootThreadId === params.threadId) return null;
      const clientId = renderer.resolvePresentationClient(rootThreadId);
      const turnId = conversations.latestTurnId(rootThreadId);
      return clientId && turnId ? { clientId, threadId: rootThreadId, turnId } : null;
    };

    return NodexAgentProtocolTools.of({
      execute: (params) =>
        Effect.gen(function* () {
          if (!tools.enabled) return nodexDynamicToolsDisabledResponse();
          const lineage = yield* conversationContext.read(params.threadId);
          const authority = yield* capture(params);
          const projectId = authority ? authority.actorProjectId : lineage.projectId;
          const revision = yield* toolsetRevision(params, projectId);
          const isCurrent = capture(params).pipe(
            Effect.map(
              (current) =>
                current !== null &&
                authority !== null &&
                nodexAgentAuthorityFingerprint(current) ===
                  nodexAgentAuthorityFingerprint(authority),
            ),
            Effect.catch(() => Effect.succeed(false)),
          );
          const context = yield* appAuthority.bind({
            authority,
            callId: params.callId,
            presentation: presentation(params, lineage.rootThreadId),
            isCurrent,
          });
          return yield* tools.execute(params, { toolsetRevision: revision, ...context });
        }).pipe(
          Effect.catchCause((cause) =>
            tools
              .execute(params, {
                toolsetRevision: null,
                authority: null,
                access: {
                  read: "allowed",
                  write: "unavailable",
                  domains: ["document", "placement", "database"],
                },
                resolveResourceAccess: (intents) =>
                  Effect.succeed({
                    kind: "denied" as const,
                    intent: intents[0] ?? {
                      target: { kind: "library" as const, libraryId: "unavailable" },
                      action: "read" as const,
                    },
                    reason: "authority_stale" as const,
                  }),
                authorize: () => Effect.succeed("unavailable" as const),
              })
              .pipe(Effect.annotateLogs({ cause })),
          ),
        ),
    });
  }),
);
