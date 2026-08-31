import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
  CodexConversationThreadSettings,
  CodexModelOption,
} from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
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
import { CodexThreadSettingsOperationError, make } from "./CodexThreadSettingsRuntime";
import { ComposerCatalog } from "./ComposerCatalog";

type CoreThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "thread" }
>["thread"];

const settings = (model: string): CodexConversationThreadSettings => ({
  model,
  modelProvider: "openai",
  serviceTier: null,
  reasoningEffort: "high",
  summary: null,
  collaborationMode: {
    mode: "default",
    settings: { model, reasoning_effort: "high", developer_instructions: null },
  },
  personality: null,
});

const modelOption = (overrides: Partial<CodexModelOption> = {}): CodexModelOption => ({
  id: "model-a",
  model: "model-a",
  displayName: "Model A",
  description: "Agent model",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deep" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
  multiAgentVersion: null,
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: true,
  ...overrides,
});

const canonical = (threadId: string): CodexCanonicalConversationState =>
  ({
    protocol: { id: threadId },
    turns: [],
    requests: [],
    sidecar: {
      hasUnreadTurn: false,
      hydrationContext: {
        model: "model-a",
        reasoningEffort: "high",
        latestModel: "model-a",
        latestReasoningEffort: "high",
        cwd: "/repo",
        latestThreadSettings: null,
        currentPermissions: {
          activePermissionProfile: null,
          runtimeWorkspaceRoots: ["/repo"],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/repo"],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        },
      },
    },
  }) as unknown as CodexCanonicalConversationState;

const coreThread = (overrides: Partial<CoreThread> = {}): CoreThread =>
  ({
    thread_id: "thread-1",
    project_id: "project-a",
    session_id: null,
    forked_from_id: null,
    parent_thread_id: null,
    thread_source: null,
    service_name: null,
    agent_nickname: null,
    agent_role: null,
    agent_path: null,
    thread_name: "Thread",
    thread_preview: "",
    model_id: "model-a",
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
    created_at: 1,
    updated_at: 1,
    recency_at: 1,
    linked_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  }) as unknown as CoreThread;

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
  readonly request?: CodexGateway["Service"]["requestForThread"];
  readonly configure?: (
    command: Parameters<CodexConversationProjectionService["configureTurn"]>[0],
  ) => Effect.Effect<void>;
  readonly models?: readonly CodexModelOption[];
  readonly workspace?: CoreModuleClients["workspace"];
}) => {
  const current = new Map<string, CodexConversationThreadSettings>();
  const projection = CodexConversationProjection.of({
    read: (threadId: string) =>
      Effect.succeed({
        canonical: canonical(threadId),
        snapshot: {
          threadId,
          latestCollaborationMode: current.get(threadId)?.collaborationMode ?? undefined,
          latestThreadSettings: current.get(threadId) ?? settings("model-a"),
        } as unknown as CodexConversationSnapshot,
      }),
    configureTurn: (command: Parameters<CodexConversationProjectionService["configureTurn"]>[0]) =>
      (input.configure?.(command) ?? Effect.void).pipe(
        Effect.andThen(Effect.sync(() => void current.set(command.threadId, command.settings))),
      ),
  } as unknown as CodexConversationProjectionService);
  const workspace =
    input.workspace ??
    ({
      read: () => Effect.die("Unexpected Core read"),
      apply: () => Effect.die("Unexpected Core apply"),
    } as CoreModuleClients["workspace"]);
  return make.pipe(
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
    ),
    Effect.provideService(CodexConversationProjection, projection),
    Effect.provideService(
      ComposerCatalog,
      ComposerCatalog.of({
        listModels: Effect.succeed(input.models ?? []),
      } as unknown as ComposerCatalog["Service"]),
    ),
    Effect.provideService(
      CodexGateway,
      gateway(
        input.request ??
          ((() => Effect.succeed({})) as CodexGateway["Service"]["requestForThread"]),
      ),
    ),
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

it.effect("serializes complete settings transactions and the admission barrier per Thread", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const order: string[] = [];
    const service = yield* harness({
      configure: (command) =>
        Effect.sync(() => void order.push(`${command.settings.model}:project`)).pipe(
          Effect.andThen(
            command.settings.model === "first"
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Effect.void,
          ),
        ),
      request: ((_threadId, method, params) => {
        assert.strictEqual(method, "thread/settings/update");
        const model = String((params as { model?: unknown }).model);
        return Effect.sync(() => void order.push(`${model}:remote`)).pipe(Effect.as({}));
      }) as CodexGateway["Service"]["requestForThread"],
    });

    const first = yield* Effect.forkChild(
      service.update({ threadId: "thread-1", patch: { model: "first" } }),
    );
    yield* Deferred.await(firstStarted);
    const second = yield* Effect.forkChild(
      service.update({ threadId: "thread-1", patch: { model: "second" } }),
    );
    let admitted = false;
    const admission = yield* Effect.forkChild(
      service
        .awaitCurrent("thread-1")
        .pipe(Effect.andThen(Effect.sync(() => void (admitted = true)))),
    );
    yield* Effect.yieldNow;
    assert.deepEqual(order, ["first:project"]);
    assert.isFalse(admitted);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Fiber.join(admission);
    assert.deepEqual(order, ["first:project", "first:remote", "second:project", "second:remote"]);
    assert.isTrue(admitted);
  }),
);

it.effect("keeps different Thread settings transactions independent", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const service = yield* harness({
      configure: (command) =>
        command.threadId === "thread-1"
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            )
          : Effect.void,
    });
    const first = yield* Effect.forkChild(
      service.update({ threadId: "thread-1", patch: { model: "first" } }),
    );
    yield* Deferred.await(firstStarted);
    assert.strictEqual(
      (yield* service.update({ threadId: "thread-2", patch: { model: "independent" } })).model,
      "independent",
    );
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
  }),
);

it.effect("contains unloaded and unsupported remote updates while support stays monotonic", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const service = yield* harness({
      request: ((_threadId, _method, params) => {
        const model = String((params as { model?: unknown }).model);
        return Effect.sync(() => void requests.push(model)).pipe(
          Effect.andThen(
            Effect.fail(
              codexRuntimeError({
                operation: "settings-test",
                reason: "request",
                retryable: false,
                cause:
                  model === "missing"
                    ? new CodexAppServerRequestError({
                        code: -32603,
                        errorMessage: "Thread not found",
                      })
                    : CodexAppServerRequestError.methodNotFound("thread/settings/update"),
              }),
            ),
          ),
        );
      }) as CodexGateway["Service"]["requestForThread"],
    });

    assert.strictEqual(
      (yield* service.update({ threadId: "thread-1", patch: { model: "missing" } })).model,
      "missing",
    );
    assert.strictEqual(service.remoteUpdateSupport(), "unknown");
    assert.strictEqual(
      (yield* service.update({ threadId: "thread-1", patch: { model: "unsupported" } })).model,
      "unsupported",
    );
    assert.strictEqual(service.remoteUpdateSupport(), "unsupported");
    assert.strictEqual(
      (yield* service.update({ threadId: "thread-1", patch: { model: "local-only" } })).model,
      "local-only",
    );
    assert.deepEqual(requests, ["missing", "unsupported"]);
  }),
);

it.effect("persists a validated same-thread profile before canonical and remote projection", () =>
  Effect.gen(function* () {
    const order: string[] = [];
    let stored = coreThread();
    const workspace: CoreModuleClients["workspace"] = {
      read: () => Effect.succeed({ value: { kind: "thread", thread: stored } } as never),
      apply: (operation) =>
        Effect.sync(() => {
          if (operation.intent.kind !== "update_thread") return {} as never;
          order.push("core");
          stored = {
            ...stored,
            model_id: operation.intent.patch.model_id ?? stored.model_id,
            reasoning_effort: operation.intent.patch.reasoning_effort ?? stored.reasoning_effort,
            service_tier: operation.intent.patch.service_tier ?? stored.service_tier,
          };
          return {} as never;
        }),
    };
    const service = yield* harness({
      models: [modelOption({ id: "model-b", model: "model-b" })],
      workspace,
      configure: () => Effect.sync(() => void order.push("project")),
      request: ((_threadId, _method, params) =>
        Effect.sync(() => {
          order.push("remote");
          assert.strictEqual((params as { model?: string }).model, "model-b");
          return {};
        })) as CodexGateway["Service"]["requestForThread"],
    });
    const requested: CodexExecutionProfile = {
      modelId: "model-b",
      reasoningEffort: "high",
      serviceTier: null,
    };

    assert.strictEqual(
      (yield* service.update({
        threadId: "thread-1",
        patch: { executionProfile: requested, executionProfileChange: "model" },
      })).model,
      "model-b",
    );
    assert.deepEqual(order, ["core", "project", "remote"]);

    const failure = yield* service
      .update({
        threadId: "thread-1",
        patch: {
          executionProfile: { ...requested, modelId: "unavailable" },
          executionProfileChange: "model",
        },
      })
      .pipe(Effect.flip);
    assert.instanceOf(failure, CodexThreadSettingsOperationError);
    assert.match(String(failure.cause), /unavailable/u);
  }),
);
