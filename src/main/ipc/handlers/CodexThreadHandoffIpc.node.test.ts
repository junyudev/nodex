import { describe, vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  CodexAppHandoffOperation,
  CodexThreadHandoffSnapshot,
} from "../../../shared/codex-thread-handoff";
import { testLayer as mainConfigLayer, testLayer as configLayer } from "../../app/MainConfig";
import {
  CodexThreadHandoffRuntime,
  type CodexLaunchThreadHandoffInput,
  type CodexThreadHandoffRuntimeError,
} from "../../codex-application/CodexThreadHandoffRuntime";
import { ThreadExecution } from "../../host-runtime/ThreadExecution";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live, type CodexThreadHandoffIpcError } from "./CodexThreadHandoffIpc";
import type { CodexRealtimeVoiceSnapshot } from "../../../shared/codex-realtime-voice";
import { CodexRealtimeVoice } from "../../codex-application/CodexRealtimeVoice";
import { CodexRealtimeVoicePolicy } from "../../codex-application/CodexRealtimeVoicePolicy";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { live as liveCodexRealtimeVoiceIpc } from "./CodexRealtimeVoiceIpc";

vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: () => {} },
  BrowserWindow: { fromWebContents: () => ({}) },
  systemPreferences: {},
  ipcMain: {},
  app: {},
  session: {},
  net: {},
  shell: {},
  dialog: {},
  screen: {},
  clipboard: {},
  nativeImage: {},
  Menu: {},
  globalShortcut: {},
  powerMonitor: {},
  webContents: {},
  desktopCapturer: {},
  safeStorage: {},
  nativeTheme: {},
}));

describe("CodexThreadHandoffIpc", () => {
  const unusedThreadExecution = Layer.succeed(
    ThreadExecution,
    {} as unknown as ThreadExecution["Service"],
  );

  const rendererEvent = (id: number, url = "app://-/index.html"): IpcMainInvokeEvent => {
    const frame = { url };
    return {
      sender: { getType: () => "window", id, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
  };

  it.effect(
    "authorizes snapshot reads and scopes progress delivery to the renderer ingress lifetime",
    () =>
      Effect.gen(function* () {
        const handlers = new Map<
          string,
          (event: IpcMainInvokeEvent) => Effect.Effect<unknown, CodexThreadHandoffIpcError>
        >();
        const delivered: unknown[][] = [];
        const state = yield* SubscriptionRef.make<CodexThreadHandoffSnapshot>({
          revision: 0,
          operations: [],
        });
        const ipc = makeTestElectronIpc({
          handle: (channel, handler) =>
            Effect.acquireRelease(
              Effect.sync(() => handlers.set(channel, handler as never)),
              () => Effect.sync(() => handlers.delete(channel)),
            ).pipe(Effect.asVoid),
          on: () => Effect.die("unused"),
        });
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ElectronIpc, ipc),
                Layer.succeed(CodexThreadHandoffRuntime, {
                  snapshot: SubscriptionRef.get(state),
                  changes: SubscriptionRef.changes(state),
                } as CodexThreadHandoffRuntime["Service"]),
                Layer.succeed(WindowRuntime, {
                  has: (id: number) => id === 7,
                  all: () => [
                    {
                      isDestroyed: () => false,
                      webContents: {
                        isDestroyed: () => false,
                        send: (...args: unknown[]) => delivered.push(args),
                      },
                    },
                  ],
                } as unknown as WindowRuntime["Service"]),
                unusedThreadExecution,
                mainConfigLayer(),
              ),
            ),
          ),
          scope,
        );
        const read = handlers.get("codex:thread-handoffs:list")!;
        assert.deepEqual(yield* read(rendererEvent(7)), { revision: 0, operations: [] });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(read(rendererEvent(8)))));
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(read(rendererEvent(7, "https://untrusted.example")))),
        );
        yield* SubscriptionRef.set(state, { revision: 1, operations: [] });
        yield* Effect.yieldNow;
        assert.deepEqual(delivered.at(-1), [
          "codex:thread-handoffs:changed",
          { revision: 1, operations: [] },
        ]);
        yield* Scope.close(scope, Exit.void);
        const deliveredCount = delivered.length;
        yield* SubscriptionRef.set(state, { revision: 2, operations: [] });
        yield* Effect.yieldNow;
        assert.strictEqual(delivered.length, deliveredCount);
        assert.strictEqual(handlers.size, 0);
      }),
  );

  it.effect("admits only a trusted, bounded attached-thread destination intent", () =>
    Effect.gen(function* () {
      const handlers = new Map<
        string,
        (
          event: IpcMainInvokeEvent,
          input: unknown,
        ) => Effect.Effect<unknown, CodexThreadHandoffIpcError | CodexThreadHandoffRuntimeError>
      >();
      const launches: CodexLaunchThreadHandoffInput[] = [];
      const result: CodexAppHandoffOperation = {
        operationId: "move-1",
        revision: 0,
        status: "running",
        recoveryRequired: false,
        threadId: "thread-1",
        sourceThreadId: "thread-1",
        requestThreadId: "thread-1",
        threadTitle: null,
        projectId: "project-1",
        sourceHostId: "local",
        direction: "local-to-worktree",
        localBranch: null,
        sourceBranch: null,
        worktreeBranch: null,
        destinationHostId: "local",
        destinationHostDisplayName: "This Mac",
        message: null,
        steps: [],
        createdAt: 1,
        updatedAt: 1,
        completedAt: null,
      };
      const ipc = makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as never)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.die("unused"),
      });
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(CodexThreadHandoffRuntime, {
                snapshot: Effect.succeed({ revision: 0, operations: [] }),
                changes: Stream.empty,
                launch: (input: CodexLaunchThreadHandoffInput) =>
                  Effect.sync(() => {
                    launches.push(input);
                    return result;
                  }),
              } as unknown as CodexThreadHandoffRuntime["Service"]),
              Layer.succeed(WindowRuntime, {
                has: (id: number) => id === 7,
                all: () => [],
              } as unknown as WindowRuntime["Service"]),
              unusedThreadExecution,
              mainConfigLayer(),
            ),
          ),
        ),
        scope,
      );
      const handoff = handlers.get("thread-execution:handoff")!;
      const valid = { threadId: " thread-1 ", operationId: " move-1 ", destination: "worktree" };
      assert.deepEqual(yield* handoff(rendererEvent(7), valid), result);
      assert.deepEqual(launches, [
        {
          threadId: "thread-1",
          operationId: "move-1",
          requestThreadId: "thread-1",
          expectedDestination: "worktree",
          destinationHostId: null,
          followUpPrompt: null,
        },
      ]);
      for (const input of [
        { ...valid, destination: "remote" },
        { ...valid, threadId: " " },
        { ...valid, operationId: "" },
        { ...valid, threadId: "t".repeat(1025) },
        { ...valid, operationId: "o".repeat(1025) },
        { ...valid, destinationHostId: "ssh-host" },
        { ...valid, followUpPrompt: "run shell" },
      ])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(handoff(rendererEvent(7), input))));
      const subframe = rendererEvent(7);
      Object.assign(subframe, { senderFrame: { url: "app://-/index.html" } });
      for (const event of [
        rendererEvent(8),
        rendererEvent(7, "https://untrusted.example"),
        subframe,
      ])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(handoff(event, valid))));
      assert.lengthOf(launches, 1);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(handlers.size, 0);
    }),
  );

  it.effect("reads the location that handoff admission classifies, for trusted windows only", () =>
    Effect.gen(function* () {
      const handlers = new Map<
        string,
        (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>
      >();
      const reads: string[] = [];
      const ipc = makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as never)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.die("unused"),
      });
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(CodexThreadHandoffRuntime, {
                snapshot: Effect.succeed({ revision: 0, operations: [] }),
                changes: Stream.empty,
              } as unknown as CodexThreadHandoffRuntime["Service"]),
              Layer.succeed(ThreadExecution, {
                read: (threadId: string) =>
                  Effect.sync(() => {
                    reads.push(threadId);
                    return {
                      hostId: "local",
                      cwd: "/managed/feature/app",
                      workspaceRoots: ["/managed/feature"],
                      managedWorktreePath: "/managed/feature",
                      projectId: "project-1",
                      projectlessOutputDirectory: null,
                      projectlessWorkspaceBrowserRoot: null,
                    };
                  }),
              } as unknown as ThreadExecution["Service"]),
              Layer.succeed(WindowRuntime, {
                has: (id: number) => id === 7,
                all: () => [],
              } as unknown as WindowRuntime["Service"]),
              mainConfigLayer(),
            ),
          ),
        ),
        scope,
      );
      const location = handlers.get("thread-execution:location")!;
      assert.deepEqual(yield* location(rendererEvent(7), { threadId: " root-1 " }), {
        hostId: "local",
        cwd: "/managed/feature/app",
        managedWorktreePath: "/managed/feature",
      });
      for (const input of [{ threadId: " " }, { threadId: "root-1", extra: true }, null])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(location(rendererEvent(7), input))));
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(location(rendererEvent(8), { threadId: "root-1" }))),
      );
      assert.deepEqual(reads, ["root-1"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});

describe("CodexRealtimeVoiceIpc", () => {
  const claimId = "019a1240-1000-7000-8000-000000000001";
  const event = (url = "http://localhost:5173", id = 42, kind = "window"): IpcMainInvokeEvent => {
    const frame = { url };
    return {
      sender: { id, getType: () => kind, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
  };
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, unknown>;
  const withIpc = <A, E>(
    run: (handlers: Map<string, Handler>, calls: unknown[][]) => Effect.Effect<A, E>,
    currentSession: CodexRealtimeVoiceSnapshot | null = null,
  ) =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const calls: unknown[][] = [];
      const operation = (name: string, ...args: unknown[]) =>
        Effect.sync(() => {
          calls.push([name, ...args]);
        });
      const deps = Layer.mergeAll(
        configLayer({ rendererUrl: "http://localhost:5173" }),
        Layer.succeed(
          ElectronIpc,
          makeTestElectronIpc({
            handle: (channel, handler) =>
              Effect.sync(() => {
                handlers.set(channel, handler as Handler);
              }),
            on: () => Effect.void,
          }),
        ),
        Layer.succeed(RendererClientRuntime, {
          getClientIdForWebContentsId: (id: number) => (id === 42 ? "client" : null),
        } as RendererClientRuntime["Service"]),
        Layer.succeed(CodexRealtimeVoicePolicy, {
          availability: (target: unknown) =>
            operation("availability", target).pipe(Effect.as({ available: false })),
        } as unknown as CodexRealtimeVoicePolicy["Service"]),
        Layer.succeed(CodexRealtimeVoice, {
          readSession: () => {
            calls.push(["read-session"]);
            return currentSession;
          },
          prepare: (sender: number, target: unknown) =>
            operation("prepare", sender, target).pipe(Effect.as({ claimId })),
          start: (sender: number, claim: string, sdp: string) =>
            operation("start", sender, claim, sdp),
          reportMedia: (sender: number, claim: string, evidence: unknown) =>
            operation("media", sender, claim, evidence),
          setMuted: (sender: number, claim: string, value: unknown) =>
            operation("mute", sender, claim, value),
          stop: (sender: number, claim: string) => operation("stop", sender, claim),
          release: (sender: number, claim: string) =>
            operation("release", sender, claim).pipe(Effect.as(true)),
          appendText: (sender: number, claim: string, role: unknown, text: string) =>
            operation("text", sender, claim, role, text),
          appendSpeech: (sender: number, claim: string, text: string) =>
            operation("speech", sender, claim, text),
          injectContext: (sender: number, claim: string, attachments: unknown) =>
            operation("context", sender, claim, attachments),
        } as unknown as CodexRealtimeVoice["Service"]),
      );
      yield* Layer.buildWithScope(
        liveCodexRealtimeVoiceIpc.pipe(Layer.provide(deps)),
        yield* Scope.Scope,
      );
      return yield* run(handlers, calls);
    }).pipe(Effect.scoped);

  it.effect("only a registered physical application renderer can claim native Voice", () =>
    withIpc((handlers, calls) =>
      Effect.gen(function* () {
        const prepare = handlers.get("codex:realtime-voice:prepare")!;
        for (const sender of [
          event("https://foreign.example"),
          event("http://localhost:5173", 43),
          event("http://localhost:5173", 42, "webview"),
        ])
          assert.strictEqual(
            (yield* prepare(sender, { hostId: "ssh:owner", threadId: "thread" }).pipe(
              Effect.result,
            ))._tag,
            "Failure",
          );
        assert.strictEqual(calls.length, 0);
        yield* prepare(event(), { hostId: "ssh:owner", threadId: "thread" });
        assert.deepStrictEqual(calls, [
          ["prepare", 42, { hostId: "ssh:owner", threadId: "thread" }],
        ]);
      }),
    ),
  );
  it.effect(
    "a different Thread query reports the Profile claim without changing its target admission",
    () => {
      const session: CodexRealtimeVoiceSnapshot = {
        hostId: "local",
        threadId: "owning-thread",
        claimId,
        realtimeSessionId: "019a1240-1000-7000-8000-000000000002",
        phase: "active",
        microphoneMuted: false,
        outputMuted: false,
        revision: 1,
      };
      const target = { hostId: "ssh:other", threadId: "other-thread" };
      return withIpc(
        (handlers, calls) =>
          Effect.gen(function* () {
            const result = yield* handlers.get("codex:realtime-voice:read")!(event(), target);
            assert.deepStrictEqual(result, { available: false, session });
            assert.deepStrictEqual(calls, [["availability", target], ["read-session"]]);
          }),
        session,
      );
    },
  );
  it.effect(
    "rejects chosen sender identities, unbounded SDP and invalid generated text roles before dispatch",
    () =>
      withIpc((handlers, calls) =>
        Effect.gen(function* () {
          for (const [name, value] of [
            ["prepare", { hostId: "local", threadId: "thread", webContentsId: 1 }],
            ["start", { claimId, sdp: "a".repeat(1_048_577) }],
            ["report-media", { claimId, evidence: "requestAccepted" }],
            ["append-text", { claimId, role: "system", text: "text" }],
            ["append-speech", { claimId, text: "x".repeat(1_048_577) }],
            ["append-speech", { claimId, threadId: "foreign", text: "text" }],
            ["stop", { claimId: "not-a-claim" }],
          ] as const)
            assert.strictEqual(
              (yield* handlers.get(`codex:realtime-voice:${name}`)!(event(), value).pipe(
                Effect.result,
              ))._tag,
              "Failure",
            );
          assert.strictEqual(calls.length, 0);
          yield* handlers.get("codex:realtime-voice:start")!(event(), { claimId, sdp: "offer" });
          yield* handlers.get("codex:realtime-voice:append-text")!(event(), {
            claimId,
            role: "user",
            text: " exact ",
          });
          yield* handlers.get("codex:realtime-voice:append-speech")!(event(), {
            claimId,
            text: " exact warning ",
          });
          assert.deepStrictEqual(calls, [
            ["start", 42, claimId, "offer"],
            ["text", 42, claimId, "user", " exact "],
            ["speech", 42, claimId, " exact warning "],
          ]);
        }),
      ),
  );
});
