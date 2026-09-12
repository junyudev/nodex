/* oxlint-disable effecttsgo/async-function -- Cap'n Web RPC methods adapt scoped Effect operations. */
import { RpcTarget, type RpcStub } from "capnweb";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type {
  ThreadReadStateChange,
  ThreadReadStateEvent,
  ThreadReadStateRpcOpenResult,
} from "../../../shared/codex-thread-read-state";
import type { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import type { CodexThreadReadState } from "../../codex-application/CodexThreadReadState";
import type { IdentityReadStateSession } from "../../codex-application/CodexIdentityReadState";

class ReadStateSession extends RpcTarget {
  private disposed = false;
  constructor(
    private readonly session: IdentityReadStateSession,
    private readonly callbacks: ScopedCallbackRuntime["Service"],
    private readonly cleanup: () => void,
  ) {
    super();
  }
  set(change: ThreadReadStateChange) {
    return this.callbacks.runPromise(this.session.set(change));
  }
  clearForLogout() {
    return this.callbacks.runPromise(this.session.clearForLogout);
  }
  unsubscribe(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.callbacks.fork(this.session.unsubscribe);
    this.cleanup();
  }
  [Symbol.dispose](): void {
    this.unsubscribe();
  }
}

/** Each RPC callback capability and its event subscription have one window-owned lifetime. */
export class CodexThreadReadStateService extends RpcTarget {
  constructor(
    private readonly owner: CodexThreadReadState["Service"],
    private readonly callbacks: ScopedCallbackRuntime["Service"],
    private readonly scope: Scope.Scope,
  ) {
    super();
  }
  getExecutionHostKeys() {
    return this.callbacks.runPromise(this.owner.getExecutionHostKeys);
  }
  async open(
    listener: RpcStub<(event: ThreadReadStateEvent) => void>,
  ): Promise<ThreadReadStateRpcOpenResult> {
    const callback = listener.dup();
    let target: ReadStateSession | undefined;
    let child: Scope.Closeable | undefined;
    let disposed = false;
    let retired = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      callback[Symbol.dispose]();
      if (child) this.callbacks.fork(Scope.close(child, Exit.void));
    };
    try {
      const result = await this.callbacks.runPromise(
        this.owner.openSession((event) =>
          Effect.sync(() => {
            const pending = callback(event);
            try {
              if (event.type === "retired") {
                retired = true;
                target?.unsubscribe();
              }
            } finally {
              pending[Symbol.dispose]();
            }
          }),
        ),
      );
      if (result.status !== "ready") {
        cleanup();
        return result;
      }
      child = await this.callbacks.runPromise(Scope.fork(this.scope, "sequential"));
      target = new ReadStateSession(result.session, this.callbacks, cleanup);
      const session = target;
      await this.callbacks.runPromise(
        Effect.addFinalizer(() => Effect.sync(() => session.unsubscribe())).pipe(
          Effect.provideService(Scope.Scope, child),
        ),
      );
      callback.onRpcBroken(() => session.unsubscribe());
      if (retired) session.unsubscribe();
      return {
        status: "ready",
        identity: result.session.identity,
        executionHostKeysByHostId: result.session.executionHostKeysByHostId,
        unreadThreadIdsByHostId: result.session.unreadThreadIdsByHostId,
        session,
      };
    } catch (error) {
      target?.unsubscribe();
      cleanup();
      throw error;
    }
  }
}
