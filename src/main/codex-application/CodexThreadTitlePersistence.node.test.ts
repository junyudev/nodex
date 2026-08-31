import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import {
  CodexConversationProjection,
  type CodexConversationProjectionService,
} from "./CodexConversationProjection";
import {
  CodexSidebarSyncRuntime,
  type CodexSidebarSyncNotification,
} from "./CodexSidebarSyncRuntime";
import { CodexThreadTitlePersistenceEffectError, make } from "./CodexThreadTitlePersistence";

type CoreThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "thread" }
>["thread"];

const coreThread = (
  threadId: string,
  name: string,
  backendKind: "codex" | "acp" = "codex",
): CoreThread =>
  ({
    thread_id: threadId,
    project_id: "project-a",
    session_id: null,
    forked_from_id: null,
    parent_thread_id: null,
    thread_source: null,
    service_name: null,
    agent_nickname: null,
    agent_role: null,
    agent_path: null,
    thread_name: name,
    thread_preview: "",
    backend_binding:
      backendKind === "codex"
        ? { kind: "codex" }
        : {
            kind: "acp",
            agent_definition_id: "claude-agent-acp",
            instance_config_id: "claude-local",
          },
    model_id: "gpt-test",
    reasoning_effort: "high",
    service_tier: null,
    execution_host_id: "local",
    cwd: "/repo",
    writable_roots: ["/repo"],
    managed_worktree_path: null,
    projectless_output_directory: null,
    projectless_workspace_browser_root: null,
    status: { status_type: "idle", active_flags: [] },
    archived: false,
    pinned_order: null,
    has_unread_turn: false,
    dynamic_tool_catalogs: [],
    created_at: 1,
    updated_at: 1,
    recency_at: 1,
    linked_at: "2026-08-24T00:00:00.000Z",
  }) satisfies CoreThread;

const gateway = (request: CodexGateway["Service"]["requestForThread"]): CodexGateway["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  return CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
    events: Stream.empty,
    requestLocal: unsupported as CodexGateway["Service"]["requestLocal"],
    requestOnHost: unsupported as CodexGateway["Service"]["requestOnHost"],
    requestForThread: request,
    notifyLocal: unsupported,
    connection: unsupported,
    connectionChanges: () => Stream.empty,
    awaitReady: unsupported,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
};

const harness = (input: {
  readonly request: CodexGateway["Service"]["requestForThread"];
  readonly onProject?: (threadId: string, name: string) => void;
  readonly onCoreApply?: (threadId: string, name: string) => void;
  readonly backendKind?: "codex" | "acp";
}) => {
  const names = new Map<string, string>();
  const projection = CodexConversationProjection.of({
    renameThread: ({ threadId, name }: { readonly threadId: string; readonly name: string }) =>
      Effect.sync(() => {
        names.set(threadId, name);
        input.onProject?.(threadId, name);
      }),
    read: (threadId: string) =>
      Effect.succeed({
        canonical: {} as never,
        snapshot: {
          threadId,
          threadName: names.get(threadId) ?? null,
          ephemeral: false,
        } as unknown as CodexConversationSnapshot,
      }),
  } as unknown as CodexConversationProjectionService);
  const workspace: CoreModuleClients["workspace"] = {
    apply: (operation) =>
      Effect.sync(() => {
        if (operation.intent.kind !== "update_thread") return {} as never;
        const name = operation.intent.patch.thread_name ?? "";
        names.set(operation.intent.thread_id, name);
        input.onCoreApply?.(operation.intent.thread_id, name);
        return {} as never;
      }),
    read: (read) => {
      const id = read.kind === "thread" ? read.thread_id : "unexpected";
      return Effect.succeed({
        value: {
          kind: "thread",
          thread: coreThread(id, names.get(id) ?? "", input.backendKind),
        },
      } as ProjectWorkspaceReadSnapshot);
    },
  };
  return make.pipe(
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
    ),
    Effect.provideService(CodexConversationProjection, projection),
    Effect.provideService(CodexGateway, gateway(input.request)),
    Effect.provideService(
      CodexSidebarSyncRuntime,
      CodexSidebarSyncRuntime.of({
        scheduleNotification: (_notification: CodexSidebarSyncNotification) => undefined,
      } as unknown as CodexSidebarSyncRuntime["Service"]),
    ),
    Effect.provideService(
      CoreModules,
      CoreModules.of({ workspace } as unknown as CoreModuleClients),
    ),
  );
};

it.effect("normalizes locally before best-effort remote and durable persistence", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const failure = new Error("remote failed");
    const persistence = yield* harness({
      onProject: (_threadId, name) => calls.push(`project:${name}`),
      request: ((_threadId, _method, params) => {
        const name = (params as { name: string }).name;
        return Effect.sync(() => void calls.push(`remote:${name}`)).pipe(
          Effect.andThen(Effect.fail(failure as never)),
        );
      }) as CodexGateway["Service"]["requestForThread"],
      onCoreApply: (_threadId, name) => calls.push(`workspace:${name}`),
    });

    assert.isTrue(
      yield* persistence.set({
        threadId: "thread-1",
        name: "  **Ship**   parity  ",
        normalization: "manual",
      }),
    );
    assert.deepEqual(calls, [
      "project:**Ship** parity",
      "remote:**Ship** parity",
      "workspace:**Ship** parity",
    ]);
    assert.isFalse(
      yield* persistence.set({ threadId: "thread-1", name: "   ", normalization: "trim" }),
    );
  }),
);

it.effect("rejects ACP titles before mutating projection, app-server, or Core", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const persistence = yield* harness({
      backendKind: "acp",
      onProject: () => calls.push("project"),
      onCoreApply: () => calls.push("workspace"),
      request: (() => Effect.sync(() => calls.push("remote"))) as never,
    });

    yield* persistence
      .setRequired({ threadId: "thread-acp", name: "ACP", normalization: "trim" })
      .pipe(Effect.flip);
    assert.deepEqual(calls, []);
  }),
);

it.effect("serializes the complete title transaction per Thread", () =>
  Effect.gen(function* () {
    const firstRemote = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const calls: string[] = [];
    const persistence = yield* harness({
      request: ((_threadId, _method, params) => {
        const name = (params as { name: string }).name;
        return Effect.sync(() => void calls.push(`remote:${name}`)).pipe(
          Effect.andThen(
            name === "first"
              ? Deferred.succeed(firstRemote, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                  Effect.as({}),
                )
              : Effect.succeed({}),
          ),
        );
      }) as CodexGateway["Service"]["requestForThread"],
      onCoreApply: (_threadId, name) => calls.push(`workspace:${name}`),
    });

    const first = yield* Effect.forkChild(
      persistence.setRequired({ threadId: "thread-1", name: "first", normalization: "trim" }),
    );
    yield* Deferred.await(firstRemote);
    const second = yield* Effect.forkChild(
      persistence.setRequired({ threadId: "thread-1", name: "second", normalization: "trim" }),
    );
    yield* Effect.yieldNow;
    assert.deepEqual(calls, ["remote:first"]);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.deepEqual(calls, [
      "remote:first",
      "workspace:first",
      "remote:second",
      "workspace:second",
    ]);
  }),
);

it.effect("surfaces required failure and releases the Thread lane", () =>
  Effect.gen(function* () {
    let failRemote = true;
    const persistence = yield* harness({
      request: (() =>
        failRemote
          ? Effect.fail(
              new CodexThreadTitlePersistenceEffectError({
                cause: new Error("required failed"),
              }) as never,
            )
          : Effect.succeed({})) as CodexGateway["Service"]["requestForThread"],
    });

    const error = yield* persistence
      .setRequired({ threadId: "thread-1", name: "first", normalization: "trim" })
      .pipe(Effect.flip);
    assert.instanceOf(error.cause, Error);
    failRemote = false;
    yield* persistence.setRequired({
      threadId: "thread-1",
      name: "second",
      normalization: "trim",
    });
  }),
);
