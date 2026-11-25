import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import type { BrowserUseCdpEvent, BrowserUseIabAsyncRuntime } from "./browser-use-iab-api";
import {
  type BrowserUseNativePipeRequestHandler,
  makeBrowserUseNativePipeServer,
  type BrowserUseNativePipeServerEvents,
} from "./browser-use-native-pipe-server";
import {
  makeBrowserUseSessionRuntime,
  type BrowserUseRouteCapture,
} from "./browser-use-session-runtime";
import { Duplex, PassThrough } from "node:stream";
import * as Queue from "effect/Queue";
import type { WindowsPipeConnection } from "../platform/node/WindowsDesktopTools";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { endianness } from "node:os";
import path from "node:path";
import {
  BrowserUseNativePipeFrameDecoder,
  encodeBrowserUseNativePipeFrame,
} from "./native-pipe-framing";
import {
  createBrowserUsePeerAuthorizer,
  makeWindowsBrowserPeerAuthorizer,
} from "./browser-use-peer-authorizer";

describe("browser-use-session-runtime", () => {
  class FakeApi {
    activeControl = false;
    activeDispatches = 0;
    disposed = false;
    readonly endedTurns: string[] = [];
    maxActiveDispatches = 0;
    readonly focusedTabIds: number[] = [];
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

    focusControlledTab(tabId: number): boolean {
      this.focusedTabIds.push(tabId);
      return true;
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

    controlRelease: Promise<void> | null = null;
    async releaseSessionControl(): Promise<void> {
      this.activeControl = false;
      if (this.controlRelease) await this.controlRelease;
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

  it.effect("focuses a presentation through the exact Browser Use session", () =>
    Effect.gen(function* () {
      const { apis, runtime, scope } = yield* makeTestRuntime;
      yield* runtime.captureRoute(capture());

      assert.isTrue(yield* runtime.focusPresentation({ sessionId: "thread-1", tabId: 7 }));
      assert.deepEqual(apis[0]!.focusedTabIds, [7]);
      assert.isFalse(yield* runtime.focusPresentation({ sessionId: "missing", tabId: 7 }));
      assert.isFalse(yield* runtime.focusPresentation({ sessionId: "thread-1", tabId: 0 }));

      yield* Scope.close(scope, Exit.void);
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

  it.effect("ending session activity releases control and preserves a reusable route", () =>
    Effect.gen(function* () {
      const { apis, runtime, scope } = yield* makeTestRuntime;
      yield* runtime.captureRoute(capture());
      apis[0]!.activeControl = true;
      yield* runtime.endSessionActivity("thread-1");
      assert.isFalse(apis[0]!.activeControl);
      assert.isFalse(apis[0]!.disposed);
      assert.lengthOf((yield* runtime.debugSnapshot).sessions, 1);
      assert.deepEqual(apis[0]!.endedTurns, []);
      yield* Scope.close(scope, Exit.void);
    }),
  );
  it.effect("ending temporary session activity disposes only that captured route", () =>
    Effect.gen(function* () {
      const { apis, runtime, scope, servers } = yield* makeTestRuntime;
      yield* runtime.captureRoute(capture({ disposeAfterSessionActivity: true }));
      apis[0]!.activeControl = true;
      yield* runtime.endSessionActivity("thread-1");
      assert.isTrue(apis[0]!.disposed);
      assert.isTrue(servers[0]!.released);
      assert.lengthOf((yield* runtime.debugSnapshot).sessions, 0);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("temporary activity retirement does not wait for a pending control release", () =>
    Effect.gen(function* () {
      const { apis, runtime, scope } = yield* makeTestRuntime;
      yield* runtime.captureRoute(capture({ disposeAfterSessionActivity: true }));
      let release: () => void = () => {};
      apis[0]!.controlRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      yield* runtime.endSessionActivity("thread-1");
      assert.isTrue(apis[0]!.disposed);
      assert.lengthOf((yield* runtime.debugSnapshot).sessions, 0);
      release();
      yield* Scope.close(scope, Exit.void);
    }),
  );
});

describe("browser-use-native-pipe-server", () => {
  const testUnixPipe = it.effect.skipIf(process.platform === "win32");

  const makeServer = (
    authorized: boolean,
    handler: BrowserUseNativePipeRequestHandler,
    events?: BrowserUseNativePipeServerEvents,
  ) =>
    Effect.acquireRelease(
      Effect.promise(() => {
        const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
        return fs.mkdtemp(path.join(temporaryRoot, "nxbu-"));
      }),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((nativePipeDirectory) =>
        makeBrowserUseNativePipeServer({
          events,
          handler,
          nativePipeDirectory: process.platform === "win32" ? undefined : nativePipeDirectory,
          platform: process.platform,
          socketPeerAuthorizer: () => ({
            authorized,
            ...(!authorized ? { reason: "test-denied" } : {}),
          }),
        }),
      ),
    );

  const connect = (pipePath: string): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });

  const connectScoped = (pipePath: string) =>
    Effect.acquireRelease(
      Effect.promise(() => connect(pipePath)),
      (socket) => Effect.sync(() => socket.destroy()),
    );

  const readOne = (socket: net.Socket): Promise<Record<string, unknown>> => {
    const decoder = new BrowserUseNativePipeFrameDecoder();
    return new Promise((resolve, reject) => {
      socket.on("data", (chunk) => {
        try {
          const [message] = decoder.push(chunk);
          if (message) resolve(JSON.parse(message) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    });
  };

  testUnixPipe("authorizes before reading and returns isolated JSON-RPC responses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer(true, (request, context) => ({
          connectionId: context.connectionId,
          method: request.method,
        }));
        const [first, second] = yield* Effect.all(
          [connectScoped(server.pipePath), connectScoped(server.pipePath)],
          { concurrency: 2 },
        );
        const firstResponse = readOne(first);
        const secondResponse = readOne(second);
        first.write(
          encodeBrowserUseNativePipeFrame(
            JSON.stringify({ jsonrpc: "2.0", id: "same-id", method: "ping" }),
          ),
        );
        second.write(
          encodeBrowserUseNativePipeFrame(
            JSON.stringify({ jsonrpc: "2.0", id: "same-id", method: "getInfo" }),
          ),
        );

        const [firstMessage, secondMessage] = yield* Effect.promise(() =>
          Promise.all([firstResponse, secondResponse]),
        );
        expect(firstMessage.id).toBe("same-id");
        expect(secondMessage.id).toBe("same-id");
        expect((firstMessage.result as { method: string }).method).toBe("ping");
        expect((secondMessage.result as { method: string }).method).toBe("getInfo");
        expect((firstMessage.result as { connectionId: string }).connectionId).not.toBe(
          (secondMessage.result as { connectionId: string }).connectionId,
        );
      }),
    ),
  );

  testUnixPipe("rejects unauthorized peers without dispatching a request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const server = yield* makeServer(false, () => {
          calls += 1;
        });
        const socket = yield* connectScoped(server.pipePath);
        socket.write(
          encodeBrowserUseNativePipeFrame(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
          ),
        );
        yield* Effect.promise(
          () => new Promise<void>((resolve) => socket.once("close", () => resolve())),
        );
        expect(calls).toBe(0);
      }),
    ),
  );

  // Named pipes do not expose POSIX directory or socket permission bits.
  testUnixPipe("uses restrictive directory and socket permissions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer(true, () => "pong");
        const directoryMode =
          (yield* Effect.promise(() => fs.stat(path.dirname(server.pipePath)))).mode & 0o777;
        const socketMode = (yield* Effect.promise(() => fs.stat(server.pipePath))).mode & 0o777;
        expect(directoryMode).toBe(0o700);
        expect(socketMode).toBe(0o600);
      }),
    ),
  );

  testUnixPipe("closes accepted sockets and removes the exact pipe with its Scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            fs.mkdtemp(
              path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "nxbu-release-"),
            ),
          ),
          (ownedDirectory) =>
            Effect.promise(() => fs.rm(ownedDirectory, { recursive: true, force: true })),
        );
        const parentScope = yield* Scope.Scope;
        const serverScope = yield* Scope.fork(parentScope);
        const server = yield* makeBrowserUseNativePipeServer({
          handler: () => "pong",
          nativePipeDirectory: process.platform === "win32" ? undefined : directory,
          platform: process.platform,
          socketPeerAuthorizer: () => ({ authorized: true }),
        }).pipe(Scope.provide(serverScope));
        const socket = yield* connectScoped(server.pipePath);
        const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

        yield* Scope.close(serverScope, Exit.void);
        yield* Effect.promise(() => socketClosed);

        yield* Effect.promise(() =>
          expect(connect(server.pipePath)).rejects.toMatchObject({ code: "ENOENT" }),
        );
        expect(socket.destroyed).toBe(true);
      }),
    ),
  );

  testUnixPipe("reports bounded request lifecycle metadata without request parameters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started: unknown[] = [];
        const completed: unknown[] = [];
        const server = yield* makeServer(true, () => "ok", {
          onRequestCompleted: (event) => completed.push(event),
          onRequestStarted: (event) => started.push(event),
        });
        const socket = yield* connectScoped(server.pipePath);
        const response = readOne(socket);
        socket.write(
          encodeBrowserUseNativePipeFrame(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "executeCdp",
              params: {
                method: "Page.navigate",
                params: { url: "https://private.example/path" },
                tabId: 1,
              },
            }),
          ),
        );

        expect(yield* Effect.promise(() => response)).toMatchObject({ id: 1, result: "ok" });
        expect(started).toEqual([
          expect.objectContaining({ label: "executeCdp:Page.navigate", notification: false }),
        ]);
        expect(completed).toEqual([
          expect.objectContaining({
            label: "executeCdp:Page.navigate",
            notification: false,
            outcome: "success",
          }),
        ]);
        expect(JSON.stringify({ started, completed })).not.toContain("private.example");
      }),
    ),
  );

  testUnixPipe("surfaces the actionable cause of a wrapped Browser request failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeServer(true, () => {
          throw Object.assign(new Error(), {
            _tag: "BrowserUseSessionRuntimeError",
            cause: new Error("Timed out executing Browser Use CDP command Page.navigate"),
          });
        });
        const socket = yield* connectScoped(server.pipePath);
        const response = readOne(socket);
        socket.write(
          encodeBrowserUseNativePipeFrame(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "executeCdp" }),
          ),
        );

        expect(yield* Effect.promise(() => response)).toMatchObject({
          error: {
            code: 1,
            message: "Timed out executing Browser Use CDP command Page.navigate",
          },
          id: 1,
        });
      }),
    ),
  );

  it.effect("dispatches framed Windows traffic only after the native peer is admitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const accepted = yield* Queue.unbounded<WindowsPipeConnection>();
        const requests: string[] = [];
        const rejected = yield* Queue.unbounded<string>();
        const makePeer = (pid: number) => {
          const output = new PassThrough();
          const stream = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              output.write(chunk, callback);
            },
          });
          return {
            output,
            connection: {
              peer: { pid, creationTime: String(pid), imagePath: "C:/runtime/node_repl.exe" },
              stream,
            },
          };
        };
        const server = yield* makeBrowserUseNativePipeServer({
          platform: "win32",
          socketPeerAuthorizer: () => {
            throw new Error("POSIX authorization must not run");
          },
          handler: (request) => {
            requests.push(request.method);
            return "result";
          },
          events: {
            onRejectedSocket: ({ reason }) => {
              Queue.offerUnsafe(rejected, reason!);
            },
          },
          windows: {
            profileNamespace: "profile-a",
            native: {
              listenPipe: (prefix) =>
                Effect.succeed({
                  endpoint: "\\\\.\\pipe\\" + prefix + "-nonce",
                  accept: Queue.take(accepted),
                }),
            },
            authorize: ({ pid }) => Effect.succeed({ authorized: pid === 1, reason: "foreign" }),
          },
        });
        expect(server.pipePath).toContain("codex-browser-use-profile-a-nonce");
        const frame = encodeBrowserUseNativePipeFrame(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getInfo" }),
        );
        const denied = makePeer(2);
        denied.connection.stream.push(frame);
        yield* Queue.offer(accepted, denied.connection);
        expect(yield* Queue.take(rejected)).toBe("foreign");
        const allowed = makePeer(1);
        const received = new Promise<Buffer>((resolve) => allowed.output.once("data", resolve));
        allowed.connection.stream.push(frame);
        yield* Queue.offer(accepted, allowed.connection);
        const [body] = new BrowserUseNativePipeFrameDecoder().push(
          yield* Effect.promise(() => received),
        );
        expect(JSON.parse(body!)).toEqual({ jsonrpc: "2.0", id: 1, result: "result" });
        expect(requests).toEqual(["getInfo"]);
      }),
    ),
  );
});

describe("browser-use-peer-authorizer", () => {
  describe("createBrowserUsePeerAuthorizer", () => {
    test("allows the explicit disabled policy without loading an addon", () => {
      const authorize = createBrowserUsePeerAuthorizer({
        addonPath: null,
        mode: "disabled",
        platform: "darwin",
      });

      expect(authorize({} as never)).toEqual({ authorized: true });
    });

    test("fails closed when packaged authorization has no addon", () => {
      const authorize = createBrowserUsePeerAuthorizer({
        addonPath: null,
        mode: "packaged",
        platform: "darwin",
      });

      expect(authorize({} as never)).toEqual({
        authorized: false,
        reason: "peer-authorization-addon-unavailable",
      });
    });

    test("does not infer a bypass from development peer verification", () => {
      const authorize = createBrowserUsePeerAuthorizer({
        addonPath: null,
        mode: "development",
        platform: "darwin",
      });

      expect(authorize({} as never)).toEqual({
        authorized: false,
        reason: "peer-authorization-addon-unavailable",
      });
    });
  });

  it.effect("admits a verified Windows image only in the owning Profile's process tree", () =>
    Effect.gen(function* () {
      const host = { pid: 10, creationTime: "100", imagePath: "C:/Nodex/Nodex.exe" };
      const launcher = { pid: 11, creationTime: "110", imagePath: "C:/Nodex/nodex-core.exe" };
      const repl = { pid: 12, creationTime: "120", imagePath: "C:/Bundle/node_repl.exe" };
      const node = { pid: 13, creationTime: "130", imagePath: "c:/bundle/node.exe" };
      const options = {
        host,
        launcher: launcher.imagePath,
        repl: repl.imagePath,
        node: "C:/Bundle/node.exe",
        native: { ancestors: () => Effect.succeed([repl, launcher, host]) },
      };
      const authorize = makeWindowsBrowserPeerAuthorizer({ ...options, mode: "packaged" });
      expect(yield* authorize(node)).toEqual({ authorized: true });
      expect(yield* authorize({ ...node, imagePath: "C:/Other/node.exe" })).toMatchObject({
        authorized: false,
        reason: "unverified-peer-image",
      });
      const other = makeWindowsBrowserPeerAuthorizer({
        ...options,
        host: { ...host, creationTime: "900" },
        mode: "packaged",
      });
      expect(yield* other(node)).toMatchObject({
        authorized: false,
        reason: "peer-outside-desktop-tool-launch",
      });
      const detached = { ...options, native: { ancestors: () => Effect.succeed([]) } };
      const strict = makeWindowsBrowserPeerAuthorizer({ ...detached, mode: "packaged" });
      const development = makeWindowsBrowserPeerAuthorizer({ ...detached, mode: "development" });
      expect(yield* strict(repl)).toMatchObject({ authorized: false });
      expect(yield* development(repl)).toMatchObject({ authorized: true });
    }),
  );
});

describe("Browser Use native-pipe framing", () => {
  test("decodes split headers, split payloads, and coalesced frames", () => {
    const first = encodeBrowserUseNativePipeFrame(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    );
    const second = encodeBrowserUseNativePipeFrame(
      JSON.stringify({ jsonrpc: "2.0", id: "two", method: "getInfo" }),
    );
    const decoder = new BrowserUseNativePipeFrameDecoder();

    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(first.subarray(2, 7))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(7), second]))).toEqual([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: "two", method: "getInfo" }),
    ]);
  });

  test("rejects oversized outgoing and incoming frames", () => {
    expect(() => encodeBrowserUseNativePipeFrame("12345", 4)).toThrow("exceeds 4 bytes");

    const oversizedHeader = Buffer.alloc(4);
    if (endianness() === "LE") {
      oversizedHeader.writeUInt32LE(5);
    } else {
      oversizedHeader.writeUInt32BE(5);
    }
    const decoder = new BrowserUseNativePipeFrameDecoder(4);
    expect(() => decoder.push(oversizedHeader)).toThrow("exceeds 4 bytes");
  });

  test("accepts the maximum payload and preserves unicode", () => {
    const message = "你好 Browser";
    const encoded = encodeBrowserUseNativePipeFrame(message, Buffer.byteLength(message));
    const decoder = new BrowserUseNativePipeFrameDecoder(Buffer.byteLength(message));
    expect(decoder.push(encoded)).toEqual([message]);
  });
});
