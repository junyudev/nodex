import type { DynamicToolCallParams } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallResponse";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  nodexAgentAuthorityFingerprint,
  type FrozenNodexAgentTurnAuthority,
} from "../../shared/nodex-agent-authority";
import type { NodexAgentAccess } from "../../shared/nodex-agent-tools/read-runtime";
import { NODEX_APP_TOOL_NAMESPACE } from "../../shared/nodex-agent-tools/identity";
import type { NodexAgentResourceIntent } from "../../shared/nodex-agent-resource-access";
import { CodexConversations } from "../codex-application/CodexConversations";
import { CodexConversationContext } from "../codex-application/CodexConversationContext";
import {
  NodexAgentAuthorizationRuntime,
  type NodexAgentAuthorizationPresentationTarget,
} from "../codex-application/NodexAgentAuthorizationRuntime";
import { CodexRendererConversationRegistry } from "../codex-application/CodexRendererConversationRegistry";
import { resolveNodexAgentWriteAccess } from "../codex/nodex-agent-access";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  NodexAgentDynamicTools,
  nodexDynamicToolsDisabledResponse,
} from "./NodexAgentDynamicTools";
import { NodexAgentResourceAccess } from "./NodexAgentResourceAccess";

export class NodexAgentProtocolTools extends Context.Service<
  NodexAgentProtocolTools,
  {
    readonly execute: (params: DynamicToolCallParams) => Effect.Effect<DynamicToolCallResponse>;
  }
>()("nodex/main/nodex-agent-application/NodexAgentProtocolTools") {}

const fromCoreAuthority = (
  authority: {
    readonly thread_id: string;
    readonly turn_id: string;
    readonly root_thread_id: string;
    readonly actor_project_id: string;
    readonly library_id: string;
    readonly store_epoch: string;
    readonly scope: FrozenNodexAgentTurnAuthority["scope"];
    readonly source: FrozenNodexAgentTurnAuthority["source"];
  },
  frozenAtMs: number,
): FrozenNodexAgentTurnAuthority => ({
  threadId: authority.thread_id,
  turnId: authority.turn_id,
  rootThreadId: authority.root_thread_id,
  actorProjectId: authority.actor_project_id,
  libraryId: authority.library_id,
  storeEpoch: authority.store_epoch,
  frozenAtMs,
  scope: authority.scope,
  source: authority.source,
});

/**
 * Executes Nodex Agent calls from their frozen Core Turn authority. Model-controlled arguments
 * never select Project, root Thread, toolset revision, resource grants, or presentation target.
 */
export const live: Layer.Layer<
  NodexAgentProtocolTools,
  never,
  | CodexConversationContext
  | CodexConversations
  | CodexRendererConversationRegistry
  | CoreModules
  | NodexAgentAuthorizationRuntime
  | NodexAgentDynamicTools
  | NodexAgentResourceAccess
> = Layer.effect(
  NodexAgentProtocolTools,
  Effect.gen(function* () {
    const conversationContext = yield* CodexConversationContext;
    const conversations = yield* CodexConversations;
    const renderer = yield* CodexRendererConversationRegistry;
    const core = yield* CoreModules;
    const authorization = yield* NodexAgentAuthorizationRuntime;
    const tools = yield* NodexAgentDynamicTools;
    const resources = yield* NodexAgentResourceAccess;

    const capture = Effect.fn("NodexAgentProtocolTools.captureAuthority")(function* (
      params: DynamicToolCallParams,
    ) {
      const lineage = yield* conversationContext.read(params.threadId);
      if (!lineage.projectId) return null;
      const snapshot = yield* core.workspace.read(
        {
          kind: "turn_authority",
          thread_id: params.threadId,
          turn_id: params.turnId,
          root_thread_id: lineage.rootThreadId,
          actor_project_id: lineage.projectId,
        },
        undefined,
        lineage.projectId,
      );
      if (snapshot.value.kind !== "turn_authority") {
        return yield* Effect.die(new Error("Core returned the wrong Turn authority variant"));
      }
      const resolution = snapshot.value.resolution;
      return resolution.persisted && resolution.authority && resolution.frozen_at_ms != null
        ? fromCoreAuthority(resolution.authority, resolution.frozen_at_ms)
        : null;
    });

    const toolsetRevision = Effect.fn("NodexAgentProtocolTools.toolsetRevision")(function* (
      params: DynamicToolCallParams,
      projectId: string | null,
    ) {
      if (!projectId) return null;
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
          const projectId = authority?.actorProjectId ?? lineage.projectId;
          const revision = yield* toolsetRevision(params, projectId);
          const access: NodexAgentAccess = {
            read: "allowed",
            write: resolveNodexAgentWriteAccess({
              authorityScope: authority?.scope ?? null,
              hasActorProject: projectId !== null,
            }),
            domains: ["document", "placement", "database"],
          };
          const taskAccess = authority ? yield* authorization.getTaskAccess(authority) : undefined;
          return yield* tools.execute(params, {
            toolsetRevision: revision,
            authority,
            access,
            ...(taskAccess ? { resourceAccess: taskAccess } : {}),
            ...(authority
              ? {
                  recordTaskResourceAccess: (grants) =>
                    authorization.extendTaskAccess(authority, grants),
                }
              : {}),
            resolveResourceAccess: (intents: readonly NodexAgentResourceIntent[]) => {
              if (!authority) {
                return Effect.succeed({
                  kind: "denied" as const,
                  intent: intents[0] ?? {
                    target: { kind: "library" as const, libraryId: "unavailable" },
                    action: "read" as const,
                  },
                  reason: "project_not_found" as const,
                });
              }
              return resources
                .plan({
                  authority,
                  callId: params.callId,
                  intents,
                  ...(taskAccess ? { taskAccess } : {}),
                })
                .pipe(Effect.orDie);
            },
            authorize: (input) => {
              if (!authority) return Effect.succeed("unavailable" as const);
              const isCurrent = capture(params).pipe(
                Effect.map(
                  (current) =>
                    current !== null &&
                    nodexAgentAuthorityFingerprint(current) ===
                      nodexAgentAuthorityFingerprint(authority),
                ),
                Effect.catch(() => Effect.succeed(false)),
              );
              if (authority.scope === "library") {
                return isCurrent.pipe(
                  Effect.map((current) =>
                    current ? ({ decision: "allow_once" } as const) : ("unavailable" as const),
                  ),
                );
              }
              return authorization.authorize({
                ...input,
                rootThreadId: lineage.rootThreadId,
                authority,
                presentation: presentation(params, lineage.rootThreadId),
                isAuthorityCurrent: isCurrent,
              });
            },
          });
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
