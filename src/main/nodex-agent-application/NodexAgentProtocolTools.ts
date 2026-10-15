import type { DynamicToolCallParams } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallResponse";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import { NODEX_APP_TOOL_NAMESPACE } from "../../shared/nodex-agent-tools/identity";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexConversationContext } from "../codex-application/CodexConversationContext";
import { NodexAppToolAuthority } from "../app-tools/NodexAppToolAuthority";
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
 * Executes Nodex Agent calls from their admitted Core execution identity. Model-controlled
 * arguments never select caller coordinates, toolset revision, or presentation target.
 */
export const live: Layer.Layer<
  NodexAgentProtocolTools,
  never,
  | CodexConversationContext
  | CodexTurnAuthority
  | CoreModules
  | NodexAppToolAuthority
  | NodexAgentDynamicTools
> = Layer.effect(
  NodexAgentProtocolTools,
  Effect.gen(function* () {
    const conversationContext = yield* CodexConversationContext;
    const turnAuthority = yield* CodexTurnAuthority;
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
            isCurrent,
          });
          return yield* tools.execute(params, { toolsetRevision: revision, ...context });
        }).pipe(
          Effect.catchCause((cause) =>
            tools
              .execute(params, {
                toolsetRevision: null,
                authority: null,
              })
              .pipe(Effect.annotateLogs({ cause })),
          ),
        ),
    });
  }),
);
