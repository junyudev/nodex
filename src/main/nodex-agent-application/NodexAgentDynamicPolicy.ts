import type {
  NodexAgentAccess,
  NodexAgentAuthorizationDecision,
  NodexAgentAuthorizationPreview,
  NodexAgentV3ToolName,
  ToolFailure,
} from "../../shared/nodex-agent-tools";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type {
  NodexAgentResourceAccessOverlay,
  NodexAgentResourceAccessPlan,
  NodexAgentResourceConsentRequirement,
  NodexAgentResourceGrantSpec,
  NodexAgentResourceIntent,
} from "../../shared/nodex-agent-resource-access";
import type { DynamicToolEffect } from "../codex/dynamic-tool-registry";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  sameAuthorizationFootprint,
  type NodexAgentAuthorizationFootprint,
} from "../agent-tools/authorization-footprint";

export type NodexAgentAuthorizationTool = Extract<
  NodexAgentV3ToolName,
  | "fetch"
  | "search"
  | "query_database_view"
  | "query_data_source"
  | "create_pages"
  | "update_page"
  | "advanced_update_page"
  | "move_pages"
  | "duplicate_page"
>;

export interface NodexAgentDynamicAuthorizationInput {
  readonly threadId: string;
  readonly callId: string;
  readonly projectId: string;
  readonly tool: NodexAgentAuthorizationTool;
  readonly effect: "read" | Extract<DynamicToolEffect, "write" | "destructive">;
  readonly preview: NodexAgentAuthorizationPreview;
  readonly requirements: readonly NodexAgentResourceConsentRequirement[];
  readonly inspectionAccess: NodexAgentResourceAccessOverlay;
}

export type NodexAgentDynamicAuthorizationResolution =
  | {
      readonly decision: Exclude<NodexAgentAuthorizationDecision, "deny">;
      readonly resourceAccess?: NodexAgentResourceAccessOverlay;
    }
  | "deny"
  | "unavailable";

export interface NodexAgentDynamicExecutionContext {
  readonly threadId: string;
  readonly callId: string;
  readonly operationId: string;
  readonly authority: FrozenNodexAgentTurnAuthority | null;
  readonly access: NodexAgentAccess;
  readonly resourceAccess?: NodexAgentResourceAccessOverlay;
  readonly resolveResourceAccess: (
    intents: readonly NodexAgentResourceIntent[],
  ) => Effect.Effect<NodexAgentResourceAccessPlan>;
  readonly recordTaskResourceAccess?: (
    grants: readonly NodexAgentResourceGrantSpec[],
  ) => Effect.Effect<void>;
  readonly authorize: (
    input: NodexAgentDynamicAuthorizationInput,
  ) => Effect.Effect<NodexAgentDynamicAuthorizationResolution>;
}

export function toolFailure(
  code: ToolFailure["error"]["code"],
  message: string,
  recovery: ToolFailure["error"]["recovery"],
  retryable = false,
): ToolFailure {
  return {
    error: { code, message, retryable, recovery },
  };
}

export class NodexAgentDynamicToolFailure extends Error {
  constructor(readonly failure: ToolFailure) {
    super(failure.error.message);
    this.name = "NodexAgentDynamicToolFailure";
  }
}

export function fail(failure: ToolFailure): never {
  throw new NodexAgentDynamicToolFailure(failure);
}

export function projectRequired(context: NodexAgentDynamicExecutionContext): string {
  if (context.authority?.actorProjectId != null) return context.authority.actorProjectId;
  return fail(
    toolFailure(
      "project_context_required",
      "This Nodex tool requires a task bound to a Project",
      "start_new_task",
    ),
  );
}

export function actorProject(context: NodexAgentDynamicExecutionContext): string | null {
  if (context.authority) return context.authority.actorProjectId;
  return fail(
    toolFailure(
      "authorization_denied",
      "This Nodex tool requires verified execution authority",
      "start_new_task",
    ),
  );
}

function requireStableAuthorizationFootprint(
  before: NodexAgentAuthorizationFootprint,
  after: NodexAgentAuthorizationFootprint,
): void {
  if (sameAuthorizationFootprint(before, after)) return;
  fail(
    toolFailure(
      "conflict",
      "The mutation scope changed while authorization was pending; review and retry the call",
      "retry_same",
      true,
    ),
  );
}

function failResourceAccessPlan(
  plan: Extract<NodexAgentResourceAccessPlan, { readonly kind: "denied" }>,
): never {
  const code =
    plan.reason === "resource_not_found"
      ? ("not_found" as const)
      : plan.reason === "project_not_found" || plan.reason === "authority_stale"
        ? ("authorization_denied" as const)
        : ("authorization_denied" as const);
  fail(
    toolFailure(
      code,
      `Nodex resource access was denied: ${plan.reason}`,
      plan.reason === "authority_stale" || plan.reason === "project_not_found"
        ? "start_new_task"
        : "none",
    ),
  );
}

const requireAuthorization = (
  context: NodexAgentDynamicExecutionContext,
  input: Omit<NodexAgentDynamicAuthorizationInput, "threadId" | "callId" | "projectId">,
): Effect.Effect<NodexAgentResourceAccessOverlay | undefined> =>
  Effect.gen(function* () {
    const projectId = projectRequired(context);
    const decision = yield* context.authorize({
      threadId: context.threadId,
      callId: context.callId,
      projectId,
      ...input,
    });
    if (typeof decision === "object") return decision.resourceAccess;
    if (decision === "unavailable") {
      return fail(
        toolFailure(
          "authorization_required",
          "A visible task is required to authorize this Nodex resource access",
          "request_authorization",
        ),
      );
    }
    return fail(
      toolFailure("authorization_denied", "The Nodex resource access was denied", "none"),
    );
  });

export const authorizeNodexAgentResourceIntents = (
  context: NodexAgentDynamicExecutionContext,
  input: Readonly<{
    intents: readonly NodexAgentResourceIntent[];
    tool: NodexAgentAuthorizationTool;
    effect: NodexAgentDynamicAuthorizationInput["effect"];
    preview: NodexAgentAuthorizationPreview;
  }>,
): Effect.Effect<NodexAgentResourceAccessOverlay | undefined> =>
  Effect.gen(function* () {
    const plan = yield* context.resolveResourceAccess(input.intents);
    if (plan.kind === "denied") return failResourceAccessPlan(plan);
    if (plan.kind === "authorized") return plan.resourceAccess;
    return yield* requireAuthorization(context, {
      tool: input.tool,
      effect: input.effect,
      preview: input.preview,
      requirements: plan.requirements,
      inspectionAccess: plan.inspectionAccess,
    });
  });

type CompletedWritePreflight<TOutput> = {
  readonly kind: "completed";
  readonly output: TOutput;
};

export const prepareAuthorizedWrite = <
  TOutput,
  TPrepared extends { readonly kind: "prepared" },
  E,
  R,
>(
  context: NodexAgentDynamicExecutionContext,
  input: {
    readonly intents: readonly NodexAgentResourceIntent[];
    readonly prepare: (
      resourceAccess?: NodexAgentResourceAccessOverlay,
    ) => Effect.Effect<CompletedWritePreflight<TOutput> | TPrepared, E, R>;
    readonly footprint: (prepared: TPrepared) => NodexAgentAuthorizationFootprint;
    readonly authorization: (
      prepared: TPrepared,
    ) => Omit<
      NodexAgentDynamicAuthorizationInput,
      "threadId" | "callId" | "projectId" | "effect" | "requirements" | "inspectionAccess"
    >;
  },
): Effect.Effect<CompletedWritePreflight<TOutput> | TPrepared, E, R> =>
  Effect.gen(function* () {
    const accessPlan = yield* context.resolveResourceAccess(input.intents);
    if (accessPlan.kind === "denied") return failResourceAccessPlan(accessPlan);
    const initialAccess =
      accessPlan.kind === "authorized" ? accessPlan.resourceAccess : accessPlan.inspectionAccess;
    const prepared = yield* input.prepare(initialAccess);
    if (prepared.kind === "completed") return prepared;

    const approvedFootprint = input.footprint(prepared);
    const executionAccess =
      accessPlan.kind === "authorized"
        ? accessPlan.resourceAccess
        : yield* requireAuthorization(context, {
            ...input.authorization(prepared),
            effect: approvedFootprint.effect,
            requirements: accessPlan.requirements,
            inspectionAccess: accessPlan.inspectionAccess,
          });

    const refreshed = yield* input.prepare(executionAccess);
    if (refreshed.kind === "completed") return refreshed;
    requireStableAuthorizationFootprint(approvedFootprint, input.footprint(refreshed));
    return refreshed;
  });

export function withExecutionTimeout<T, E, R>(
  operation: Effect.Effect<T, E, R>,
  timeoutMs: number,
): Effect.Effect<T, E | NodexAgentDynamicToolFailure, R> {
  return operation.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.fail(
          new NodexAgentDynamicToolFailure(
            toolFailure(
              "timeout",
              "The Nodex write did not finish within its execution window; retry the same call identity",
              "retry_same",
              true,
            ),
          ),
        ),
    }),
  );
}
