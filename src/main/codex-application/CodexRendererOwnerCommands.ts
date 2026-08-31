import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2/ThreadGoal";
import type { ThreadGoalSetParams } from "@nodex/codex-app-server-protocol/v2/ThreadGoalSetParams";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createEmptyCodexPreparedPrompt } from "../../shared/codex-prompt-preparation";
import { CodexThreadGoalStatusSchema } from "../../shared/schemas/codex";
import type {
  CodexLiveFileAttachment,
  CodexOwnerAppServerRequestInput,
  CodexPreparedPrompt,
  CodexThreadActionResult,
} from "../../shared/types";
import { ConversationCommands } from "./ConversationCommands";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexFreshThreadLaunchRuntime } from "./CodexFreshThreadLaunchRuntime";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { CodexThreadRollbackCommands } from "./CodexThreadRollbackCommands";
import { CodexTurnCommands } from "./CodexTurnCommands";

export class CodexRendererOwnerCommandError extends Schema.TaggedError<CodexRendererOwnerCommandError>()(
  "CodexRendererOwnerCommandError",
  {
    method: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexRendererOwnerCommands extends Context.Service<
  CodexRendererOwnerCommands,
  {
    readonly execute: (
      ownerClientId: string,
      input: CodexOwnerAppServerRequestInput,
    ) => Effect.Effect<unknown, CodexRendererOwnerCommandError>;
  }
>()("nodex/main/codex-application/CodexRendererOwnerCommands") {}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const isOwnerTurnUserInput = (
  value: unknown,
): value is CodexPreparedPrompt["inputItems"][number] => {
  const input = asRecord(value);
  if (!input || typeof input.type !== "string") return false;
  switch (input.type) {
    case "text":
      return typeof input.text === "string" && Array.isArray(input.text_elements);
    case "image":
      return typeof input.url === "string";
    case "localImage":
      return typeof input.path === "string";
    case "skill":
    case "mention":
      return typeof input.name === "string" && typeof input.path === "string";
    default:
      return false;
  }
};

const isLiveFileAttachment = (value: unknown): value is CodexLiveFileAttachment => {
  const attachment = asRecord(value);
  return Boolean(
    attachment &&
    typeof attachment.label === "string" &&
    typeof attachment.path === "string" &&
    typeof attachment.fsPath === "string",
  );
};

const readPreparedPrompt = (value: unknown): CodexPreparedPrompt => {
  const prepared = asRecord(value);
  if (!prepared || typeof prepared.promptText !== "string") {
    throw new Error("Owner turn/start request requires a prepared prompt");
  }
  if (
    !Array.isArray(prepared.inputItems) ||
    !prepared.inputItems.every(isOwnerTurnUserInput) ||
    !Array.isArray(prepared.pendingInputItems) ||
    !prepared.pendingInputItems.every(isOwnerTurnUserInput)
  ) {
    throw new Error("Owner turn/start request has invalid prepared input");
  }
  if (
    !Array.isArray(prepared.fileAttachments) ||
    !prepared.fileAttachments.every(isLiveFileAttachment) ||
    !Array.isArray(prepared.addedFiles) ||
    !prepared.addedFiles.every(isLiveFileAttachment) ||
    !Array.isArray(prepared.pastedTextAttachments) ||
    !Array.isArray(prepared.commentAttachments) ||
    !Array.isArray(prepared.agentConfigs)
  ) {
    throw new Error("Owner turn/start request has invalid prepared sidecars");
  }
  if (prepared.inputItems.length === 0 && prepared.pastedTextAttachments.length === 0) {
    throw new Error("Owner turn/start request requires prepared input or pasted text");
  }
  if (prepared.additionalContext !== undefined && !asRecord(prepared.additionalContext)) {
    throw new Error("Owner turn/start request has invalid prepared additionalContext");
  }
  return value as CodexPreparedPrompt;
};

const readGoalSetParams = (threadId: string, value: unknown): ThreadGoalSetParams => {
  const params = asRecord(value);
  if (!params) throw new Error("Invalid thread goal input");
  const input: ThreadGoalSetParams = { threadId };
  if (Object.prototype.hasOwnProperty.call(params, "objective")) {
    if (typeof params.objective !== "string" && params.objective !== null) {
      throw new Error("Invalid thread goal objective");
    }
    input.objective = params.objective;
  }
  if (Object.prototype.hasOwnProperty.call(params, "status")) {
    const status = params.status;
    if (status !== null && !CodexThreadGoalStatusSchema.safeParse(status).success) {
      throw new Error("Invalid thread goal status");
    }
    input.status = status as ThreadGoal["status"] | null;
  }
  if (Object.prototype.hasOwnProperty.call(params, "tokenBudget")) {
    input.tokenBudget =
      typeof params.tokenBudget === "number" && Number.isFinite(params.tokenBudget)
        ? params.tokenBudget
        : null;
  }
  return input;
};

const validateIdentity = (
  ownerClientId: string,
  input: CodexOwnerAppServerRequestInput,
  rendererConversations: CodexRendererConversationRegistry["Service"],
): string => {
  const threadId = input.conversationId.trim();
  if (!ownerClientId || rendererConversations.getOwnerClientId(threadId) !== ownerClientId) {
    throw new Error(`Renderer client ${ownerClientId || "unknown"} is not owner for ${threadId}`);
  }
  const params = asRecord(input.request.params);
  if (!params || params.threadId !== threadId) {
    throw new Error(`Owner app-server request '${input.request.method}' must target ${threadId}`);
  }
  return threadId;
};

export const make: Effect.Effect<
  CodexRendererOwnerCommands["Service"],
  never,
  | CodexConversationFork
  | CodexRendererConversationRegistry
  | CodexFreshThreadLaunchRuntime
  | CodexManualCompactionRuntime
  | CodexThreadGoalRuntime
  | CodexThreadSettingsRuntime
  | CodexThreadRollbackCommands
  | CodexTurnCommands
  | ConversationCommands
> = Effect.gen(function* () {
  const conversationFork = yield* CodexConversationFork;
  const rendererConversations = yield* CodexRendererConversationRegistry;
  const freshThreadLaunch = yield* CodexFreshThreadLaunchRuntime;
  const manualCompaction = yield* CodexManualCompactionRuntime;
  const threadGoals = yield* CodexThreadGoalRuntime;
  const threadSettings = yield* CodexThreadSettingsRuntime;
  const threadRollback = yield* CodexThreadRollbackCommands;
  const turnCommands = yield* CodexTurnCommands;
  const conversations = yield* ConversationCommands;
  const forkError = (threadId: string, cause: unknown) =>
    new CodexRendererOwnerCommandError({ method: "thread/fork", threadId, cause });

  const forkFromTurn = Effect.fn("CodexRendererOwnerCommands.forkFromTurn")(function* (input: {
    readonly ownerClientId: string;
    readonly threadId: string;
    readonly turnId: string;
  }): Effect.fn.Return<CodexThreadActionResult, object> {
    const turnId = input.turnId.trim();
    if (!turnId) {
      return yield* forkError(input.threadId, new Error("Owner thread/fork requires a turnId"));
    }
    const result = yield* conversationFork
      .fork({
        sourceThreadId: input.threadId,
        lastTurnId: turnId,
        threadSource: "user",
        ownerClientId: input.ownerClientId,
      })
      .pipe(Effect.mapError((cause) => forkError(input.threadId, cause)));
    return { threadId: result.threadId, composerIntent: result.composerIntent };
  });

  const execute = (
    ownerClientId: string,
    input: CodexOwnerAppServerRequestInput,
  ): Effect.Effect<unknown, CodexRendererOwnerCommandError> => {
    const method = input.request.method;
    const requestedThreadId = input.conversationId.trim();
    return Effect.try({
      try: () => validateIdentity(ownerClientId, input, rendererConversations),
      catch: (cause) =>
        new CodexRendererOwnerCommandError({ method, threadId: requestedThreadId, cause }),
    }).pipe(
      Effect.flatMap((threadId): Effect.Effect<unknown, object> => {
        const request = input.request;
        switch (request.method) {
          case "thread/revert":
            return threadRollback.revertLatestForEdit({
              threadId,
              turnId: request.params.beforeTurnId,
              numTurns: 1,
            });
          case "thread/fork":
            return forkFromTurn({
              ownerClientId,
              threadId,
              turnId: request.params.turnId,
            });
          case "turn/start":
            return Effect.try({
              try: () => readPreparedPrompt(request.params.preparedPrompt),
              catch: (cause) => new CodexRendererOwnerCommandError({ method, threadId, cause }),
            }).pipe(
              Effect.flatMap((preparedPrompt) =>
                turnCommands.startRendererOwned(threadId, request.params.prompt, {
                  ...(request.params.opts ?? {}),
                  clientUserMessageId: request.params.clientUserMessageId,
                  preparedPrompt,
                }),
              ),
            );
          case "turn/resume-interrupted":
            if (!request.params.clientUserMessageId.trim()) {
              return Effect.fail(
                new CodexRendererOwnerCommandError({
                  method,
                  threadId,
                  cause: new Error("Owner turn/resume-interrupted requires a clientUserMessageId"),
                }),
              );
            }
            return turnCommands.startRendererOwned(threadId, "", {
              ...(request.params.opts ?? {}),
              clientUserMessageId: request.params.clientUserMessageId,
              preparedPrompt: createEmptyCodexPreparedPrompt(),
            });
          case "thread/session-first-turn/start":
            return freshThreadLaunch.start({
              threadId,
              launchId: request.params.launchId,
              ownerClientId,
            });
          case "turn/interrupt":
            return conversations.interrupt(threadId, request.params.turnId);
          case "thread/settings/update":
            return threadSettings.update({
              threadId,
              patch: request.params.patch,
            });
          case "thread/goal/set":
            return Effect.try({
              try: () => readGoalSetParams(threadId, request.params),
              catch: (cause) => new CodexRendererOwnerCommandError({ method, threadId, cause }),
            }).pipe(Effect.flatMap(threadGoals.set));
          case "thread/goal/clear":
            return threadGoals.clear(threadId);
          case "thread/memoryMode/set":
            return conversations.setMemoryMode(threadId, request.params.mode);
          case "thread/compact/start":
            return manualCompaction.start(threadId);
          case "thread/backgroundTerminals/list":
            return conversations.listBackgroundTerminalsPage(threadId, {
              cursor: request.params.cursor ?? null,
              limit:
                request.params.limit && request.params.limit > 0 ? request.params.limit : undefined,
            });
          case "thread/backgroundTerminals/terminate":
            if (!request.params.processId.trim()) {
              return Effect.fail(
                new CodexRendererOwnerCommandError({
                  method,
                  threadId,
                  cause: new Error(
                    "Owner thread/backgroundTerminals/terminate requires a processId",
                  ),
                }),
              );
            }
            return conversations
              .terminateBackgroundTerminal(threadId, request.params.processId)
              .pipe(Effect.map((terminated) => ({ terminated })));
        }
      }),
      Effect.mapError((cause) =>
        cause instanceof CodexRendererOwnerCommandError
          ? cause
          : new CodexRendererOwnerCommandError({
              method,
              threadId: requestedThreadId,
              cause,
            }),
      ),
      Effect.withSpan("CodexRendererOwnerCommands.execute", {
        attributes: { method, threadId: requestedThreadId },
      }),
    );
  };

  return CodexRendererOwnerCommands.of({ execute });
});
