import {
  CodexTurnDeliveryError,
  type CodexTurnDelivery,
} from "../../../shared/codex-conversation-state/codex-turn-delivery";
import {
  createCodexNativeRequestError,
  type CodexNativeRequestDeliveryUpdate,
  type CodexNativeRequestOutcome,
  type CodexNativeResponseMetadata,
} from "../../../shared/codex-native-request-outcome";
import type { RequestId } from "@nodex/codex-app-server-protocol";
import {
  codexRequestCanRetainOutcome,
  type CodexRendererRequestCaller,
  type CodexRendererNativeRequestOptions,
} from "../../../shared/codex-renderer-request";
import {
  codexRequestConversationId,
  type CodexRequestLifecycleEvent,
  type CodexRequestLifecycleTiming,
} from "../../../shared/codex-request-lifecycle";
import {
  codexRendererRequestPriority,
  codexRequestSource,
} from "../../../shared/codex-request-policy";
import {
  beginCodexWorkspaceDiscovery,
  finishCodexWorkspaceDiscovery,
  recordCodexRequestTraceSpan,
  startCodexRequestInteractionTrace,
  type CodexRequestInteractionTrace,
  type CodexWorkspaceDiscoveryInteraction,
} from "./codex-request-interaction-trace";

export interface RendererAppServerRequestOptions extends CodexRendererNativeRequestOptions {
  readonly requestId?: string;
  readonly timeoutMs?: number;
  readonly onOutcomeUnknown?: (delivery: CodexTurnDelivery) => void;
  readonly params?: unknown;
  readonly clientUserMessageId?: string;
  readonly trace?: CodexRequestLifecycleTiming["trace"] | null;
}

interface PendingRequest {
  readonly id: string;
  readonly method: string;
  readonly epoch: number;
  readonly queuedAtMs: number;
  startedAtMs: number | null;
  readonly priority: CodexRequestLifecycleTiming["priority"];
  readonly source: string;
  readonly timeoutMs: number;
  readonly queuedRequestCountAtEnqueue: number;
  readonly clientUserMessageId?: string;
  readonly trace?: CodexRequestLifecycleTiming["trace"];
  readonly discoveryInteraction: CodexWorkspaceDiscoveryInteraction | null;
  readonly interactionTrace: CodexRequestInteractionTrace | null;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: unknown) => void;
  readonly abandon: (reason: "timeout" | "disposed") => void;
  readonly onOutcomeUnknown?: (delivery: CodexTurnDelivery) => void;
  capacityReleased: boolean;
  outcomeUnknown: boolean;
  peakInFlightRequestCount: number;
  peakBackgroundInFlightRequestCount: number;
  coalescedRequestCount: number;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

interface QueuedRequest {
  readonly priority: CodexRequestLifecycleTiming["priority"];
  readonly request: PendingRequest;
  readonly dispatch: () => void;
}

const MAX_IN_FLIGHT_REQUESTS = 6;
const MAX_NONCRITICAL_REQUESTS = MAX_IN_FLIGHT_REQUESTS - 1;
const MAX_BACKGROUND_REQUESTS = 3;
const INTERACTIVE_DISPATCHES_BEFORE_BACKGROUND = 4;
const QUEUE_CAPS = {
  background: 128,
  critical: 16,
  interactive: 64,
} as const;
const DISCOVERY_METHODS = new Set([
  "app/installed",
  "app/list",
  "app/read",
  "collaborationMode/list",
  "config/read",
  "configRequirements/read",
  "experimentalFeature/list",
  "hooks/list",
  "mcpServerStatus/list",
  "model/list",
  "modelProvider/capabilities/read",
  "permissionProfile/list",
  "plugin/installed",
  "plugin/list",
  "plugin/read",
  "plugin/share/list",
  "skills/list",
]);
const THREAD_ACTION_METHODS = new Set([
  "thread/archive",
  "thread/unarchive",
  "thread/delete",
  "thread/name/set",
  "thread/metadata/update",
  "thread/settings/update",
  "thread/rollback",
  "thread/compact/start",
]);

function requestInteractionNames(
  method: string,
  source: string,
): {
  readonly rootName: string;
  readonly childName: string;
} {
  if (method === "turn/start")
    return { rootName: "desktop.turn_submit", childName: "app_server.client" };
  if (method === "turn/interrupt" || method === "turn/steer")
    return { rootName: "desktop.turn_control", childName: "turn.control" };
  if (method === "thread/start" || method === "thread/resume")
    return { rootName: "desktop.thread_open", childName: "thread.hydration" };
  if (method === "thread/list")
    return { rootName: "desktop.thread_list", childName: "thread.list" };
  if (method === "thread/search")
    return { rootName: "desktop.thread_search", childName: "thread.search" };
  if (THREAD_ACTION_METHODS.has(method))
    return { rootName: "desktop.thread_action", childName: "thread.action" };
  if (method === "mcpServer/tool/call" || method === "mcpServer/resource/read")
    return { rootName: "desktop.tool_request", childName: "app_server.tool_request" };
  if (
    method === "command/exec" ||
    method === "process/spawn" ||
    method === "process/kill" ||
    method === "thread/shellCommand" ||
    method === "thread/backgroundTerminals/clean"
  )
    return { rootName: "desktop.terminal_operation", childName: "terminal.operation" };
  if (source === "filesystem" || source === "windows_sandbox")
    return { rootName: "desktop.workspace_operation", childName: "workspace.operation" };
  if (source === "fuzzy_file_search" && method !== "fuzzyFileSearch/sessionStop")
    return { rootName: "desktop.file_search", childName: "file.search" };
  if (source === "remote_control")
    return { rootName: "desktop.remote_control", childName: "app_server.remote_control" };
  return { rootName: "desktop.app_server_request", childName: "app_server.client" };
}

function releaseBackgroundYield(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 50);
    const requestAnimationFrame = globalThis.window?.requestAnimationFrame;
    if (!requestAnimationFrame) {
      clearTimeout(timer);
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => {
      clearTimeout(timer);
      setTimeout(resolve, 0);
    });
  });
}

/** The window owns response deadlines; abandoning delivery does not undo a server mutation. */
export class RendererAppServerRequestClient implements Disposable {
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly inFlight = new Set<PendingRequest>();
  private readonly queuedRequests: QueuedRequest[] = [];
  private readonly listeners = new Set<(event: CodexRequestLifecycleEvent) => void>();
  private readonly configReads = new Map<
    string,
    { request: PendingRequest; promise: Promise<unknown> }
  >();
  private inFlightRequestCount = 0;
  private noncriticalRequestCount = 0;
  private backgroundRequestCount = 0;
  private backgroundYieldsInProgress = 0;
  private interactiveDispatchesSinceBackground = 0;
  private disposed = false;
  private epoch = 0;

  constructor(
    private readonly abandon: (
      requestId: string,
      reason: "timeout" | "disposed",
    ) => Promise<unknown>,
    readonly hostId = "local",
    private readonly useHostRequestScheduler = true,
  ) {}

  addRequestLifecycleListener(listener: (event: CodexRequestLifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getPendingRequestCount(): number {
    return this.pending.size;
  }

  send<TResult>(
    method: string,
    dispatch: (caller: CodexRendererRequestCaller) => Promise<TResult>,
    options: RendererAppServerRequestOptions = {},
  ): Promise<TResult> {
    return this.sendNative(
      method,
      (caller) => dispatch(caller).then((result) => ({ type: "result", result })),
      options,
    );
  }

  sendNative<TResult>(
    method: string,
    dispatch: (
      caller: CodexRendererRequestCaller,
      trace: CodexRequestLifecycleTiming["trace"] | undefined,
    ) => Promise<CodexNativeRequestOutcome<TResult>>,
    options: RendererAppServerRequestOptions = {},
  ): Promise<TResult> {
    if (this.disposed) return Promise.reject(new Error("App server request client disposed"));
    const priority = codexRendererRequestPriority(method, options.priority);
    const source = codexRequestSource(method, options.source);
    const configKey =
      method === "config/read"
        ? JSON.stringify({
            params: options.params,
            priority,
            source,
            timeoutMs: options.timeoutMs ?? 0,
            trace: options.trace === undefined ? "auto" : options.trace,
          })
        : null;
    const coalesced = configKey === null ? undefined : this.configReads.get(configKey);
    if (coalesced) {
      coalesced.request.coalescedRequestCount += 1;
      return coalesced.promise as Promise<TResult>;
    }
    const onOutcomeUnknown = codexRequestCanRetainOutcome(method)
      ? options.onOutcomeUnknown
      : undefined;
    const timeoutMs = options.timeoutMs ?? (method === "plugin/list" ? 30_000 : 0);
    const requestId =
      options.requestId ??
      `${method === "plugin/list" || method === "thread/resume" ? `${method}:` : ""}${crypto.randomUUID()}`;
    if (this.pending.has(requestId))
      return Promise.reject(new Error("Request identity is already pending"));
    if (
      !this.useHostRequestScheduler &&
      this.queuedRequests.filter((request) => request.priority === priority).length >=
        QUEUE_CAPS[priority]
    ) {
      const endedAtMs = Date.now();
      const error = new Error("App server request queue is full");
      const discoveryInteraction =
        options.trace === undefined && DISCOVERY_METHODS.has(method)
          ? beginCodexWorkspaceDiscovery({
              hostId: this.hostId,
              method,
              priority,
              source,
              now: endedAtMs,
            })
          : null;
      const trace = options.trace ?? discoveryInteraction?.interactionTrace?.trace ?? undefined;
      finishCodexWorkspaceDiscovery(discoveryInteraction, error);
      this.emit({
        type: "background-queue-full",
        hostId: this.hostId,
        endedAtMs,
        peakBackgroundInFlightRequestCount: this.backgroundRequestCount,
        coalescedRequestCount: 0,
        durationMs: 0,
        peakInFlightRequestCount: this.inFlightRequestCount,
        method,
        priority,
        queueWaitMs: 0,
        queuedRequestCountAtEnqueue: this.queuedRequests.length,
        requestDurationMs: 0,
        source,
        timeoutMs,
        ...(trace ? { trace } : {}),
      });
      return Promise.reject(error);
    }
    const queuedAtMs = Date.now();
    const discoveryInteraction =
      options.trace === undefined && priority !== "critical" && DISCOVERY_METHODS.has(method)
        ? beginCodexWorkspaceDiscovery({
            hostId: this.hostId,
            method,
            priority,
            source,
            now: queuedAtMs,
          })
        : null;
    const interactionNames = requestInteractionNames(method, source);
    const interactionTrace =
      discoveryInteraction === null && options.trace === undefined
        ? startCodexRequestInteractionTrace({
            attributes: {
              "app_server.method": method,
              "app_server.priority": priority,
              "app_server.source": source,
            },
            childName: interactionNames.childName,
            rootName: interactionNames.rootName,
          })
        : null;
    const trace =
      options.trace ??
      discoveryInteraction?.interactionTrace?.trace ??
      interactionTrace?.trace ??
      undefined;
    let pending!: PendingRequest;
    const result = new Promise<TResult>((resolve, reject) => {
      pending = {
        id: requestId,
        method,
        epoch: this.epoch,
        queuedAtMs,
        startedAtMs: null,
        priority,
        source,
        timeoutMs,
        clientUserMessageId: options.clientUserMessageId,
        queuedRequestCountAtEnqueue: this.queuedRequests.length,
        trace,
        discoveryInteraction,
        interactionTrace,
        reject,
        resolve: (value) => resolve(value as TResult),
        onOutcomeUnknown,
        capacityReleased: false,
        outcomeUnknown: false,
        peakInFlightRequestCount: 0,
        peakBackgroundInFlightRequestCount: 0,
        coalescedRequestCount: 0,
        abandon: (reason) => {
          void this.abandon(requestId, reason).catch(() => {});
        },
        timeout: undefined,
      };
      this.pending.set(requestId, pending);
      this.queuedRequests.push({
        priority,
        request: pending,
        dispatch: () => {
          if (!this.isPending(pending)) return;
          this.startRequest(pending, options.params);
          const caller = {
            retainResponse: onOutcomeUnknown !== undefined,
            requestId,
            timeoutMs,
            expiresAtMs: timeoutMs > 0 ? Date.now() + timeoutMs : null,
          };
          let operation: Promise<CodexNativeRequestOutcome<TResult>>;
          try {
            operation = dispatch(caller, pending.trace);
          } catch (error) {
            const failure = onOutcomeUnknown
              ? new CodexTurnDeliveryError(
                  error instanceof Error ? error.message : "App server request dispatch failed",
                  { requestId, method, stage: "outcome-unknown" },
                )
              : error;
            this.fail(pending, failure);
            return;
          }
          void operation.then(
            (outcome) => {
              if (!this.isPending(pending)) {
                this.lateResponse(pending, outcome.hostMetrics);
                return;
              }
              if (outcome.type === "error") {
                this.fail(
                  pending,
                  outcome.error,
                  outcome.hostMetrics,
                  createCodexNativeRequestError(outcome.error),
                );
                return;
              }
              const endedAtMs = Date.now();
              this.finishTrace(pending);
              this.finish(pending);
              pending.resolve(outcome.result);
              this.emit({
                type: "completed",
                hostId: this.hostId,
                id: requestId,
                clientUserMessageId: pending.clientUserMessageId,
                endedAtMs,
                result: outcome.result,
                ...this.timing(pending, endedAtMs, outcome.hostMetrics),
              });
            },
            (error: unknown) => this.fail(pending, error),
          );
        },
      });
      this.pumpQueue();
    });
    if (configKey === null) return result;
    const entry = { request: pending, promise: result };
    entry.promise = result.finally(() => {
      if (this.configReads.get(configKey) === entry) this.configReads.delete(configKey);
    });
    this.configReads.set(configKey, entry);
    return entry.promise;
  }

  private isPending(request: PendingRequest): boolean {
    return this.pending.get(request.id) === request;
  }

  private pumpQueue(): void {
    for (;;) {
      const index = this.getNextRequestIndex();
      if (index === -1) return;
      const [next] = this.queuedRequests.splice(index, 1);
      next?.dispatch();
    }
  }

  private getNextRequestIndex(): number {
    if (this.useHostRequestScheduler) return this.queuedRequests.length > 0 ? 0 : -1;
    const critical = this.queuedRequests.findIndex((request) => request.priority === "critical");
    if (critical !== -1 && this.inFlightRequestCount < MAX_IN_FLIGHT_REQUESTS) return critical;
    if (
      this.inFlightRequestCount >= MAX_IN_FLIGHT_REQUESTS ||
      this.noncriticalRequestCount >= MAX_NONCRITICAL_REQUESTS
    )
      return -1;
    const interactive = this.queuedRequests.findIndex(
      (request) => request.priority === "interactive",
    );
    const background =
      this.backgroundRequestCount < MAX_BACKGROUND_REQUESTS && this.backgroundYieldsInProgress === 0
        ? this.queuedRequests.findIndex((request) => request.priority === "background")
        : -1;
    if (
      background !== -1 &&
      (interactive === -1 ||
        this.interactiveDispatchesSinceBackground >= INTERACTIVE_DISPATCHES_BEFORE_BACKGROUND)
    )
      return background;
    return interactive;
  }

  private startRequest(request: PendingRequest, params: unknown): void {
    request.startedAtMs = Date.now();
    if (request.trace) {
      recordCodexRequestTraceSpan({
        trace: request.trace,
        name: "app_server.renderer_queue_wait",
        startTimeMs: request.queuedAtMs,
        endTimeMs: request.startedAtMs,
        attributes: {
          "app_server.method": request.method,
          "app_server.priority": request.priority,
          "app_server.source": request.source,
        },
      });
    }
    this.inFlightRequestCount += 1;
    if (request.priority !== "critical") this.noncriticalRequestCount += 1;
    if (request.priority === "background") {
      this.backgroundRequestCount += 1;
      this.interactiveDispatchesSinceBackground = 0;
    } else if (request.priority === "interactive") {
      this.interactiveDispatchesSinceBackground += 1;
    }
    this.inFlight.add(request);
    const activeBackgroundCount = this.backgroundRequestCount - this.backgroundYieldsInProgress;
    for (const item of this.inFlight) {
      item.peakInFlightRequestCount = Math.max(
        item.peakInFlightRequestCount,
        this.inFlightRequestCount,
      );
      item.peakBackgroundInFlightRequestCount = Math.max(
        item.peakBackgroundInFlightRequestCount,
        activeBackgroundCount,
      );
    }
    if (request.timeoutMs > 0)
      request.timeout = setTimeout(() => this.onTimeout(request), request.timeoutMs);
    this.emit({
      type: "started",
      hostId: this.hostId,
      id: request.id,
      method: request.method,
      params,
      conversationId: codexRequestConversationId(params),
      priority: request.priority,
      source: request.source,
      queueWaitMs: request.startedAtMs - request.queuedAtMs,
      startedAtMs: request.startedAtMs,
      timeoutMs: request.timeoutMs,
      clientUserMessageId: request.clientUserMessageId,
    });
  }

  private timing(
    request: PendingRequest,
    endedAtMs: number,
    hostMetrics?: CodexNativeResponseMetadata["hostMetrics"],
  ): CodexRequestLifecycleTiming {
    const startedAtMs = request.startedAtMs ?? request.queuedAtMs;
    return {
      method: request.method,
      priority: request.priority,
      source: request.source,
      timeoutMs: request.timeoutMs,
      durationMs: endedAtMs - request.queuedAtMs,
      queueWaitMs: startedAtMs - request.queuedAtMs,
      requestDurationMs: endedAtMs - startedAtMs,
      queuedRequestCountAtEnqueue: request.queuedRequestCountAtEnqueue,
      peakInFlightRequestCount: request.peakInFlightRequestCount,
      peakBackgroundInFlightRequestCount: request.peakBackgroundInFlightRequestCount,
      coalescedRequestCount: request.coalescedRequestCount,
      ...(request.trace ? { trace: request.trace } : {}),
      hostMetrics,
    };
  }

  private finish(request: PendingRequest): void {
    clearTimeout(request.timeout);
    request.timeout = undefined;
    this.releaseRequestCapacity(request);
    if (this.isPending(request)) this.pending.delete(request.id);
  }

  private finishTrace(request: PendingRequest, error?: unknown): void {
    if (error === undefined) request.interactionTrace?.finish();
    else request.interactionTrace?.finish(error);
    finishCodexWorkspaceDiscovery(request.discoveryInteraction, error);
  }

  private releaseRequestCapacity(request: PendingRequest): void {
    if (request.capacityReleased) return;
    request.capacityReleased = true;
    if (request.startedAtMs !== null) {
      this.inFlightRequestCount -= 1;
      this.inFlight.delete(request);
      if (request.priority !== "critical") this.noncriticalRequestCount -= 1;
    }
    this.resumeQueueAfter(request);
  }

  private resumeQueueAfter(request: PendingRequest): void {
    if (request.priority !== "background" || request.startedAtMs === null) {
      this.pumpQueue();
      return;
    }
    this.backgroundYieldsInProgress += 1;
    this.pumpQueue();
    void releaseBackgroundYield().then(() => {
      this.backgroundRequestCount -= 1;
      this.backgroundYieldsInProgress -= 1;
      this.pumpQueue();
    });
  }

  private lateResponse(
    request: PendingRequest,
    hostMetrics?: CodexNativeResponseMetadata["hostMetrics"],
  ): void {
    if (hostMetrics && !this.disposed && request.epoch === this.epoch)
      this.emit({ type: "late-response", hostId: this.hostId, id: request.id, hostMetrics });
  }

  private fail(
    request: PendingRequest,
    error: unknown,
    hostMetrics?: CodexNativeResponseMetadata["hostMetrics"],
    rejection = error,
  ): void {
    if (!this.isPending(request)) {
      this.lateResponse(request, hostMetrics);
      return;
    }
    const endedAtMs = Date.now();
    this.finishTrace(request, error);
    this.finish(request);
    request.reject(rejection);
    this.emit({
      type: "failed",
      hostId: this.hostId,
      id: request.id,
      clientUserMessageId: request.clientUserMessageId,
      endedAtMs,
      error,
      ...this.timing(request, endedAtMs, hostMetrics),
    });
  }

  private onTimeout(request: PendingRequest): void {
    if (!this.isPending(request)) return;
    if (request.onOutcomeUnknown) {
      this.onDelivery({
        type: "outcome-unknown",
        delivery: { requestId: request.id, method: request.method, stage: "outcome-unknown" },
      });
      if (this.useHostRequestScheduler) request.abandon("timeout");
      return;
    }
    const endedAtMs = Date.now();
    const error = new Error("Timeout");
    if (this.useHostRequestScheduler) request.abandon("timeout");
    this.finishTrace(request, error);
    this.finish(request);
    request.reject(error);
    this.emit({
      type: "timed-out",
      hostId: this.hostId,
      id: request.id,
      clientUserMessageId: request.clientUserMessageId,
      endedAtMs,
      error,
      ...this.timing(request, endedAtMs),
    });
  }

  onDelivery(update: CodexNativeRequestDeliveryUpdate): void {
    const pending = this.pending.get(update.delivery.requestId);
    if (!pending) return;
    if (update.type === "failed") {
      this.fail(pending, new CodexTurnDeliveryError(update.message, update.delivery));
      return;
    }
    if (pending.outcomeUnknown || !pending.onOutcomeUnknown) return;
    pending.outcomeUnknown = true;
    clearTimeout(pending.timeout);
    pending.timeout = undefined;
    this.releaseRequestCapacity(pending);
    try {
      pending.onOutcomeUnknown(update.delivery);
    } catch {
      /* Listener failure must not retire the retained native response. */
    }
  }

  private emit(event: CodexRequestLifecycleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Observers do not own request settlement. */
      }
    }
  }

  /** Ends the current host lifetime without preventing requests on its replacement. */
  retire(): void {
    this.epoch += 1;
    this.configReads.clear();
    this.rejectPending(new Error("App server request lifetime retired"));
  }

  private rejectPending(error: Error): void {
    const requests = [...this.pending.values()];
    // Prevent capacity release from dispatching another queued request while the whole client is
    // being retired. Upstream's queue is gone as one lifetime; preserve that boundary here too.
    this.queuedRequests.length = 0;
    for (const pending of requests) {
      if (this.useHostRequestScheduler) pending.abandon("disposed");
      this.fail(pending, error);
    }
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(new Error("App server request client disposed"));
    this.configReads.clear();
    this.listeners.clear();
  }
}
