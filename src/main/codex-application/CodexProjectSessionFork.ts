import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isCodexAgentBackendBinding } from "../../shared/agent-backend";
import type { CodexPendingThreadSource } from "../../shared/codex-pending-worktree";
import type { CodexForkBrowserSceneContext } from "../../shared/codex-fork-browser-transfer";
import { ProjectSessionForkInputSchema } from "../../shared/schemas/project-sessions";
import type { ProjectSessionForkInput, ProjectSessionForkResult } from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";

export interface CodexProjectSessionForkCommand {
  readonly sessionId: string;
  readonly destinationSessionId?: string;
  readonly input: ProjectSessionForkInput;
  readonly sourceSceneContext?: CodexForkBrowserSceneContext;
  /** Protocol-originated forks may classify their child without changing Session semantics. */
  readonly threadSource?: CodexPendingThreadSource;
}

export class CodexProjectSessionForkError extends Data.TaggedError("CodexProjectSessionForkError")<{
  readonly operation: "parse" | "admit" | "direct" | "settings";
  readonly sessionId: string;
  readonly cause: unknown;
}> {}

export class CodexProjectSessionFork extends Context.Service<
  CodexProjectSessionFork,
  {
    readonly fork: (
      command: CodexProjectSessionForkCommand,
    ) => Effect.Effect<ProjectSessionForkResult, CodexProjectSessionForkError>;
  }
>()("nodex/main/codex-application/CodexProjectSessionFork") {}

interface AdmittedSource {
  readonly threadId: string;
}

/** Forks a Session owned by an explicitly retained remote native host. */
export const make: Effect.Effect<
  CodexProjectSessionFork["Service"],
  never,
  | CodexConversationFork
  | CodexGateway
  | CodexThreadDirectory
  | CodexThreadSettingsRuntime
  | CoreModules
> = Effect.gen(function* () {
  const core = yield* CoreModules;
  const gateway = yield* CodexGateway;
  const conversationFork = yield* CodexConversationFork;
  const directory = yield* CodexThreadDirectory;
  const threadSettings = yield* CodexThreadSettingsRuntime;

  const error = (
    operation: CodexProjectSessionForkError["operation"],
    sessionId: string,
    cause: unknown,
  ) => new CodexProjectSessionForkError({ operation, sessionId, cause });

  const admit = Effect.fn("CodexProjectSessionFork.admit")(function* (
    sessionId: string,
    sourceSceneContext?: CodexForkBrowserSceneContext,
  ): Effect.fn.Return<AdmittedSource, CodexProjectSessionForkError> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return yield* error("admit", sessionId, new Error("Project Session is required"));
    }
    const response = yield* core.workspace
      .read({ kind: "session", session_id: normalizedSessionId })
      .pipe(Effect.mapError((cause) => error("admit", normalizedSessionId, cause)));
    if (response.value.kind !== "session") {
      return yield* error(
        "admit",
        normalizedSessionId,
        new Error("Core returned a non-Session read variant"),
      );
    }
    const sourceSession = response.value.session;
    const threadId = sourceSession.thread_id?.trim() ?? "";
    if (!threadId) {
      return yield* error(
        "admit",
        normalizedSessionId,
        new Error("Project Session has no Codex Thread to fork"),
      );
    }
    if (
      sourceSceneContext &&
      (sourceSceneContext.scene.owner.kind !== "session" ||
        sourceSceneContext.scene.owner.sessionId !== normalizedSessionId)
    ) {
      return yield* error(
        "admit",
        normalizedSessionId,
        new Error("Fork source Scene does not belong to the source Session"),
      );
    }
    const resolved = yield* directory
      .resolve({ threadId, fidelity: "durable" })
      .pipe(Effect.mapError((cause) => error("admit", normalizedSessionId, cause)));
    if (!resolved || resolved.durable.sessionId !== normalizedSessionId) {
      return yield* error(
        "admit",
        normalizedSessionId,
        new Error("Project Session does not own its durable Thread"),
      );
    }
    if (!isCodexAgentBackendBinding(resolved.durable.backendBinding)) {
      return yield* error(
        "admit",
        normalizedSessionId,
        new Error("Project Session is not owned by the native Codex backend"),
      );
    }
    const hostId = resolved.durable.executionHostId;
    if (!hostId || hostId.trim() !== hostId || hostId === gateway.localHostId) {
      return yield* error(
        "admit",
        normalizedSessionId,
        new Error(
          "Local imported history has no native execution owner; start an Agent Runtime Session",
        ),
      );
    }
    const projectId = sourceSession.project_id ?? null;
    if (resolved.durable.projectId !== projectId) {
      return yield* error(
        "admit",
        normalizedSessionId,
        new Error("Session and native Thread placement changed"),
      );
    }
    return { threadId };
  });

  return CodexProjectSessionFork.of({
    fork: (command) =>
      Effect.gen(function* () {
        const sessionId = command.sessionId.trim();
        const parsed = yield* Effect.try({
          try: () => ProjectSessionForkInputSchema.parse(command.input),
          catch: (cause) => error("parse", sessionId, cause),
        });
        const source = yield* admit(sessionId, command.sourceSceneContext);
        if (parsed.target !== "local") {
          return yield* error(
            "admit",
            sessionId,
            new Error("Worktree forks require an Agent Runtime Session"),
          );
        }
        const forked = yield* conversationFork
          .fork({
            sourceThreadId: source.threadId,
            ...(command.destinationSessionId
              ? { destinationSessionId: command.destinationSessionId }
              : {}),
            lastTurnId: parsed.turnId ?? null,
            threadSource: command.threadSource ?? "user",
            ...(command.sourceSceneContext
              ? { sourceSceneContext: command.sourceSceneContext }
              : {}),
          })
          .pipe(Effect.mapError((cause) => error("direct", sessionId, cause)));
        if (parsed.collaborationMode) {
          yield* threadSettings
            .update({
              threadId: forked.threadId,
              patch: { collaborationMode: parsed.collaborationMode },
            })
            .pipe(Effect.mapError((cause) => error("settings", sessionId, cause)));
        }
        return {
          session: forked.session,
          threadId: forked.threadId,
          ...(parsed.turnId ? { composerIntent: forked.composerIntent } : {}),
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof CodexProjectSessionForkError
            ? cause
            : error("direct", command.sessionId, cause),
        ),
        Effect.withSpan("CodexProjectSessionFork.fork", {
          attributes: { sessionId: command.sessionId, target: command.input.target },
        }),
      ),
  });
});
