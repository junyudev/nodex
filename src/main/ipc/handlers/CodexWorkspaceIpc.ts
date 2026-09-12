import { CodexRendererSessionLaunch } from "../../codex-application/CodexRendererSessionLaunch";
import { CodexConversationFork } from "../../codex-application/CodexConversationFork";
import { encodeCodexNativeRequestFailure } from "../../../shared/codex-native-request-outcome";
import { codexNativeIpcMethod, type CodexNativeIpcChannel } from "../../../shared/codex-native-ipc";
import {
  CodexRendererResponseMetrics,
  type CodexRendererResponseMetricsState,
} from "../../codex-runtime/CodexHostRequestMetrics";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import {
  codexNativeResponseMessage,
  codexNativeResponseIsCritical,
  codexNativePredispatchOutcome,
  codexNativeRequestDetachesOnTimeout,
  codexNativeResponseDropsOrphan,
  codexNativeResponseRoute,
  codexNativeUntracedResponseMessage,
} from "../../host-runtime/CodexNativeResponse";
import type { RendererClientWebContents } from "../../codex/renderer-client-runtime-contracts";
import { materializeCodexJson } from "@nodex/effect-codex-app-server/transport-values";
import { CodexApplicationEventHub } from "../../codex-application/CodexApplicationEventHub";
import { CodexNodeReplRuntime } from "../../codex-application/CodexNodeReplRuntime";
import { CodexThreadDirectory } from "../../codex-application/CodexThreadDirectory";
import { CodexConversationPeerRuntime } from "../../platform/node/CodexConversationPeerRuntime";
import { CodexMainConversationManagers } from "../../codex-application/CodexMainConversationManagers";
import { CodexAppServerCapabilities } from "../../codex-runtime/CodexAppServerCapabilities";
import { CodexApplicationRequestInbox } from "../../codex-runtime/CodexApplicationRequestInbox";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import {
  CLIENT_REQUEST_PARAMS,
  SERVER_REQUEST_RESPONSES,
} from "@nodex/effect-codex-app-server/rpc";
import { CodexGateway } from "../../codex-runtime/CodexGateway";
import { codexRequestCanRetainOutcome } from "../../../shared/codex-renderer-request";
import * as Fiber from "effect/Fiber";
import { makeCodexRendererRequestLifetimes } from "../../codex-runtime/CodexRendererRequestLifetimes";
import {
  CodexRendererRequestOrigin,
  CodexRendererDeliverySink,
  CodexRendererDispatchState,
} from "../../codex-runtime/CodexRendererRequestOrigin";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
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
import { CodexPersistedHistorySearchRuntime } from "../../codex-application/CodexPersistedHistorySearchRuntime";
import { CodexConversationHistoryExport } from "../../codex-application/CodexConversationHistoryExport";
import { CodexConversationResumeRuntime } from "../../codex-application/CodexConversationResumeRuntime";
import { CodexFreshThreadLaunchRuntime } from "../../codex-application/CodexFreshThreadLaunchRuntime";
import { CodexManualCompactionRuntime } from "../../codex-application/CodexManualCompactionRuntime";
import { CodexQueuedFollowUps } from "../../codex-application/CodexQueuedFollowUps";
import { CodexServerRequestResponses } from "../../codex-application/CodexServerRequestResponses";
import { CodexSessionThreadLaunch } from "../../codex-application/CodexSessionThreadLaunch";
import { CodexSidebarSyncRuntime } from "../../codex-application/CodexSidebarSyncRuntime";
import { CodexSideChatCommands } from "../../codex-application/CodexSideChatCommands";
import { CodexStructuredThreadTitle } from "../../codex-application/CodexStructuredThreadTitle";
import { CodexSubagentDirectory } from "../../codex-application/CodexSubagentDirectory";
import { CodexThreadCatalog } from "../../codex-application/CodexThreadCatalog";
import { CodexThreadGoalRuntime } from "../../codex-application/CodexThreadGoalRuntime";
import { CodexThreadReadState } from "../../codex-application/CodexThreadReadState";
import { CodexThreadSettingsRuntime } from "../../codex-application/CodexThreadSettingsRuntime";
import { CodexThreadTitlePersistence } from "../../codex-application/CodexThreadTitlePersistence";
import { CodexTurnCommands } from "../../codex-application/CodexTurnCommands";
import { CodexTurnPresentation } from "../../codex-application/CodexTurnPresentation";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { CodexTurnPresentationTicket } from "../../../shared/nodex-app-tools/turn-presentation";
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
import { requireTrustedAppRendererSender as requireTrustedAppRendererSenderWithOrigin } from "../../platform/electron/TrustedRendererSender";
import { captureMainException } from "../../observability/sentry-main";
import { runMainTraceSpan } from "../../observability/sentry-main";
import { codexRequestTraceCoordinator } from "../../codex-runtime/CodexRequestTraceCoordinator";
import { codexAppServerResponseErrorTraceAttributes } from "../../codex-runtime/CodexAppServerTraceAttributes";
import { codexRequestConversationId } from "../../../shared/codex-request-lifecycle";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import type { IpcApi } from "../../../shared/ipc-api";
import type {
  IpcControlChannel,
  IpcQueryChannel,
  PlainResultCommandChannel,
} from "../../../shared/ipc-endpoint-policy";
import type {
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

const RENDERER_NATIVE_THREAD_QUEUE_METHODS = new Set([
  "thread/queue/list",
  "thread/queue/add",
  "thread/queue/update",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/queue/start",
]);

const RENDERER_NATIVE_REQUEST_METHODS = new Set([
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
  "model/list",
  "collaborationMode/list",
  "plugin/installed",
  "thread/settings/update",
  "turn/settings/update",
  "turn/interrupt",
  "thread/backgroundTerminals/clean",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "thread/compact/start",
  "thread/memoryMode/set",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "thread/revert",
  "thread/rollback",
  "config/read",
  "thread/unsubscribe",
  ...RENDERER_NATIVE_THREAD_QUEUE_METHODS,
]);

export function codexRendererNativeRequestAdmission(
  method: string,
  capabilities: { readonly threadQueue: boolean },
): "allowed" | "requires-thread-queue" | "requires-application-capability" {
  if (!RENDERER_NATIVE_REQUEST_METHODS.has(method)) return "requires-application-capability";
  if (RENDERER_NATIVE_THREAD_QUEUE_METHODS.has(method) && !capabilities.threadQueue)
    return "requires-thread-queue";
  return "allowed";
}

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

function nativeOutcomeThreadId(
  input: IpcApi[CodexNativeIpcChannel]["args"][0],
  outcome: import("../../../shared/codex-native-request-outcome").CodexNativeRequestOutcome<unknown>,
): string | null {
  if (outcome.type === "result") {
    const resultId = codexRequestConversationId(outcome.result);
    if (resultId) return resultId;
    if (outcome.result && typeof outcome.result === "object" && "id" in outcome.result) {
      const id = Reflect.get(outcome.result, "id");
      if (typeof id === "string") return id;
    }
  }
  if ("threadId" in input && typeof input.threadId === "string") return input.threadId;
  if (!("request" in input)) return null;
  const request = input.request;
  if (request && typeof request === "object" && "method" in request && "params" in request)
    return codexRequestConversationId(Reflect.get(request, "params"));
  return codexRequestConversationId(request);
}

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
    const persistedHistorySearch = yield* CodexPersistedHistorySearchRuntime;
    const conversationHistoryExport = yield* CodexConversationHistoryExport;
    const conversationResume = yield* CodexConversationResumeRuntime;
    const nativeFork = yield* CodexConversationFork;
    const queuedFollowUps = yield* CodexQueuedFollowUps;
    const freshThreadLaunch = yield* CodexFreshThreadLaunchRuntime;
    const structuredThreadTitle = yield* CodexStructuredThreadTitle;
    const backgroundProcesses = yield* CodexBackgroundProcesses;
    const subagentDirectory = yield* CodexSubagentDirectory;
    const serverRequestResponses = yield* CodexServerRequestResponses;
    const requestInbox = yield* CodexApplicationRequestInbox;
    const turnCommands = yield* CodexTurnCommands;
    const threadDirectory = yield* CodexThreadDirectory;
    const nativeCapabilities = yield* CodexAppServerCapabilities;
    const nativeManagers = yield* CodexMainConversationManagers;
    const nodeRepl = yield* CodexNodeReplRuntime;
    const applicationEvents = yield* CodexApplicationEventHub;
    const conversationPeers = yield* CodexConversationPeerRuntime;
    const turnPresentation = yield* CodexTurnPresentation;
    const sideChatCommands = yield* CodexSideChatCommands;
    const sessionThreadLaunch = yield* CodexSessionThreadLaunch;
    const rendererSessionLaunch = yield* CodexRendererSessionLaunch;
    const gateway = yield* CodexGateway;
    const requestLifetimes = yield* makeCodexRendererRequestLifetimes;
    const callbacks = yield* ScopedCallbackRuntime;
    const rendererClients = yield* RendererClientRuntime;
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
    const mappedIpc = mapElectronIpcHandlers(
      ipc,
      (channel, listener) =>
        (event, ...args) =>
          authorize(event).pipe(
            // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- the IPC decorator immediately translates each handler's erased failure into the adapter error.
            Effect.andThen(Effect.suspend(() => listener(event, ...args))),
            Effect.mapError((cause) =>
              cause instanceof CodexIpcError
                ? cause
                : new CodexIpcError({ operation: channel, cause }),
            ),
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
    );
    const registerEffectQuery = <Channel extends IpcQueryChannel>(
      channel: Channel,
      listener: TypedEffectIpcHandler<Channel>,
    ): void => void registrations.push(mappedIpc.handleQuery(channel, listener));
    const registerEffectControl = <Channel extends IpcControlChannel>(
      channel: Channel,
      listener: TypedEffectIpcHandler<Channel>,
    ): void => void registrations.push(mappedIpc.handleControl(channel, listener));
    const registerNativeControl = <Channel extends CodexNativeIpcChannel>(
      channel: Channel,
      listener: TypedEffectIpcHandler<Channel>,
    ): void => {
      registrations.push(
        mappedIpc.handleControl(
          channel,
          (event, ...args) =>
            Effect.suspend(() => {
              const input = args[0];
              if (typeof input.hostId !== "string" || !input.hostId.trim())
                return Effect.fail(
                  new CodexIpcError({
                    operation: channel,
                    cause: new Error("Native request host is required"),
                  }),
                );
              const response: CodexRendererResponseMetricsState = { hostId: input.hostId };
              const method = codexNativeIpcMethod(channel, input);
              const dispatchState = {
                dispatched: false,
                detachOnTimeout: codexNativeRequestDetachesOnTimeout(method),
                onDetachedPhysicalResponse: (
                  response: import("../../codex-runtime/CodexRendererRequestOrigin").CodexDetachedPhysicalResponse,
                ) =>
                  Effect.sync(() => {
                    const outcome =
                      response.type === "result"
                        ? ({ type: "result", result: response.result } as const)
                        : ({
                            type: "error",
                            error: encodeCodexNativeRequestFailure(response.error),
                          } as const);
                    codexRequestTraceCoordinator.settleRequest(
                      nativeOutcomeThreadId(input, outcome),
                      null,
                      input.caller.requestId,
                      outcome.type === "result",
                    );
                    if (codexNativeResponseDropsOrphan(input.caller.requestId)) return;
                    rendererClients.broadcast(
                      "codex:host-message",
                      codexNativeUntracedResponseMessage(input, outcome),
                    );
                  }),
              };
              return listener(event, ...args).pipe(
                Effect.provideService(CodexRendererResponseMetrics, response),
                Effect.provideService(CodexRendererDispatchState, dispatchState),
                Effect.provideService(CodexRendererDeliverySink, (message) =>
                  Effect.sync(() => {
                    if (event.sender.isDestroyed()) return;
                    const client = rendererClients.ensureClient(
                      event.sender as RendererClientWebContents,
                    );
                    rendererClients.sendCriticalToClient(
                      client.clientId,
                      "codex:host-message",
                      message,
                    );
                  }),
                ),
                Effect.map((outcome) => ({
                  ...codexNativePredispatchOutcome(
                    channel,
                    input,
                    outcome,
                    dispatchState.dispatched,
                  ),
                  abandonmentReason: response.abandonmentReason,
                  hostId: response.hostId,
                  hostMetrics: response.hostMetrics,
                  receivedAtMs: response.responseReceivedAtMs,
                  requestMethod: response.requestMethod,
                  trace: response.wireTrace,
                })),
              );
            }),
          {
            deliver: (event, args, outcome) =>
              Effect.sync(() => {
                const senderDestroyed = event.sender.isDestroyed();
                const client = senderDestroyed
                  ? null
                  : rendererClients.ensureClient(event.sender as RendererClientWebContents);
                const input = args[0];
                const method = outcome.requestMethod ?? codexNativeIpcMethod(channel, input);
                const route = codexNativeResponseRoute({
                  requestId: input.caller.requestId,
                  abandonmentReason: outcome.abandonmentReason,
                  senderDestroyed,
                });
                const abandoned = route === "drop" || route === "broadcast-orphan";
                if (!abandoned) {
                  codexRequestTraceCoordinator.settleRequest(
                    nativeOutcomeThreadId(input, outcome),
                    event.sender.id,
                    input.caller.requestId,
                    outcome.type === "result",
                  );
                }
                if (route === "drop") return;
                if (route === "broadcast-orphan") {
                  rendererClients.broadcast(
                    "codex:host-message",
                    codexNativeUntracedResponseMessage(input, outcome),
                  );
                  return;
                }
                const broadcastFallback = route === "broadcast-fallback";
                const makeMessage = (
                  trace:
                    | import("../../../shared/codex-request-lifecycle").CodexRequestTraceContext
                    | null,
                ) =>
                  codexNativeResponseMessage(input, outcome, {
                    ...(outcome.receivedAtMs === undefined ? {} : { receivedAtMs: Date.now() }),
                    requestMethod: method,
                    ...(trace ? { trace } : {}),
                  });
                const deliverMessage = (message: ReturnType<typeof codexNativeResponseMessage>) => {
                  if (broadcastFallback) {
                    if (message.type === "mcp-response") {
                      const {
                        receivedAtMs: _receivedAtMs,
                        requestMethod: _requestMethod,
                        trace: _trace,
                        ...bareMessage
                      } = message;
                      rendererClients.broadcast("codex:host-message", bareMessage);
                    } else {
                      rendererClients.broadcast("codex:host-message", message);
                    }
                    return;
                  }
                  if (
                    message.type === "mcp-request-delivery" ||
                    codexNativeResponseIsCritical(channel, input)
                  ) {
                    if (!client) return;
                    rendererClients.sendCriticalToClient(
                      client.clientId,
                      "codex:host-message",
                      message,
                    );
                  } else {
                    if (!client) return;
                    rendererClients.sendToClient(client.clientId, "codex:host-message", message);
                  }
                };
                if (outcome.trace && outcome.receivedAtMs !== undefined) {
                  runMainTraceSpan(
                    {
                      name: "electron.response_route",
                      op: "codex.app_server.response_route",
                      trace: outcome.trace,
                      startTimeMs: outcome.receivedAtMs,
                      attributes: {
                        "app_server.method": method,
                        "app_server.response_error": outcome.type === "error",
                        "electron.broadcast_fallback": broadcastFallback,
                        ...(outcome.type === "error"
                          ? {
                              "codex.outcome": "failure",
                              "error.category": "app_server",
                              "error.type": "operation_failed",
                              ...codexAppServerResponseErrorTraceAttributes(outcome.error),
                            }
                          : {}),
                      },
                    },
                    (activeTrace) =>
                      deliverMessage(makeMessage(activeTrace ?? outcome.trace ?? null)),
                  );
                  return;
                }
                const message = codexNativeResponseMessage(input, outcome);
                if (
                  message.type === "mcp-request-delivery" ||
                  codexNativeResponseIsCritical(channel, input)
                ) {
                  if (!client) return;
                  rendererClients.sendCriticalToClient(
                    client.clientId,
                    "codex:host-message",
                    message,
                  );
                } else {
                  if (!client) return;
                  rendererClients.sendToClient(client.clientId, "codex:host-message", message);
                }
              }),
          },
        ),
      );
    };
    const registerEffectPlainCommand = <Channel extends PlainResultCommandChannel>(
      channel: Channel,
      listener: TypedEffectIpcHandler<Channel>,
    ): void => void registrations.push(mappedIpc.handlePlainCommand(channel, listener));
    const toEffectHandler =
      <Channel extends keyof IpcApi>(
        channel: Channel,
        listener: TypedIpcHandler<Channel>,
      ): TypedEffectIpcHandler<Channel> =>
      (event, ...args) =>
        Effect.tryPromise({
          try: (signal) => Promise.resolve(listener(event, ...args, signal)),
          catch: (cause) => new CodexIpcError({ operation: channel, cause }),
        });
    const registerQuery = <Channel extends IpcQueryChannel>(
      channel: Channel,
      listener: TypedIpcHandler<Channel>,
    ): void => registerEffectQuery(channel, toEffectHandler(channel, listener));
    const registerPlainCommand = <Channel extends PlainResultCommandChannel>(
      channel: Channel,
      listener: TypedIpcHandler<Channel>,
    ): void => registerEffectPlainCommand(channel, toEffectHandler(channel, listener));
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
    registerEffectQuery("codex:threads:list", (_, projectId, input) =>
      threadCatalog
        .listProject(projectId, input)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "codex:threads:list", cause })),
        ),
    );

    registerEffectQuery("codex:sidebar:snapshot", (_, input) => {
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

    registerEffectControl("codex:sidebar:sync", (_, input) => {
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

    registerEffectPlainCommand("codex:sidebar:thread:move", (_, input) =>
      threadCatalog
        .move(input)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:sidebar:thread:move", cause }),
          ),
        ),
    );

    registerEffectQuery("codex:threads:pinned:list", () =>
      threadCatalog.listPinned.pipe(
        Effect.map((threadIds) => [...threadIds]),
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "codex:threads:pinned:list", cause }),
        ),
      ),
    );

    registerEffectPlainCommand("codex:threads:pinned:set", (_, threadId: string, input) =>
      threadCatalog
        .setPinned(threadId, input.pinned)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:threads:pinned:set", cause }),
          ),
        ),
    );

    registerEffectPlainCommand("codex:threads:pinned:reorder", (_, orderedThreadIds) =>
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

    registerEffectPlainCommand("codex:thread:ensure-session", (_, threadId: string) =>
      threadCatalog
        .ensureSession(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:ensure-session", cause }),
          ),
        ),
    );

    registerEffectQuery("codex:threads:palette:list", (_, input) =>
      threadCatalog.listPalette(input).pipe(
        Effect.map((threads) => [...threads]),
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "codex:threads:palette:list", cause }),
        ),
      ),
    );

    registerEffectQuery("codex:threads:palette:search", (_, input) =>
      threadCatalog.searchPalette(input).pipe(
        Effect.map((results) => [...results]),
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "codex:threads:palette:search", cause }),
        ),
      ),
    );

    registerEffectQuery("codex:thread:summary:get", (_, threadId: string) =>
      threadCatalog
        .resolve(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:summary:get", cause }),
          ),
        ),
    );

    const parseAgentImportSourceKind = (value: unknown): AgentImportSourceKind => {
      if (value === "claude-code" || value === "codex") {
        return value;
      }
      throw new Error("Invalid agent import source");
    };
    registerEffectQuery("agent-import:scan", (_, input: AgentImportScanInput) =>
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
    registerEffectQuery("agent-import:scan-picked-home", (event, input: AgentImportScanInput) =>
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
                title: `Select ${sourceKind === "codex" ? "Codex" : "Claude Code"} home`,
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
    registerEffectPlainCommand("agent-import:apply", (_, input: AgentImportApplyInput) =>
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

    registerQuery("codex:projectless-thread-cwd", (_, rawInput) => {
      const input = parseCodexProjectlessThreadCwdInput(rawInput);
      return createCodexProjectlessWorkspace({
        prompt: input.prompt,
        directoryName: input.directoryName,
        createSplitDirectories: input.createSplitDirectories !== false,
      });
    });

    const prepareSessionLaunchContext = (
      event: IpcMainInvokeEvent,
      input: CodexThreadStartForSessionInput,
    ) =>
      Effect.gen(function* () {
        const presentationClaim = input.presentationTicket
          ? yield* turnPresentation
              .claim(
                input.presentationTicket,
                {
                  kind: "session",
                  sessionId: input.sessionId,
                  launchId: input.firstSubmission.launchId,
                },
                input.firstSubmission.clientUserMessageId,
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new CodexIpcError({ operation: "codex:thread:start-for-session", cause }),
                ),
              )
          : undefined;
        const ownerClientId = yield* Effect.tryPromise({
          try: () => conversationPeers.resolvePeerClientId(event.sender.id),
          catch: (cause) => new CodexIpcError({ operation: "session-start-peer", cause }),
        });
        if (!ownerClientId)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "session-start-peer",
              cause: new Error("Starting window peer unavailable"),
            }),
          );
        if (!freshLaunchWindows.has(event.sender.id)) {
          const senderId = event.sender.id;
          const onDestroyed = () => {
            freshLaunchWindows.delete(senderId);
            freshThreadLaunch.releaseRenderer(ownerClientId, new Error("Starting window closed"));
          };
          event.sender.once("destroyed", onDestroyed);
          freshLaunchWindows.set(senderId, () =>
            event.sender.removeListener("destroyed", onDestroyed),
          );
        }
        return {
          presentationClaim,
          ownerClientId,
          browserViewScopeId:
            windows.resolveSessionId(event.sender.id) ?? `headless:${input.sessionId}`,
        };
      });
    registerEffectPlainCommand(
      "codex:thread:start-for-session",
      (event, input: CodexThreadStartForSessionInput) =>
        interruptWhenRendererIsDestroyed(
          event,
          Effect.gen(function* () {
            const context = yield* prepareSessionLaunchContext(event, input);
            const { presentationClaim } = context;
            return yield* sessionThreadLaunch.start(input, context).pipe(
              Effect.onExit((exit) =>
                exit._tag === "Failure"
                  ? Effect.sync(() => turnPresentation.releaseClaim(presentationClaim))
                  : Effect.void,
              ),
              Effect.mapError(
                (cause) =>
                  new CodexIpcError({ operation: "codex:thread:start-for-session", cause }),
              ),
            );
          }),
        ),
    );

    registerEffectPlainCommand(
      "codex:thread:side-chat:start",
      (_, input: CodexSideChatStartInput) =>
        Effect.gen(function* () {
          const clientUserMessageId = input.clientUserMessageId ?? createUuidV7();
          const presentationClaim = input.presentationTicket
            ? yield* turnPresentation
                .claim(
                  input.presentationTicket,
                  {
                    kind: "side_chat",
                    parentThreadId: input.parentThreadId,
                    clientUserMessageId,
                  },
                  clientUserMessageId,
                )
                .pipe(
                  Effect.mapError(
                    (cause) => new CodexIpcError({ operation: "side-chat:start", cause }),
                  ),
                )
            : undefined;
          return yield* sideChatCommands
            .start(input, { presentationClaim, clientUserMessageId })
            .pipe(
              Effect.onExit(() =>
                Effect.sync(() => turnPresentation.releaseClaim(presentationClaim)),
              ),
              Effect.mapError(
                (cause) => new CodexIpcError({ operation: "side-chat:start", cause }),
              ),
            );
        }),
    );

    registerEffectPlainCommand("codex:thread:side-chat:discard", (_, threadId: string) =>
      sideChatCommands
        .discard(threadId)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "side-chat:discard", cause })),
        ),
    );

    registerEffectQuery("worktrees:list", (_, hostId: string) =>
      managedWorktreeCatalog.list(hostId).pipe(
        Effect.map((records) => [...records]),
        Effect.mapError((cause) => new CodexIpcError({ operation: "worktrees:list", cause })),
      ),
    );
    registerEffectQuery("worktrees:settings:get", () =>
      managedWorktreeCatalog.settings.pipe(
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "worktrees:settings:get", cause }),
        ),
      ),
    );
    registerEffectPlainCommand("worktrees:settings:update", (_, input) =>
      managedWorktreeCatalog
        .updateSettings(input)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "worktrees:settings:update", cause }),
          ),
        ),
    );
    registerEffectQuery("worktrees:thread:availability", (_, threadId: string) =>
      managedWorktreeCatalog
        .inspectThread(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "worktrees:thread:availability", cause }),
          ),
        ),
    );
    registerEffectPlainCommand("worktrees:thread:restore", (_, threadId: string) =>
      managedWorktreeCatalog
        .restoreThread(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "worktrees:thread:restore", cause }),
          ),
        ),
    );

    registerEffectPlainCommand("worktrees:delete", (_, hostId: string, worktreePath: string) =>
      managedWorktreeCatalog
        .delete(hostId, worktreePath)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "worktrees:delete", cause })),
        ),
    );

    registerEffectControl("codex:thread:snapshot:request", (_, threadId: string) =>
      conversationResume
        .snapshot(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:snapshot:request", cause }),
          ),
        ),
    );

    registerEffectControl(
      "codex:thread:resume:prepare",
      (event, threadId, metadata, overrides, options) =>
        conversationResume
          .prepareRendererResume(threadId, event.sender.id, metadata, overrides, options)
          .pipe(
            Effect.mapError((cause) => new CodexIpcError({ operation: "resume.prepare", cause })),
          ),
    );
    registerEffectControl("codex:thread:resume:retry", (event, receiptId) =>
      conversationResume
        .retryRendererResume(receiptId, event.sender.id)
        .pipe(Effect.mapError((cause) => new CodexIpcError({ operation: "resume.retry", cause }))),
    );
    registerEffectControl("codex:thread:resume:accept", (event, receiptId) =>
      conversationResume
        .acceptRendererResume(receiptId, event.sender.id)
        .pipe(Effect.mapError((cause) => new CodexIpcError({ operation: "resume.accept", cause }))),
    );
    registerEffectControl("codex:thread:resume:release", (event, receiptId) =>
      Effect.sync(() => conversationResume.releaseRendererResume(receiptId, event.sender.id)),
    );

    registerEffectControl("codex:thread:fresh-owner:adopt", (event, threadId, launchId) =>
      Effect.gen(function* () {
        const ownerClientId = yield* Effect.tryPromise({
          try: () => conversationPeers.resolvePeerClientId(event.sender.id),
          catch: (cause) => new CodexIpcError({ operation: "fresh-adopt", cause }),
        });
        if (!ownerClientId)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "fresh-adopt",
              cause: new Error("Fresh owner peer unavailable"),
            }),
          );
        return yield* freshThreadLaunch.adopt({ threadId, launchId, ownerClientId });
      }).pipe(Effect.mapError((cause) => new CodexIpcError({ operation: "fresh-adopt", cause }))),
    );
    registerEffectControl("codex:turn:native-fresh:prepare", (event, threadId, launchId) =>
      Effect.gen(function* () {
        const ownerClientId = yield* Effect.tryPromise({
          try: () => conversationPeers.resolvePeerClientId(event.sender.id),
          catch: (cause) => new CodexIpcError({ operation: "native-fresh-prepare", cause }),
        });
        if (!ownerClientId)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-fresh-prepare",
              cause: new Error("Fresh owner peer unavailable"),
            }),
          );
        const operation = yield* freshThreadLaunch.prepare({ threadId, launchId, ownerClientId });
        const id = operation.request.clientUserMessageId;
        if (!id)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-fresh-prepare",
              cause: new Error("Fresh message identity unavailable"),
            }),
          );
        const onDestroyed = () => {
          turnCommands.releasePreparedNativeStart(id);
          clearNativeTurnPreparation(id);
        };
        if (event.sender.isDestroyed()) {
          onDestroyed();
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-fresh-prepare",
              cause: new Error("Fresh owner closed"),
            }),
          );
        }
        clearNativeTurnPreparation(id);
        event.sender.once("destroyed", onDestroyed);
        nativeTurnPreparations.set(id, {
          senderId: event.sender.id,
          cleanup: () => event.sender.removeListener("destroyed", onDestroyed),
        });
        return operation;
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-fresh-prepare", cause })),
      ),
    );
    registerNativeControl(
      "codex:turn:native-fresh:execute",
      (event, { threadId, launchId, request, caller, trace }) =>
        Effect.gen(function* () {
          const ownerClientId = yield* Effect.tryPromise({
            try: () => conversationPeers.resolvePeerClientId(event.sender.id),
            catch: (cause) => new CodexIpcError({ operation: "native-fresh-turn", cause }),
          });
          if (
            !ownerClientId ||
            !caller ||
            typeof caller.requestId !== "string" ||
            !caller.requestId ||
            !Number.isFinite(caller.timeoutMs) ||
            caller.timeoutMs < 0 ||
            (caller.expiresAtMs !== null && !Number.isFinite(caller.expiresAtMs))
          )
            return yield* Effect.fail(
              new CodexIpcError({
                operation: "native-fresh-turn",
                cause: new Error("Invalid first-turn caller"),
              }),
            );
          const key = `${event.sender.id}:${caller.requestId}`;
          let abandonmentReason: "timeout" | "disposed" | undefined;
          const fiber = yield* requestLifetimes.start(
            key,
            caller.retainResponse === true,
            freshThreadLaunch.start({ threadId, launchId, ownerClientId }, request).pipe(
              Effect.provideService(CodexRendererRequestOrigin, {
                ...caller,
                method: "turn/start",
                conversationId: threadId,
                wireTrace: trace,
                destinationId: String(event.sender.id),
                abandonment: () => abandonmentReason,
              }),
            ),
            (reason) => {
              abandonmentReason = reason;
            },
          );
          const onDestroyed = () => callbacks.fork(requestLifetimes.closeRenderer(key));
          event.sender.once("destroyed", onDestroyed);
          if (event.sender.isDestroyed()) yield* requestLifetimes.closeRenderer(key);
          return yield* Fiber.join(fiber).pipe(
            Effect.ensuring(
              Effect.sync(() => event.sender.removeListener("destroyed", onDestroyed)),
            ),
          );
        }).pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "native-fresh-turn", cause })),
          Effect.match({
            onSuccess: (result) => ({ type: "result" as const, result }),
            onFailure: (cause) => ({
              type: "error" as const,
              error: encodeCodexNativeRequestFailure(cause),
            }),
          }),
        ),
    );

    const nativeSessionReceipts = new Map<
      string,
      { senderId: number; ownerClientId: string; cleanup: () => void }
    >();
    const releaseNativeSession = (id: string) =>
      Effect.gen(function* () {
        nativeSessionReceipts.get(id)?.cleanup();
        nativeSessionReceipts.delete(id);
        yield* rendererSessionLaunch.release(id);
      });
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...nativeSessionReceipts.keys()], releaseNativeSession, { discard: true }),
    );
    registerEffectControl("codex:thread:native-session:prepare", (event, input) =>
      interruptWhenRendererIsDestroyed(
        event,
        Effect.gen(function* () {
          const context = yield* prepareSessionLaunchContext(event, input);
          const prepared = yield* rendererSessionLaunch
            .prepare(input, context)
            .pipe(
              Effect.onError(() =>
                Effect.sync(() => turnPresentation.releaseClaim(context.presentationClaim)),
              ),
            );
          const onDestroyed = () => callbacks.fork(releaseNativeSession(prepared.receiptId));
          if (event.sender.isDestroyed()) {
            yield* releaseNativeSession(prepared.receiptId);
            return yield* Effect.fail(
              new CodexIpcError({
                operation: "session-prepare",
                cause: new Error("Starting window closed"),
              }),
            );
          }
          event.sender.once("destroyed", onDestroyed);
          nativeSessionReceipts.set(prepared.receiptId, {
            senderId: event.sender.id,
            ownerClientId: context.ownerClientId,
            cleanup: () => event.sender.removeListener("destroyed", onDestroyed),
          });
          return prepared;
        }).pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "session-prepare", cause })),
        ),
      ),
    );
    registerNativeControl(
      "codex:thread:native-session:execute",
      (event, { receiptId, caller, trace }) =>
        Effect.gen(function* () {
          const entry = nativeSessionReceipts.get(receiptId);
          if (
            entry?.senderId !== event.sender.id ||
            !caller ||
            !caller.requestId ||
            !Number.isFinite(caller.timeoutMs) ||
            caller.timeoutMs < 0 ||
            (caller.expiresAtMs !== null && !Number.isFinite(caller.expiresAtMs))
          )
            return yield* Effect.fail(
              new CodexIpcError({
                operation: "session-execute",
                cause: new Error("Invalid native Session caller"),
              }),
            );
          const key = `${event.sender.id}:${caller.requestId}`;
          let abandonmentReason: "timeout" | "disposed" | undefined;
          const fiber = yield* requestLifetimes.start(
            key,
            caller.retainResponse === true,
            rendererSessionLaunch.execute(receiptId, entry.ownerClientId, {
              ...caller,
              method: "thread/start",
              conversationId: "",
              wireTrace: trace,
              destinationId: String(event.sender.id),
              abandonment: () => abandonmentReason,
            }),
            (reason) => {
              abandonmentReason = reason;
            },
          );
          const onDestroyed = () => callbacks.fork(requestLifetimes.closeRenderer(key));
          event.sender.once("destroyed", onDestroyed);
          if (event.sender.isDestroyed()) yield* requestLifetimes.closeRenderer(key);
          return yield* Fiber.join(fiber).pipe(
            Effect.ensuring(
              Effect.sync(() => event.sender.removeListener("destroyed", onDestroyed)),
            ),
          );
        }).pipe(
          Effect.match({
            onSuccess: (result) => ({ type: "result" as const, result }),
            onFailure: (cause) => ({
              type: "error" as const,
              error: encodeCodexNativeRequestFailure(cause),
            }),
          }),
        ),
    );
    registerEffectControl("codex:thread:native-session:accept", (event, id) =>
      Effect.gen(function* () {
        const entry = nativeSessionReceipts.get(id);
        if (entry?.senderId !== event.sender.id)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "session-accept",
              cause: new Error("Session caller unavailable"),
            }),
          );
        return yield* rendererSessionLaunch
          .accept(id, entry.ownerClientId)
          .pipe(Effect.ensuring(releaseNativeSession(id)));
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "session-accept", cause })),
      ),
    );
    registerEffectControl("codex:thread:native-session:release", (event, id) =>
      nativeSessionReceipts.get(id)?.senderId === event.sender.id
        ? releaseNativeSession(id)
        : Effect.void,
    );

    const rendererForkReceipts = new Map<
      string,
      { senderId: number; cleanup: () => void; sourceThreadId: string }
    >();
    const releaseRendererFork = (id: string) =>
      Effect.suspend(() => {
        rendererForkReceipts.get(id)?.cleanup();
        rendererForkReceipts.delete(id);
        return nativeFork.releaseRenderer(id);
      });
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...rendererForkReceipts.keys()], releaseRendererFork, { discard: true }),
    );
    registerEffectControl("codex:thread:native-fork:prepare", (event, sourceThreadId, lastTurnId) =>
      Effect.gen(function* () {
        const prepared = yield* nativeFork.prepareRenderer({
          sourceThreadId,
          lastTurnId,
          threadSource: "user",
        });
        if (event.sender.isDestroyed()) {
          yield* nativeFork.releaseRenderer(prepared.receiptId);
          return yield* Effect.fail(
            new CodexIpcError({ operation: "native-fork", cause: new Error("Fork caller closed") }),
          );
        }
        const onDestroyed = () => callbacks.fork(releaseRendererFork(prepared.receiptId));
        event.sender.once("destroyed", onDestroyed);
        rendererForkReceipts.set(prepared.receiptId, {
          senderId: event.sender.id,
          sourceThreadId,
          cleanup: () => event.sender.removeListener("destroyed", onDestroyed),
        });
        return prepared;
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-fork-prepare", cause })),
      ),
    );
    registerNativeControl(
      "codex:thread:native-fork:execute",
      (event, { receiptId, caller, trace }) =>
        Effect.gen(function* () {
          const receipt = rendererForkReceipts.get(receiptId);
          if (
            !receipt ||
            receipt.senderId !== event.sender.id ||
            !caller ||
            typeof caller.requestId !== "string" ||
            !caller.requestId ||
            !Number.isFinite(caller.timeoutMs) ||
            caller.timeoutMs < 0 ||
            (caller.expiresAtMs !== null && !Number.isFinite(caller.expiresAtMs))
          )
            return yield* Effect.fail(
              new CodexIpcError({
                operation: "native-fork",
                cause: new Error("Invalid fork caller"),
              }),
            );
          const key = `${event.sender.id}:${caller.requestId}`;
          let abandonmentReason: "timeout" | "disposed" | undefined;
          const fiber = yield* requestLifetimes.start(
            key,
            caller.retainResponse === true,
            nativeFork.executeRenderer(receiptId).pipe(
              Effect.provideService(CodexRendererRequestOrigin, {
                ...caller,
                method: "thread/fork",
                conversationId: receipt.sourceThreadId,
                wireTrace: trace,
                destinationId: String(event.sender.id),
                abandonment: () => abandonmentReason,
              }),
            ),
            (reason) => {
              abandonmentReason = reason;
            },
          );
          const onDestroyed = () => callbacks.fork(requestLifetimes.closeRenderer(key));
          event.sender.once("destroyed", onDestroyed);
          if (event.sender.isDestroyed()) yield* requestLifetimes.closeRenderer(key);
          return yield* Fiber.join(fiber).pipe(
            Effect.ensuring(
              Effect.sync(() => event.sender.removeListener("destroyed", onDestroyed)),
            ),
          );
        }).pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "native-fork-execute", cause }),
          ),
          Effect.match({
            onSuccess: (result) => ({ type: "result" as const, result }),
            onFailure: (cause) => ({
              type: "error" as const,
              error: encodeCodexNativeRequestFailure(cause),
            }),
          }),
        ),
    );
    registerEffectControl("codex:thread:native-fork:accept", (event, id) =>
      Effect.gen(function* () {
        if (rendererForkReceipts.get(id)?.senderId !== event.sender.id)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-fork",
              cause: new Error("Fork caller retired"),
            }),
          );
        return yield* nativeFork.acceptRenderer(id);
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-fork-accept", cause })),
      ),
    );
    registerEffectControl("codex:thread:native-fork:release", (event, id) =>
      rendererForkReceipts.get(id)?.senderId === event.sender.id
        ? releaseRendererFork(id)
        : Effect.void,
    );

    registerEffectControl("codex:thread:history-hydration:prepare", (_event, threadId) =>
      threadDirectory
        .prepareHistoryHydration(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "readonly-history-prepare", cause }),
          ),
        ),
    );
    registerEffectControl("codex:thread:interrupt-effects", (event, hostId, threadId, effect) =>
      Effect.gen(function* () {
        const manager = yield* nativeManagers.get(hostId);
        const peerId = yield* Effect.tryPromise({
          try: () => conversationPeers.resolvePeerClientId(event.sender.id),
          catch: (cause) => new CodexIpcError({ operation: "interrupt-effects", cause }),
        });
        const ownerId = yield* Effect.tryPromise({
          try: () => manager.findOwner(threadId),
          catch: (cause) => new CodexIpcError({ operation: "interrupt-effects", cause }),
        });
        yield* Effect.try({
          try: manager.assertCurrent,
          catch: (cause) => new CodexIpcError({ operation: "interrupt-effects", cause }),
        });
        if (!peerId || ownerId !== peerId)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "interrupt-effects",
              cause: new Error("Interrupt consequences require the current conversation owner"),
            }),
          );
        if (effect === "steered") {
          applicationEvents.publish({ kind: "conversationTurnSteered", value: threadId });
          return;
        }
        if (effect === "started") {
          applicationEvents.publish({ kind: "conversationTurnInterruptStarted", value: threadId });
          return;
        }
        if (effect !== "descendants")
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "interrupt-effects",
              cause: new Error("Unknown interrupt consequence"),
            }),
          );
        yield* subagentDirectory.settleInterruptedSubtree(threadId);
      }).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new CodexIpcError({ operation: "interrupt-effects", cause })),
      ),
    );
    registerEffectControl("codex:thread:node-repl:cleanup", (event, hostId, threadId, turnId) =>
      Effect.gen(function* () {
        const peerId = yield* Effect.tryPromise({
          try: () => conversationPeers.resolvePeerClientId(event.sender.id),
          catch: (cause) => new CodexIpcError({ operation: "node-repl-cleanup", cause }),
        });
        yield* nodeRepl.cleanupForOwner(hostId, threadId, turnId, peerId);
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "node-repl-cleanup", cause })),
      ),
    );
    registerEffectControl("codex:thread:settings:prepare-profile", (_event, id, profile, change) =>
      threadSettings
        .prepareExecutionProfile(id, profile, change)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "thread-settings-prepare-profile", cause }),
          ),
        ),
    );
    registerEffectControl("codex:app-server:host-context", (_event, hostId) =>
      Effect.gen(function* () {
        const manager = yield* nativeManagers.get(hostId);
        const capability = yield* nativeCapabilities.forHost(hostId);
        yield* Effect.try({
          try: manager.assertCurrent,
          catch: (cause) => new CodexIpcError({ operation: "native-host-context", cause }),
        });
        if (!capability.sourceEpoch)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-host-context",
              cause: new Error("Native host incarnation unavailable"),
            }),
          );
        return {
          hostId: capability.hostId,
          generation: capability.generation,
          sourceEpoch: capability.sourceEpoch,
          supportsPaginatedHistory: capability.flags.paginatedHistory,
          supportsTurnApprovalsReviewer: capability.flags.turnApprovalsReviewer,
          supportsThreadRevert: capability.flags.threadRevert,
          supportsThreadQueue: capability.flags.threadQueue,
          accountContext: manager.context,
        };
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-host-context", cause })),
      ),
    );

    // Window cleanup only. TurnCommands authorizes preparations from both Main and windows.
    const nativeSteerPreparations = new Map<string, { senderId: number; cleanup: () => void }>();
    const releaseNativeSteer = (id: string) => {
      nativeSteerPreparations.get(id)?.cleanup();
      nativeSteerPreparations.delete(id);
      turnCommands.releasePreparedNativeSteer(id);
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const id of nativeSteerPreparations.keys()) releaseNativeSteer(id);
      }),
    );
    registerEffectControl("codex:turn:native-steer:prepare", (event, input) =>
      Effect.gen(function* () {
        const prepared = yield* turnCommands.prepareNativeSteer(input);
        const id = prepared.clientUserMessageId;
        if (event.sender.isDestroyed()) {
          turnCommands.releasePreparedNativeSteer(id);
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-steer-prepare",
              cause: new Error("Steer caller closed"),
            }),
          );
        }
        const onDestroyed = () => releaseNativeSteer(id);
        event.sender.once("destroyed", onDestroyed);
        nativeSteerPreparations.set(id, {
          senderId: event.sender.id,
          cleanup: () => event.sender.removeListener("destroyed", onDestroyed),
        });
        return prepared;
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-steer-prepare", cause })),
      ),
    );
    registerEffectControl("codex:turn:native-steer:inspect", (_event, id) =>
      turnCommands
        .inspectPreparedNativeSteer(id)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "native-steer-inspect", cause }),
          ),
        ),
    );
    registerEffectControl("codex:turn:native-steer:release", (event, id) =>
      Effect.sync(() => {
        if (nativeSteerPreparations.get(id)?.senderId === event.sender.id) releaseNativeSteer(id);
      }),
    );
    registerNativeControl(
      "codex:turn:native-steer:execute",
      (event, { request, clientUserMessageId, caller, trace }) =>
        Effect.gen(function* () {
          const peerId = yield* Effect.tryPromise({
            try: () => conversationPeers.resolvePeerClientId(event.sender.id),
            catch: (cause) => new CodexIpcError({ operation: "native-steer-execute", cause }),
          });
          if (!peerId)
            return yield* Effect.fail(
              new CodexIpcError({
                operation: "native-steer-execute",
                cause: new Error("Executing peer unavailable"),
              }),
            );
          if (
            !caller ||
            typeof caller.requestId !== "string" ||
            !caller.requestId ||
            !Number.isFinite(caller.timeoutMs) ||
            caller.timeoutMs < 0 ||
            (caller.expiresAtMs !== null && !Number.isFinite(caller.expiresAtMs))
          )
            return yield* Effect.fail(
              new CodexIpcError({
                operation: "native-steer-execute",
                cause: new Error("Invalid native steer caller"),
              }),
            );
          const key = `${event.sender.id}:${caller.requestId}`;
          let abandonmentReason: "timeout" | "disposed" | undefined;
          const fiber = yield* requestLifetimes.start(
            key,
            caller.retainResponse === true,
            turnCommands.executePreparedNativeSteer(request, clientUserMessageId, peerId).pipe(
              Effect.provideService(CodexRendererRequestOrigin, {
                ...caller,
                method: request.method,
                conversationId: request.params.threadId,
                wireTrace: trace,
                destinationId: String(event.sender.id),
                abandonment: () => abandonmentReason,
              }),
            ),
            (reason) => {
              abandonmentReason = reason;
            },
          );
          const onDestroyed = () => callbacks.fork(requestLifetimes.closeRenderer(key));
          event.sender.once("destroyed", onDestroyed);
          return yield* Fiber.join(fiber).pipe(
            Effect.ensuring(
              Effect.sync(() => event.sender.removeListener("destroyed", onDestroyed)),
            ),
          );
        }).pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "native-steer-execute", cause }),
          ),
          Effect.match({
            onSuccess: (result) => ({ type: "result" as const, result }),
            onFailure: (cause) => ({
              type: "error" as const,
              error: encodeCodexNativeRequestFailure(cause),
            }),
          }),
        ),
    );

    const freshLaunchWindows = new Map<number, () => void>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const cleanup of freshLaunchWindows.values()) cleanup();
        freshLaunchWindows.clear();
      }),
    );
    // Window cleanup only. A Main-originated preparation can execute in the window owner.
    const nativeTurnPreparations = new Map<string, { senderId: number; cleanup: () => void }>();
    const clearNativeTurnPreparation = (id: string) => {
      nativeTurnPreparations.get(id)?.cleanup();
      nativeTurnPreparations.delete(id);
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const id of nativeTurnPreparations.keys()) {
          turnCommands.releasePreparedNativeStart(id);
          clearNativeTurnPreparation(id);
        }
      }),
    );
    registerEffectControl("codex:turn:native:prepare", (event, input) =>
      Effect.gen(function* () {
        const presentationClaim = input.presentationTicket
          ? yield* turnPresentation.claim(
              input.presentationTicket,
              { kind: "thread", threadId: input.threadId },
              input.clientUserMessageId,
            )
          : undefined;
        const request = yield* turnCommands
          .prepareNativeStart(
            input.threadId,
            input.prompt,
            {
              ...input.opts,
              presentationClaim,
              clientUserMessageId: input.clientUserMessageId,
              preparedPrompt: input.preparedPrompt,
            },
            input.originalRequest,
            input.sourceContext,
          )
          .pipe(
            Effect.onExit((exit) =>
              exit._tag === "Failure"
                ? Effect.sync(() => turnPresentation.releaseClaim(presentationClaim))
                : Effect.void,
            ),
          );
        const onDestroyed = () => {
          turnCommands.releasePreparedNativeStart(input.clientUserMessageId);
          clearNativeTurnPreparation(input.clientUserMessageId);
        };
        if (event.sender.isDestroyed()) {
          turnCommands.releasePreparedNativeStart(input.clientUserMessageId);
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-turn-prepare",
              cause: new Error("Turn caller closed during preparation"),
            }),
          );
        }
        event.sender.once("destroyed", onDestroyed);
        nativeTurnPreparations.set(input.clientUserMessageId, {
          senderId: event.sender.id,
          cleanup: () => event.sender.removeListener("destroyed", onDestroyed),
        });
        return request;
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-turn-prepare", cause })),
      ),
    );
    registerEffectControl("codex:turn:native:inspect", (event, request) =>
      Effect.gen(function* () {
        const peerId = yield* Effect.tryPromise({
          try: () => conversationPeers.resolvePeerClientId(event.sender.id),
          catch: (cause) => new CodexIpcError({ operation: "native-turn-inspect", cause }),
        });
        if (!peerId)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-turn-inspect",
              cause: new Error("Executing window peer unavailable"),
            }),
          );
        return yield* turnCommands.inspectPreparedNativeStart(request, peerId);
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-turn-inspect", cause })),
      ),
    );
    registerNativeControl("codex:turn:native:execute", (event, { request, caller, trace }) =>
      Effect.gen(function* () {
        const id = request.clientUserMessageId;
        if (!id)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-turn-execute",
              cause: new Error("Turn preparation unavailable"),
            }),
          );
        const executingPeerClientId = yield* Effect.tryPromise({
          try: () => conversationPeers.resolvePeerClientId(event.sender.id),
          catch: (cause) => new CodexIpcError({ operation: "native-turn-execute", cause }),
        });
        if (!executingPeerClientId)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-turn-execute",
              cause: new Error("Executing window peer unavailable"),
            }),
          );
        if (
          !caller ||
          typeof caller.requestId !== "string" ||
          !caller.requestId ||
          !Number.isFinite(caller.timeoutMs) ||
          caller.timeoutMs < 0 ||
          (caller.expiresAtMs !== null && !Number.isFinite(caller.expiresAtMs))
        )
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-turn-execute",
              cause: new Error("Invalid native turn caller"),
            }),
          );
        clearNativeTurnPreparation(id);
        const key = `${event.sender.id}:${caller.requestId}`;
        let abandonmentReason: "timeout" | "disposed" | undefined;
        const fiber = yield* requestLifetimes.start(
          key,
          caller.retainResponse === true,
          turnCommands.executePreparedNativeStart(request, executingPeerClientId).pipe(
            Effect.provideService(CodexRendererRequestOrigin, {
              ...caller,
              method: "turn/start",
              conversationId: request.threadId,
              wireTrace: trace,
              destinationId: String(event.sender.id),
              abandonment: () => abandonmentReason,
            }),
          ),
          (reason) => {
            abandonmentReason = reason;
          },
        );
        const onDestroyed = () => callbacks.fork(requestLifetimes.closeRenderer(key));
        event.sender.once("destroyed", onDestroyed);
        if (event.sender.isDestroyed()) yield* requestLifetimes.closeRenderer(key);
        return yield* Fiber.join(fiber).pipe(
          Effect.ensuring(Effect.sync(() => event.sender.removeListener("destroyed", onDestroyed))),
        );
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-turn-execute", cause })),
        Effect.match({
          onSuccess: (result) => ({ type: "result" as const, result }),
          onFailure: (cause) => ({
            type: "error" as const,
            error: encodeCodexNativeRequestFailure(cause),
          }),
        }),
      ),
    );
    registerNativeControl("codex:turn:native:inject", (event, { operation, caller, trace }) =>
      Effect.gen(function* () {
        const id = operation.request.clientUserMessageId;
        if (!id)
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-inject",
              cause: new Error("Turn preparation unavailable"),
            }),
          );
        const peerId = yield* Effect.tryPromise({
          try: () => conversationPeers.resolvePeerClientId(event.sender.id),
          catch: (cause) => new CodexIpcError({ operation: "native-inject", cause }),
        });
        if (
          !peerId ||
          !caller ||
          typeof caller.requestId !== "string" ||
          !caller.requestId ||
          !Number.isFinite(caller.timeoutMs) ||
          caller.timeoutMs < 0 ||
          (caller.expiresAtMs !== null && !Number.isFinite(caller.expiresAtMs))
        )
          return yield* Effect.fail(
            new CodexIpcError({
              operation: "native-inject",
              cause: new Error("Invalid native injection caller"),
            }),
          );
        const key = `${event.sender.id}:${caller.requestId}`;
        let abandonmentReason: "timeout" | "disposed" | undefined;
        const fiber = yield* requestLifetimes.start(
          key,
          caller.retainResponse === true,
          turnCommands.injectPreparedNativeStart(operation, peerId).pipe(
            Effect.provideService(CodexRendererRequestOrigin, {
              ...caller,
              method: "thread/inject_items",
              conversationId: operation.request.threadId,
              wireTrace: trace,
              destinationId: String(event.sender.id),
              abandonment: () => abandonmentReason,
            }),
          ),
          (reason) => {
            abandonmentReason = reason;
          },
        );
        const onDestroyed = () => callbacks.fork(requestLifetimes.closeRenderer(key));
        event.sender.once("destroyed", onDestroyed);
        if (event.sender.isDestroyed()) yield* requestLifetimes.closeRenderer(key);
        return yield* Fiber.join(fiber).pipe(
          Effect.ensuring(Effect.sync(() => event.sender.removeListener("destroyed", onDestroyed))),
        );
      }).pipe(
        Effect.mapError((cause) => new CodexIpcError({ operation: "native-inject", cause })),
        Effect.match({
          onSuccess: (result) => ({ type: "result" as const, result }),
          onFailure: (cause) => ({
            type: "error" as const,
            error: encodeCodexNativeRequestFailure(cause),
          }),
        }),
      ),
    );
    registerEffectControl("codex:turn:native:release", (event, id) =>
      Effect.sync(() => {
        if (nativeTurnPreparations.get(id)?.senderId !== event.sender.id) return;
        clearNativeTurnPreparation(id);
        turnCommands.releasePreparedNativeStart(id);
      }),
    );

    registerEffectControl("codex:app-server:respond", (_event, input) =>
      Effect.gen(function* () {
        if (!("effect" in input)) {
          const occurrence = yield* requestInbox.resolveOccurrence(input);
          if (
            !occurrence ||
            occurrence.occurrenceId !== input.occurrenceId ||
            typeof occurrence.params !== "object" ||
            occurrence.params === null ||
            !("threadId" in occurrence.params) ||
            occurrence.params.threadId !== input.threadId
          )
            return false;
          if (input.method === "item/tool/requestOptionPicker") {
            const response = input.response;
            if (
              !response ||
              !["submit", "skip", "dismiss"].includes(response.action) ||
              !Array.isArray(response.selectedOptions) ||
              !response.selectedOptions.every((value) => typeof value === "string") ||
              (response.freeformAnswer !== null && typeof response.freeformAnswer !== "string")
            )
              return false;
          } else if (input.method === "item/tool/requestSetupCodexContextPicker") {
            const response = input.response;
            if (
              !response ||
              !["continue", "skip", "dismiss"].includes(response.action) ||
              !Array.isArray(response.selectedSources) ||
              !response.selectedSources.every((value) => typeof value === "string")
            )
              return false;
          } else {
            const decoder: Schema.ConstraintDecoder<unknown> =
              SERVER_REQUEST_RESPONSES[input.method];
            yield* Schema.decodeUnknownEffect(decoder)(input.response);
          }
          return yield* serverRequestResponses.native(input);
        }
        const method = input.effect.method;
        if (
          method !== "currentTime/read" &&
          method !== "mcpServer/elicitation/request" &&
          method !== "item/tool/call" &&
          method !== "item/tool/requestSetupCodexContextPicker"
        )
          return false;
        const occurrence = yield* requestInbox.resolveOccurrence({
          ...input,
          requestId: input.effect.requestId,
          method,
        });
        if (!occurrence || occurrence.occurrenceId !== input.occurrenceId) return false;
        if (method === "item/tool/requestSetupCodexContextPicker") {
          const response = input.effect.response;
          if (
            !response ||
            !["continue", "skip", "dismiss"].includes(response.action) ||
            !Array.isArray(response.selectedSources) ||
            !response.selectedSources.every((value) => typeof value === "string")
          )
            return false;
          return yield* requestInbox.settle(
            occurrence,
            { kind: "result", value: response },
            input.trace,
          );
        }
        const decoder: Schema.ConstraintDecoder<unknown> = SERVER_REQUEST_RESPONSES[method];
        const response = yield* Schema.decodeUnknownEffect(decoder)(input.effect.response);
        return yield* requestInbox.settle(
          occurrence,
          { kind: "result", value: response },
          input.trace,
        );
      }).pipe(
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "codex:app-server:respond", cause }),
        ),
      ),
    );

    registerNativeControl("codex:app-server:request", (event, input) =>
      Effect.gen(function* () {
        const validated = yield* Effect.try({
          try: () => {
            if (typeof input.hostId !== "string" || !input.hostId.trim())
              throw new Error("Invalid request host");
            const caller = input.caller;
            if (
              !caller ||
              typeof caller.requestId !== "string" ||
              !caller.requestId ||
              input.request.id !== caller.requestId ||
              !Number.isFinite(caller.timeoutMs) ||
              caller.timeoutMs < 0 ||
              (caller.expiresAtMs !== null && !Number.isFinite(caller.expiresAtMs))
            )
              throw new Error("Invalid native request caller");
            if (
              input.scheduling &&
              ((input.scheduling.priority !== undefined &&
                input.scheduling.priority !== "background" &&
                input.scheduling.priority !== "interactive" &&
                input.scheduling.priority !== "critical") ||
                (input.scheduling.source !== undefined &&
                  typeof input.scheduling.source !== "string"))
            )
              throw new Error("Invalid native request scheduling");
            const method = input.request.method;
            if (!RENDERER_NATIVE_REQUEST_METHODS.has(method))
              throw new Error(
                "Native renderer method requires an application admission capability",
              );
            if (!Object.hasOwn(CLIENT_REQUEST_PARAMS, method))
              throw new Error("Unknown generated request method");
            const decoder: Schema.ConstraintDecoder<unknown> | undefined =
              CLIENT_REQUEST_PARAMS[method];
            if (decoder === undefined && input.request.params !== undefined)
              throw new Error("Method has no request parameters");
            return { caller, method, decoder, params: input.request.params };
          },
          catch: (cause) => new CodexIpcError({ operation: "native-renderer-request", cause }),
        });
        const { caller, method } = validated;
        const params =
          validated.decoder === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(validated.decoder, {
                onExcessProperty: "preserve",
              })(validated.params).pipe(
                Effect.mapError(
                  (cause) => new CodexIpcError({ operation: "native-renderer-request", cause }),
                ),
              );
        const manager = yield* nativeManagers.get(input.hostId);
        yield* Effect.try({
          try: manager.assertCurrent,
          catch: (cause) => new CodexIpcError({ operation: "native-renderer-request", cause }),
        });
        if (RENDERER_NATIVE_THREAD_QUEUE_METHODS.has(method)) {
          const capability = yield* nativeCapabilities.forHost(input.hostId);
          if (codexRendererNativeRequestAdmission(method, capability.flags) !== "allowed")
            return yield* Effect.fail(
              new CodexIpcError({
                operation: "native-renderer-request",
                cause: new Error("Native renderer queue method requires threadQueue capability"),
              }),
            );
        }
        const key = `${event.sender.id}:${caller.requestId}`;
        let abandonmentReason: "timeout" | "disposed" | undefined;
        const fiber = yield* requestLifetimes.start(
          key,
          caller.retainResponse === true && codexRequestCanRetainOutcome(method),
          gateway
            .requestRawOnHost(input.hostId, method, params, {
              ...input.scheduling,
              expectedHostId: input.hostId,
              expectedGeneration: manager.generation,
              wireTrace: input.request.trace,
            })
            .pipe(
              Effect.tap(() =>
                Effect.try({
                  try: manager.assertCurrent,
                  catch: (cause) =>
                    new CodexIpcError({ operation: "native-renderer-request", cause }),
                }),
              ),
              Effect.tap((response) =>
                method === "thread/resume"
                  ? conversationResume.observeRendererResume({
                      senderId: event.sender.id,
                      requestId: caller.requestId,
                      hostId: input.hostId,
                      params,
                      response: materializeCodexJson(response) as ThreadResumeResponse,
                    })
                  : Effect.void,
              ),
              Effect.provideService(CodexRendererRequestOrigin, {
                ...caller,
                method,
                conversationId: "",
                wireTrace: input.request.trace,
                destinationId: String(event.sender.id),
                abandonment: () => abandonmentReason,
              }),
            ),
          (reason) => {
            abandonmentReason = reason;
          },
        );
        const retirement = manager.onDispose(() => callbacks.fork(requestLifetimes.close(key)));
        const onDestroyed = () => callbacks.fork(requestLifetimes.closeRenderer(key));
        event.sender.once("destroyed", onDestroyed);
        return yield* Fiber.join(fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              event.sender.removeListener("destroyed", onDestroyed);
              retirement[Symbol.dispose]();
            }),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof CodexIpcError
            ? cause
            : new CodexIpcError({
                operation: "native-renderer-request",
                cause,
              }),
        ),
        Effect.match({
          onSuccess: (result) => ({ type: "result" as const, result }),
          onFailure: (cause) => ({
            type: "error" as const,
            error: encodeCodexNativeRequestFailure(cause),
          }),
        }),
      ),
    );

    registerEffectControl("codex:app-server:request:abandon", (event, input) =>
      input.reason === "disposed"
        ? requestLifetimes.close(`${event.sender.id}:${input.requestId}`)
        : requestLifetimes.abandon(`${event.sender.id}:${input.requestId}`),
    );
    registerEffectQuery("codex:subagents:overview:read", (_, input) =>
      subagentDirectory
        .readOverview(input)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:subagents:overview:read", cause }),
          ),
        ),
    );

    registerEffectControl("codex:subagents:selected:hydrate", (_, input) =>
      subagentDirectory.hydrateSelected(input),
    );

    registerEffectQuery("codex:thread:history-search", (_, threadId, query) =>
      persistedHistorySearch
        .search(threadId, query)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:history-search", cause }),
          ),
        ),
    );
    registerEffectControl("codex:thread:history-export:start", (event, threadId) =>
      conversationHistoryExport
        .start({ consumerId: String(event.sender.id), threadId })
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:history-export:start", cause }),
          ),
        ),
    );
    registerEffectControl("codex:thread:history-export:next", (event, jobId) =>
      conversationHistoryExport
        .next({ consumerId: String(event.sender.id), jobId })
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:history-export:next", cause }),
          ),
        ),
    );
    registerEffectControl("codex:thread:history-export:cancel", (event, jobId) =>
      conversationHistoryExport.cancel({ consumerId: String(event.sender.id), jobId }),
    );

    registerEffectPlainCommand("codex:thread:name:set", (_, threadId: string, name: string) =>
      threadTitles
        .set({ threadId, name, normalization: "manual" })
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:name:set", cause }),
          ),
        ),
    );

    registerEffectPlainCommand(
      "codex:thread:name:set-generated",
      (_, threadId: string, name: string) =>
        threadTitles
          .set({ threadId, name, normalization: "trim" })
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:thread:name:set-generated", cause }),
            ),
          ),
    );

    registerEffectPlainCommand(
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

    registerEffectPlainCommand("codex:thread:archive", (_, threadId: string) =>
      conversationCommands
        .archive(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:archive", cause }),
          ),
        ),
    );

    registerEffectPlainCommand("codex:thread:delete-archived", (_, threadId: string) =>
      conversationCommands
        .deleteArchived(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:delete-archived", cause }),
          ),
        ),
    );

    registerEffectPlainCommand("codex:thread:unarchive", (_, threadId: string) =>
      conversationCommands
        .unarchive(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:unarchive", cause }),
          ),
        ),
    );

    registerEffectPlainCommand(
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

    registerEffectPlainCommand(
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

    registerEffectPlainCommand(
      "codex:turn:start",
      (
        _,
        threadId: string,
        prompt: string,
        opts?: CodexTurnStartOptions,
        presentationTicket?: CodexTurnPresentationTicket,
      ) =>
        Effect.gen(function* () {
          const clientUserMessageId = createUuidV7();
          const presentationClaim = presentationTicket
            ? yield* turnPresentation
                .claim(presentationTicket, { kind: "thread", threadId }, clientUserMessageId)
                .pipe(
                  Effect.mapError(
                    (cause) => new CodexIpcError({ operation: "codex:turn:start", cause }),
                  ),
                )
            : undefined;
          return yield* turnCommands
            .start(threadId, prompt, {
              ...opts,
              presentationClaim,
              clientUserMessageId,
            })
            .pipe(
              Effect.onExit((exit) =>
                exit._tag === "Failure"
                  ? Effect.sync(() => turnPresentation.releaseClaim(presentationClaim))
                  : Effect.void,
              ),
              Effect.mapError(
                (cause) => new CodexIpcError({ operation: "codex:turn:start", cause }),
              ),
            );
        }),
    );

    registerEffectControl(
      "codex:queued-messages:prepare-native",
      (event, threadId, message, mode, preparationContext) =>
        Effect.gen(function* () {
          const prepared = yield* turnCommands.prepareNativeQueuedMessage(
            threadId,
            message,
            mode,
            preparationContext,
          );
          const id = preparationContext.clientUserMessageId ?? message.id;
          const release = () => {
            turnCommands.releasePreparedNativeStart(id);
            clearNativeTurnPreparation(id);
            releaseNativeSteer(id);
          };
          if (event.sender.isDestroyed()) {
            release();
            return yield* Effect.fail(
              new CodexIpcError({
                operation: "queued-native-prepare",
                cause: new Error("Queue caller closed"),
              }),
            );
          }
          const onDestroyed = () => release();
          event.sender.once("destroyed", onDestroyed);
          const receipt = {
            senderId: event.sender.id,
            cleanup: () => event.sender.removeListener("destroyed", onDestroyed),
          };
          if (prepared.start) {
            clearNativeTurnPreparation(id);
            nativeTurnPreparations.set(id, receipt);
          } else {
            nativeSteerPreparations.get(id)?.cleanup();
            nativeSteerPreparations.set(id, receipt);
          }
          return prepared;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CodexIpcError({ operation: "codex:queued-messages:prepare-native", cause }),
          ),
        ),
    );
    registerEffectControl("codex:queued-messages:read", () =>
      queuedFollowUps.readMessageState.pipe(
        Effect.mapError(
          (cause) => new CodexIpcError({ operation: "codex:queued-messages:read", cause }),
        ),
      ),
    );
    registerEffectControl("codex:queued-messages:write", (_, state) =>
      queuedFollowUps
        .writeMessageState(state)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:queued-messages:write", cause }),
          ),
        ),
    );
    registerEffectControl(
      "codex:queued-messages:prepare",
      (_, threadId, prompt, opts, presentationTicket) =>
        queuedFollowUps
          .prepareMessage({
            threadId,
            prompt,
            presentationTicket,
            collaborationMode: opts?.collaborationMode,
            serviceTier: opts?.serviceTier,
            promptInput: opts?.promptInput,
            summary: opts?.summary,
            permissionMode: opts?.permissionMode,
            workspaceRoots: opts?.workspaceRoots,
            permissionSelection: opts?.permissionSelection,
            permissionProfileId: opts?.permissionProfileId,
            usePermissionSelection: opts?.usePermissionSelection,
            shouldSendPermissionOverrides: opts?.shouldSendPermissionOverrides,
          })
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:queued-messages:prepare", cause }),
            ),
          ),
    );
    registerEffectControl("codex:queued-messages:acquire-send", (_, identity) =>
      Effect.sync(() => queuedFollowUps.acquireSendLock(identity)),
    );
    registerEffectControl("codex:queued-messages:release-send", (_, identity) =>
      Effect.sync(() => queuedFollowUps.releaseSendLock(identity)),
    );

    registerEffectPlainCommand("codex:thread:compact:start", (_, threadId: string) =>
      manualCompaction
        .start(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:compact:start", cause }),
          ),
        ),
    );

    registerEffectQuery("codex:thread:goal:get", (_, threadId: string) =>
      threadGoals
        .get(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:goal:get", cause }),
          ),
        ),
    );

    registerEffectPlainCommand(
      "codex:thread:goal:set",
      (_, params: CodexThreadGoalSetActionInput) =>
        threadGoals
          .set(params)
          .pipe(
            Effect.mapError(
              (cause) => new CodexIpcError({ operation: "codex:thread:goal:set", cause }),
            ),
          ),
    );

    registerEffectPlainCommand("codex:thread:goal:clear", (_, threadId: string) =>
      threadGoals
        .clear(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new CodexIpcError({ operation: "codex:thread:goal:clear", cause }),
          ),
        ),
    );

    registerEffectPlainCommand("codex:turn:steer", (_, input: CodexSteerTurnInput) =>
      turnCommands
        .steer(input)
        .pipe(
          Effect.mapError((cause) => new CodexIpcError({ operation: "codex:turn:steer", cause })),
        ),
    );

    registerEffectQuery(
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

    registerEffectPlainCommand(
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

    registerPlainCommand("mcp-app:open-external", async (event, value) => {
      requireTrustedAppRendererSender(event, "MCP external navigation");
      if (value.length > 8_192) throw new Error("MCP external URL is too long");
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("MCP external navigation requires a credential-free HTTPS URL");
      }
      await shell.openExternal(url.toString());
    });

    registerEffectControl(
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

    registerEffectControl(
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

    registerEffectControl(
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

    registerEffectControl(
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

    registerEffectControl(
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

    registerEffectControl(
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

    registerEffectControl(
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

    registerEffectPlainCommand(
      "codex:conversation-unread:set",
      (_, conversationId, hasUnreadTurn) =>
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
