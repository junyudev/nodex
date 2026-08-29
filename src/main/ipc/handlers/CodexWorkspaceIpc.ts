import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  BrowserWindow,
  dialog,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import { MainConfig } from "../../app/MainConfig";
import { AgentImportRuntime } from "../../codex-application/AgentImportRuntime";
import { CodexBackgroundProcesses } from "../../codex-application/CodexBackgroundProcesses";
import { CodexConversationHistoryRuntime } from "../../codex-application/CodexConversationHistoryRuntime";
import { CodexConversationResumeRuntime } from "../../codex-application/CodexConversationResumeRuntime";
import { CodexFreshThreadLaunchRuntime } from "../../codex-application/CodexFreshThreadLaunchRuntime";
import { CodexManualCompactionRuntime } from "../../codex-application/CodexManualCompactionRuntime";
import { CodexQueuedFollowUps } from "../../codex-application/CodexQueuedFollowUps";
import { CodexRendererOwnerCommands } from "../../codex-application/CodexRendererOwnerCommands";
import { CodexServerRequestResponses } from "../../codex-application/CodexServerRequestResponses";
import { CodexSessionThreadLaunch } from "../../codex-application/CodexSessionThreadLaunch";
import { CodexSidebarSyncRuntime } from "../../codex-application/CodexSidebarSyncRuntime";
import { CodexSideChatCommands } from "../../codex-application/CodexSideChatCommands";
import { CodexStructuredThreadTitle } from "../../codex-application/CodexStructuredThreadTitle";
import { CodexSubagentCatalog } from "../../codex-application/CodexSubagentCatalog";
import { CodexThreadCatalog } from "../../codex-application/CodexThreadCatalog";
import { CodexThreadGoalRuntime } from "../../codex-application/CodexThreadGoalRuntime";
import { CodexThreadReadState } from "../../codex-application/CodexThreadReadState";
import { CodexThreadSettingsRuntime } from "../../codex-application/CodexThreadSettingsRuntime";
import { CodexThreadTitlePersistence } from "../../codex-application/CodexThreadTitlePersistence";
import { CodexTurnCommands } from "../../codex-application/CodexTurnCommands";
import { ConversationCommands } from "../../codex-application/ConversationCommands";
import { ManagedWorktreeCatalog } from "../../codex-application/ManagedWorktreeCatalog";
import { parseCodexApprovalResponse } from "../../../shared/codex-approval-response";
import {
  createCodexProjectlessWorkspace,
  parseCodexProjectlessThreadCwdInput,
} from "../../codex/codex-projectless-workspace";
import type {
  CodexBackgroundProcessRunActionInput,
  CodexApprovalResponse,
  CodexCollaborationModeKind,
  CodexProtocolRequestId,
} from "../../../shared/types";
import type {
  AgentImportApplyInput,
  AgentImportScanInput,
  AgentImportSourceKind,
} from "../../../shared/agent-import";
import type { ThreadBackgroundTerminal } from "@nodex/codex-app-server-protocol/v2/ThreadBackgroundTerminal";
import type { RendererClientWebContents } from "../../codex/renderer-client-runtime-contracts";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { requireTrustedAppRendererSender as requireTrustedAppRendererSenderWithOrigin } from "../../platform/electron/TrustedRendererSender";
import { captureMainException } from "../../observability/sentry-main";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import type { IpcApi } from "../../../shared/ipc-api";
import type {
  CodexBackgroundSubagentThreadsHydrateInput,
  CodexSubagentPanelHydrateInput,
  CodexConversationThreadSettingsPatch,
  CodexSideChatStartInput,
  CodexThreadGoalSetActionInput,
  CodexThreadStartForSessionInput,
  CodexSteerTurnInput,
  CodexTurnStartOptions,
} from "../../../shared/types";
import {
  approximateJsonPayloadBytes,
  getDevRuntimeMetricDurationMs,
  getDevRuntimeMetricStart,
  logDevRuntimeMetric,
} from "../../dev-runtime-metrics";

type TypedIpcHandler<Channel extends keyof IpcApi> = (
  event: IpcMainInvokeEvent,
  ...args: [...IpcApi[Channel]["args"], signal?: AbortSignal]
) => IpcApi[Channel]["result"] | Promise<IpcApi[Channel]["result"]>;

type TypedEffectIpcHandler<Channel extends keyof IpcApi> = (
  event: IpcMainInvokeEvent,
  ...args: IpcApi[Channel]["args"]
) => Effect.Effect<IpcApi[Channel]["result"], CodexIpcError>;

function requireNonBlankStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
  return [...value];
}

async function showDirectoryPicker(
  event: IpcMainInvokeEvent,
  options: OpenDialogOptions,
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

export class CodexIpcError extends Schema.TaggedError<CodexIpcError>()("CodexIpcError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const managedWorktreeCatalog = yield* ManagedWorktreeCatalog;
    const manualCompaction = yield* CodexManualCompactionRuntime;
    const threadGoals = yield* CodexThreadGoalRuntime;
    const threadSettings = yield* CodexThreadSettingsRuntime;
    const threadCatalog = yield* CodexThreadCatalog;
    const threadTitles = yield* CodexThreadTitlePersistence;
    const conversationCommands = yield* ConversationCommands;
    const sidebarSync = yield* CodexSidebarSyncRuntime;
    const threadReadState = yield* CodexThreadReadState;
    const agentImport = yield* AgentImportRuntime;
    const conversationHistory = yield* CodexConversationHistoryRuntime;
    const conversationResume = yield* CodexConversationResumeRuntime;
    const queuedFollowUps = yield* CodexQueuedFollowUps;
    const freshThreadLaunch = yield* CodexFreshThreadLaunchRuntime;
    const structuredThreadTitle = yield* CodexStructuredThreadTitle;
    const backgroundProcesses = yield* CodexBackgroundProcesses;
    const subagentCatalog = yield* CodexSubagentCatalog;
    const serverRequestResponses = yield* CodexServerRequestResponses;
    const turnCommands = yield* CodexTurnCommands;
    const sideChatCommands = yield* CodexSideChatCommands;
    const sessionThreadLaunch = yield* CodexSessionThreadLaunch;
    const rendererOwnerCommands = yield* CodexRendererOwnerCommands;
    const rendererClientRouter = yield* RendererClientRuntime;
    const registrations: Array<Effect.Effect<void, never, Scope.Scope>> = [];
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSenderWithOrigin(event, "Codex application", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Codex application access requires an active Nodex window");
          }
        },
        catch: (cause) => new CodexIpcError({ operation: "authorize-renderer", cause }),
      });
    const registerEffectHandle = <Channel extends keyof IpcApi>(
      channel: Channel,
      listener: TypedEffectIpcHandler<Channel>,
    ): void => {
      registrations.push(
        ipc.handle(channel, (event, ...args: IpcApi[Channel]["args"]) =>
          authorize(event).pipe(
            Effect.andThen(Effect.suspend(() => listener(event, ...args))),
            Effect.tapError((error) =>
              Effect.sync(() =>
                captureMainException(error.cause, {
                  tags: { channel, mechanism: "ipc" },
                  extra: {
                    channel,
                    senderWebContentsId: event.sender.id,
                    argCount: args.length,
                  },
                }),
              ),
            ),
          ),
        ),
      );
    };
    const registerHandle = <Channel extends keyof IpcApi>(
      channel: Channel,
      listener: TypedIpcHandler<Channel>,
    ): void => {
      registerEffectHandle(channel, (event, ...args) =>
        Effect.tryPromise({
          try: (signal) => Promise.resolve(listener(event, ...args, signal)),
          catch: (cause) => new CodexIpcError({ operation: channel, cause }),
        }),
      );
    };
    const requireTrustedAppRendererSender = (
      event: IpcMainInvokeEvent,
      capabilityName: string,
    ): void => {
      requireTrustedAppRendererSenderWithOrigin(event, capabilityName, config.rendererUrl);
    };
    const requireAssignedWindowSessionId = (senderId: number): string => {
      const windowSessionId = windows.resolveSessionId(senderId);
      if (!windowSessionId) {
        throw new Error("The requesting window has no assigned Window Session");
      }
      return windowSessionId;
    };
    const resolveRendererClientId = (event: IpcMainInvokeEvent): string =>
      rendererClientRouter.ensureClient(event.sender as RendererClientWebContents).clientId;
    const interruptWhenRendererIsDestroyed = <A, E, R>(
      event: IpcMainInvokeEvent,
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.raceFirst(
        operation,
        Effect.callback<never>((resume) => {
          if (event.sender.isDestroyed()) {
            resume(Effect.interrupt);
            return;
          }
          const interrupt = (): void => resume(Effect.interrupt);
          event.sender.once("destroyed", interrupt);
          return Effect.sync(() => event.sender.removeListener("destroyed", interrupt));
        }),
      );

    // Codex
    registerEffectHandle("codex:threads:list", (_, projectId, input) =>
      threadCatalog
        .listProject(projectId, input)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "codex:threads:list", cause })),
        ),
    );

    registerEffectHandle("codex:sidebar:snapshot", (_, input) => {
      const startedAt = getDevRuntimeMetricStart();
      return sidebarSync
        .sync({
          includeArchived: input?.includeArchived,
          policy: input?.refresh ? "force" : "read",
          reason: "manual",
        })
        .pipe(
          Effect.map((result) => result.snapshot),
          Effect.tap((snapshot) =>
            Effect.sync(() =>
              logDevRuntimeMetric("ipc.codex_sidebar_snapshot", {
                refresh: input?.refresh === true,
                includeArchived: input?.includeArchived === true,
                itemCount: snapshot.items.length,
                pinnedThreadCount: snapshot.pinnedThreadIds.length,
                projectAssignmentCount: Object.keys(snapshot.projectAssignments).length,
                projectlessThreadCount: snapshot.projectlessThreadIds.length,
                approxPayloadBytes: approximateJsonPayloadBytes(snapshot),
                durationMs: getDevRuntimeMetricDurationMs(startedAt),
              }),
            ),
          ),
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:sidebar:snapshot", cause }),
          ),
        );
    });

    registerEffectHandle("codex:sidebar:sync", (_, input) => {
      const startedAt = getDevRuntimeMetricStart();
      return sidebarSync.sync(input).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const approxPayloadBytes = approximateJsonPayloadBytes(result);
            logDevRuntimeMetric("ipc.codex_sidebar_sync", {
              policy: input?.policy ?? "stale",
              reason: input?.reason ?? "manual",
              includeArchived: input?.includeArchived === true,
              source: result.source,
              refreshed: result.refreshed,
              itemCount: result.snapshot.items.length,
              changedProjectCount: result.changedProjectIds.length,
              projectlessChanged: result.projectlessChanged,
              materializedSessionCount: result.materializedSessionIds.length,
              failedThreadCount: result.failedThreadIds.length,
              approxPayloadBytes,
              durationMs: getDevRuntimeMetricDurationMs(startedAt),
            });
            logDevRuntimeMetric("ipc.codex_sidebar_sync.request", {
              policy: input?.policy ?? "stale",
              reason: input?.reason ?? "manual",
              includeArchived: input?.includeArchived === true,
              approxPayloadBytes,
            });
          }),
        ),
        Effect.mapError((cause) => new CodexIpcError({ operation: "codex:sidebar:sync", cause })),
      );
    });

    registerEffectHandle("codex:sidebar:thread:move", (_, input) =>
      threadCatalog
        .move(input)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:sidebar:thread:move", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:threads:pinned:list", () =>
      threadCatalog.listPinned.pipe(
        Effect.map((threadIds) => [...threadIds]),
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "codex:threads:pinned:list", cause }),
        ),
      ),
    );

    registerEffectHandle("codex:threads:pinned:set", (_, threadId: string, input) =>
      threadCatalog
        .setPinned(threadId, input.pinned)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:threads:pinned:set", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:threads:pinned:reorder", (_, orderedThreadIds) =>
      Effect.try({
        try: () => requireNonBlankStringArray(orderedThreadIds, "Pinned thread order"),
        catch: (cause) => new CodexIpcError({ operation: "codex:threads:pinned:reorder", cause }),
      }).pipe(
        Effect.flatMap(threadCatalog.reorderPinned),
        Effect.mapError((cause) =>
          cause instanceof CodexIpcError
            ? cause
            : new CodexIpcError({ operation: "codex:threads:pinned:reorder", cause }),
        ),
      ),
    );

    registerEffectHandle("codex:thread:ensure-session", (_, threadId: string) =>
      threadCatalog
        .ensureSession(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:ensure-session", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:threads:palette:list", (_, input) =>
      threadCatalog.listPalette(input).pipe(
        Effect.map((threads) => [...threads]),
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "codex:threads:palette:list", cause }),
        ),
      ),
    );

    registerEffectHandle("codex:threads:palette:search", (_, input) =>
      threadCatalog.searchPalette(input).pipe(
        Effect.map((results) => [...results]),
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "codex:threads:palette:search", cause }),
        ),
      ),
    );

    registerEffectHandle("codex:thread:summary:get", (_, threadId: string) =>
      threadCatalog
        .resolve(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:summary:get", cause }),
          ),
        ),
    );

    const parseAgentImportSourceKind = (value: unknown): AgentImportSourceKind => {
      if (value === "claude-code" || value === "codex" || value === "open-interpreter") {
        return value;
      }
      throw new Error("Invalid agent import source");
    };
    registerEffectHandle("agent-import:scan", (_, input: AgentImportScanInput) =>
      Effect.try({
        try: () => parseAgentImportSourceKind(input?.sourceKind),
        catch: (cause) => new CodexIpcError({ operation: "agent-import:scan", cause }),
      }).pipe(
        Effect.flatMap(agentImport.scan),
        Effect.mapError((cause) =>
          cause instanceof CodexIpcError
            ? cause
            : new CodexIpcError({ operation: "agent-import:scan", cause }),
        ),
      ),
    );
    registerEffectHandle("agent-import:scan-picked-home", (event, input: AgentImportScanInput) =>
      Effect.try({
        try: () => {
          const sourceKind = parseAgentImportSourceKind(input?.sourceKind);
          if (sourceKind === "claude-code") {
            throw new Error("Claude Code imports use its standard home directory");
          }
          return sourceKind;
        },
        catch: (cause) => new CodexIpcError({ operation: "agent-import:scan-picked-home", cause }),
      }).pipe(
        Effect.flatMap((sourceKind) =>
          Effect.tryPromise({
            try: () =>
              showDirectoryPicker(event, {
                buttonLabel: "Scan",
                message: "The selected directory is read-only during import.",
                properties: ["openDirectory"],
                title: `Select ${sourceKind === "codex" ? "Codex" : "Open Interpreter"} home`,
              }),
            catch: (cause) =>
              new CodexIpcError({ operation: "agent-import:scan-picked-home", cause }),
          }).pipe(
            Effect.flatMap((sourceHome) =>
              sourceHome ? agentImport.scan(sourceKind, sourceHome) : Effect.succeed(null),
            ),
          ),
        ),
        Effect.mapError((cause) =>
          cause instanceof CodexIpcError
            ? cause
            : new CodexIpcError({ operation: "agent-import:scan-picked-home", cause }),
        ),
      ),
    );
    registerEffectHandle("agent-import:apply", (_, input: AgentImportApplyInput) =>
      Effect.try({
        try: () => {
          if (
            typeof input !== "object" ||
            input === null ||
            typeof input.scanId !== "string" ||
            !Array.isArray(input.itemIds) ||
            !input.itemIds.every((itemId) => typeof itemId === "string")
          ) {
            throw new Error("Invalid agent import selection");
          }
          return { itemIds: input.itemIds, scanId: input.scanId };
        },
        catch: (cause) => new CodexIpcError({ operation: "agent-import:apply", cause }),
      }).pipe(
        Effect.flatMap(agentImport.apply),
        Effect.mapError((cause) =>
          cause instanceof CodexIpcError
            ? cause
            : new CodexIpcError({ operation: "agent-import:apply", cause }),
        ),
      ),
    );

    registerHandle("codex:projectless-thread-cwd", (_, rawInput) => {
      const input = parseCodexProjectlessThreadCwdInput(rawInput);
      return createCodexProjectlessWorkspace({
        prompt: input.prompt,
        directoryName: input.directoryName,
        createSplitDirectories: input.createSplitDirectories !== false,
      });
    });

    registerEffectHandle(
      "codex:thread:start-for-session",
      (event, input: CodexThreadStartForSessionInput) =>
        interruptWhenRendererIsDestroyed(
          event,
          sessionThreadLaunch
            .start(input, {
              browserViewScopeId:
                windows.resolveSessionId(event.sender.id) ?? `headless:${input.sessionId}`,
              ownerClientId: resolveRendererClientId(event),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new CodexIpcError({ operation: "codex:thread:start-for-session", cause }),
              ),
            ),
        ),
    );

    registerEffectHandle("codex:thread:side-chat:start", (_, input: CodexSideChatStartInput) =>
      sideChatCommands
        .start(input)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "side-chat:start", cause })),
        ),
    );

    registerEffectHandle("codex:thread:side-chat:discard", (_, threadId: string) =>
      sideChatCommands
        .discard(threadId)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "side-chat:discard", cause })),
        ),
    );

    registerEffectHandle("worktrees:list", (_, hostId: string) =>
      managedWorktreeCatalog.list(hostId).pipe(
        Effect.map((records) => [...records]),
        Effect.mapError((cause) => new CodexIpcError({ operation: "worktrees:list", cause })),
      ),
    );
    registerEffectHandle("worktrees:settings:get", () =>
      managedWorktreeCatalog.settings.pipe(
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "worktrees:settings:get", cause }),
        ),
      ),
    );
    registerEffectHandle("worktrees:settings:update", (_, input) =>
      managedWorktreeCatalog
        .updateSettings(input)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "worktrees:settings:update", cause }),
          ),
        ),
    );
    registerEffectHandle("worktrees:thread:availability", (_, threadId: string) =>
      managedWorktreeCatalog
        .inspectThread(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "worktrees:thread:availability", cause }),
          ),
        ),
    );
    registerEffectHandle("worktrees:thread:restore", (_, threadId: string) =>
      managedWorktreeCatalog
        .restoreThread(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "worktrees:thread:restore", cause }),
          ),
        ),
    );

    registerEffectHandle("worktrees:delete", (_, hostId: string, worktreePath: string) =>
      managedWorktreeCatalog
        .delete(hostId, worktreePath)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "worktrees:delete", cause })),
        ),
    );

    registerEffectHandle("codex:thread:snapshot:request", (_, threadId: string) =>
      conversationResume
        .snapshot(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:snapshot:request", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread:resume:request", (event, threadId: string) =>
      Effect.try({
        try: () => {
          const ownerClientId = resolveRendererClientId(event);
          if (!ownerClientId) throw new Error("Renderer client is not registered");
          return ownerClientId;
        },
        catch: (cause) => new CodexIpcError({ operation: "codex:thread:resume:request", cause }),
      }).pipe(
        Effect.flatMap((ownerClientId) =>
          conversationResume.resumeForRenderer(threadId, ownerClientId),
        ),
        Effect.mapError((cause) =>
          cause instanceof CodexIpcError
            ? cause
            : new CodexIpcError({ operation: "codex:thread:resume:request", cause }),
        ),
      ),
    );

    registerEffectHandle(
      "codex:thread:fresh-owner:adopt",
      (event, threadId: string, launchId: string) =>
        Effect.try({
          try: () => resolveRendererClientId(event),
          catch: (cause) =>
            new CodexIpcError({ operation: "codex:thread:fresh-owner:adopt", cause }),
        }).pipe(
          Effect.flatMap((ownerClientId) =>
            freshThreadLaunch.adopt({ threadId, launchId, ownerClientId }),
          ),
          Effect.mapError((cause) =>
            cause instanceof CodexIpcError
              ? cause
              : new CodexIpcError({ operation: "codex:thread:fresh-owner:adopt", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread-owner:app-server-request", (event, input) =>
      Effect.try({
        try: () => resolveRendererClientId(event),
        catch: (cause) =>
          new CodexIpcError({ operation: "codex:thread-owner:app-server-request", cause }),
      }).pipe(
        Effect.flatMap((ownerClientId) => rendererOwnerCommands.execute(ownerClientId, input)),
        Effect.mapError((cause) =>
          cause instanceof CodexIpcError
            ? cause
            : new CodexIpcError({
                operation: "codex:thread-owner:app-server-request",
                cause,
              }),
        ),
      ),
    );

    registerEffectHandle(
      "codex:thread:background-subagents:hydrate",
      (_, input: CodexBackgroundSubagentThreadsHydrateInput) =>
        subagentCatalog.hydrateBackground(input).pipe(
          Effect.map((summaries) => [...summaries]),
          Effect.mapError(
            (cause) =>
              new CodexIpcError({
                operation: "codex:thread:background-subagents:hydrate",
                cause,
              }),
          ),
        ),
    );

    registerEffectHandle(
      "codex:thread:subagents-panel:hydrate",
      (_, input: CodexSubagentPanelHydrateInput) =>
        subagentCatalog.hydratePanel(input).pipe(
          Effect.map((summaries) => [...summaries]),
          Effect.mapError(
            (cause) =>
              new CodexIpcError({
                operation: "codex:thread:subagents-panel:hydrate",
                cause,
              }),
          ),
        ),
    );

    registerEffectHandle("codex:subagent-thread:opened", (_, threadId: string) =>
      subagentCatalog.open(threadId),
    );

    registerEffectHandle("codex:thread:resume-buffer:release", (_, threadId: string) =>
      conversationResume
        .releaseBuffer(threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CodexIpcError({ operation: "codex:thread:resume-buffer:release", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread:turns:load-older", (_, threadId) =>
      conversationHistory
        .loadPage(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:turns:load-older", cause }),
          ),
        ),
    );
    registerEffectHandle("codex:thread:turns:load-complete", (_, threadId) =>
      conversationHistory
        .loadComplete(threadId, false)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:turns:load-complete", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread:name:set", (_, threadId: string, name: string) =>
      threadTitles
        .set({ threadId, name, normalization: "manual" })
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:name:set", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread:name:set-generated", (_, threadId: string, name: string) =>
      threadTitles
        .set({ threadId, name, normalization: "trim" })
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:name:set-generated", cause }),
          ),
        ),
    );

    registerEffectHandle(
      "codex:thread:title:generate",
      (_, input: { hostId: string; prompt: string; cwd: string | null }) => {
        void input.hostId;
        return structuredThreadTitle.generate(input).pipe(
          Effect.map((title) => ({ title })),
          Effect.catch((error) =>
            Effect.logWarning("Could not generate Thread title").pipe(
              Effect.annotateLogs({ error: String(error.cause) }),
              Effect.as({ title: null }),
            ),
          ),
        );
      },
    );

    registerEffectHandle("codex:thread:archive", (_, threadId: string) =>
      conversationCommands
        .archive(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:archive", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread:unarchive", (_, threadId: string) =>
      conversationCommands
        .unarchive(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:unarchive", cause }),
          ),
        ),
    );

    registerEffectHandle(
      "codex:thread:collaboration-mode:set",
      (_, threadId: string, collaborationMode: CodexCollaborationModeKind) =>
        threadSettings.update({ threadId, patch: { collaborationMode } }).pipe(
          Effect.mapError(
            (cause) =>
              new CodexIpcError({
                operation: "codex:thread:collaboration-mode:set",
                cause,
              }),
          ),
          Effect.flatMap((settings) =>
            settings.collaborationMode
              ? Effect.succeed(settings.collaborationMode)
              : Effect.fail(
                  new CodexIpcError({
                    operation: "codex:thread:collaboration-mode:set",
                    cause: new Error("Thread settings projection omitted collaboration mode"),
                  }),
                ),
          ),
        ),
    );

    registerEffectHandle(
      "codex:thread:settings:update",
      (_, threadId: string, patch: CodexConversationThreadSettingsPatch) =>
        threadSettings
          .update({ threadId, patch })
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:thread:settings:update", cause }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:thread:plan-implementation:remove",
      (_, threadId: string, turnId: string) =>
        serverRequestResponses.planImplementation(threadId, turnId).pipe(
          Effect.mapError(
            (cause) =>
              new CodexIpcError({
                operation: "codex:thread:plan-implementation:remove",
                cause,
              }),
          ),
        ),
    );

    registerEffectHandle(
      "codex:turn:start",
      (_, threadId: string, prompt: string, opts?: CodexTurnStartOptions) =>
        turnCommands
          .start(threadId, prompt, opts)
          .pipe(
            Effect.mapError((cause) => new CodexIpcError({ operation: "codex:turn:start", cause })),
          ),
    );

    registerEffectHandle(
      "codex:thread:follow-up:enqueue",
      (_, threadId: string, prompt: string, opts?: CodexTurnStartOptions) =>
        queuedFollowUps
          .enqueue({
            threadId,
            prompt,
            collaborationMode: opts?.collaborationMode,
            serviceTier: opts?.serviceTier,
            promptInput: opts?.promptInput,
            summary: opts?.summary,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:thread:follow-up:enqueue", cause }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:thread:follow-up:remove",
      (_, threadId: string, followUpId: string) =>
        queuedFollowUps.remove(threadId, followUpId).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:follow-up:remove", cause }),
          ),
        ),
    );

    registerEffectHandle(
      "codex:thread:follow-up:reorder",
      (_, threadId: string, orderedFollowUpIds: string[]) =>
        queuedFollowUps
          .reorder(threadId, orderedFollowUpIds)
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:thread:follow-up:reorder", cause }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:thread:follow-up:send-now",
      (_, threadId: string, followUpId: string) =>
        queuedFollowUps
          .sendNow(threadId, followUpId)
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:thread:follow-up:send-now", cause }),
            ),
          ),
    );

    registerEffectHandle("codex:thread:compact:start", (_, threadId: string) =>
      manualCompaction
        .start(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:compact:start", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread:goal:get", (_, threadId: string) =>
      threadGoals
        .get(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:goal:get", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread:goal:set", (_, params: CodexThreadGoalSetActionInput) =>
      threadGoals
        .set(params)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:goal:set", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:thread:goal:clear", (_, threadId: string) =>
      threadGoals
        .clear(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:goal:clear", cause }),
          ),
        ),
    );

    registerEffectHandle("codex:turn:steer", (_, input: CodexSteerTurnInput) =>
      turnCommands
        .steer(input)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "codex:turn:steer", cause })),
        ),
    );

    registerEffectHandle("codex:thread:follow-up:resume", (_, threadId: string) =>
      queuedFollowUps
        .resumeInterrupted(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:follow-up:resume", cause }),
          ),
        ),
    );

    registerEffectHandle(
      "codex:thread:follow-up:replace",
      (
        _,
        threadId: string,
        followUpId: string,
        expectedLedgerRevision: number,
        prompt: string,
        opts?: CodexTurnStartOptions,
      ) =>
        queuedFollowUps
          .replace(threadId, followUpId, expectedLedgerRevision, {
            prompt,
            collaborationMode: opts?.collaborationMode,
            serviceTier: opts?.serviceTier,
            promptInput: opts?.promptInput,
            summary: opts?.summary,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CodexIpcError({
                  operation: "codex:thread:follow-up:replace",
                  cause,
                }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:thread:follow-up:resolve-after-fresh-start",
      (_, threadId: string, expectedLedgerRevision: number, resolution: "resume" | "clear") =>
        queuedFollowUps.resolveAfterFreshStart(threadId, expectedLedgerRevision, resolution).pipe(
          Effect.mapError(
            (cause) =>
              new CodexIpcError({
                operation: "codex:thread:follow-up:resolve-after-fresh-start",
                cause,
              }),
          ),
        ),
    );

    registerEffectHandle(
      "codex:thread:background-processes:list",
      (
        _,
        input: {
          threadId: string;
          observedTerminals?: ThreadBackgroundTerminal[];
        },
      ) =>
        backgroundProcesses.list(input).pipe(
          Effect.mapError(
            (cause) =>
              new CodexIpcError({
                operation: "codex:thread:background-processes:list",
                cause,
              }),
          ),
        ),
    );

    registerEffectHandle(
      "codex:thread:background-processes:run-action",
      (event, input: CodexBackgroundProcessRunActionInput) =>
        Effect.try({
          try: () => ({
            action: input,
            owner: {
              webContentsId: event.sender.id,
              windowSessionId: requireAssignedWindowSessionId(event.sender.id),
            },
          }),
          catch: (cause) =>
            new CodexIpcError({
              operation: "codex:thread:background-processes:run-action",
              cause,
            }),
        }).pipe(
          Effect.flatMap(backgroundProcesses.runAction),
          Effect.mapError(
            (cause) =>
              new CodexIpcError({
                operation: "codex:thread:background-processes:run-action",
                cause,
              }),
          ),
        ),
    );

    registerHandle("mcp-app:open-external", async (event, value) => {
      requireTrustedAppRendererSender(event, "MCP external navigation");
      if (value.length > 8_192) throw new Error("MCP external URL is too long");
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("MCP external navigation requires a credential-free HTTPS URL");
      }
      await shell.openExternal(url.toString());
    });

    registerEffectHandle(
      "codex:approval:respond",
      (
        _,
        conversationId: string,
        requestId: CodexProtocolRequestId,
        response: CodexApprovalResponse,
      ) =>
        Effect.suspend(() => {
          const parsedResponse = parseCodexApprovalResponse(response);
          if (!parsedResponse) {
            return Effect.fail(
              new CodexIpcError({
                operation: "codex:approval:respond",
                cause: new Error("Invalid Codex approval response for approval kind."),
              }),
            );
          }
          return serverRequestResponses
            .approval({ threadId: conversationId, requestId, response: parsedResponse })
            .pipe(
              Effect.mapError(
                (cause) => new CodexIpcError({ operation: "codex:approval:respond", cause }),
              ),
            );
        }),
    );

    registerEffectHandle(
      "codex:user-input:respond",
      (_, conversationId: string, requestId: CodexProtocolRequestId, answers) =>
        serverRequestResponses
          .userInput({ threadId: conversationId, requestId, answers })
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:user-input:respond", cause }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:mcp-elicitation:respond",
      (_, conversationId: string, requestId: CodexProtocolRequestId, response) =>
        serverRequestResponses
          .mcpElicitation({ threadId: conversationId, requestId, response })
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:mcp-elicitation:respond", cause }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:permission-request:respond",
      (_, conversationId: string, requestId: CodexProtocolRequestId, response) =>
        serverRequestResponses
          .permission({ threadId: conversationId, requestId, response })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CodexIpcError({ operation: "codex:permission-request:respond", cause }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:option-picker:respond",
      (_, conversationId: string, requestId: CodexProtocolRequestId, response) =>
        serverRequestResponses
          .optionPicker({ threadId: conversationId, requestId, response })
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:option-picker:respond", cause }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:setup-context-picker:respond",
      (_, conversationId: string, requestId: CodexProtocolRequestId, response) =>
        serverRequestResponses
          .setupContextPicker({ threadId: conversationId, requestId, response })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CodexIpcError({ operation: "codex:setup-context-picker:respond", cause }),
            ),
          ),
    );

    registerEffectHandle(
      "codex:setup-codex-step:respond",
      (_, conversationId: string, requestId: CodexProtocolRequestId, response) =>
        serverRequestResponses
          .setupCodexStep({ threadId: conversationId, requestId, response })
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:setup-codex-step:respond", cause }),
            ),
          ),
    );

    registerEffectHandle("codex:conversation-unread:set", (_, conversationId, hasUnreadTurn) =>
      threadReadState
        .set({ threadId: conversationId, hasUnreadTurn })
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:conversation-unread:set", cause }),
          ),
        ),
    );

    yield* Effect.all(registrations, { discard: true });
  }),
);
