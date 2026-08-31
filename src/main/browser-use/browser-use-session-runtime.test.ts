import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import type { BrowserUseCdpEvent, BrowserUseIabAsyncRuntime } from "./browser-use-iab-api";
import type { BrowserUseNativePipeRequestHandler } from "./browser-use-native-pipe-server";
import {
  makeBrowserUseSessionRuntime,
  type BrowserUseRouteCapture,
} from "./browser-use-session-runtime";

class FakeApi {
  activeControl = false;
  activeDispatches = 0;
  disposed = false;
  readonly endedTurns: string[] = [];
  maxActiveDispatches = 0;
  private releaseBlockedDispatch: (() => void) | null = null;
  private releaseBlockedTurnEnd: (() => void) | null = null;
  private resolveBlockedTurnEndStarted: (() => void) | null = null;
  private blockedTurnEndStarted: Promise<void> | null = null;

  addCdpEventListener(listener: (event: BrowserUseCdpEvent) => void) {
    void listener;
    return () => undefined;
  }

  async dispatch(method: string): Promise<unknown> {
    this.activeDispatches += 1;
    this.maxActiveDispatches = Math.max(this.maxActiveDispatches, this.activeDispatches);
    try {
      if (method === "wait-for-release") {
        await new Promise<void>((resolve) => {
          this.releaseBlockedDispatch = resolve;
        });
      }
      if (method === "release") this.releaseBlockedDispatch?.();
      return method;
    } finally {
      this.activeDispatches -= 1;
    }
  }

  getInfo(): Record<string, unknown> {
    return {};
  }

  hasActiveControl(): boolean {
    return this.activeControl;
  }

  notifyCursorArrived(moveSequence: number): void {
    void moveSequence;
  }

  ping(): string {
    return "pong";
  }

  async turnEnded(params: unknown): Promise<void> {
    this.endedTurns.push((params as { turn_id: string }).turn_id);
    this.resolveBlockedTurnEndStarted?.();
    if (this.blockedTurnEndStarted !== null) {
      await new Promise<void>((resolve) => {
        this.releaseBlockedTurnEnd = resolve;
      });
    }
  }

  blockTurnEnd(): Promise<void> {
    this.blockedTurnEndStarted = new Promise<void>((resolve) => {
      this.resolveBlockedTurnEndStarted = resolve;
    });
    return this.blockedTurnEndStarted;
  }

  releaseTurnEnd(): void {
    this.releaseBlockedTurnEnd?.();
    this.blockedTurnEndStarted = null;
    this.resolveBlockedTurnEndStarted = null;
    this.releaseBlockedTurnEnd = null;
  }
}

class FakeServer {
  released = false;

  constructor(
    readonly pipePath: string,
    private readonly handler: BrowserUseNativePipeRequestHandler,
  ) {}

  handle(method: string): Promise<unknown> {
    return Promise.resolve(
      this.handler(
        { jsonrpc: "2.0", method },
        { connectionId: "test-connection", notification: false },
      ),
    );
  }

  broadcast(method: string, params?: unknown): void {
    void method;
    void params;
  }
}

const capture = (overrides: Partial<BrowserUseRouteCapture> = {}): BrowserUseRouteCapture => ({
  browserConversationId: "session-1",
  browserViewScopeId: "window-session-1",
  codexSessionId: "thread-1",
  ownerWebContentsId: 101,
  projectId: "project-1",
  ...overrides,
});

const makeTestRuntime = Effect.gen(function* () {
  const apis: FakeApi[] = [];
  const asyncRuntimes: BrowserUseIabAsyncRuntime[] = [];
  const servers: FakeServer[] = [];
  const scope = yield* Scope.make();
  const runtime = yield* makeBrowserUseSessionRuntime(true, {
    createApi: (_route, asyncRuntime) => {
      const api = new FakeApi();
      apis.push(api);
      asyncRuntimes.push(asyncRuntime);
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            api.disposed = true;
          }),
        );
        return api;
      });
    },
    createServer: (handler) => {
      const server = new FakeServer(`/tmp/fake-${servers.length}.sock`, handler);
      servers.push(server);
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.released = true;
          }),
        );
        return server;
      });
    },
  }).pipe(Effect.provideService(Scope.Scope, scope));
  return { apis, asyncRuntimes, runtime, scope, servers };
});

it.effect("reuses one scoped backend for an exact route", () =>
  Effect.gen(function* () {
    const { apis, runtime, scope, servers } = yield* makeTestRuntime;
    const first = yield* runtime.captureRoute(capture());
    const second = yield* runtime.captureRoute(capture());

    assert.strictEqual(first.pipePath, "/tmp/fake-0.sock");
    assert.strictEqual(second.pipePath, first.pipePath);
    assert.lengthOf(apis, 1);
    assert.lengthOf(servers, 1);
    assert.deepEqual(runtime.availableBackends(), ["iab"]);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(apis[0]!.disposed);
    assert.isTrue(servers[0]!.released);
  }),
);

it.effect("allows interdependent native pipe commands to make progress concurrently", () =>
  Effect.gen(function* () {
    const { apis, runtime, scope, servers } = yield* makeTestRuntime;
    yield* runtime.captureRoute(capture());

    yield* Effect.promise(() =>
      Promise.all([servers[0]!.handle("wait-for-release"), servers[0]!.handle("release")]),
    );

    assert.strictEqual(apis[0]!.maxActiveDispatches, 2);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("waits for in-flight commands before ending a Browser turn", () =>
  Effect.gen(function* () {
    const { apis, runtime, scope, servers } = yield* makeTestRuntime;
    yield* runtime.captureRoute(capture());
    yield* runtime.turnStarted({ sessionId: "thread-1", turnId: "turn-1" });

    const blockedDispatch = servers[0]!.handle("wait-for-release");
    yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    const ending = yield* Effect.forkChild(
      runtime.turnEnded({ sessionId: "thread-1", turnId: "turn-1" }),
    );
    yield* Effect.yieldNow;

    assert.deepEqual(apis[0]!.endedTurns, []);
    yield* Effect.promise(() => servers[0]!.handle("release"));
    yield* Effect.promise(() => blockedDispatch);
    yield* Fiber.join(ending);

    assert.deepEqual(apis[0]!.endedTurns, ["turn-1"]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("runs IAB waits on the session clock and releases their registration", () =>
  Effect.gen(function* () {
    const { asyncRuntimes, runtime, scope } = yield* makeTestRuntime;
    yield* runtime.captureRoute(capture());
    let released = false;
    const result = asyncRuntimes[0]!.waitFor(
      () => () => {
        released = true;
      },
      1_000,
      () => "timeout",
    );

    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");
    assert.strictEqual(yield* Effect.promise(() => result), "timeout");
    assert.isTrue(released);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects route theft while controlled pages are live", () =>
  Effect.gen(function* () {
    const { apis, runtime, scope } = yield* makeTestRuntime;
    yield* runtime.captureRoute(capture());
    apis[0]!.activeControl = true;

    const error = yield* Effect.flip(
      runtime.captureRoute(
        capture({ browserViewScopeId: "window-session-2", ownerWebContentsId: 202 }),
      ),
    );
    assert.include(String(error.cause), "live controlled pages");
    assert.strictEqual((yield* runtime.debugSnapshot).sessions[0]?.ownerWebContentsId, 101);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("atomically replaces a provisional route with its Codex session", () =>
  Effect.gen(function* () {
    const { apis, runtime, scope, servers } = yield* makeTestRuntime;
    yield* Effect.all(
      [
        runtime.captureRoute(capture({ codexSessionId: "session-1" })),
        runtime.captureRoute(capture({ codexSessionId: "thread-1" })),
      ],
      { concurrency: "unbounded" },
    );

    const snapshot = yield* runtime.debugSnapshot;
    assert.lengthOf(snapshot.sessions, 1);
    assert.strictEqual(snapshot.sessions[0]?.browserConversationId, "session-1");
    assert.strictEqual(snapshot.sessions[0]?.sessionId, "thread-1");
    assert.lengthOf(apis, 2);
    assert.isTrue(apis[0]!.disposed);
    assert.isTrue(servers[0]!.released);
    assert.isFalse(servers[1]!.released);
    assert.isTrue(snapshot.events.some((event) => event.kind === "provisional-route-rebound"));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("serializes turn completion and ignores stale completion", () =>
  Effect.gen(function* () {
    const { apis, runtime, scope } = yield* makeTestRuntime;
    yield* runtime.captureRoute(capture());
    yield* runtime.turnStarted({ sessionId: "thread-1", turnId: "turn-2" });
    yield* runtime.turnEnded({ sessionId: "thread-1", turnId: "turn-1" });
    yield* runtime.turnEnded({ sessionId: "thread-1", turnId: "turn-2" });

    assert.deepEqual(apis[0]?.endedTurns, ["turn-2"]);
    assert.isTrue(
      (yield* runtime.debugSnapshot).events.some(
        (event) => event.kind === "stale-turn-end-ignored",
      ),
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("does not release a replacement route when an old turn finishes", () =>
  Effect.gen(function* () {
    const { apis, runtime, scope } = yield* makeTestRuntime;
    yield* runtime.captureRoute(capture({ disposeAfterSessionActivity: true }));
    yield* runtime.turnStarted({ sessionId: "thread-1", turnId: "turn-1" });
    const oldTurnEndStarted = apis[0]!.blockTurnEnd();
    const ending = yield* Effect.forkChild(
      runtime.turnEnded({ sessionId: "thread-1", turnId: "turn-1" }),
    );
    yield* Effect.promise(() => oldTurnEndStarted);

    yield* runtime.captureRoute(
      capture({ browserViewScopeId: "window-session-2", ownerWebContentsId: 202 }),
    );
    assert.lengthOf(apis, 2);
    apis[0]!.releaseTurnEnd();
    yield* Fiber.join(ending);

    const snapshot = yield* runtime.debugSnapshot;
    assert.lengthOf(snapshot.sessions, 1);
    assert.strictEqual(snapshot.sessions[0]?.ownerWebContentsId, 202);
    assert.isFalse(apis[1]!.disposed);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("invalidates every backend owned by a renderer", () =>
  Effect.gen(function* () {
    const { apis, runtime, scope, servers } = yield* makeTestRuntime;
    yield* runtime.captureRoute(capture());
    yield* runtime.releaseOwner(101);

    assert.deepEqual((yield* runtime.debugSnapshot).sessions, []);
    assert.isTrue(apis[0]!.disposed);
    assert.isTrue(servers[0]!.released);
    yield* Scope.close(scope, Exit.void);
  }),
);
