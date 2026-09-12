import type { CodexRequestLifecycleEvent } from "../../../shared/codex-request-lifecycle";
import {
  codexRequestSource,
  codexRendererRequestPriority,
} from "../../../shared/codex-request-policy";
import type { ThreadTurnsListParams } from "@nodex/codex-app-server-protocol/v2/ThreadTurnsListParams";
import type { ThreadTurnsListResponse } from "@nodex/codex-app-server-protocol/v2/ThreadTurnsListResponse";
import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import type {
  ClientRequestMethod,
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { ClientRequest } from "@nodex/codex-app-server-protocol";
import { runConversationOperation } from "./local-conversation-deps";
import {
  RendererAppServerRequestClient,
  type RendererAppServerRequestOptions,
} from "./renderer-app-server-request-client";
import { subscribeCodexAppServerMessage } from "./app-server-message-bus";
import { CodexRequestAnalytics } from "./codex-request-analytics";
import { CodexRequestRecorder } from "./codex-request-recorder";
import { codexTurnFirstResponseTracker } from "./codex-turn-first-response";

export type NativeRequestOptions = Omit<RendererAppServerRequestOptions, "params">;

export class RendererNativeAppServer implements Disposable {
  private readonly client: RendererAppServerRequestClient;

  private readonly analytics: CodexRequestAnalytics;

  private readonly unsubscribeLifecycle: () => void;

  private readonly unsubscribeDelivery: () => void;

  constructor(private readonly hostId: string) {
    this.client = new RendererAppServerRequestClient(
      (requestId, reason) =>
        runConversationOperation("codex:app-server:request:abandon", { requestId, reason }),
      hostId,
    );
    const recorder = new CodexRequestRecorder(hostId);
    this.analytics = new CodexRequestAnalytics();
    this.unsubscribeLifecycle = this.client.addRequestLifecycleListener((event) => {
      recorder.handle(event);
      codexTurnFirstResponseTracker.handleRequestLifecycleEvent(event);
      if (event.type !== "started") this.analytics.handle(event);
    });
    this.unsubscribeDelivery = subscribeCodexAppServerMessage("mcp-request-delivery", (message) => {
      if (message.hostId === this.hostId) this.client.onDelivery(message.update);
    });
  }

  addRequestLifecycleListener(listener: (event: CodexRequestLifecycleEvent) => void): () => void {
    return this.client.addRequestLifecycleListener(listener);
  }

  getPendingRequestCount(): number {
    return this.client.getPendingRequestCount();
  }

  request(
    method: "thread/read",
    params: import("@nodex/codex-app-server-protocol/v2/ThreadReadParams").ThreadReadParams,
    options?: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2/ThreadReadResponse").ThreadReadResponse>;
  request(
    method: "thread/turns/list",
    params: ThreadTurnsListParams,
    options?: NativeRequestOptions,
  ): Promise<ThreadTurnsListResponse>;
  request(
    method: "thread/resume",
    params: ThreadResumeParams,
    options?: NativeRequestOptions,
  ): Promise<ThreadResumeResponse>;
  request(
    method: "thread/goal/get",
    params: import("@nodex/codex-app-server-protocol/v2").ThreadGoalGetParams,
    options?: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2").ThreadGoalGetResponse>;
  request(
    method: "thread/goal/set",
    params: import("@nodex/codex-app-server-protocol/v2").ThreadGoalSetParams,
    options?: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2").ThreadGoalSetResponse>;
  request(
    method: "thread/backgroundTerminals/list",
    params: import("@nodex/codex-app-server-protocol/v2").ThreadBackgroundTerminalsListParams,
    options?: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2").ThreadBackgroundTerminalsListResponse>;
  request<Method extends ClientRequestMethod>(
    method: Method,
    params: ClientRequestParamsByMethod[Method],
    options?: NativeRequestOptions,
  ): Promise<ClientRequestResponsesByMethod[Method]>;
  request(
    method: ClientRequestMethod,
    params: unknown,
    options?: NativeRequestOptions,
  ): Promise<unknown> {
    return this.client.sendNative(
      method,
      (caller, trace) =>
        runConversationOperation("codex:app-server:request", {
          hostId: this.hostId,
          request: {
            method,
            params,
            id: caller.requestId,
            ...(trace !== undefined ? { trace } : {}),
          } as ClientRequest & { trace?: RendererAppServerRequestOptions["trace"] },
          caller,
          scheduling: {
            priority: codexRendererRequestPriority(method, options?.priority),
            source: codexRequestSource(method, options?.source),
          },
        }),
      { ...options, params },
    );
  }

  executePreparedTurn(
    request: import("@nodex/codex-app-server-protocol/v2/TurnStartParams").TurnStartParams,
    options?: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2/TurnStartResponse").TurnStartResponse> {
    return this.client.sendNative(
      "turn/start",
      (caller, trace) =>
        runConversationOperation("codex:turn:native:execute", {
          hostId: this.hostId,
          request,
          caller,
          trace,
        }),
      {
        ...options,
        params: request,
        clientUserMessageId:
          options?.clientUserMessageId ?? request.clientUserMessageId ?? undefined,
      },
    );
  }

  executeSessionThread(
    prepared: import("../../../shared/codex-native-thread-start").CodexNativeSessionLaunchPreparation,
    options?: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2").ThreadStartResponse> {
    return this.client.sendNative(
      "thread/start",
      (caller, trace) =>
        runConversationOperation("codex:thread:native-session:execute", {
          hostId: this.hostId,
          receiptId: prepared.receiptId,
          caller,
          trace,
        }),
      { ...options, params: prepared.request },
    );
  }

  executeFreshTurn(
    threadId: string,
    launchId: string,
    request: import("@nodex/codex-app-server-protocol/v2").TurnStartParams,
    options?: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2").TurnStartResponse> {
    return this.client.sendNative(
      "turn/start",
      (caller, trace) =>
        runConversationOperation("codex:turn:native-fresh:execute", {
          hostId: this.hostId,
          threadId,
          launchId,
          request,
          caller,
          trace,
        }),
      {
        ...options,
        params: request,
        clientUserMessageId:
          options?.clientUserMessageId ?? request.clientUserMessageId ?? undefined,
      },
    );
  }

  executePreparedFork(
    receiptId: string,
    options?: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2").ThreadForkResponse> {
    return this.client.sendNative(
      "thread/fork",
      (caller, trace) =>
        runConversationOperation("codex:thread:native-fork:execute", {
          hostId: this.hostId,
          receiptId,
          caller,
          trace,
        }),
      options,
    );
  }

  injectPreparedTurn(
    operation: import("../../../shared/codex-thread-follower-request").ConversationFollowerTurnStart,
    options?: NativeRequestOptions,
  ): Promise<void> {
    return this.client.sendNative(
      "thread/inject_items",
      (caller, trace) =>
        runConversationOperation("codex:turn:native:inject", {
          hostId: this.hostId,
          operation,
          caller,
          trace,
        }),
      {
        ...options,
        params: { threadId: operation.request.threadId, items: operation.context?.responseItems },
      },
    );
  }

  executePreparedSteer(
    request: import("../../../shared/codex-conversation-state/codex-owner-steer").CanonicalSteerNativeRequest,
    clientUserMessageId: string,
    options: NativeRequestOptions,
  ): Promise<import("@nodex/codex-app-server-protocol/v2/TurnSteerResponse").TurnSteerResponse> {
    return this.client.sendNative(
      request.method,
      (caller, trace) =>
        runConversationOperation("codex:turn:native-steer:execute", {
          hostId: this.hostId,
          request,
          clientUserMessageId,
          caller,
          trace,
        }),
      { ...options, params: request.params, clientUserMessageId },
    );
  }

  retire(): void {
    this.client.retire();
  }

  [Symbol.dispose](): void {
    this.unsubscribeDelivery();
    this.unsubscribeLifecycle();
    this.analytics[Symbol.dispose]();
    this.client[Symbol.dispose]();
  }
}
