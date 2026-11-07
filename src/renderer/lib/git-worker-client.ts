import {
  GIT_WORKER_PROTOCOL_VERSION,
  isGitWorkerMessageForView,
  type GitWorkerMessageForView,
  type GitWorkerMethod,
  type GitWorkerMethodMap,
  type GitWorkerRequest,
} from "../../shared/git-worker-protocol";

export interface GitWorkerClientBridge {
  send(message: import("../../shared/git-worker-protocol").GitWorkerMessageFromView): Promise<void>;
  subscribe(listener: (message: GitWorkerMessageForView) => void): () => void;
}

interface PendingRequest {
  method: GitWorkerMethod;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

export class GitWorkerTransportError extends Error {
  readonly code: "protocol-error" | "worker-unavailable";

  constructor(code: "protocol-error" | "worker-unavailable", message: string) {
    super(message);
    this.name = "GitWorkerTransportError";
    this.code = code;
  }
}

function createAbortError(): Error {
  return new DOMException("Git worker request was canceled", "AbortError");
}

export class GitWorkerClient {
  readonly #bridge: GitWorkerClientBridge;
  readonly #createRequestId: () => string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(message: GitWorkerMessageForView) => void>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(bridge: GitWorkerClientBridge, options: { createRequestId?: () => string } = {}) {
    this.#bridge = bridge;
    this.#createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
    this.#unsubscribe = bridge.subscribe((message) => {
      this.#handleMessage(message);
    });
  }

  request<Method extends GitWorkerMethod>(input: {
    method: Method;
    params: GitWorkerMethodMap[Method]["params"];
    signal?: AbortSignal;
  }): Promise<GitWorkerMethodMap[Method]["result"]> {
    if (this.#disposed) {
      return Promise.reject(
        new GitWorkerTransportError("worker-unavailable", "Git worker client is disposed"),
      );
    }
    if (input.signal?.aborted) return Promise.reject(createAbortError());
    const id = this.#createRequestId();
    const request = {
      type: "worker-request",
      workerId: "git",
      request: {
        id,
        method: input.method,
        params: input.params,
        enqueuedAtMs: Date.now(),
      },
    } as GitWorkerRequest;

    return new Promise<GitWorkerMethodMap[Method]["result"]>((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        void this.#bridge
          .send({
            type: "worker-request-cancel",
            workerId: "git",
            id,
          })
          .catch(() => {});
        reject(createAbortError());
      };
      const cleanup = () => input.signal?.removeEventListener("abort", abort);
      this.#pending.set(id, {
        method: input.method,
        resolve,
        reject,
        cleanup,
      });
      input.signal?.addEventListener("abort", abort, { once: true });
      void this.#bridge.send(request).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        pending.reject(error);
      });
    });
  }

  subscribe(listener: (message: GitWorkerMessageForView) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(
        new GitWorkerTransportError("worker-unavailable", "Git worker client was disposed"),
      );
    }
    this.#pending.clear();
    this.#listeners.clear();
  }

  #handleMessage(rawMessage: GitWorkerMessageForView): void {
    if (!isGitWorkerMessageForView(rawMessage)) return;
    if (rawMessage.type === "worker-restarted" || rawMessage.type === "git-live-query-event") {
      for (const listener of this.#listeners) listener(rawMessage);
      return;
    }
    const pending = this.#pending.get(rawMessage.id);
    if (!pending) return;
    this.#pending.delete(rawMessage.id);
    pending.cleanup();
    if (pending.method !== rawMessage.method) {
      pending.reject(
        new GitWorkerTransportError(
          "protocol-error",
          "Git worker response method did not match its request",
        ),
      );
      return;
    }
    if (rawMessage.result.type === "error") {
      pending.reject(
        new GitWorkerTransportError(rawMessage.result.error.code, rawMessage.result.error.message),
      );
      return;
    }
    pending.resolve(rawMessage.result.value);
  }
}

export const GIT_WORKER_CLIENT_PROTOCOL_VERSION = GIT_WORKER_PROTOCOL_VERSION;
