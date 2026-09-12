import type { IpcApi } from "./ipc-api";
import type { RequestId } from "@nodex/codex-app-server-protocol";
import type {
  CodexNativeRequestOutcome,
  CodexNativeResponseEnvelope,
} from "./codex-native-request-outcome";
import { CodexTurnDeliveryError } from "./codex-conversation-state/codex-turn-delivery";

export const CODEX_NATIVE_IPC_CHANNELS = [
  "codex:app-server:request",
  "codex:turn:native:execute",
  "codex:thread:native-session:execute",
  "codex:turn:native-fresh:execute",
  "codex:thread:native-fork:execute",
  "codex:turn:native:inject",
  "codex:turn:native-steer:execute",
] as const satisfies readonly (keyof IpcApi)[];

export type CodexNativeIpcChannel = (typeof CODEX_NATIVE_IPC_CHANNELS)[number];

export const isCodexNativeIpcChannel = (channel: string): channel is CodexNativeIpcChannel =>
  CODEX_NATIVE_IPC_CHANNELS.some((native) => native === channel);

const nativeMethods: Record<CodexNativeIpcChannel, string> = {
  "codex:app-server:request": "",
  "codex:turn:native:execute": "turn/start",
  "codex:thread:native-session:execute": "thread/start",
  "codex:turn:native-fresh:execute": "turn/start",
  "codex:thread:native-fork:execute": "thread/fork",
  "codex:turn:native:inject": "thread/inject_items",
  "codex:turn:native-steer:execute": "turn/steer",
};

export function codexNativeIpcMethod(
  channel: CodexNativeIpcChannel,
  input: IpcApi[CodexNativeIpcChannel]["args"][0],
): string {
  return "request" in input && "method" in input.request
    ? input.request.method
    : nativeMethods[channel];
}

interface PendingResponse {
  readonly hostId: string;
  readonly resolve: (result: CodexNativeRequestOutcome<unknown>) => void;
  readonly reject: (error: unknown) => void;
}

/** Physical invoke acknowledges dispatch; the host response stream settles the original caller. */
export class CodexNativeIpcClient implements Disposable {
  private readonly pending = new Map<RequestId, PendingResponse>();
  private disposed = false;

  invoke<Channel extends CodexNativeIpcChannel>(
    channel: Channel,
    args: IpcApi[Channel]["args"],
    dispatch: () => Promise<unknown>,
  ): Promise<IpcApi[Channel]["result"]> {
    const input = args[0];
    const id = input.caller.requestId;
    if (this.disposed) return Promise.reject(new Error("Native response client is disposed"));
    if (this.pending.has(id))
      return Promise.reject(new Error(`Native request '${id}' on '${channel}' is already pending`));
    const result = new Promise<CodexNativeRequestOutcome<unknown>>((resolve, reject) => {
      const pending = { hostId: input.hostId, resolve, reject };
      this.pending.set(id, pending);
      const fail = (error: unknown) => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        reject(
          input.caller.retainResponse
            ? new CodexTurnDeliveryError(
                error instanceof Error ? error.message : "App server request dispatch failed",
                { requestId: id, method: codexNativeIpcMethod(channel, input), stage: "not-sent" },
                { cause: error },
              )
            : error,
        );
      };
      try {
        void dispatch().catch(fail);
      } catch (error) {
        fail(error);
      }
    });
    return result as Promise<IpcApi[Channel]["result"]>;
  }

  receive(response: CodexNativeResponseEnvelope): void {
    if (response.type === "mcp-request-delivery") {
      if (response.update.type !== "failed") return;
      const { delivery, message } = response.update;
      const pending = this.pending.get(delivery.requestId);
      if (!pending || pending.hostId !== response.hostId) return;
      this.pending.delete(delivery.requestId);
      pending.resolve({
        type: "error",
        hostId: response.hostId,
        error: { code: null, message, delivery },
      });
      return;
    }
    const pending = this.pending.get(response.message.id);
    if (!pending || pending.hostId !== response.hostId) return;
    this.pending.delete(response.message.id);
    const metadata = { hostId: response.hostId, hostMetrics: response.hostMetrics };
    pending.resolve(
      response.message.error === undefined
        ? { ...metadata, type: "result", result: response.message.result }
        : { ...metadata, type: "error", error: response.message.error },
    );
  }

  abandon(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.reject(new Error("Native request caller was disposed"));
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    for (const pending of this.pending.values())
      pending.reject(new Error("Native response client is disposed"));
    this.pending.clear();
  }
}
