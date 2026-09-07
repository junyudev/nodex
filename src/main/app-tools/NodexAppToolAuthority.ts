import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceIntent } from "../../shared/nodex-agent-resource-access";
import type { NodexAgentAccess } from "../../shared/nodex-agent-tools/read-runtime";
import { resolveNodexAgentWriteAccess } from "../codex/nodex-agent-access";
import {
  NodexAgentAuthorizationRuntime,
  type NodexAgentAuthorizationPresentationTarget,
} from "../codex-application/NodexAgentAuthorizationRuntime";
import type { NodexAgentDynamicExecutionContext } from "../nodex-agent-application/NodexAgentDynamicPolicy";
import { NodexAgentResourceAccess } from "../nodex-agent-application/NodexAgentResourceAccess";

export interface AppToolAuthorityContext extends Pick<
  NodexAgentDynamicExecutionContext,
  "resourceAccess" | "recordTaskResourceAccess" | "resolveResourceAccess" | "authorize"
> {
  readonly authority: FrozenNodexAgentTurnAuthority | null;
  readonly access: NodexAgentAccess;
}

export interface BindAppToolAuthority {
  readonly authority: FrozenNodexAgentTurnAuthority | null;
  readonly callId: string;
  readonly presentation: NodexAgentAuthorizationPresentationTarget | null;
  /** The backend Adapter rechecks exact invocation lifetime and frozen Core authority. */
  readonly isCurrent: Effect.Effect<boolean>;
}

const denied = (intents: readonly NodexAgentResourceIntent[]) => ({
  kind: "denied" as const,
  intent: intents[0] ?? {
    target: { kind: "library" as const, libraryId: "unavailable" },
    action: "read" as const,
  },
  reason: "authority_stale" as const,
});

export class NodexAppToolAuthority extends Context.Service<
  NodexAppToolAuthority,
  { readonly bind: (input: BindAppToolAuthority) => Effect.Effect<AppToolAuthorityContext> }
>()("nodex/main/app-tools/NodexAppToolAuthority") {}

/** Shared content consent policy. Transport metadata never constructs a resource grant. */
export const make = Effect.gen(function* () {
  const authorization = yield* NodexAgentAuthorizationRuntime;
  const resources = yield* NodexAgentResourceAccess;
  return NodexAppToolAuthority.of({
    bind: Effect.fn("NodexAppToolAuthority.bind")(function* (input) {
      const authority = input.authority;
      const current = authority !== null && (yield* input.isCurrent);
      const taskAccess = current ? yield* authorization.getTaskAccess(authority) : undefined;
      return {
        authority: current ? authority : null,
        access: {
          read: "allowed",
          write:
            current && authority.readOnly
              ? "unavailable"
              : resolveNodexAgentWriteAccess({
                  authorityScope: current ? authority.scope : null,
                  hasFrozenAuthority: current,
                }),
          domains: ["document", "placement", "database"],
        },
        ...(taskAccess ? { resourceAccess: taskAccess } : {}),
        recordTaskResourceAccess: (grants) =>
          Effect.gen(function* () {
            if (!current || !authority || !(yield* input.isCurrent)) return;
            yield* authorization.extendTaskAccess(authority, grants);
          }),
        resolveResourceAccess: (intents) =>
          Effect.gen(function* () {
            if (!current || !authority || !(yield* input.isCurrent)) return denied(intents);
            return yield* resources
              .plan({
                authority,
                callId: input.callId,
                intents,
                ...(taskAccess ? { taskAccess } : {}),
              })
              .pipe(Effect.orDie);
          }),
        authorize: (request) =>
          Effect.gen(function* () {
            if (!current || !authority || !(yield* input.isCurrent)) return "unavailable" as const;
            if (request.effect !== "read" && authority.readOnly) return "deny" as const;
            if (authority.scope === "library") return { decision: "allow_once" as const };
            return yield* authorization.authorize({
              ...request,
              threadId: authority.threadId,
              callId: input.callId,
              projectId: authority.actorProjectId,
              rootThreadId: authority.rootThreadId,
              authority,
              presentation: input.presentation,
              isAuthorityCurrent: input.isCurrent,
            });
          }),
      } satisfies AppToolAuthorityContext;
    }),
  });
});

export const live = Layer.effect(NodexAppToolAuthority, make);
