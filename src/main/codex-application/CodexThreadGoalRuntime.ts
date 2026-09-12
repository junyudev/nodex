import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2/ThreadGoal";
import type { ThreadGoalSetParams } from "@nodex/codex-app-server-protocol/v2/ThreadGoalSetParams";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CodexThreadGoalSetActionInput } from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  CodexConversationProjection,
  type CodexConversationProjectionError,
} from "./CodexConversationProjection";
import {
  CodexThreadSettingsRuntime,
  type CodexThreadSettingsError,
} from "./CodexThreadSettingsRuntime";

/** Application-only metadata stays out of the renderer and app-server contracts. */
export type CodexThreadGoalSetCommand = CodexThreadGoalSetActionInput & {
  readonly dismissResumeConfirmation?: boolean;
};

export type CodexThreadGoalError =
  | CodexRuntimeError
  | CodexThreadSettingsError
  | CodexConversationProjectionError;

export type CodexThreadGoalLoadResult =
  | { readonly ok: true; readonly goal: ThreadGoal | null }
  | { readonly ok: false; readonly goal: null };

export class CodexThreadGoalRuntime extends Context.Service<
  CodexThreadGoalRuntime,
  {
    readonly get: (threadId: string) => Effect.Effect<ThreadGoal | null, CodexRuntimeError>;
    readonly set: (
      input: CodexThreadGoalSetCommand,
    ) => Effect.Effect<ThreadGoal | null, CodexThreadGoalError>;
    readonly clear: (threadId: string) => Effect.Effect<void, CodexRuntimeError>;
    readonly load: (threadId: string) => Effect.Effect<CodexThreadGoalLoadResult>;
  }
>()("nodex/main/codex-application/CodexThreadGoalRuntime") {}

const has = <Key extends PropertyKey>(value: object, key: Key): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const normalizeCodexThreadGoalSetAction = (
  input: CodexThreadGoalSetCommand,
): CodexThreadGoalSetCommand => {
  const objective = input.objective;
  const status = input.status ?? (typeof objective === "string" ? "active" : undefined);
  return {
    threadId: input.threadId,
    ...(objective !== undefined ? { objective } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    ...(input.appendTranscriptItem !== undefined
      ? { appendTranscriptItem: input.appendTranscriptItem }
      : {}),
    ...(input.dismissResumeConfirmation !== undefined
      ? { dismissResumeConfirmation: input.dismissResumeConfirmation }
      : {}),
    ...(input.threadSettings ? { threadSettings: input.threadSettings } : {}),
  };
};

const requestParams = (
  input: CodexThreadGoalSetCommand,
): ClientRequestParamsByMethod["thread/goal/set"] => {
  const params: ThreadGoalSetParams = { threadId: input.threadId };
  if (has(input, "objective")) params.objective = input.objective;
  if (has(input, "status")) params.status = input.status;
  if (has(input, "tokenBudget")) params.tokenBudget = input.tokenBudget;
  return params;
};

const projectGoal = (
  goal: NonNullable<ClientRequestResponsesByMethod["thread/goal/get"]["goal"]>,
): ThreadGoal => ({ ...goal, tokenBudget: goal.tokenBudget ?? null });

export const live: Layer.Layer<
  CodexThreadGoalRuntime,
  never,
  CodexConversationProjection | CodexGateway | CodexThreadSettingsRuntime
> = Layer.effect(
  CodexThreadGoalRuntime,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const projection = yield* CodexConversationProjection;
    const settings = yield* CodexThreadSettingsRuntime;

    const get = Effect.fn("CodexThreadGoalRuntime.get")(function* (threadId: string) {
      const response = yield* gateway.requestForThread(threadId, "thread/goal/get", { threadId });
      return response.goal ? projectGoal(response.goal) : null;
    });

    const set = Effect.fn("CodexThreadGoalRuntime.set")(function* (
      input: CodexThreadGoalSetCommand,
    ) {
      const action = normalizeCodexThreadGoalSetAction(input);
      const hasObjective = typeof action.objective === "string";
      if (hasObjective || action.status === "active") {
        if (action.threadSettings)
          yield* settings.update({ threadId: action.threadId, patch: action.threadSettings });
        else yield* settings.awaitCurrent(action.threadId);
      }
      const response = yield* gateway.requestForThread(
        action.threadId,
        "thread/goal/set",
        requestParams(action),
      );
      const goal = response.goal ? projectGoal(response.goal) : null;
      yield* projection.acceptThreadGoal({
        threadId: action.threadId,
        goal,
        appendTranscriptItem: action.appendTranscriptItem !== false && hasObjective,
        dismissResumeConfirmation: !hasObjective || action.dismissResumeConfirmation === true,
      });
      return goal;
    });

    const clear = Effect.fn("CodexThreadGoalRuntime.clear")(function* (threadId: string) {
      yield* gateway.requestForThread(threadId, "thread/goal/clear", { threadId });
    });

    const load = (threadId: string): Effect.Effect<CodexThreadGoalLoadResult> =>
      get(threadId).pipe(
        Effect.map((goal) => ({ ok: true, goal }) satisfies CodexThreadGoalLoadResult),
        Effect.catch((error) =>
          Effect.logWarning("Could not hydrate Thread goal after resume").pipe(
            Effect.annotateLogs({ threadId, error: error.message }),
            Effect.as({ ok: false, goal: null } satisfies CodexThreadGoalLoadResult),
          ),
        ),
      );

    return CodexThreadGoalRuntime.of({ get, set, clear, load });
  }),
);
