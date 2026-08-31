import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  CodexPendingThreadSource,
  CodexPendingWorktreeRequest,
} from "../../shared/codex-pending-worktree";
import type { CodexForkBrowserSceneContext } from "../../shared/codex-fork-browser-transfer";
import { ProjectSessionForkInputSchema } from "../../shared/schemas/project-sessions";
import type {
  CodexCollaborationModeState,
  ProjectSessionForkInput,
  ProjectSessionForkResult,
} from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexForkTitlePolicy } from "./CodexForkTitlePolicy";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexProjectSessionForkCommand {
  readonly sessionId: string;
  readonly input: ProjectSessionForkInput;
  readonly sourceSceneContext?: CodexForkBrowserSceneContext;
  /** Protocol-originated forks may classify their child without changing Session semantics. */
  readonly threadSource?: CodexPendingThreadSource;
}

export class CodexProjectSessionForkError extends Data.TaggedError("CodexProjectSessionForkError")<{
  readonly operation: "parse" | "admit" | "direct" | "pending" | "settings";
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
  readonly projectId: string | null;
  readonly directory: CodexThreadDirectoryEntry;
}

/** Owns the user-visible Project Session fork intent for direct and managed-worktree targets. */
export const make: Effect.Effect<
  CodexProjectSessionFork["Service"],
  never,
  | CodexConversationFork
  | CodexConversationProjection
  | CodexForkSidePanelTransfer
  | CodexForkTitlePolicy
  | CodexGateway
  | CodexOwnerNotificationDrainRuntime
  | CodexPendingWorktreeRuntime
  | CodexThreadDirectory
  | CodexThreadSettingsRuntime
  | ConversationEntityMap
  | CoreModules
> = Effect.gen(function* () {
  const core = yield* CoreModules;
  const gateway = yield* CodexGateway;
  const conversationFork = yield* CodexConversationFork;
  const projection = yield* CodexConversationProjection;
  const sidePanelTransfers = yield* CodexForkSidePanelTransfer;
  const forkTitles = yield* CodexForkTitlePolicy;
  const notificationDrain = yield* CodexOwnerNotificationDrainRuntime;
  const pendingWorktrees = yield* CodexPendingWorktreeRuntime;
  const directory = yield* CodexThreadDirectory;
  const threadSettings = yield* CodexThreadSettingsRuntime;
  const conversations = yield* ConversationEntityMap;

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
    const projectId = sourceSession.project_id ?? null;
    if (resolved.durable.projectId !== projectId) {
      return yield* error(
        "admit",
        normalizedSessionId,
        new Error("Project Session and Thread disagree on Project ownership"),
      );
    }
    return { threadId, projectId, directory: resolved };
  });

  const sourceWorkspaceRoots = Effect.fn("CodexProjectSessionFork.sourceWorkspaceRoots")(function* (
    source: AdmittedSource,
    sessionId: string,
  ) {
    const cwd = source.directory.durable.cwd;
    if (!cwd) {
      return yield* error(
        "pending",
        sessionId,
        new Error("A materialized working directory is required to create a worktree"),
      );
    }
    if (!source.projectId) return [cwd] as const;
    const response = yield* core.workspace
      .read({ kind: "project", project_id: source.projectId }, undefined, source.projectId)
      .pipe(Effect.mapError((cause) => error("pending", sessionId, cause)));
    if (response.value.kind !== "project" || response.value.project.lifecycle !== "active") {
      return yield* error(
        "pending",
        sessionId,
        new Error("Managed worktrees require an active Project"),
      );
    }
    return [
      cwd,
      ...response.value.project.sources
        .map((projectSource) => projectSource.root.trim())
        .filter((root) => root && root !== cwd),
    ];
  });

  const collaborationMode = (
    source: CodexThreadDirectoryEntry,
    requestedMode: ProjectSessionForkInput["collaborationMode"],
  ): CodexCollaborationModeState | null => {
    const current = source.snapshot?.latestCollaborationMode ?? null;
    if (!requestedMode) return current;
    return {
      mode: requestedMode,
      settings: current?.settings ?? {
        model: source.durable.executionProfile?.modelId ?? "",
        reasoning_effort: source.durable.executionProfile?.reasoningEffort ?? null,
        developer_instructions: null,
      },
    };
  };

  const enqueuePendingPhysical = Effect.fn("CodexProjectSessionFork.enqueuePendingPhysical")(
    function* (
      sessionId: string,
      source: AdmittedSource,
      full: CodexThreadDirectoryEntry,
      parsed: ProjectSessionForkInput,
      threadSource: CodexPendingThreadSource,
      sourceSceneContext?: CodexForkBrowserSceneContext,
    ): Effect.fn.Return<ProjectSessionForkResult, CodexProjectSessionForkError> {
      if (source.directory.durable.executionHostId !== gateway.localHostId) {
        return yield* error(
          "pending",
          sessionId,
          new Error("Managed worktrees can only fork a local Thread"),
        );
      }
      if (!full.canonical) {
        return yield* error(
          "pending",
          sessionId,
          new Error("Fork source has no canonical conversation"),
        );
      }
      if (parsed.turnId) {
        const turn = full.canonical.turns.find(
          (candidate) => candidate.protocol.id === parsed.turnId,
        );
        if (!turn || turn.protocol.status === "inProgress") {
          return yield* error(
            "pending",
            sessionId,
            new Error(`Turn '${parsed.turnId}' is unavailable for an exact fork`),
          );
        }
      }
      const cwd = full.durable.cwd;
      if (!cwd) {
        return yield* error(
          "pending",
          sessionId,
          new Error("Fork source has no working directory"),
        );
      }
      const roots = yield* sourceWorkspaceRoots({ ...source, directory: full }, sessionId);
      const { childTitle } = yield* forkTitles
        .derive({
          threadId: source.threadId,
          projectId: source.projectId,
          forkedFromId: full.summary.forkedFromId ?? null,
          threadName: full.summary.threadName,
          canonical: full.canonical,
          pendingForks: pendingWorktrees
            .list()
            .filter(
              (entry) => entry.launchMode === "fork-conversation" && entry.sourceConversationId,
            )
            .map((entry) => ({
              conversationId: entry.id,
              forkedFromId: entry.sourceConversationId,
              title: entry.initialThreadTitle ?? entry.label,
            })),
        })
        .pipe(Effect.mapError((cause) => error("pending", sessionId, cause)));
      const pendingWorktreeId = randomUUID();
      const clientThreadId = randomUUID();
      const request: CodexPendingWorktreeRequest = {
        id: pendingWorktreeId,
        clientThreadId,
        hostId: gateway.localHostId,
        label: childTitle ?? "New task",
        ...(childTitle ? { initialThreadTitle: childTitle } : {}),
        sourceWorkspaceRoot: cwd,
        sourceWorkspaceRoots: roots,
        startingState: { type: "working-tree" },
        localEnvironmentConfigPath: parsed.localEnvironmentConfigPath ?? null,
        launchMode: "fork-conversation",
        projectAssignment: source.projectId
          ? {
              projectKind: "local",
              projectId: source.projectId,
              path: cwd,
              pendingCoreUpdate: false,
            }
          : null,
        prompt: "Continue this task in a new worktree",
        startConversationParamsInput: null,
        sourceConversationId: source.threadId,
        sourceCollaborationMode: collaborationMode(full, parsed.collaborationMode),
        targetTurnId: parsed.turnId ?? null,
        threadSource,
      };
      yield* sidePanelTransfers
        .capturePending({
          pendingWorktreeId,
          sourceConversationId: source.threadId,
          sourceWorkspaceRoot: cwd,
          ...(sourceSceneContext ? { sourceSceneContext } : {}),
        })
        .pipe(Effect.mapError((cause) => error("pending", sessionId, cause)));
      yield* pendingWorktrees
        .create(request)
        .pipe(
          Effect.onError(() =>
            sidePanelTransfers.discardPending(pendingWorktreeId).pipe(Effect.ignore),
          ),
        );
      return { pendingWorktreeId, clientThreadId };
    },
  );

  const enqueuePending = Effect.fn("CodexProjectSessionFork.enqueuePending")(function* (
    sessionId: string,
    source: AdmittedSource,
    parsed: ProjectSessionForkInput,
    threadSource: CodexPendingThreadSource,
    sourceSceneContext?: CodexForkBrowserSceneContext,
  ): Effect.fn.Return<ProjectSessionForkResult, CodexProjectSessionForkError> {
    yield* projection.read(source.threadId).pipe(
      Effect.catch(() =>
        directory
          .resolve({
            threadId: source.threadId,
            fidelity: "tail",
            hostId: source.directory.durable.executionHostId,
          })
          .pipe(
            Effect.flatMap((entry) =>
              entry?.canonical
                ? Effect.void
                : Effect.fail(
                    error(
                      "pending",
                      sessionId,
                      new Error("Fork source has no canonical conversation"),
                    ),
                  ),
            ),
            Effect.mapError((cause) =>
              cause instanceof CodexProjectSessionForkError
                ? cause
                : error("pending", sessionId, cause),
            ),
          ),
      ),
    );
    return yield* conversations.runCommand(
      source.threadId,
      Effect.gen(function* () {
        yield* notificationDrain
          .awaitCurrent(source.threadId)
          .pipe(Effect.mapError((cause) => error("pending", sessionId, cause)));
        const current = yield* projection
          .read(source.threadId)
          .pipe(Effect.mapError((cause) => error("pending", sessionId, cause)));
        return yield* enqueuePendingPhysical(
          sessionId,
          source,
          {
            ...source.directory,
            fidelity: "tail",
            canonical: current.canonical,
            snapshot: current.snapshot,
          },
          parsed,
          threadSource,
          sourceSceneContext,
        );
      }),
    );
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
        if (parsed.target === "newWorktree") {
          return yield* enqueuePending(
            sessionId,
            source,
            parsed,
            command.threadSource ?? "user",
            command.sourceSceneContext,
          );
        }
        const forked = yield* conversationFork
          .fork({
            sourceThreadId: source.threadId,
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
