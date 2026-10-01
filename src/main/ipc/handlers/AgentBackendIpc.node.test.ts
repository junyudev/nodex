import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import type {
  AgentBackendThreadStartInput,
  NativePermissionMode,
} from "../../../shared/agent-backend-api";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { ClaudeDiscoveryInput } from "../../../shared/claude-models";
import { AgentBackendApplication } from "../../agent-backend/AgentBackendApplication";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { AgentBackendIpcError, live } from "./AgentBackendIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  value: unknown,
) => Effect.Effect<unknown, AgentBackendIpcError>;

it.effect("bridges renderer observation reference counts and destruction into session leases", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () =>
            Effect.sync(() => {
              handlers.delete(channel);
            }),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const observed: string[] = [];
    const unobserved: string[] = [];
    const destructionReleased = yield* Deferred.make<void>();
    const started: AgentBackendThreadStartInput[] = [];
    const discoveries: ClaudeDiscoveryInput[] = [];
    const application = AgentBackendApplication.of({
      startAgentThread: (input: AgentBackendThreadStartInput) =>
        Effect.sync(() => {
          started.push(input);
          return null;
        }),
      claudeDiscovery: (input: ClaudeDiscoveryInput) =>
        Effect.sync(() => {
          discoveries.push(input);
          return null;
        }),
      observeAgentSession: (threadId: string) =>
        Effect.sync(() => {
          observed.push(threadId);
        }),
      unobserveAgentSession: (threadId: string) =>
        Effect.sync(() => {
          unobserved.push(threadId);
        }).pipe(
          Effect.flatMap(() =>
            unobserved.length >= 2
              ? Deferred.succeed(destructionReleased, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      changes: Stream.empty,
    } as unknown as AgentBackendApplication["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AgentBackendApplication, application),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(
              WindowRuntime,
              WindowRuntime.of({ has: () => true } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );

    const sender = Object.assign(new EventEmitter(), {
      id: 77,
      getType: () => "window",
      isDestroyed: () => false,
    });
    const frame = { url: "app://-/index.html" };
    Object.assign(sender, { mainFrame: frame });
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    const start = handlers.get("agent-backend:thread:start")!;
    const launch: AgentBackendThreadStartInput = {
      sessionId: "draft",
      instanceConfigId: "claude-default",
      backendKind: "claude",
      prompt: "Inspect workspace",
      runInTarget: "newWorktree",
      runInEnvironmentPath: ".codex/environments/development.toml",
      worktreeStartingState: { type: "branch", branchName: "main", onMissing: "error" },
      firstSubmission: { launchId: createUuidV7(), clientUserMessageId: createUuidV7() },
    };
    yield* start(event, launch);
    expect(started).toEqual([launch]);
    const discover = handlers.get("agent-backend:claude:discover")!;
    const discoveryInput: ClaudeDiscoveryInput = {
      scope: { kind: "project", instanceConfigId: "claude-default", projectId: null },
      requestId: createUuidV7(),
      forceReload: true,
    };
    yield* discover(event, discoveryInput);
    expect(discoveries).toEqual([discoveryInput]);
    const threadDiscovery: ClaudeDiscoveryInput = {
      scope: { kind: "thread", threadId: "attached" },
      requestId: createUuidV7(),
    };
    yield* discover(event, threadDiscovery);
    expect(discoveries).toEqual([discoveryInput, threadDiscovery]);
    for (const scope of [
      { ...threadDiscovery.scope, cwd: "/untrusted" },
      { ...threadDiscovery.scope, instanceConfigId: "untrusted" },
      { kind: "thread", threadId: "" },
    ])
      expect(
        Exit.isFailure(yield* Effect.exit(discover(event, { ...threadDiscovery, scope }))),
      ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(discover(event, { ...discoveryInput, forceReload: "yes" })),
      ),
    ).toBe(true);
    expect(discoveries).toEqual([discoveryInput, threadDiscovery]);
    for (const invalid of [
      { ...launch, runInTarget: "cloud" },
      { ...launch, worktreeStartingState: { type: "branch", branchName: "" } },
      { ...launch, worktreeStartingState: { type: "working-tree", branchName: "main" } },
    ])
      expect(Exit.isFailure(yield* Effect.exit(start(event, invalid)))).toBe(true);
    expect(started).toEqual([launch]);
    const observe = handlers.get("agent-backend:session:observe");
    const unobserve = handlers.get("agent-backend:session:unobserve");
    expect(observe).toBeDefined();
    expect(unobserve).toBeDefined();

    yield* observe!(event, "thread-a");
    yield* observe!(event, "thread-a");
    expect(observed).toEqual(["thread-a"]);

    yield* unobserve!(event, "thread-a");
    expect(unobserved).toEqual([]);
    yield* unobserve!(event, "thread-a");
    expect(unobserved).toEqual(["thread-a"]);

    observed.length = 0;
    unobserved.length = 0;
    yield* observe!(event, "thread-a");
    yield* observe!(event, "thread-b");
    sender.emit("destroyed");
    yield* Deferred.await(destructionReleased);
    expect(observed).toEqual(["thread-a", "thread-b"]);
    expect(new Set(unobserved)).toEqual(new Set(["thread-a", "thread-b"]));

    const closingSender = Object.assign(new EventEmitter(), {
      id: 78,
      getType: () => "window",
      isDestroyed: () => false,
      mainFrame: frame,
    });
    const closingEvent = {
      sender: closingSender,
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    yield* observe!(closingEvent, "thread-c");
    yield* Scope.close(scope, Exit.void);
    expect(unobserved).toContain("thread-c");
    expect(closingSender.listenerCount("destroyed")).toBe(0);
    expect(handlers.size).toBe(0);
  }),
);

it.effect(
  "native permission endpoints validate trusted scope and supported choices before Core dispatch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        type PermissionHandler = (
          event: IpcMainInvokeEvent,
          ...args: unknown[]
        ) => Effect.Effect<unknown, AgentBackendIpcError>;
        const handlers = new Map<string, PermissionHandler>();
        const calls: Array<{ projectId: string | null; mode?: NativePermissionMode }> = [];
        const selected = new Map<string | null, NativePermissionMode>();
        const ipc = makeTestElectronIpc({
          handle: (channel: string, handler: PermissionHandler) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                handlers.set(channel, handler);
              }),
              () =>
                Effect.sync(() => {
                  handlers.delete(channel);
                }),
            ).pipe(Effect.asVoid),
          on: () => Effect.void,
        });
        const application = AgentBackendApplication.of({
          readNativePermissionMode: (projectId: string | null) =>
            Effect.sync(() => {
              calls.push({ projectId });
              return selected.get(projectId) ?? "auto";
            }),
          setNativePermissionMode: (projectId: string | null, mode: NativePermissionMode) =>
            Effect.sync(() => {
              calls.push({ projectId, mode });
              selected.set(projectId, mode);
              return mode;
            }),
          changes: Stream.empty,
          observeAgentSession: () => Effect.void,
          unobserveAgentSession: () => Effect.void,
        } as unknown as AgentBackendApplication["Service"]);
        yield* Layer.buildWithScope(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentBackendApplication, application),
                Layer.succeed(ElectronIpc, ipc),
                mainConfigLayer(),
                Layer.succeed(
                  WindowRuntime,
                  WindowRuntime.of({
                    has: (id: number) => id === 77,
                  } as unknown as WindowRuntime["Service"]),
                ),
              ),
            ),
          ),
          yield* Effect.scope,
        );
        const frame = { url: "app://-/index.html" };
        const sender = Object.assign(new EventEmitter(), {
          id: 77,
          mainFrame: frame,
          getType: () => "window",
          isDestroyed: () => false,
        });
        const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
        const get = handlers.get("agent-backend:permission-mode:get")!;
        const set = handlers.get("agent-backend:permission-mode:set")!;
        expect(yield* get(event, "project")).toBe("auto");
        expect(yield* set(event, "project", "full-access")).toBe("full-access");
        expect(yield* get(event, "project")).toBe("full-access");
        expect(yield* set(event, null, "guardian-approvals")).toBe("guardian-approvals");
        expect(yield* get(event, null)).toBe("guardian-approvals");
        const dispatched = calls.length;
        for (const input of [
          ["project", "custom"],
          ["project", "bypassPermissions"],
          ["", "full-access"],
        ])
          expect(Exit.isFailure(yield* Effect.exit(set(event, ...input)))).toBe(true);
        const childFrame = { url: frame.url };
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              set(
                { sender, senderFrame: childFrame } as unknown as IpcMainInvokeEvent,
                "project",
                "full-access",
              ),
            ),
          ),
        ).toBe(true);
        expect(calls.length).toBe(dispatched);
      }),
    ),
);
