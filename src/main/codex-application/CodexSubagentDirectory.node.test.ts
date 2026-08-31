import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexConversations } from "./CodexConversations";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { make } from "./CodexSubagentDirectory";

type RequestOnHost = CodexGateway["Service"]["requestOnHost"];
type Overview = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "subagent_overview_window" }
>["overview"];
type Lifecycle = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "subagent_lifecycle_batch" }
>["lifecycle"];

const capability: CodexAppServerCapabilitySnapshot = {
  hostId: "remote-a",
  generation: 7,
  userAgent: "codex-app-server/0.150.0-alpha.12",
  version: "0.150.0-alpha.12",
  flags: {
    forkLastTurnId: true,
    paginatedHistory: true,
    searchOccurrences: true,
    ephemeralFork: true,
    sideConversation: true,
    threadRevert: true,
    subagentAncestorFilter: true,
    multiAgentV2Protocol: true,
  },
};

const child = {
  id: "child-a",
  extra: null,
  sessionId: "session-child-a",
  forkedFromId: null,
  parentThreadId: "root-a",
  preview: "Inspect the renderer without loading its transcript",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 100,
  updatedAt: 120,
  recencyAt: 120,
  status: { type: "active", activeFlags: [] },
  path: null,
  cwd: "/repo",
  cliVersion: "test",
  source: {
    subAgent: {
      thread_spawn: {
        parent_thread_id: "root-a",
        depth: 1,
        agent_path: "root-a/Scout",
        agent_nickname: "Scout",
        agent_role: "explorer",
      },
    },
  },
  canAcceptDirectInput: true,
  threadSource: "subAgentThreadSpawn",
  agentNickname: "Scout",
  agentRole: "explorer",
  gitInfo: null,
  name: "Scout",
  turns: [],
} as Thread;

const spawnThread = (id: string, parentThreadId: string, preview = id): Thread => ({
  ...child,
  id,
  sessionId: `session-${id}`,
  parentThreadId,
  preview,
  source: {
    subAgent: {
      thread_spawn: {
        parent_thread_id: parentThreadId,
        depth: parentThreadId === "root-a" ? 1 : 2,
        agent_path: `${parentThreadId}/${id}`,
        agent_nickname: id,
        agent_role: "explorer",
      },
    },
  },
  agentNickname: id,
  name: id,
});

const rootDirectoryEntry = {
  fidelity: "durable",
  historyMode: null,
  durable: {
    threadId: "root-a",
    projectId: "project-a",
    sessionId: "session-a",
    forkedFromId: null,
    parentThreadId: null,
    threadSource: "user",
    serviceName: null,
    agentNickname: null,
    agentRole: null,
    agentPath: null,
    threadName: "Root",
    threadPreview: "Root",
    modelProvider: "openai",
    executionProfile: {
      modelId: "gpt-test",
      reasoningEffort: "high",
      serviceTier: null,
    },
    backendBinding: { kind: "codex" },
    executionHostId: "remote-a",
    cwd: "/repo",
    writableRoots: ["/repo"],
    managedWorktreePath: null,
    projectlessOutputDirectory: null,
    projectlessWorkspaceBrowserRoot: null,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    pinnedOrder: null,
    hasUnreadTurn: false,
    createdAt: 100_000,
    updatedAt: 100_000,
    recencyAt: 100_000,
    linkedAt: "2026-08-31T00:00:00.000Z",
  },
  summary: {},
  canonical: null,
  snapshot: null,
} as unknown as CodexThreadDirectoryEntry;

const buildDirectory = (input: {
  readonly capability: CodexAppServerCapabilitySnapshot;
  readonly read: CoreModuleClients["workspace"]["read"];
  readonly apply: CoreModuleClients["workspace"]["apply"];
  readonly requestOnHost: RequestOnHost;
  readonly hasLiveRootTurn?: boolean;
  readonly resolve?: CodexThreadDirectory["Service"]["resolve"];
  readonly observedSubagentThreadIds?: readonly string[];
  readonly observedSubagentThreadIdsByParent?: Readonly<Record<string, readonly string[]>>;
  readonly publish?: CodexApplicationEventHub["Service"]["publish"];
}) => {
  const unsupported = () => Effect.die(new Error("unused"));
  return make.pipe(
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: input.publish ?? (() => undefined),
      }),
    ),
    Effect.provideService(
      CoreModules,
      CoreModules.of({
        workspace: { read: input.read, apply: input.apply },
      } as unknown as CoreModuleClients),
    ),
    Effect.provideService(
      CodexConversations,
      CodexConversations.of({
        read: (threadId: string) => {
          const observedThreadIds =
            input.observedSubagentThreadIdsByParent?.[threadId] ??
            (threadId === "root-a" ? input.observedSubagentThreadIds : undefined);
          if (!observedThreadIds?.length && !input.hasLiveRootTurn) return null;
          return {
            generation: 1,
            snapshot: null,
            canonicalState: {
              protocol: { id: "root-a" },
              turns: [
                {
                  protocol: {
                    id: "turn-root",
                    status: input.hasLiveRootTurn ? "inProgress" : "completed",
                  },
                  items: [
                    {
                      type: "collabAgentToolCall",
                      tool: "spawnAgent",
                      receiverThreadIds: observedThreadIds ?? [],
                    },
                  ],
                },
              ],
            },
          } as never;
        },
      } as unknown as CodexConversations["Service"]),
    ),
    Effect.provideService(
      CodexGateway,
      CodexGateway.of({
        localHostId: "local",
        events: Stream.empty,
        requestOnHost: input.requestOnHost,
        requestForThread: unsupported,
        requestRawOnHost: unsupported,
        requestRawForThread: unsupported,
        requestLocal: unsupported,
        notifyLocal: unsupported,
        connection: unsupported,
        connectionChanges: () => Stream.empty,
        awaitReady: () => Effect.void,
        reconcileHost: unsupported,
        removeHost: unsupported,
        restartHost: unsupported,
      }),
    ),
    Effect.provideService(
      CodexAppServerCapabilities,
      CodexAppServerCapabilities.of({
        forHost: () => Effect.succeed(input.capability),
        forThread: () => Effect.succeed(input.capability),
        isCurrent: () => Effect.succeed(true),
      }),
    ),
    Effect.provideService(
      CodexThreadDirectory,
      CodexThreadDirectory.of({
        resolve:
          input.resolve ??
          (({ threadId }: { readonly threadId: string }) =>
            Effect.succeed(threadId === "root-a" ? (rootDirectoryEntry as never) : null)),
      } as unknown as CodexThreadDirectory["Service"]),
    ),
  );
};

it.effect("rejects an ACP root before reading Codex capabilities or remote topology", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: string[] = [];
      const acpRoot = {
        ...rootDirectoryEntry,
        durable: {
          ...rootDirectoryEntry.durable,
          backendBinding: {
            kind: "acp",
            agentDefinitionId: "claude-agent-acp",
            instanceConfigId: "claude-local",
          },
        },
      } as CodexThreadDirectoryEntry;
      const service = yield* buildDirectory({
        capability,
        read: () => Effect.die("Core subagent projection must not be read"),
        apply: () => Effect.die("Core subagent projection must not be mutated"),
        requestOnHost: ((_hostId: string, method: string) =>
          Effect.sync(() => requests.push(method)).pipe(
            Effect.andThen(Effect.die("Codex gateway must not be called")),
          )) as RequestOnHost,
        resolve: () => Effect.succeed(acpRoot),
      });

      yield* service.readKnownOverview({ rootThreadId: "root-a" }).pipe(Effect.flip);
      assert.deepEqual(requests, []);
    }),
  ),
);

it.effect(
  "reconciles a terminal child after app-server replacement without a replayed notification",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reconnectChild: Thread = { ...child, status: { type: "notLoaded" } };
        let status: "unknown" | "done" = "unknown";
        let discoveryComplete = true;
        let revision = 1;
        const operationKinds: string[] = [];
        const requestMethods: string[] = [];
        const invalidatedRoots: string[] = [];
        const projectedThread = {
          thread_id: child.id,
          parent_thread_id: "root-a",
          thread_name: "Scout",
          thread_preview: child.preview,
          model_provider: "openai",
          model_id: "gpt-test",
          agent_nickname: "Scout",
          agent_role: "explorer",
          agent_path: "root-a/Scout",
          archived: false,
          created_at: 100_000,
          updated_at: 120_000,
          recency_at: 120_000,
        };
        const overview = (): Overview =>
          ({
            universe: {
              host_id: "remote-a",
              source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
              generation: 7,
              root_thread_id: "root-a",
            },
            active: {
              items:
                status === "unknown" ? [{ thread: projectedThread, status, evidence: null }] : [],
              next_cursor: null,
              authority: { projection_revision: revision },
            },
            done: {
              items:
                status === "done"
                  ? [
                      {
                        thread: projectedThread,
                        status,
                        evidence: {
                          kind: "reconciliation",
                          source_revision: 0,
                          observed_at_ms: 130_000,
                        },
                      },
                    ]
                  : [],
              next_cursor: null,
              authority: { projection_revision: revision },
            },
            known_active_count: status === "unknown" ? 1 : 0,
            known_done_count: status === "done" ? 1 : 0,
            discovery_complete: discoveryComplete,
            discovery_continuation: null,
            projection_revision: revision,
          }) as unknown as Overview;
        const read: CoreModuleClients["workspace"]["read"] = (input) =>
          Effect.succeed(
            input.kind === "subagent_overview_item"
              ? ({
                  commit_head: revision,
                  value: {
                    kind: "subagent_overview_item",
                    item:
                      status === "unknown"
                        ? { thread: projectedThread, status, evidence: null }
                        : {
                            thread: projectedThread,
                            status,
                            evidence: {
                              kind: "reconciliation",
                              source_revision: 0,
                              observed_at_ms: 130_000,
                            },
                          },
                    projection_revision: revision,
                  },
                } as unknown as ProjectWorkspaceReadSnapshot)
              : ({
                  commit_head: revision,
                  value: { kind: "subagent_overview_window", overview: overview() },
                } as unknown as ProjectWorkspaceReadSnapshot),
          );
        const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
          Effect.sync(() => {
            operationKinds.push(input.intent.kind);
            if (input.intent.kind === "observe_subagent_discovery_page") {
              discoveryComplete = input.intent.complete;
            }
            if (input.intent.kind === "observe_subagent_status_evidence") {
              assert.strictEqual(input.intent.status, "done");
              assert.strictEqual(input.intent.evidence_kind, "reconciliation");
              status = "done";
            }
            revision += 1;
            return {} as never;
          });
        const requestOnHost = ((_hostId: string, method: string, params: unknown) =>
          Effect.sync(() => {
            requestMethods.push(method);
            if (method === "thread/list") {
              return { data: [reconnectChild], nextCursor: null, backwardsCursor: null };
            }
            assert.strictEqual(method, "thread/turns/list");
            assert.deepEqual(params, {
              threadId: child.id,
              cursor: null,
              limit: 1,
              sortDirection: "desc",
              itemsView: "notLoaded",
            });
            return {
              data: [
                {
                  id: "turn-child-a",
                  items: [],
                  itemsView: "notLoaded",
                  status: "completed",
                  error: null,
                  startedAt: 100,
                  completedAt: 130,
                  durationMs: 30_000,
                },
              ],
              nextCursor: null,
              backwardsCursor: null,
            };
          })) as RequestOnHost;
        const service = yield* buildDirectory({
          capability,
          read,
          apply,
          requestOnHost,
          publish: (event) => {
            if (event.kind !== "codex" || event.value.type !== "subagentOverviewInvalidated")
              return;
            invalidatedRoots.push(event.value.rootThreadId);
          },
        });

        yield* service.readKnownOverview({ rootThreadId: "root-a" });
        yield* service.reconcileAfterReconnect({ loadedThreadIds: ["root-a"] });
        const settled = yield* service.readKnownOverview({ rootThreadId: "root-a" });

        assert.deepEqual(requestMethods, ["thread/list", "thread/turns/list"]);
        assert.deepEqual(operationKinds, [
          "observe_subagent_discovery_page",
          "observe_subagent_discovery_page",
          "observe_subagent_status_evidence",
        ]);
        assert.deepEqual(invalidatedRoots, ["root-a"]);
        assert.strictEqual(settled.active.knownCount, 0);
        assert.deepEqual(
          settled.done.rows.map((row) => row.threadId),
          [child.id],
        );
      }),
    ),
);

it.effect("retains status-before-identity when Core buffering is temporarily unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let complete = false;
      let observed = false;
      let durableBufferAttempts = 0;
      let flushedStatus: string | null = null;
      const requests: Array<{
        readonly method: string;
        readonly params: unknown;
        readonly options: unknown;
      }> = [];
      const overview = (): Overview =>
        ({
          universe: {
            host_id: "remote-a",
            source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
            generation: 7,
            root_thread_id: "root-a",
          },
          active: {
            items: observed
              ? [
                  {
                    thread: {
                      thread_id: "child-a",
                      parent_thread_id: "root-a",
                      thread_name: "Scout",
                      thread_preview: child.preview,
                      model_provider: "openai",
                      model_id: "gpt-test",
                      agent_nickname: "Scout",
                      agent_role: "explorer",
                      agent_path: "root-a/Scout",
                      archived: false,
                      created_at: 100_000,
                      updated_at: 120_000,
                      recency_at: 120_000,
                    },
                    status: "active",
                    evidence: null,
                  },
                ]
              : [],
            next_cursor: null,
            authority: { projection_revision: observed ? 2 : 1 },
          },
          done: {
            items: [],
            next_cursor: null,
            authority: { projection_revision: observed ? 2 : 1 },
          },
          known_active_count: observed ? 1 : 0,
          known_done_count: 0,
          discovery_complete: complete,
          discovery_continuation: null,
          projection_revision: observed ? 2 : 1,
        }) as unknown as Overview;
      const read: CoreModuleClients["workspace"]["read"] = (_input) =>
        Effect.succeed({
          commit_head: observed ? 2 : 1,
          value: { kind: "subagent_overview_window", overview: overview() },
        } as unknown as ProjectWorkspaceReadSnapshot);
      const apply: CoreModuleClients["workspace"]["apply"] = (input) => {
        if (input.intent.kind === "buffer_subagent_status_evidence") {
          durableBufferAttempts += 1;
          return Effect.fail(new Error("Core status buffer is temporarily unavailable") as never);
        }
        return Effect.sync(() => {
          if (input.intent.kind === "observe_subagent_discovery_page") {
            observed = input.intent.observations.some(
              (observation) => observation.thread_id === "child-a",
            );
            complete = input.intent.complete;
          }
          if (input.intent.kind === "observe_subagent_status_evidence") {
            flushedStatus = input.intent.status;
          }
          return {} as never;
        });
      };
      const requestOnHost = ((hostId: string, method: string, params: unknown, options: unknown) =>
        Effect.sync(() => {
          requests.push({ method, params, options });
          assert.strictEqual(hostId, "remote-a");
          return { data: [], nextCursor: null, backwardsCursor: null };
        })) as RequestOnHost;
      const service = yield* buildDirectory({
        capability,
        read,
        apply,
        hasLiveRootTurn: true,
        requestOnHost,
      });

      yield* service.observeNotification({
        hostId: "remote-a",
        generation: 7,
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "child-a",
            status: { type: "active", activeFlags: ["waitingOnUserInput"] },
          },
        },
        occurrenceToken: 1,
        observedAtMs: 119_000,
      });
      assert.strictEqual(durableBufferAttempts, 1);
      assert.strictEqual(flushedStatus, null, "status-before-row must stay pending");

      yield* service.observeNotification({
        hostId: "remote-a",
        generation: 7,
        notification: {
          method: "item/completed",
          params: {
            threadId: "root-a",
            turnId: "turn-root",
            completedAtMs: 120_000,
            item: {
              type: "subAgentActivity",
              id: "spawn-child-a",
              kind: "started",
              agentThreadId: child.id,
              agentPath: "root-a/Scout",
            },
          },
        },
        occurrenceToken: 1,
        observedAtMs: 120_000,
      });
      assert.isTrue(observed, "the V2 started activity must materialize its child identity");
      assert.strictEqual(
        flushedStatus,
        "waiting",
        "the stronger pending status must merge after identity",
      );
      assert.isFalse(complete, "a compact activity item must not claim complete discovery");

      const result = yield* service.readOverview({ rootThreadId: "root-a", mode: "initial" });

      assert.include(["incomplete", "complete"], result.completeness);
      assert.strictEqual(result.active.knownCount, 1);
      assert.deepEqual(
        result.active.rows.map((row) => row.threadId),
        ["child-a"],
      );
      assert.deepEqual(
        requests,
        [],
        "the active Thread owner must not be duplicated for discovery",
      );
    }),
  ),
);

it.effect("does not admit a known root Thread as pending Subagent status evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let applyCount = 0;
      const service = yield* buildDirectory({
        capability,
        read: () => Effect.die("unexpected Core read"),
        apply: () =>
          Effect.sync(() => {
            applyCount += 1;
            return {} as never;
          }),
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
      });

      yield* service.observeNotification({
        hostId: "remote-a",
        generation: 7,
        notification: {
          method: "thread/status/changed",
          params: { threadId: "root-a", status: { type: "active", activeFlags: [] } },
        },
        occurrenceToken: 1,
        observedAtMs: 120_000,
      });

      assert.strictEqual(applyCount, 0);
    }),
  ),
);

it.effect("durably merges completion-before-row after a Directory restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let bufferedCompletion: {
        readonly status: string;
        readonly sourceRevision: number;
      } | null = null;
      let admittedStatus: string | null = null;
      const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
        Effect.sync(() => {
          if (input.intent.kind === "buffer_subagent_status_evidence") {
            bufferedCompletion = {
              status: input.intent.status,
              sourceRevision: input.intent.source_revision,
            };
          }
          if (
            input.intent.kind === "observe_subagent_discovery_page" &&
            input.intent.observations.some((observation) => observation.thread_id === child.id)
          ) {
            admittedStatus = bufferedCompletion?.status ?? null;
            bufferedCompletion = null;
          }
          return {} as never;
        });
      const read: CoreModuleClients["workspace"]["read"] = () =>
        Effect.succeed({
          commit_head: 1,
          value: {
            kind: "subagent_overview_window",
            overview: {
              universe: {
                host_id: "remote-a",
                source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
                generation: 7,
                root_thread_id: "root-a",
              },
              active: { items: [], next_cursor: null, authority: { projection_revision: 1 } },
              done: { items: [], next_cursor: null, authority: { projection_revision: 1 } },
              known_active_count: 0,
              known_done_count: 0,
              discovery_complete: false,
              discovery_continuation: null,
              projection_revision: 1,
            },
          },
        } as unknown as ProjectWorkspaceReadSnapshot);
      const services = {
        capability,
        read,
        apply,
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
      };
      const beforeRestart = yield* buildDirectory(services);
      yield* beforeRestart.observeNotification({
        hostId: "remote-a",
        generation: 7,
        notification: {
          method: "item/completed",
          params: {
            threadId: "root-a",
            turnId: "turn-root",
            completedAtMs: 130_000,
            item: {
              type: "subAgentActivity",
              id: "completed-before-row",
              kind: "completed",
              agentThreadId: child.id,
              agentPath: "root-a/Scout",
            },
          },
        },
        occurrenceToken: 42,
        observedAtMs: 130_000,
      });
      assert.deepEqual(bufferedCompletion, { status: "done", sourceRevision: 42 });

      // A fresh service has no access to the first Directory's in-memory maps. The shared Core
      // adapter models the durable ledger that survives the Main restart.
      const afterRestart = yield* buildDirectory(services);
      yield* afterRestart.observeNotification({
        hostId: "remote-a",
        generation: 7,
        notification: { method: "thread/started", params: { thread: child } },
        occurrenceToken: 43,
        observedAtMs: 131_000,
      });

      assert.strictEqual(admittedStatus, "done");
      assert.isNull(bufferedCompletion);
    }),
  ),
);

it.effect("single-flights concurrent initial discovery for the same root universe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let complete = false;
      let observed = false;
      let requestCount = 0;
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const overview = (): Overview =>
        ({
          universe: {
            host_id: "remote-a",
            source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
            generation: 7,
            root_thread_id: "root-a",
          },
          active: {
            items: observed
              ? [
                  {
                    thread: {
                      thread_id: child.id,
                      parent_thread_id: "root-a",
                      thread_name: child.name,
                      thread_preview: child.preview,
                      model_provider: child.modelProvider,
                      model_id: "gpt-test",
                      agent_nickname: child.agentNickname,
                      agent_role: child.agentRole,
                      agent_path: "root-a/Scout",
                      archived: false,
                      created_at: 100_000,
                      updated_at: 120_000,
                      recency_at: 120_000,
                    },
                    status: "active",
                    evidence: null,
                  },
                ]
              : [],
            next_cursor: null,
            authority: { projection_revision: observed ? 2 : 1 },
          },
          done: {
            items: [],
            next_cursor: null,
            authority: { projection_revision: observed ? 2 : 1 },
          },
          known_active_count: observed ? 1 : 0,
          known_done_count: 0,
          discovery_complete: complete,
          discovery_continuation: null,
          projection_revision: observed ? 2 : 1,
        }) as unknown as Overview;
      const service = yield* buildDirectory({
        capability,
        read: () =>
          Effect.succeed({
            commit_head: observed ? 2 : 1,
            value: { kind: "subagent_overview_window", overview: overview() },
          } as unknown as ProjectWorkspaceReadSnapshot),
        apply: (input) =>
          Effect.sync(() => {
            if (input.intent.kind === "observe_subagent_discovery_page") {
              observed = input.intent.observations.some(
                (observation) => observation.thread_id === child.id,
              );
              complete = input.intent.complete;
            }
            return {} as never;
          }),
        requestOnHost: ((_hostId: string, method: string) => {
          assert.strictEqual(method, "thread/list");
          return Effect.gen(function* () {
            requestCount += 1;
            yield* Deferred.succeed(requestStarted, undefined);
            yield* Deferred.await(releaseRequest);
            return { data: [child], nextCursor: null, backwardsCursor: null };
          });
        }) as RequestOnHost,
      });

      const first = yield* Effect.forkChild(
        service.readOverview({ rootThreadId: "root-a", mode: "initial" }),
      );
      yield* Deferred.await(requestStarted);
      const second = yield* Effect.forkChild(
        service.readOverview({ rootThreadId: "root-a", mode: "initial" }),
      );
      yield* Effect.yieldNow;
      assert.strictEqual(requestCount, 1);
      yield* Deferred.succeed(releaseRequest, undefined);
      const [firstResult, secondResult] = yield* Effect.all(
        [Fiber.join(first), Fiber.join(second)],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(requestCount, 1);
      for (const result of [firstResult, secondResult]) {
        assert.strictEqual(result.completeness, "complete");
        assert.deepEqual(
          result.active.rows.map((row) => row.threadId),
          [child.id],
        );
      }
    }),
  ),
);

it.effect("recovers repeated ancestor and legacy cursors without poisoning page identity", () =>
  Effect.scoped(
    Effect.forEach(
      [true, false] as const,
      (subagentAncestorFilter) =>
        Effect.gen(function* () {
          const childB = spawnThread("child-b", "root-a");
          const known = new Map<string, Thread>();
          const pagePayloads = new Map<string, string>();
          let continuation: string | null = null;
          let complete = false;
          let revision = 1;
          let cursorACalls = 0;
          const overview = (): Overview =>
            ({
              universe: {
                host_id: "remote-a",
                source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
                generation: 7,
                root_thread_id: "root-a",
              },
              active: {
                items: [...known.values()].map((thread) => ({
                  thread: {
                    thread_id: thread.id,
                    parent_thread_id: thread.parentThreadId,
                    thread_name: thread.name,
                    thread_preview: thread.preview,
                    model_provider: thread.modelProvider,
                    model_id: "gpt-test",
                    agent_nickname: thread.agentNickname,
                    agent_role: thread.agentRole,
                    agent_path: extractCodexThreadSubagentMetadata(thread).agentPath,
                    archived: false,
                    created_at: 100_000,
                    updated_at: 120_000,
                    recency_at: 120_000,
                  },
                  status: "active",
                  evidence: null,
                })),
                next_cursor: null,
                authority: { projection_revision: revision },
              },
              done: {
                items: [],
                next_cursor: null,
                authority: { projection_revision: revision },
              },
              known_active_count: known.size,
              known_done_count: 0,
              discovery_complete: complete,
              discovery_continuation: continuation,
              projection_revision: revision,
            }) as unknown as Overview;
          const read: CoreModuleClients["workspace"]["read"] = () =>
            Effect.succeed({
              commit_head: revision,
              value: { kind: "subagent_overview_window", overview: overview() },
            } as unknown as ProjectWorkspaceReadSnapshot);
          const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
            Effect.sync(() => {
              if (input.intent.kind !== "observe_subagent_discovery_page") {
                return {} as never;
              }
              const payload = JSON.stringify({
                observations: input.intent.observations,
                continuation: input.intent.continuation,
                complete: input.intent.complete,
              });
              const existing = pagePayloads.get(input.intent.page_identity);
              assert.isTrue(
                existing === undefined || existing === payload,
                "a retryable cursor coordinate must not be bound to a different payload",
              );
              pagePayloads.set(input.intent.page_identity, payload);
              for (const observation of input.intent.observations) {
                const thread = observation.thread_id === child.id ? child : childB;
                known.set(thread.id, thread);
              }
              continuation = input.intent.continuation ?? null;
              complete = input.intent.complete;
              revision += 1;
              return {} as never;
            });
          const requestOnHost = ((_hostId: string, method: string, rawParams: unknown) => {
            assert.strictEqual(method, "thread/list");
            const params = rawParams as {
              readonly cursor: string | null;
              readonly parentThreadId?: string;
            };
            if (!subagentAncestorFilter && params.parentThreadId !== "root-a") {
              return Effect.succeed({ data: [], nextCursor: null, backwardsCursor: null });
            }
            const cursor = params.cursor;
            if (cursor === null) {
              return Effect.succeed({
                data: [child],
                nextCursor: "cursor-a",
                backwardsCursor: null,
              });
            }
            assert.strictEqual(cursor, "cursor-a");
            cursorACalls += 1;
            return Effect.succeed(
              cursorACalls === 1
                ? { data: [], nextCursor: "cursor-a", backwardsCursor: null }
                : { data: [childB], nextCursor: null, backwardsCursor: null },
            );
          }) as RequestOnHost;
          const service = yield* buildDirectory({
            capability: {
              ...capability,
              flags: { ...capability.flags, subagentAncestorFilter },
            },
            read,
            apply,
            requestOnHost,
          });

          const incomplete = yield* service.readOverview({
            rootThreadId: "root-a",
            mode: "expanded",
          });
          assert.strictEqual(incomplete.completeness, "incomplete");
          assert.deepEqual(
            incomplete.active.rows.map((row) => row.threadId),
            [child.id],
          );
          assert.strictEqual(
            pagePayloads.size,
            1,
            "the non-advancing cursor is not a durable page",
          );

          const recovered = yield* service.readOverview({
            rootThreadId: "root-a",
            mode: "expanded",
          });
          assert.strictEqual(recovered.completeness, "complete");
          assert.deepEqual(
            recovered.active.rows.map((row) => row.threadId),
            [child.id, childB.id],
          );
          assert.isAtLeast(pagePayloads.size, 2);
        }),
      { discard: true },
    ),
  ),
);

it.effect("restarts expanded pagination when the Core projection revision changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const item = (threadId: string, status: "active" | "done") => ({
        thread: {
          thread_id: threadId,
          parent_thread_id: "root-a",
          thread_name: threadId,
          thread_preview: `Objective for ${threadId}`,
          model_provider: "openai",
          model_id: "gpt-test",
          agent_nickname: threadId,
          agent_role: "explorer",
          agent_path: `root-a/${threadId}`,
          archived: false,
          created_at: 100_000,
          updated_at: status === "done" ? 140_000 : 120_000,
          recency_at: status === "done" ? 140_000 : 120_000,
        },
        status,
        evidence: null,
      });
      const overview = (input: {
        readonly revision: number;
        readonly active: readonly string[];
        readonly done: readonly string[];
        readonly activeNext?: string | null;
      }): Overview =>
        ({
          universe: {
            host_id: "remote-a",
            source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
            generation: 7,
            root_thread_id: "root-a",
          },
          active: {
            items: input.active.map((threadId) => item(threadId, "active")),
            next_cursor: input.activeNext ?? null,
            authority: { projection_revision: input.revision },
          },
          done: {
            items: input.done.map((threadId) => item(threadId, "done")),
            next_cursor: null,
            authority: { projection_revision: input.revision },
          },
          known_active_count: input.active.length,
          known_done_count: input.done.length,
          discovery_complete: true,
          discovery_continuation: null,
          projection_revision: input.revision,
        }) as unknown as Overview;
      let readCount = 0;
      const read: CoreModuleClients["workspace"]["read"] = () =>
        Effect.sync(() => {
          readCount += 1;
          const value = (() => {
            if (readCount === 1) {
              return overview({ revision: 1, active: ["child-a"], done: [] });
            }
            if (readCount === 2) {
              return overview({
                revision: 1,
                active: ["child-a"],
                done: [],
                activeNext: "active-after-a",
              });
            }
            if (readCount === 3) {
              return overview({ revision: 2, active: [], done: ["child-a"] });
            }
            return overview({ revision: 2, active: ["child-b"], done: ["child-a"] });
          })();
          return {
            commit_head: value.projection_revision,
            value: { kind: "subagent_overview_window", overview: value },
          } as unknown as ProjectWorkspaceReadSnapshot;
        });
      const service = yield* buildDirectory({
        capability,
        read,
        apply: () => Effect.die("unexpected apply"),
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
      });

      const result = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });

      assert.strictEqual(readCount, 4);
      assert.strictEqual(result.revision, 2);
      assert.deepEqual(
        result.active.rows.map((row) => row.threadId),
        ["child-b"],
      );
      assert.deepEqual(
        result.done.rows.map((row) => row.threadId),
        ["child-a"],
      );
    }),
  ),
);

it.effect("retries strongest V2 completion evidence after the first durable apply fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const completeOverview = {
        universe: {
          host_id: "remote-a",
          source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
          generation: 7,
          root_thread_id: "root-a",
        },
        active: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: 1 },
        },
        done: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: 1 },
        },
        known_active_count: 0,
        known_done_count: 0,
        discovery_complete: true,
        discovery_continuation: null,
        projection_revision: 1,
      } as unknown as Overview;
      let statusAttempts = 0;
      let appliedStatus: string | null = null;
      const read: CoreModuleClients["workspace"]["read"] = () =>
        Effect.succeed({
          commit_head: 1,
          value: { kind: "subagent_overview_window", overview: completeOverview },
        } as unknown as ProjectWorkspaceReadSnapshot);
      const apply: CoreModuleClients["workspace"]["apply"] = (input) => {
        if (input.intent.kind !== "observe_subagent_status_evidence") {
          return Effect.succeed({} as never);
        }
        statusAttempts += 1;
        if (statusAttempts === 1) return Effect.fail(new Error("transient Core failure") as never);
        appliedStatus = input.intent.status;
        return Effect.succeed({} as never);
      };
      const childDirectoryEntry = {
        ...rootDirectoryEntry,
        durable: {
          ...rootDirectoryEntry.durable,
          threadId: child.id,
          sessionId: child.sessionId,
          parentThreadId: "root-a",
          threadSource: "subAgentThreadSpawn",
          threadName: child.name,
        },
      } as CodexThreadDirectoryEntry;
      const service = yield* buildDirectory({
        capability,
        read,
        apply,
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
        resolve: ({ threadId }) =>
          Effect.succeed(
            threadId === "root-a"
              ? rootDirectoryEntry
              : threadId === child.id
                ? childDirectoryEntry
                : null,
          ),
      });

      const firstObservation = yield* service
        .observeNotification({
          hostId: "remote-a",
          generation: 7,
          notification: {
            method: "item/completed",
            params: {
              threadId: "root-a",
              turnId: "turn-root",
              completedAtMs: 130_000,
              item: {
                type: "subAgentActivity",
                id: "completed-child-a",
                kind: "completed",
                agentThreadId: child.id,
                agentPath: "root-a/Scout",
              },
            },
          },
          occurrenceToken: 42,
          observedAtMs: 130_000,
        })
        .pipe(Effect.result);
      assert.strictEqual(
        firstObservation._tag,
        "Failure",
        "the notification consequence must fence its Endpoint generation until durable",
      );
      yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow, {
        discard: true,
      });

      assert.isAtLeast(statusAttempts, 2);
      assert.strictEqual(appliedStatus, "done");
    }),
  ),
);

it.effect("invalidates the overview when interruption races a committed status receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let committed = false;
      const invalidatedRoots: string[] = [];
      const childDirectoryEntry = {
        ...rootDirectoryEntry,
        durable: {
          ...rootDirectoryEntry.durable,
          threadId: child.id,
          sessionId: child.sessionId,
          parentThreadId: "root-a",
          threadSource: "subAgentThreadSpawn",
          threadName: child.name,
        },
      } as CodexThreadDirectoryEntry;
      const service = yield* buildDirectory({
        capability,
        read: () => Effect.die("unexpected Core read"),
        apply: (input) => {
          if (input.intent.kind !== "observe_subagent_status_evidence") {
            return Effect.die("unexpected Core apply");
          }
          return Effect.sync(() => {
            committed = true;
            return {} as never;
          }).pipe(Effect.andThen(Effect.interrupt));
        },
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
        resolve: ({ threadId }) =>
          Effect.succeed(
            threadId === "root-a"
              ? rootDirectoryEntry
              : threadId === child.id
                ? childDirectoryEntry
                : null,
          ),
        publish: (event) => {
          if (event.kind !== "codex" || event.value.type !== "subagentOverviewInvalidated") return;
          invalidatedRoots.push(event.value.rootThreadId);
        },
      });

      const exit = yield* Effect.exit(
        service.observeNotification({
          hostId: "remote-a",
          generation: 7,
          notification: {
            method: "thread/status/changed",
            params: { threadId: child.id, status: { type: "idle" } },
          },
          occurrenceToken: 43,
          observedAtMs: 131_000,
        }),
      );

      assert.isTrue(committed);
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure") assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      assert.deepEqual(invalidatedRoots, ["root-a"]);
    }),
  ),
);

it.effect("retains a compact nested spawn until its parent edge is materialized", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const parentShell = {
        ...rootDirectoryEntry,
        durable: {
          ...rootDirectoryEntry.durable,
          threadId: "parent-a",
          sessionId: "session-parent-a",
          parentThreadId: null,
          threadSource: "subAgentThreadSpawn",
        },
      } as CodexThreadDirectoryEntry;
      const entries = new Map<string, CodexThreadDirectoryEntry>([
        ["root-a", rootDirectoryEntry],
        ["parent-a", parentShell],
      ]);
      const observedEdges: Array<{ readonly parentId: string | null; readonly threadId: string }> =
        [];
      const service = yield* buildDirectory({
        capability,
        read: () => Effect.die("unexpected Core read"),
        apply: (input) =>
          Effect.sync(() => {
            if (input.intent.kind === "observe_subagent_discovery_page") {
              observedEdges.push(
                ...input.intent.observations.map((observation) => ({
                  parentId: observation.parent_thread_id,
                  threadId: observation.thread_id,
                })),
              );
            }
            return {} as never;
          }),
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
        resolve: ({ threadId }) => Effect.succeed(entries.get(threadId) ?? null),
      });

      yield* service.observeNotification({
        hostId: "remote-a",
        generation: 7,
        notification: {
          method: "item/completed",
          params: {
            threadId: "parent-a",
            turnId: "turn-parent",
            completedAtMs: 120_000,
            item: {
              type: "subAgentActivity",
              id: "spawn-child-a",
              kind: "started",
              agentThreadId: "child-a",
              agentPath: "root-a/parent-a/child-a",
            },
          },
        },
        occurrenceToken: 1,
        observedAtMs: 120_000,
      });
      assert.deepEqual(observedEdges, []);

      entries.set("parent-a", {
        ...parentShell,
        durable: { ...parentShell.durable, parentThreadId: "root-a" },
      });
      yield* service.observeNotification({
        hostId: "remote-a",
        generation: 7,
        notification: {
          method: "item/completed",
          params: {
            threadId: "root-a",
            turnId: "turn-root",
            completedAtMs: 121_000,
            item: {
              type: "subAgentActivity",
              id: "spawn-parent-a",
              kind: "started",
              agentThreadId: "parent-a",
              agentPath: "root-a/parent-a",
            },
          },
        },
        occurrenceToken: 2,
        observedAtMs: 121_000,
      });

      assert.deepEqual(observedEdges, [
        { parentId: "root-a", threadId: "parent-a" },
        { parentId: "parent-a", threadId: "child-a" },
      ]);
    }),
  ),
);

it.effect("bounds child-before-parent spawn admission by count and bytes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entries = new Map<string, CodexThreadDirectoryEntry>([["root-a", rootDirectoryEntry]]);
      const observedThreadIds: string[] = [];
      const read: CoreModuleClients["workspace"]["read"] = () => Effect.die("unexpected Core read");
      const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
        Effect.sync(() => {
          if (input.intent.kind === "observe_subagent_discovery_page") {
            observedThreadIds.push(
              ...input.intent.observations.map((observation) => observation.thread_id),
            );
          }
          return {} as never;
        });
      const service = yield* buildDirectory({
        capability,
        read,
        apply,
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
        resolve: ({ threadId }) => Effect.succeed(entries.get(threadId) ?? null),
      });
      const observeStarted = (thread: Thread, occurrenceToken: number) =>
        service.observeNotification({
          hostId: "remote-a",
          generation: 7,
          notification: { method: "thread/started", params: { thread } },
          occurrenceToken,
          observedAtMs: occurrenceToken,
        });

      for (let index = 0; index < 4_097; index += 1) {
        yield* observeStarted(spawnThread(`count-child-${index}`, "count-parent"), index + 1);
      }
      entries.set("count-parent", {
        ...rootDirectoryEntry,
        durable: {
          ...rootDirectoryEntry.durable,
          threadId: "count-parent",
          sessionId: "session-count-parent",
          parentThreadId: "root-a",
          threadSource: "subAgentThreadSpawn",
        },
      } as CodexThreadDirectoryEntry);
      yield* observeStarted(spawnThread("count-parent", "root-a"), 5_000);

      const countChildren = observedThreadIds.filter((threadId) =>
        threadId.startsWith("count-child-"),
      );
      assert.isAtMost(countChildren.length, 4_096);
      assert.notInclude(countChildren, "count-child-0");
      assert.include(countChildren, "count-child-4096");

      for (let index = 0; index < 60; index += 1) {
        yield* observeStarted(
          spawnThread(`byte-child-${index}`, "byte-parent", "x".repeat(100_000)),
          6_000 + index,
        );
      }
      entries.set("byte-parent", {
        ...rootDirectoryEntry,
        durable: {
          ...rootDirectoryEntry.durable,
          threadId: "byte-parent",
          sessionId: "session-byte-parent",
          parentThreadId: "root-a",
          threadSource: "subAgentThreadSpawn",
        },
      } as CodexThreadDirectoryEntry);
      yield* observeStarted(spawnThread("byte-parent", "root-a"), 7_000);

      const byteChildren = observedThreadIds.filter((threadId) =>
        threadId.startsWith("byte-child-"),
      );
      assert.isAbove(byteChildren.length, 0);
      assert.isBelow(byteChildren.length, 60);
      assert.include(byteChildren, "byte-child-59");
    }),
  ),
);

it.effect("repairs a non-empty but stale state-db result before declaring discovery complete", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const staleChild = {
        ...child,
        id: "child-stale",
        sessionId: "session-child-stale",
        name: "Stale scout",
      } satisfies Thread;
      const observed = new Map<string, Thread>();
      let complete = false;
      const stateDbModes: boolean[] = [];
      const overview = (): Overview =>
        ({
          universe: {
            host_id: "remote-a",
            source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
            generation: 7,
            root_thread_id: "root-a",
          },
          active: {
            items: [...observed.values()].map((thread) => ({
              thread: {
                thread_id: thread.id,
                parent_thread_id: "root-a",
                thread_name: thread.name,
                thread_preview: thread.preview,
                model_provider: thread.modelProvider,
                model_id: "gpt-test",
                agent_nickname: thread.agentNickname,
                agent_role: thread.agentRole,
                agent_path: null,
                archived: false,
                created_at: 100_000,
                updated_at: 120_000,
                recency_at: 120_000,
              },
              status: "unknown",
              evidence: null,
            })),
            next_cursor: null,
            authority: { projection_revision: observed.size + 1 },
          },
          done: {
            items: [],
            next_cursor: null,
            authority: { projection_revision: observed.size + 1 },
          },
          known_active_count: observed.size,
          known_done_count: 0,
          discovery_complete: complete,
          discovery_continuation: null,
          projection_revision: observed.size + 1,
        }) as unknown as Overview;
      const read: CoreModuleClients["workspace"]["read"] = () =>
        Effect.succeed({
          commit_head: observed.size + 1,
          value: { kind: "subagent_overview_window", overview: overview() },
        } as unknown as ProjectWorkspaceReadSnapshot);
      const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
        Effect.sync(() => {
          if (input.intent.kind !== "observe_subagent_discovery_page") return {} as never;
          for (const observation of input.intent.observations) {
            observed.set(
              observation.thread_id,
              observation.thread_id === child.id ? child : staleChild,
            );
          }
          complete = input.intent.complete;
          return {} as never;
        });
      const requestOnHost = ((_hostId: string, method: string, rawParams: unknown) =>
        Effect.sync(() => {
          const params = rawParams as {
            readonly threadId?: string;
            readonly useStateDbOnly?: boolean;
          };
          if (method === "thread/read") {
            assert.strictEqual(params.threadId, child.id);
            return { thread: child };
          }
          if (method === "thread/turns/list") {
            return { data: [], nextCursor: null, backwardsCursor: null };
          }
          assert.strictEqual(method, "thread/list");
          stateDbModes.push(params.useStateDbOnly === true);
          return {
            data: [staleChild],
            nextCursor: null,
            backwardsCursor: null,
          };
        })) as RequestOnHost;
      const service = yield* buildDirectory({
        capability,
        read,
        apply,
        requestOnHost,
        observedSubagentThreadIds: [child.id],
      });

      const result = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });

      assert.deepEqual(stateDbModes, [true, false]);
      assert.strictEqual(result.completeness, "complete");
      assert.deepEqual(
        result.active.rows.map((row) => row.threadId).sort(),
        [child.id, staleChild.id].sort(),
      );
    }),
  ),
);

it.effect(
  "repairs a nested edge from bounded parent history when state-db and started miss it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nestedChild: Thread = {
          ...child,
          id: "child-b",
          sessionId: "session-child-b",
          parentThreadId: child.id,
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: child.id,
                depth: 2,
                agent_path: "root-a/Scout/Verifier",
                agent_nickname: "Verifier",
                agent_role: "reviewer",
              },
            },
          },
          agentNickname: "Verifier",
          agentRole: "reviewer",
          name: "Verifier",
        };
        const observed = new Map<string, Thread>();
        let complete = false;
        let continuation: string | null = null;
        const requestMethods: string[] = [];
        const overview = (): Overview =>
          ({
            universe: {
              host_id: "remote-a",
              source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
              generation: 7,
              root_thread_id: "root-a",
            },
            active: {
              items: [...observed.values()].map((thread) => ({
                thread: {
                  thread_id: thread.id,
                  parent_thread_id: extractCodexThreadSubagentMetadata(thread).parentThreadId,
                  thread_name: thread.name,
                  thread_preview: thread.preview,
                  model_provider: thread.modelProvider,
                  model_id: "gpt-test",
                  agent_nickname: thread.agentNickname,
                  agent_role: thread.agentRole,
                  agent_path: null,
                  archived: false,
                  created_at: 100_000,
                  updated_at: 120_000,
                  recency_at: 120_000,
                },
                status: "active",
                evidence: null,
              })),
              next_cursor: null,
              authority: { projection_revision: observed.size + 1 },
            },
            done: {
              items: [],
              next_cursor: null,
              authority: { projection_revision: observed.size + 1 },
            },
            known_active_count: observed.size,
            known_done_count: 0,
            discovery_complete: complete,
            discovery_continuation: continuation,
            projection_revision: observed.size + 1,
          }) as unknown as Overview;
        const read: CoreModuleClients["workspace"]["read"] = () =>
          Effect.succeed({
            commit_head: observed.size + 1,
            value: { kind: "subagent_overview_window", overview: overview() },
          } as unknown as ProjectWorkspaceReadSnapshot);
        const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
          Effect.sync(() => {
            if (input.intent.kind !== "observe_subagent_discovery_page") return {} as never;
            for (const observation of input.intent.observations) {
              observed.set(
                observation.thread_id,
                observation.thread_id === child.id ? child : nestedChild,
              );
            }
            continuation = input.intent.continuation ?? null;
            complete = input.intent.complete;
            return {} as never;
          });
        const requestOnHost = ((_hostId: string, method: string, rawParams: unknown) =>
          Effect.sync(() => {
            requestMethods.push(method);
            const params = rawParams as { readonly threadId?: string };
            if (method === "thread/list") {
              return { data: [child], nextCursor: null, backwardsCursor: null };
            }
            if (method === "thread/read") {
              assert.strictEqual(params.threadId, nestedChild.id);
              return { thread: nestedChild };
            }
            assert.strictEqual(method, "thread/turns/list");
            if (params.threadId !== child.id) {
              return { data: [], nextCursor: null, backwardsCursor: null };
            }
            return {
              data: [
                {
                  id: "turn-spawn-nested",
                  status: "completed",
                  itemsView: "full",
                  items: [
                    {
                      type: "collabAgentToolCall",
                      id: "spawn-nested",
                      tool: "spawnAgent",
                      status: "completed",
                      senderThreadId: child.id,
                      receiverThreadIds: [nestedChild.id],
                      prompt: null,
                      model: null,
                      reasoningEffort: null,
                      agentsStates: {},
                    },
                  ],
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  durationMs: 1_000,
                },
              ],
              nextCursor: null,
              backwardsCursor: null,
            };
          })) as RequestOnHost;
        const service = yield* buildDirectory({
          capability,
          read,
          apply,
          requestOnHost,
          observedSubagentThreadIdsByParent: { [child.id]: [nestedChild.id] },
        });

        const result = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });

        assert.strictEqual(result.completeness, "complete");
        assert.deepEqual(
          result.active.rows.map((row) => row.threadId).sort(),
          [child.id, nestedChild.id].sort(),
        );
        assert.deepEqual(requestMethods, [
          "thread/list",
          "thread/list",
          "thread/read",
          "thread/turns/list",
          "thread/turns/list",
          "thread/turns/list",
        ]);
      }),
    ),
);

it.effect(
  "persists topology budget exhaustion instead of rescanning an oversized history page",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let complete = false;
        let continuation: string | null = null;
        let observed = false;
        const requestMethods: string[] = [];
        const overview = (): Overview =>
          ({
            universe: {
              host_id: "remote-a",
              source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
              generation: 7,
              root_thread_id: "root-a",
            },
            active: {
              items: observed
                ? [
                    {
                      thread: {
                        thread_id: child.id,
                        parent_thread_id: "root-a",
                        thread_name: child.name,
                        thread_preview: child.preview,
                        model_provider: child.modelProvider,
                        model_id: "gpt-test",
                        agent_nickname: child.agentNickname,
                        agent_role: child.agentRole,
                        agent_path: null,
                        archived: false,
                        created_at: 100_000,
                        updated_at: 120_000,
                        recency_at: 120_000,
                      },
                      status: "active",
                      evidence: null,
                    },
                  ]
                : [],
              next_cursor: null,
              authority: { projection_revision: observed ? 2 : 1 },
            },
            done: {
              items: [],
              next_cursor: null,
              authority: { projection_revision: observed ? 2 : 1 },
            },
            known_active_count: observed ? 1 : 0,
            known_done_count: 0,
            discovery_complete: complete,
            discovery_continuation: continuation,
            projection_revision: observed ? 2 : 1,
          }) as unknown as Overview;
        const read: CoreModuleClients["workspace"]["read"] = () =>
          Effect.succeed({
            commit_head: observed ? 2 : 1,
            value: { kind: "subagent_overview_window", overview: overview() },
          } as unknown as ProjectWorkspaceReadSnapshot);
        const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
          Effect.sync(() => {
            if (input.intent.kind !== "observe_subagent_discovery_page") return {} as never;
            observed ||= input.intent.observations.some(
              (observation) => observation.thread_id === child.id,
            );
            continuation = input.intent.continuation ?? null;
            complete = input.intent.complete;
            return {} as never;
          });
        const oversizedText = "x".repeat(9 * 1024 * 1024);
        const requestOnHost = ((_hostId: string, method: string) =>
          Effect.sync(() => {
            requestMethods.push(method);
            if (method === "thread/list") {
              return { data: [], nextCursor: null, backwardsCursor: null };
            }
            if (method === "thread/read") {
              return { thread: child };
            }
            assert.strictEqual(method, "thread/turns/list");
            return {
              data: [
                {
                  id: "oversized-turn",
                  status: "completed",
                  itemsView: "full",
                  items: [
                    {
                      type: "agentMessage",
                      id: "oversized-message",
                      text: oversizedText,
                      phase: null,
                      memoryCitation: null,
                      delivery: null,
                    },
                  ],
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  durationMs: 1_000,
                },
              ],
              nextCursor: "oversized-next",
              backwardsCursor: null,
            };
          })) as RequestOnHost;
        const service = yield* buildDirectory({
          capability,
          read,
          apply,
          requestOnHost,
          observedSubagentThreadIds: [child.id],
        });

        const first = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });
        const requestsAfterFirst = requestMethods.length;
        const second = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });

        assert.strictEqual(first.completeness, "incomplete");
        assert.strictEqual(second.completeness, "incomplete");
        assert.deepEqual(requestMethods, [
          "thread/list",
          "thread/list",
          "thread/read",
          "thread/turns/list",
        ]);
        assert.strictEqual(requestMethods.length, requestsAfterFirst);
        const state = JSON.parse((continuation ?? "").slice("subagent-ancestor-v1:".length)) as {
          readonly scannedPages: number;
          readonly scannedBytes: number;
        };
        assert.strictEqual(state.scannedPages, 200);
        assert.strictEqual(state.scannedBytes, 64 * 1024 * 1024);
      }),
    ),
);

it.effect("resumes bounded direct-parent BFS when an older host lacks ancestor filtering", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const legacyCapability: CodexAppServerCapabilitySnapshot = {
        ...capability,
        userAgent: "codex-app-server/0.149.0",
        version: "0.149.0",
        flags: {
          ...capability.flags,
          subagentAncestorFilter: false,
          multiAgentV2Protocol: false,
        },
      };
      const nestedChild: Thread = {
        ...child,
        id: "child-b",
        sessionId: "session-child-b",
        parentThreadId: "child-a",
        preview: "Inspect the nested runtime state",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "child-a",
              depth: 2,
              agent_path: "root-a/Scout/Verifier",
              agent_nickname: "Verifier",
              agent_role: "reviewer",
            },
          },
        },
        agentNickname: "Verifier",
        agentRole: "reviewer",
        name: "Verifier",
      };
      const observed = new Map<string, Thread>();
      let complete = false;
      const requests: Array<{
        readonly method: string;
        readonly params: Record<string, unknown>;
        readonly options: unknown;
      }> = [];
      const overview = (): Overview =>
        ({
          universe: {
            host_id: "remote-a",
            source_epoch: "remote-a:codex-app-server/0.149.0",
            generation: 7,
            root_thread_id: "root-a",
          },
          active: {
            items: [...observed.values()].map((thread) => ({
              thread: {
                thread_id: thread.id,
                parent_thread_id: extractCodexThreadSubagentMetadata(thread).parentThreadId,
                thread_name: thread.name,
                thread_preview: thread.preview,
                model_provider: thread.modelProvider,
                model_id: "gpt-test",
                agent_nickname: thread.agentNickname,
                agent_role: thread.agentRole,
                agent_path: null,
                archived: false,
                created_at: 100_000,
                updated_at: 120_000,
                recency_at: 120_000,
              },
              status: "active",
              evidence: null,
            })),
            next_cursor: null,
            authority: { projection_revision: observed.size + 1 },
          },
          done: {
            items: [],
            next_cursor: null,
            authority: { projection_revision: observed.size + 1 },
          },
          known_active_count: observed.size,
          known_done_count: 0,
          discovery_complete: complete,
          discovery_continuation: null,
          projection_revision: observed.size + 1,
        }) as unknown as Overview;
      const read: CoreModuleClients["workspace"]["read"] = () =>
        Effect.succeed({
          commit_head: observed.size + 1,
          value: { kind: "subagent_overview_window", overview: overview() },
        } as unknown as ProjectWorkspaceReadSnapshot);
      const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
        Effect.sync(() => {
          if (input.intent.kind === "observe_subagent_discovery_page") {
            for (const observation of input.intent.observations) {
              const thread = observation.thread_id === child.id ? child : nestedChild;
              observed.set(observation.thread_id, thread);
            }
            complete = input.intent.complete;
          }
          return {} as never;
        });
      const requestOnHost = ((
        hostId: string,
        method: string,
        rawParams: unknown,
        options: unknown,
      ) =>
        Effect.sync(() => {
          const params = rawParams as Record<string, unknown>;
          assert.strictEqual(hostId, "remote-a");
          if (method === "thread/turns/list") {
            requests.push({ method, params, options });
            return { data: [], nextCursor: null, backwardsCursor: null };
          }
          assert.strictEqual(method, "thread/list");
          assert.notProperty(params, "ancestorThreadId");
          requests.push({ method, params, options });
          if (params.parentThreadId === "root-a") {
            return { data: [child], nextCursor: null, backwardsCursor: null };
          }
          if (params.parentThreadId === "child-a") {
            return { data: [nestedChild], nextCursor: null, backwardsCursor: null };
          }
          return { data: [], nextCursor: null, backwardsCursor: null };
        })) as RequestOnHost;
      const service = yield* buildDirectory({
        capability: legacyCapability,
        read,
        apply,
        requestOnHost,
      });

      const result = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });

      assert.strictEqual(result.completeness, "complete");
      assert.deepEqual(
        result.active.rows.map((row) => row.threadId),
        ["child-a", "child-b"],
      );
      assert.deepEqual(
        requests
          .filter((request) => request.method === "thread/list")
          .map((request) => [request.params.parentThreadId, request.params.useStateDbOnly]),
        [
          ["root-a", true],
          ["child-a", true],
          ["child-b", true],
          ["child-b", false],
        ],
      );
      assert.isTrue(
        requests.every(
          (request) =>
            (request.options as { readonly conversationId?: string }).conversationId === "root-a",
        ),
      );
    }),
  ),
);

it.live("checks only the latest turn skeleton before interrupting an unknown descendant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const overview: Overview = {
        universe: {
          host_id: "remote-a",
          source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
          generation: 7,
          root_thread_id: "root-a",
        },
        active: {
          items: [
            {
              thread: {
                thread_id: "child-a",
                parent_thread_id: "root-a",
                thread_name: "Scout",
                thread_preview: child.preview,
                model_provider: "openai",
                model_id: "gpt-test",
                agent_nickname: "Scout",
                agent_role: "explorer",
                agent_path: "root-a/Scout",
                archived: false,
                created_at: 100_000,
                updated_at: 120_000,
                recency_at: 120_000,
              },
              status: "unknown",
              evidence: null,
            },
          ],
          next_cursor: null,
          authority: { projection_revision: 3 },
        },
        done: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: 3 },
        },
        known_active_count: 1,
        known_done_count: 0,
        discovery_complete: true,
        discovery_continuation: null,
        projection_revision: 3,
      } as unknown as Overview;
      let projectedDone = false;
      const read: CoreModuleClients["workspace"]["read"] = (input) =>
        Effect.succeed(
          input.kind === "subagent_overview_item"
            ? ({
                commit_head: 3,
                value: {
                  kind: "subagent_overview_item",
                  item: {
                    ...overview.active.items[0],
                    status: projectedDone ? "done" : "unknown",
                    evidence: projectedDone
                      ? { kind: "reconciliation", source_revision: 0, observed_at_ms: 130_000 }
                      : null,
                  },
                  projection_revision: 3,
                },
              } as unknown as ProjectWorkspaceReadSnapshot)
            : ({
                commit_head: 3,
                value: { kind: "subagent_overview_window", overview },
              } as unknown as ProjectWorkspaceReadSnapshot),
        );
      const requests: Array<{
        readonly method: string;
        readonly params: unknown;
        readonly options: unknown;
      }> = [];
      let interrupted = false;
      let postconditionReads = 0;
      const requestOnHost = ((hostId: string, method: string, params: unknown, options: unknown) =>
        Effect.sync(() => {
          assert.strictEqual(hostId, "remote-a");
          requests.push({ method, params, options });
          if (method === "thread/turns/list") {
            if (interrupted) postconditionReads += 1;
            return {
              data: [
                {
                  id: "turn-child-a",
                  status: interrupted && postconditionReads > 1 ? "interrupted" : "inProgress",
                },
              ],
              nextCursor: null,
            };
          }
          if (method === "turn/interrupt") {
            interrupted = true;
            return {};
          }
          throw new Error(`Unexpected method ${method}`);
        })) as RequestOnHost;
      const service = yield* buildDirectory({
        capability,
        read,
        apply: (input) =>
          Effect.sync(() => {
            if (input.intent.kind === "observe_subagent_status_evidence") projectedDone = true;
            return {} as never;
          }),
        requestOnHost,
      });

      const result = yield* service.settleInterruptedSubtree("root-a");

      assert.deepEqual(result, {
        discoveryComplete: true,
        interruptedThreadIds: ["child-a"],
        failed: [],
        unresolvedThreadIds: [],
      });
      assert.deepEqual(
        requests.map((request) => request.method),
        ["thread/turns/list", "turn/interrupt", "thread/turns/list", "thread/turns/list"],
      );
      assert.deepEqual(requests[0]?.params, {
        threadId: "child-a",
        cursor: null,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      assert.deepInclude(requests[1]?.options as object, {
        priority: "critical",
        source: "collab_lifecycle",
        conversationId: "root-a",
      });
    }),
  ),
);

it.effect("treats a typed missing Thread response as an idempotently settled descendant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const overview: Overview = {
        universe: {
          host_id: "remote-a",
          source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
          generation: 7,
          root_thread_id: "root-a",
        },
        active: {
          items: [
            {
              thread: {
                thread_id: "child-a",
                parent_thread_id: "root-a",
                thread_name: "Scout",
                thread_preview: child.preview,
                model_provider: "openai",
                model_id: "gpt-test",
                agent_nickname: "Scout",
                agent_role: "explorer",
                agent_path: "root-a/Scout",
                archived: false,
                created_at: 100_000,
                updated_at: 120_000,
                recency_at: 120_000,
              },
              status: "unknown",
              evidence: null,
            },
          ],
          next_cursor: null,
          authority: { projection_revision: 3 },
        },
        done: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: 3 },
        },
        known_active_count: 1,
        known_done_count: 0,
        discovery_complete: true,
        discovery_continuation: null,
        projection_revision: 3,
      } as unknown as Overview;
      const appliedStatuses: string[] = [];
      const service = yield* buildDirectory({
        capability,
        read: (input) =>
          Effect.succeed(
            input.kind === "subagent_overview_item"
              ? ({
                  commit_head: 3,
                  value: {
                    kind: "subagent_overview_item",
                    item: {
                      ...overview.active.items[0],
                      status: appliedStatuses.length > 0 ? "done" : "unknown",
                      evidence:
                        appliedStatuses.length > 0
                          ? {
                              kind: "reconciliation",
                              source_revision: 0,
                              observed_at_ms: 130_000,
                            }
                          : null,
                    },
                    projection_revision: 3,
                  },
                } as unknown as ProjectWorkspaceReadSnapshot)
              : ({
                  commit_head: 3,
                  value: { kind: "subagent_overview_window", overview },
                } as unknown as ProjectWorkspaceReadSnapshot),
          ),
        apply: (input) =>
          Effect.sync(() => {
            if (input.intent.kind === "observe_subagent_status_evidence") {
              appliedStatuses.push(input.intent.status);
            }
            return {} as never;
          }),
        requestOnHost: ((hostId: string, method: string) =>
          Effect.fail(
            codexRuntimeError({
              operation: "request",
              reason: "request",
              retryable: false,
              hostId,
              method,
              cause: new CodexAppServerRequestError({
                code: -32_600,
                errorMessage: "thread not loaded: child-a",
                method,
                operation: "receive-response",
              }),
            }),
          )) as RequestOnHost,
      });

      const result = yield* service.settleInterruptedSubtree("root-a");

      assert.deepEqual(result, {
        discoveryComplete: true,
        interruptedThreadIds: [],
        failed: [],
        unresolvedThreadIds: [],
      });
      assert.deepEqual(appliedStatuses, ["done"]);
    }),
  ),
);

it.effect("projects an observed terminal skeleton before reporting the child settled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const overview: Overview = {
        universe: {
          host_id: "remote-a",
          source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
          generation: 7,
          root_thread_id: "root-a",
        },
        active: {
          items: [
            {
              thread: {
                thread_id: "child-a",
                parent_thread_id: "root-a",
                thread_name: "Scout",
                thread_preview: child.preview,
                model_provider: "openai",
                model_id: "gpt-test",
                agent_nickname: "Scout",
                agent_role: "explorer",
                agent_path: "root-a/Scout",
                archived: false,
                created_at: 100_000,
                updated_at: 120_000,
                recency_at: 120_000,
              },
              status: "unknown",
              evidence: null,
            },
          ],
          next_cursor: null,
          authority: { projection_revision: 3 },
        },
        done: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: 3 },
        },
        known_active_count: 1,
        known_done_count: 0,
        discovery_complete: true,
        discovery_continuation: null,
        projection_revision: 3,
      } as unknown as Overview;
      let projectedStatus: string | null = null;
      const invalidatedRoots: string[] = [];
      const read: CoreModuleClients["workspace"]["read"] = (input) =>
        Effect.succeed(
          input.kind === "subagent_overview_item"
            ? ({
                commit_head: 3,
                value: {
                  kind: "subagent_overview_item",
                  item: {
                    ...overview.active.items[0],
                    status: projectedStatus === "done" ? "done" : "unknown",
                    evidence:
                      projectedStatus === "done"
                        ? {
                            kind: "reconciliation",
                            source_revision: 0,
                            observed_at_ms: 130_000,
                          }
                        : null,
                  },
                  projection_revision: 3,
                },
              } as unknown as ProjectWorkspaceReadSnapshot)
            : ({
                commit_head: 3,
                value: { kind: "subagent_overview_window", overview },
              } as unknown as ProjectWorkspaceReadSnapshot),
        );
      const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
        Effect.sync(() => {
          if (input.intent.kind === "observe_subagent_status_evidence") {
            projectedStatus = input.intent.status;
          }
          return {} as never;
        });
      const requestOnHost = ((_hostId: string, method: string) => {
        if (method !== "thread/turns/list") return Effect.die(`Unexpected method ${method}`);
        return Effect.succeed({
          data: [{ id: "turn-child-a", status: "completed", completedAt: 130 }],
          nextCursor: null,
        });
      }) as RequestOnHost;
      const service = yield* buildDirectory({
        capability,
        read,
        apply,
        requestOnHost,
        publish: (event) => {
          if (event.kind !== "codex" || event.value.type !== "subagentOverviewInvalidated") return;
          invalidatedRoots.push(event.value.rootThreadId);
        },
      });

      const result = yield* service.settleInterruptedSubtree("root-a");

      assert.strictEqual(projectedStatus, "done");
      assert.deepEqual(invalidatedRoots, ["root-a"]);
      assert.deepEqual(result, {
        discoveryComplete: true,
        interruptedThreadIds: [],
        failed: [],
        unresolvedThreadIds: [],
      });
    }),
  ),
);

it.effect("returns one typed outcome for every known descendant when the stop budget expires", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadIds = Array.from({ length: 8 }, (_, index) => `child-${index + 1}`);
      const items = threadIds.map((threadId) => ({
        thread: {
          thread_id: threadId,
          parent_thread_id: "root-a",
          thread_name: threadId,
          thread_preview: threadId,
          model_provider: "openai",
          model_id: "gpt-test",
          agent_nickname: threadId,
          agent_role: "explorer",
          agent_path: `root-a/${threadId}`,
          archived: false,
          created_at: 100_000,
          updated_at: 120_000,
          recency_at: 120_000,
        },
        status: "unknown" as const,
        evidence: null,
      }));
      const overview = {
        universe: {
          host_id: "remote-a",
          source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
          generation: 7,
          root_thread_id: "root-a",
        },
        active: {
          items,
          next_cursor: null,
          authority: { projection_revision: 3 },
        },
        done: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: 3 },
        },
        known_active_count: items.length,
        known_done_count: 0,
        discovery_complete: true,
        discovery_continuation: null,
        projection_revision: 3,
      } as unknown as Overview;
      const read: CoreModuleClients["workspace"]["read"] = (input) =>
        Effect.succeed(
          input.kind === "subagent_overview_item"
            ? ({
                commit_head: 3,
                value: {
                  kind: "subagent_overview_item",
                  item: items.find((item) => item.thread.thread_id === input.thread_id) ?? null,
                  projection_revision: 3,
                },
              } as unknown as ProjectWorkspaceReadSnapshot)
            : ({
                commit_head: 3,
                value: { kind: "subagent_overview_window", overview },
              } as unknown as ProjectWorkspaceReadSnapshot),
        );
      const requestedThreadIds: string[] = [];
      const requestOnHost = ((_hostId: string, method: string, params: unknown) => {
        if (method !== "thread/turns/list") return Effect.die(`Unexpected method ${method}`);
        requestedThreadIds.push((params as { readonly threadId: string }).threadId);
        return Effect.never;
      }) as RequestOnHost;
      const service = yield* buildDirectory({
        capability,
        read,
        apply: () => Effect.succeed({} as never),
        requestOnHost,
      });

      const fiber = yield* service.settleInterruptedSubtree("root-a").pipe(Effect.forkChild);
      yield* TestClock.adjust("4750 millis");
      const result = yield* Fiber.join(fiber);

      assert.deepEqual(requestedThreadIds.sort(), ["child-1", "child-2"]);
      assert.deepEqual(result, {
        discoveryComplete: true,
        interruptedThreadIds: [],
        failed: [],
        unresolvedThreadIds: threadIds,
      });
      assert.strictEqual(new Set(result.unresolvedThreadIds).size, threadIds.length);
    }),
  ),
);

it.effect("reconciles a durable delete closure by operation id after the root is gone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let settled = false;
      let rootResolveCount = 0;
      const lifecycle = (includeSettled = false): Lifecycle =>
        ({
          universe: {
            host_id: "remote-a",
            source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
            generation: 7,
            root_thread_id: "deleted-root",
          },
          lifecycle_operation_id: "delete-operation-a",
          action: "delete",
          members: {
            items:
              settled && !includeSettled
                ? []
                : [
                    {
                      thread_id: "deleted-root",
                      outcome: settled ? "settled" : "pending",
                      attempt_count: settled ? 1 : 0,
                      last_reason: null,
                      observed_at_ms: settled ? 10 : null,
                    },
                    {
                      thread_id: "deleted-child",
                      outcome: settled ? "settled" : "pending",
                      attempt_count: settled ? 1 : 0,
                      last_reason: null,
                      observed_at_ms: settled ? 10 : null,
                    },
                  ],
            next_cursor: null,
            authority: { projection_revision: settled ? 5 : 4 },
          },
          expected_count: 2,
          processed_count: settled ? 2 : 0,
          unresolved_count: settled ? 0 : 2,
          complete: settled,
          projection_revision: settled ? 5 : 4,
        }) as unknown as Lifecycle;
      const read: CoreModuleClients["workspace"]["read"] = (input) => {
        if (input.kind !== "subagent_lifecycle_batch") {
          return assert.fail(`Unexpected read ${input.kind}`) as never;
        }
        return Effect.succeed({
          commit_head: settled ? 5 : 4,
          value: {
            kind: "subagent_lifecycle_batch",
            lifecycle: lifecycle(input.include_settled),
          },
        } as unknown as ProjectWorkspaceReadSnapshot);
      };
      const locallyDeletedThreadIds: string[] = [];
      const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
        Effect.sync(() => {
          if (input.intent.kind === "observe_subagent_lifecycle_outcomes") {
            assert.deepEqual(
              input.intent.observations.map((observation) => observation.outcome),
              ["settled", "settled"],
            );
            settled = true;
            return {} as never;
          }
          if (input.intent.kind !== "delete_thread") {
            return assert.fail(`Unexpected intent ${input.intent.kind}`) as never;
          }
          locallyDeletedThreadIds.push(input.intent.thread_id);
          return {} as never;
        });
      const readThreadIds: string[] = [];
      const requestOnHost = ((hostId: string, method: string, rawParams: unknown) => {
        assert.strictEqual(hostId, "remote-a");
        assert.strictEqual(method, "thread/read");
        readThreadIds.push((rawParams as { readonly threadId: string }).threadId);
        return Effect.fail(
          codexRuntimeError({
            operation: "request",
            reason: "request",
            retryable: false,
            hostId,
            method,
            cause: new CodexAppServerRequestError({
              code: -32_600,
              errorMessage: `thread not loaded: ${readThreadIds.at(-1)}`,
              method,
              requestId: "read-missing",
              operation: "receive-response",
            }),
          }),
        );
      }) as unknown as RequestOnHost;
      const service = yield* buildDirectory({
        capability,
        read,
        apply,
        requestOnHost,
        resolve: () =>
          Effect.sync(() => {
            rootResolveCount += 1;
            return null;
          }),
      });

      const result = yield* service.reconcileLifecycle({ operationId: "delete-operation-a" });

      assert.deepEqual(result, {
        operationId: "delete-operation-a",
        action: "delete",
        expectedCount: 2,
        processedCount: 2,
        unresolvedCount: 0,
        complete: true,
      });
      assert.deepEqual(readThreadIds, ["deleted-root", "deleted-child"]);
      assert.deepEqual(locallyDeletedThreadIds, ["deleted-child"]);
      assert.strictEqual(rootResolveCount, 0);
    }),
  ),
);

it.effect("cleans the complete durable delete cohort across reconciliation rounds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const outcomes = new Map<string, "pending" | "unresolved" | "failed" | "settled">([
        ["deleted-root", "pending"],
        ["deleted-child-a", "pending"],
        ["deleted-child-b", "pending"],
      ]);
      let reconciliationRound = 1;
      let revision = 4;
      const lifecycle = (includeSettled: boolean): Lifecycle => {
        const items = [...outcomes].flatMap(([threadId, outcome]) =>
          includeSettled || outcome !== "settled"
            ? [
                {
                  thread_id: threadId,
                  outcome,
                  attempt_count: outcome === "pending" ? 0 : 1,
                  last_reason: outcome === "failed" ? "failed" : null,
                  observed_at_ms: outcome === "pending" ? null : reconciliationRound * 10,
                },
              ]
            : [],
        );
        const unresolvedCount = [...outcomes.values()].filter(
          (outcome) => outcome !== "settled",
        ).length;
        return {
          universe: {
            host_id: "remote-a",
            source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
            generation: 7,
            root_thread_id: "deleted-root",
          },
          lifecycle_operation_id: "delete-operation-multi-round",
          action: "delete",
          members: {
            items,
            next_cursor: null,
            authority: { projection_revision: revision },
          },
          expected_count: outcomes.size,
          processed_count: [...outcomes.values()].filter((outcome) => outcome !== "pending").length,
          unresolved_count: unresolvedCount,
          complete: unresolvedCount === 0,
          projection_revision: revision,
        } as unknown as Lifecycle;
      };
      const read: CoreModuleClients["workspace"]["read"] = (input) => {
        if (input.kind !== "subagent_lifecycle_batch") {
          return assert.fail(`Unexpected read ${input.kind}`) as never;
        }
        return Effect.succeed({
          commit_head: revision,
          value: {
            kind: "subagent_lifecycle_batch",
            lifecycle: lifecycle(input.include_settled),
          },
        } as unknown as ProjectWorkspaceReadSnapshot);
      };
      const locallyDeletedThreadIds: string[] = [];
      const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
        Effect.sync(() => {
          if (input.intent.kind === "observe_subagent_lifecycle_outcomes") {
            for (const observation of input.intent.observations) {
              outcomes.set(observation.thread_id, observation.outcome);
            }
            revision += 1;
            return {} as never;
          }
          if (input.intent.kind !== "delete_thread") {
            return assert.fail(`Unexpected intent ${input.intent.kind}`) as never;
          }
          locallyDeletedThreadIds.push(input.intent.thread_id);
          return {} as never;
        });
      const requestOnHost = ((hostId: string, method: string, rawParams: unknown) => {
        assert.strictEqual(hostId, "remote-a");
        assert.strictEqual(method, "thread/read");
        const threadId = (rawParams as { readonly threadId: string }).threadId;
        if (threadId === "deleted-child-b" && reconciliationRound === 1) {
          return Effect.succeed({ id: threadId } as never);
        }
        return Effect.fail(
          codexRuntimeError({
            operation: "request",
            reason: "request",
            retryable: false,
            hostId,
            method,
            cause: new CodexAppServerRequestError({
              code: -32_600,
              errorMessage: `thread not loaded: ${threadId}`,
              method,
              requestId: `read-${threadId}`,
              operation: "receive-response",
            }),
          }),
        );
      }) as unknown as RequestOnHost;
      const firstService = yield* buildDirectory({ capability, read, apply, requestOnHost });

      const partial = yield* firstService.reconcileLifecycle({
        operationId: "delete-operation-multi-round",
      });

      assert.isFalse(partial.complete);
      assert.strictEqual(outcomes.get("deleted-child-a"), "settled");
      assert.strictEqual(outcomes.get("deleted-child-b"), "unresolved");
      assert.deepEqual(locallyDeletedThreadIds, []);

      reconciliationRound = 2;
      // A new Directory scope models a Main restart; only the durable lifecycle state survives.
      const secondService = yield* buildDirectory({ capability, read, apply, requestOnHost });
      const complete = yield* secondService.reconcileLifecycle({
        operationId: "delete-operation-multi-round",
      });

      assert.isTrue(complete.complete);
      assert.deepEqual(locallyDeletedThreadIds.sort(), ["deleted-child-a", "deleted-child-b"]);
    }),
  ),
);

it.effect(
  "replays an already-complete delete cohort after local cleanup fails across a Directory restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadIds = ["deleted-root", "deleted-child-a", "deleted-child-b"] as const;
        let lifecycleComplete = false;
        let failChildCleanup = true;
        let revision = 4;
        const locallyDeletedThreadIds = new Set<string>();
        const lifecycle = (includeSettled: boolean): Lifecycle => {
          const items =
            lifecycleComplete && !includeSettled
              ? []
              : threadIds.map((threadId) => ({
                  thread_id: threadId,
                  outcome: lifecycleComplete ? ("settled" as const) : ("pending" as const),
                  attempt_count: lifecycleComplete ? 1 : 0,
                  last_reason: null,
                  observed_at_ms: lifecycleComplete ? 10 : null,
                }));
          return {
            universe: {
              host_id: "remote-a",
              source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
              generation: 7,
              root_thread_id: "deleted-root",
            },
            lifecycle_operation_id: "delete-operation-cleanup-replay",
            action: "delete",
            members: {
              items,
              next_cursor: null,
              authority: { projection_revision: revision },
            },
            expected_count: threadIds.length,
            processed_count: lifecycleComplete ? threadIds.length : 0,
            unresolved_count: lifecycleComplete ? 0 : threadIds.length,
            complete: lifecycleComplete,
            projection_revision: revision,
          } as unknown as Lifecycle;
        };
        const read: CoreModuleClients["workspace"]["read"] = (input) => {
          if (input.kind !== "subagent_lifecycle_batch") {
            return assert.fail(`Unexpected read ${input.kind}`) as never;
          }
          return Effect.succeed({
            commit_head: revision,
            value: {
              kind: "subagent_lifecycle_batch",
              lifecycle: lifecycle(input.include_settled),
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        };
        const apply: CoreModuleClients["workspace"]["apply"] = (input) => {
          if (input.intent.kind === "observe_subagent_lifecycle_outcomes") {
            return Effect.sync(() => {
              lifecycleComplete = true;
              revision += 1;
              return {} as never;
            });
          }
          if (input.intent.kind !== "delete_thread") {
            return assert.fail(`Unexpected intent ${input.intent.kind}`) as never;
          }
          const threadId = input.intent.thread_id;
          if (threadId === "deleted-child-b" && failChildCleanup) {
            return Effect.fail(new Error("local child cleanup unavailable") as never);
          }
          if (locallyDeletedThreadIds.has(threadId)) {
            return Effect.fail(
              new CoreRuntimeError({
                message: `Missing ${threadId}`,
                operation: "workspace.apply",
                reason: "operation",
                retryable: false,
                cause: new CoreModuleResponseError({
                  code: "not_found",
                  message: `Missing ${threadId}`,
                  retryable: false,
                  recovery: { kind: "none" },
                }),
              }) as never,
            );
          }
          return Effect.sync(() => {
            locallyDeletedThreadIds.add(threadId);
            return {} as never;
          });
        };
        const requestOnHost = ((hostId: string, method: string, rawParams: unknown) => {
          assert.strictEqual(hostId, "remote-a");
          assert.strictEqual(method, "thread/read");
          const threadId = (rawParams as { readonly threadId: string }).threadId;
          return Effect.fail(
            codexRuntimeError({
              operation: "request",
              reason: "request",
              retryable: false,
              hostId,
              method,
              cause: new CodexAppServerRequestError({
                code: -32_600,
                errorMessage: `thread not loaded: ${threadId}`,
                method,
                requestId: `read-${threadId}`,
                operation: "receive-response",
              }),
            }),
          );
        }) as unknown as RequestOnHost;
        const firstService = yield* buildDirectory({ capability, read, apply, requestOnHost });

        const first = yield* Effect.exit(
          firstService.reconcileLifecycle({ operationId: "delete-operation-cleanup-replay" }),
        );

        assert.isTrue(first._tag === "Failure");
        assert.isTrue(lifecycleComplete);
        assert.isFalse(locallyDeletedThreadIds.has("deleted-child-b"));

        failChildCleanup = false;
        const restartedService = yield* buildDirectory({ capability, read, apply, requestOnHost });
        const recovered = yield* restartedService.reconcileLifecycle({
          operationId: "delete-operation-cleanup-replay",
        });

        assert.isTrue(recovered.complete);
        assert.deepEqual([...locallyDeletedThreadIds].sort(), [
          "deleted-child-a",
          "deleted-child-b",
        ]);
      }),
    ),
);

it.effect("restores archive and delete notification quarantine from durable lifecycle state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let action: "archive" | "delete" = "archive";
      let complete = false;
      const read: CoreModuleClients["workspace"]["read"] = (input) => {
        if (input.kind !== "subagent_lifecycle_batch") {
          return assert.fail(`Unexpected read ${input.kind}`) as never;
        }
        return Effect.succeed({
          commit_head: 4,
          value: {
            kind: "subagent_lifecycle_batch",
            lifecycle: {
              universe: {
                host_id: "remote-a",
                source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
                generation: 7,
                root_thread_id: "root-a",
              },
              lifecycle_operation_id: input.lifecycle_operation_id,
              action,
              members: {
                items: complete
                  ? []
                  : [
                      {
                        thread_id: "root-a",
                        outcome: "pending",
                        attempt_count: 0,
                        last_reason: null,
                        observed_at_ms: null,
                      },
                    ],
                next_cursor: null,
                authority: { projection_revision: 4 },
              },
              expected_count: 1,
              processed_count: complete ? 1 : 0,
              unresolved_count: complete ? 0 : 1,
              complete,
              projection_revision: 4,
            },
          },
        } as unknown as ProjectWorkspaceReadSnapshot);
      };
      const service = yield* buildDirectory({
        capability,
        read,
        apply: () => Effect.die("unexpected apply"),
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
      });

      assert.isTrue(yield* service.shouldDeferLifecycleNotification("root-a", "thread/archived"));
      service.releaseLifecycleQuarantine("root-a", "archive");
      action = "delete";
      assert.isTrue(yield* service.shouldDeferLifecycleNotification("root-a", "thread/deleted"));
      service.releaseLifecycleQuarantine("root-a", "delete");
      complete = true;
      assert.isFalse(yield* service.shouldDeferLifecycleNotification("root-a", "thread/deleted"));
    }),
  ),
);

it.effect("fails closed when durable lifecycle quarantine cannot be read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* buildDirectory({
        capability,
        read: () => Effect.fail(new Error("Core temporarily unavailable") as never),
        apply: () => Effect.die("unexpected apply"),
        requestOnHost: (() => Effect.die("unexpected gateway request")) as RequestOnHost,
      });

      const result = yield* service
        .shouldDeferLifecycleNotification("root-a", "thread/archived")
        .pipe(Effect.result);

      assert.strictEqual(result._tag, "Failure");
    }),
  ),
);
