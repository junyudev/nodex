import { RpcTarget, type RpcStub } from "capnweb";
import type { CodexTranscriptEvent } from "./codex-transcript-projection";
import type { CodexTranscriptSubscription } from "./codex-transcript-subscription";
import type { CodexHistoryViewportBoundary } from "./codex-history-policy";

export interface CodexTranscriptReadRpcSubscription {
  unsubscribe(): void;
  setHistoryViewport(boundaries: readonly (CodexHistoryViewportBoundary | null)[]): void;
}

export interface CodexTranscriptReadRpcService {
  subscribe(
    threadId: string,
    listener: (event: CodexTranscriptEvent) => Promise<void>,
  ): CodexTranscriptReadRpcSubscription;
}

/** A read capability borrows the manager's projection; it never accepts canonical writes. */
export class CodexTranscriptReadService extends RpcTarget implements CodexTranscriptReadRpcService {
  constructor(
    private readonly open: (
      threadId: string,
      listener: (event: CodexTranscriptEvent) => Promise<void>,
    ) => CodexTranscriptSubscription,
    private readonly setViewport?: (
      threadId: string,
      viewer: symbol,
      boundaries: readonly (CodexHistoryViewportBoundary | null)[] | undefined,
    ) => void,
  ) {
    super();
  }

  subscribe(
    threadId: string,
    listener: (event: CodexTranscriptEvent) => Promise<void>,
  ): CodexTranscriptReadRpcSubscription {
    // RPC owns argument stubs only until this call returns. Retain the callback for the session.
    const retained = (listener as RpcStub<typeof listener>).dup?.() ?? listener;
    const viewer = Symbol("transcript-read-viewer");
    let alive = true;
    const release = () => {
      if (!alive) return;
      alive = false;
      this.setViewport?.(threadId, viewer, undefined);
      (retained as Partial<Disposable>)[Symbol.dispose]?.();
    };
    try {
      const subscription = this.open(threadId, retained);
      this.setViewport?.(threadId, viewer, [null]);
      void subscription.completion.then(release, release);
      return new CodexTranscriptReadSession(subscription, release, (boundaries) => {
        if (alive) this.setViewport?.(threadId, viewer, boundaries);
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

class CodexTranscriptReadSession extends RpcTarget implements CodexTranscriptReadRpcSubscription {
  constructor(
    private readonly subscription: CodexTranscriptSubscription,
    private readonly release: () => void,
    private readonly setViewport: (
      boundaries: readonly (CodexHistoryViewportBoundary | null)[],
    ) => void,
  ) {
    super();
  }
  unsubscribe(): void {
    try {
      this.subscription.dispose();
    } finally {
      this.release();
    }
  }
  [Symbol.dispose](): void {
    this.unsubscribe();
  }
  setHistoryViewport(boundaries: readonly (CodexHistoryViewportBoundary | null)[]): void {
    this.setViewport(boundaries);
  }
}
