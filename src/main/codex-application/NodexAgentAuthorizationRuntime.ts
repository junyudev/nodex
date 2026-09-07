import { createHash, randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  NODEX_AGENT_AUTHORIZATION_RENDERER_METHOD,
  NODEX_AGENT_AUTHORIZATION_TIMEOUT_MS,
  type NodexAgentAuthorizationRequest,
} from "../../shared/nodex-agent-tools/authorization";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import {
  canonicalizeNodexAgentResourceGrantSpecs,
  type NodexAgentResourceAccessOverlay,
  type NodexAgentResourceGrantSpec,
  type PersistNodexAgentProjectResourceGrantsInput,
} from "../../shared/nodex-agent-resource-access";
import type { NodexAgentDynamicAuthorizationInput } from "../nodex-agent-application/NodexAgentDynamicPolicy";
import {
  NodexAgentResourceAccess,
  type NodexAgentResourceAccessError,
} from "../nodex-agent-application/NodexAgentResourceAccess";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { createOperationId } from "../core-runtime/operation-identity";
import { RendererClientRuntime } from "../host-runtime/RendererClientRuntime";

export type NodexAgentAuthorizationOutcome =
  | {
      readonly decision: "allow_once" | "allow_task" | "allow_project";
      readonly resourceAccess?: NodexAgentResourceAccessOverlay;
    }
  | "deny"
  | "unavailable";

interface NodexAgentAuthorizationGrant {
  readonly key: string;
  readonly rootThreadId: string;
  readonly projectId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly grants: readonly NodexAgentResourceGrantSpec[];
}

interface NodexAgentAuthorizationState {
  readonly closed: boolean;
  readonly grants: ReadonlyMap<string, NodexAgentAuthorizationGrant>;
}

export interface NodexAgentAuthorizationPresentationTarget {
  readonly clientId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export interface AuthorizeNodexAgentAccessInput extends NodexAgentDynamicAuthorizationInput {
  readonly rootThreadId: string;
  readonly authority: FrozenNodexAgentTurnAuthority;
  readonly presentation: NodexAgentAuthorizationPresentationTarget | null;
  /** Main-owned exact-Turn check, evaluated after the renderer responds. */
  readonly isAuthorityCurrent?: Effect.Effect<boolean>;
}

interface NodexAgentAuthorizationTestOptions {
  readonly persistProjectGrants: (
    input: PersistNodexAgentProjectResourceGrantsInput,
  ) => Effect.Effect<void, NodexAgentResourceAccessError>;
  readonly readStoreEpoch: () => string | null;
  readonly sessionEpoch?: string;
  readonly rendererClients: Pick<RendererClientRuntime["Service"], "request">;
}

export class NodexAgentAuthorizationRuntime extends Context.Service<
  NodexAgentAuthorizationRuntime,
  {
    readonly authorize: (
      input: AuthorizeNodexAgentAccessInput,
    ) => Effect.Effect<NodexAgentAuthorizationOutcome>;
    readonly extendTaskAccess: (
      authority: FrozenNodexAgentTurnAuthority,
      grants: readonly NodexAgentResourceGrantSpec[],
    ) => Effect.Effect<void>;
    readonly getTaskAccess: (
      authority: FrozenNodexAgentTurnAuthority,
    ) => Effect.Effect<NodexAgentResourceAccessOverlay | undefined>;
    readonly revokeRoot: (rootThreadId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/NodexAgentAuthorizationRuntime") {}

const AuthorizationResponse = Schema.Struct({
  decision: Schema.Literals(["allow_once", "allow_task", "allow_project", "deny"]),
});
const decodeAuthorizationResponse = Schema.decodeUnknownEffect(AuthorizationResponse);

const hashParts = (parts: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
};

const callOverlay = (
  authority: Extract<FrozenNodexAgentTurnAuthority, { readonly scope: "project" }>,
  callId: string,
  grants: readonly NodexAgentResourceGrantSpec[],
  persistResultingPageGrants = false,
): NodexAgentResourceAccessOverlay => ({
  kind: "consent",
  scope: "call",
  threadId: authority.threadId,
  turnId: authority.turnId,
  callId,
  rootThreadId: authority.rootThreadId,
  actorProjectId: authority.actorProjectId,
  libraryId: authority.libraryId,
  storeEpoch: authority.storeEpoch,
  grants: canonicalizeNodexAgentResourceGrantSpecs(grants),
  ...(persistResultingPageGrants ? { persistResultingPageGrants: true } : {}),
});

const taskOverlay = (
  authority: Extract<FrozenNodexAgentTurnAuthority, { readonly scope: "project" }>,
  grants: readonly NodexAgentResourceGrantSpec[],
): NodexAgentResourceAccessOverlay => ({
  kind: "consent",
  scope: "task",
  rootThreadId: authority.rootThreadId,
  actorProjectId: authority.actorProjectId,
  libraryId: authority.libraryId,
  storeEpoch: authority.storeEpoch,
  grants: canonicalizeNodexAgentResourceGrantSpecs(grants),
});

const make = (options: NodexAgentAuthorizationTestOptions) =>
  Effect.gen(function* () {
    const sessionEpoch = options.sessionEpoch ?? randomUUID();
    const state = yield* Ref.make<NodexAgentAuthorizationState>({
      closed: false,
      grants: new Map(),
    });
    yield* Effect.addFinalizer(() =>
      Ref.set(state, {
        closed: true,
        grants: new Map(),
      }),
    );

    const readStoreEpoch = (): string | null => {
      try {
        return options.readStoreEpoch();
      } catch {
        return null;
      }
    };
    const grantKey = (input: {
      readonly rootThreadId: string;
      readonly projectId: string;
      readonly storeEpoch: string;
    }): string => hashParts([sessionEpoch, input.rootThreadId, input.projectId, input.storeEpoch]);

    const normalize = (
      current: NodexAgentAuthorizationState,
      storeEpoch: string | null,
      root?: { readonly rootThreadId: string; readonly projectId: string },
    ): NodexAgentAuthorizationState => {
      if (current.closed) return current;
      if (!storeEpoch) return { ...current, grants: new Map() };
      const grants = new Map(
        [...current.grants].filter(([, grant]) => {
          if (grant.storeEpoch !== storeEpoch) return false;
          return (
            !root || grant.rootThreadId !== root.rootThreadId || grant.projectId === root.projectId
          );
        }),
      );
      return { ...current, grants };
    };

    const getTaskAccess = (
      authority: FrozenNodexAgentTurnAuthority,
    ): Effect.Effect<NodexAgentResourceAccessOverlay | undefined> => {
      if (authority.scope !== "project") return Effect.succeed(undefined);
      const storeEpoch = readStoreEpoch();
      return Ref.modify(state, (current) => {
        const normalized = normalize(current, storeEpoch, {
          rootThreadId: authority.rootThreadId,
          projectId: authority.actorProjectId,
        });
        if (normalized.closed || !storeEpoch || storeEpoch !== authority.storeEpoch) {
          return [undefined, normalized] as const;
        }
        const grant = normalized.grants.get(
          grantKey({
            rootThreadId: authority.rootThreadId,
            projectId: authority.actorProjectId,
            storeEpoch,
          }),
        );
        if (!grant || grant.libraryId !== authority.libraryId) {
          return [undefined, normalized] as const;
        }
        return [taskOverlay(authority, grant.grants), normalized] as const;
      });
    };

    const extendTaskAccess = (
      authority: FrozenNodexAgentTurnAuthority,
      grants: readonly NodexAgentResourceGrantSpec[],
    ): Effect.Effect<void> => {
      if (authority.scope !== "project") return Effect.void;
      const storeEpoch = readStoreEpoch();
      return Ref.update(state, (current) => {
        const normalized = normalize(current, storeEpoch, {
          rootThreadId: authority.rootThreadId,
          projectId: authority.actorProjectId,
        });
        if (normalized.closed || !storeEpoch || storeEpoch !== authority.storeEpoch) {
          return normalized;
        }
        const key = grantKey({
          rootThreadId: authority.rootThreadId,
          projectId: authority.actorProjectId,
          storeEpoch,
        });
        const existing = normalized.grants.get(key);
        if (!existing || existing.libraryId !== authority.libraryId) return normalized;
        const next = new Map(normalized.grants);
        next.set(key, {
          ...existing,
          grants: canonicalizeNodexAgentResourceGrantSpecs([...existing.grants, ...grants]),
        });
        return { ...normalized, grants: next };
      });
    };

    const isCurrent = Effect.fn("NodexAgentAuthorizationRuntime.isCurrent")(function* (
      input: AuthorizeNodexAgentAccessInput,
      storeEpoch: string,
    ) {
      const current = yield* input.isAuthorityCurrent ?? Effect.succeed(true);
      if (!current || readStoreEpoch() !== storeEpoch) return false;
      return !(yield* Ref.get(state)).closed;
    });

    const authorize = (
      input: AuthorizeNodexAgentAccessInput,
    ): Effect.Effect<NodexAgentAuthorizationOutcome> =>
      Effect.gen(function* () {
        const storeEpoch = readStoreEpoch();
        const currentState = yield* Ref.get(state);
        if (
          !storeEpoch ||
          storeEpoch !== input.authority.storeEpoch ||
          input.authority.scope !== "project" ||
          input.rootThreadId !== input.authority.rootThreadId ||
          input.projectId !== input.authority.actorProjectId ||
          currentState.closed
        ) {
          if (!storeEpoch) yield* Ref.update(state, (current) => normalize(current, null));
          return "unavailable";
        }
        yield* Ref.update(state, (current) =>
          normalize(current, storeEpoch, {
            rootThreadId: input.rootThreadId,
            projectId: input.projectId,
          }),
        );
        if (!input.presentation) return "unavailable";

        const createdAt = yield* Clock.currentTimeMillis;
        const request: NodexAgentAuthorizationRequest = {
          type: "nodexAgentAuthorization",
          requestId: `nodex-authorization:${randomUUID()}`,
          projectId: input.projectId,
          threadId: input.presentation.threadId,
          turnId: input.presentation.turnId,
          itemId: input.callId,
          tool: input.tool,
          effect: input.effect,
          preview: input.preview,
          createdAt,
        };
        const rawResponse = yield* options.rendererClients
          .request(
            input.presentation.clientId,
            NODEX_AGENT_AUTHORIZATION_RENDERER_METHOD,
            request,
            { timeoutMs: NODEX_AGENT_AUTHORIZATION_TIMEOUT_MS },
          )
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const response = yield* decodeAuthorizationResponse(rawResponse).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!response) return "unavailable";
        if (response.decision === "deny") return "deny";
        if (!(yield* isCurrent(input, storeEpoch))) return "unavailable";

        if (response.decision === "allow_once") {
          return {
            decision: "allow_once",
            resourceAccess: callOverlay(
              input.authority,
              input.callId,
              input.inspectionAccess.grants,
            ),
          };
        }

        if (response.decision === "allow_task") {
          const committed = yield* Ref.modify(state, (current) => {
            const normalized = normalize(current, readStoreEpoch(), {
              rootThreadId: input.rootThreadId,
              projectId: input.projectId,
            });
            if (normalized.closed || readStoreEpoch() !== storeEpoch) {
              return [null, normalized] as const;
            }
            const key = grantKey({
              rootThreadId: input.rootThreadId,
              projectId: input.projectId,
              storeEpoch,
            });
            const grants = canonicalizeNodexAgentResourceGrantSpecs([
              ...(normalized.grants.get(key)?.grants ?? []),
              ...input.requirements.map((requirement) => requirement.grant),
            ]);
            const next = new Map(normalized.grants);
            next.set(key, {
              key,
              rootThreadId: input.rootThreadId,
              projectId: input.projectId,
              libraryId: input.authority.libraryId,
              storeEpoch,
              grants,
            });
            return [grants, { ...normalized, grants: next }] as const;
          });
          if (!committed) return "unavailable";
          return {
            decision: "allow_task",
            resourceAccess: taskOverlay(input.authority, committed),
          };
        }

        const persistable = input.requirements
          .filter((requirement) => requirement.persistable)
          .map((requirement) => requirement.grant);
        if (persistable.length > 0) {
          const persisted = yield* options
            .persistProjectGrants({
              operationId: createOperationId("nodex-agent.persist-grants"),
              authority: input.authority,
              grants: persistable,
            })
            .pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
          if (!persisted) return "unavailable";
        }
        if (!(yield* isCurrent(input, storeEpoch))) return "unavailable";

        const taskAccess = yield* getTaskAccess(input.authority);
        const nonPersistable = input.requirements
          .filter((requirement) => !requirement.persistable)
          .map((requirement) => requirement.grant);
        if (nonPersistable.length === 0) {
          return {
            decision: "allow_project",
            ...(taskAccess ? { resourceAccess: taskAccess } : {}),
          };
        }
        return {
          decision: "allow_project",
          resourceAccess: callOverlay(
            input.authority,
            input.callId,
            [...(taskAccess?.grants ?? []), ...nonPersistable],
            true,
          ),
        };
      });

    return NodexAgentAuthorizationRuntime.of({
      authorize,
      extendTaskAccess,
      getTaskAccess,
      revokeRoot: (rootThreadId) =>
        Ref.update(state, (current) => ({
          ...current,
          grants: new Map(
            [...current.grants].filter(([, grant]) => grant.rootThreadId !== rootThreadId),
          ),
        })),
    });
  });

export const live: Layer.Layer<
  NodexAgentAuthorizationRuntime,
  never,
  CoreAuthority | NodexAgentResourceAccess | RendererClientRuntime
> = Layer.effect(
  NodexAgentAuthorizationRuntime,
  Effect.gen(function* () {
    const authority = yield* CoreAuthority;
    const resources = yield* NodexAgentResourceAccess;
    const rendererClients = yield* RendererClientRuntime;
    return yield* make({
      rendererClients,
      readStoreEpoch: () => authority.identity.storeEpoch,
      persistProjectGrants: resources.persistProjectGrants,
    });
  }),
);

export const testLayer = (
  options: NodexAgentAuthorizationTestOptions,
): Layer.Layer<NodexAgentAuthorizationRuntime> =>
  Layer.effect(NodexAgentAuthorizationRuntime, make(options));
