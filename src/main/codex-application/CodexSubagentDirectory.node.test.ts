import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CodexConversations } from "./CodexConversations";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { make } from "./CodexSubagentDirectory";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";

type RequestOnHost = CodexGateway["Service"]["requestOnHost"];
type Overview = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "subagent_overview_window" }
>["overview"];

const capability: CodexAppServerCapabilitySnapshot = {
  hostId: "remote-a",
  generation: 7,
  userAgent: "codex-app-server/0.150.0-alpha.12",
  version: "0.150.0-alpha.12",
  nativeAppTools: false,
  flags: {
    turnApprovalsReviewer: false,

    turnToolOutput: false,
    forkLastTurnId: true,
    paginatedFork: true,
    paginatedHistory: true,
    searchOccurrences: true,
    ephemeralFork: true,
    sideConversation: true,
    threadRevert: true,
    threadQueue: true,
    subagentAncestorFilter: true,
    multiAgentV2Protocol: true,
  },
};

const child = {
  model: null,
  reasoningEffort: null,
  id: "child-a",
  environments: null,
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
  originator: null,
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
  daybreakEnabled: null,
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
  readonly readConversation?: CodexConversations["Service"]["read"];
  readonly shareResident?: CodexMainConversationManagers["Service"]["shareResident"];
  readonly currentManager?: CodexMainConversationManagers["Service"]["current"];
  readonly dispatchFollowerRequest?: CodexMainConversationManagers["Service"]["dispatchFollowerRequest"];
  readonly isCurrent?: CodexAppServerCapabilities["Service"]["isCurrent"];
  readonly entities?: ConversationEntityMap["Service"];
}) => {
  const unsupported = () => Effect.die(new Error("unused"));
  return make.pipe(
    Effect.provideService(
      ConversationEntityMap,
      input.entities ?? {
        ...makeConversationEntityStateRegistry(),
        entity: () => {
          throw new Error("Unexpected entity acquisition");
        },
        runCommand: (_threadId, operation) => operation,
        retire: () => Effect.void,
      },
    ),
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
        read:
          input.readConversation ??
          ((threadId: string) => {
            const observedThreadIds =
              input.observedSubagentThreadIdsByParent?.[threadId] ??
              (threadId === "root-a" ? input.observedSubagentThreadIds : undefined);
            if (!observedThreadIds?.length && !input.hasLiveRootTurn) return null;
            return {
              generation: 1,
              snapshot: null,
              canonicalState: {
                ...conversationFixture(threadId, [
                  {
                    ...turnFixture("turn-root", input.hasLiveRootTurn ? "inProgress" : "completed"),
                    items: [
                      {
                        type: "collabAgentToolCall",
                        id: "spawn-fixture",
                        tool: "spawnAgent",
                        status: "completed",
                        senderThreadId: threadId,
                        receiverThreadIds: [...(observedThreadIds ?? [])],
                        prompt: null,
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {},
                      },
                    ],
                  },
                ]),
                threadRuntimeStatus:
                  threadId !== "root-a" || input.hasLiveRootTurn
                    ? { type: "active", activeFlags: [] }
                    : { type: "idle" },
              },
            } as never;
          }),
      } as unknown as CodexConversations["Service"]),
    ),
    Effect.provideService(CodexMainConversationManagers, {
      shareResident: input.shareResident ?? (() => Effect.void),
      current: input.currentManager ?? (() => null),
      dispatchFollowerRequest: input.dispatchFollowerRequest ?? unsupported,
    } as unknown as CodexMainConversationManagers["Service"]),
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
        isCurrent: input.isCurrent ?? (() => Effect.succeed(true)),
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

for (const scenario of [
  { name: "full resident", itemsView: "full", empty: false, attach: false },
  { name: "summary resident", itemsView: "summary", empty: false, attach: false },
  { name: "complete empty", itemsView: "full", empty: true, attach: false },
  { name: "skeleton only", itemsView: "notLoaded", empty: false, attach: true },
  { name: "interactive completed", itemsView: "full", empty: false, attach: false },
  { name: "interactive cold", itemsView: "notLoaded", empty: false, attach: true },
] as const) {
  it.effect(`opens selected ${scenario.name} canonical history without a presentation`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tailReads: string[] = [];
        const interactive = scenario.name.startsWith("interactive");
        const shared: Array<[string, string]> = [];
        const parentCanonical = conversationFixture("root-a", [
          {
            ...turnFixture("parent-turn"),
            items: [
              {
                type: "collabAgentToolCall",
                id: "spawn",
                tool: "spawnAgent",
                status: "completed",
                senderThreadId: "root-a",
                receiverThreadIds: [child.id],
                prompt: null,
                model: null,
                reasoningEffort: null,
                agentsStates: {},
              },
            ],
          },
        ]);
        const initial = produce(
          conversationFixture(
            child.id,
            scenario.empty ? [] : [{ ...turnFixture("child-turn"), itemsView: scenario.itemsView }],
          ),
          (draft) => {
            replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
          },
        );
        const attached = produce(
          conversationFixture(child.id, [turnFixture("child-turn")]),
          (draft) => {
            replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
          },
        );
        let canonical: typeof initial | null =
          scenario.name === "interactive cold" ? null : initial;
        const selected = (): CodexThreadDirectoryEntry => ({
          ...rootDirectoryEntry,
          durable: { ...rootDirectoryEntry.durable, threadId: child.id, parentThreadId: "root-a" },
          summary: { ...rootDirectoryEntry.summary, archived: false },
          canonical,
          snapshot: null,
        });
        const service = yield* buildDirectory({
          capability,
          read: (input) => {
            assert.strictEqual(input.kind, "subagent_overview_item");
            return Effect.succeed({
              commit_head: 1,
              value: {
                kind: "subagent_overview_item",
                projection_revision: 17,
                item: { thread: { archived: false }, status: "done", evidence: null },
              },
            } as unknown as ProjectWorkspaceReadSnapshot);
          },
          apply: () => Effect.die("selected hydration must not mutate the overview"),
          requestOnHost: (() =>
            Effect.die("selected hydration delegates history reads")) as RequestOnHost,
          resolve: ({ threadId, fidelity }) =>
            Effect.sync(() => {
              if (threadId === "root-a") return rootDirectoryEntry;
              assert.strictEqual(threadId, child.id);
              if (fidelity === "tail") {
                tailReads.push(threadId);
                canonical = attached;
              }
              return selected();
            }),
          shareResident: (hostId, threadId) =>
            Effect.sync(() => {
              assert.isNotNull(canonical);
              shared.push([hostId, threadId]);
            }),
          readConversation: (id) =>
            id === child.id && canonical
              ? {
                  generation: 8,
                  historyCheckpoint: [8, canonical.turnHistory!.history.generation, 13],
                  canonicalState: canonical,
                  snapshot: null,
                }
              : id === "root-a" && interactive
                ? {
                    generation: 1,
                    historyCheckpoint: [1, 0, 0],
                    canonicalState: parentCanonical,
                    snapshot: null,
                  }
                : null,
        });
        const result = yield* service.hydrateSelected({
          rootThreadId: "root-a",
          threadId: child.id,
        });
        assert.strictEqual(result.outcome, "ready");
        assert.strictEqual(result.fidelity, scenario.attach ? "attachedSparse" : "residentSparse");
        assert.strictEqual(result.canInteract, interactive);
        assert.strictEqual(
          result.checkpoint,
          JSON.stringify([8, canonical!.turnHistory!.history.generation, 13]),
        );
        assert.deepEqual(tailReads, scenario.attach ? [child.id] : []);
        assert.deepEqual(shared, [[capability.hostId, child.id]]);
      }),
    ),
  );
}

for (const transition of [
  "child replacement",
  "child retirement",
  "root replacement",
  "history release",
  "host reconnect",
] as const) {
  it.effect(`rejects selected history invalidated by ${transition} during authority lookup`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const initial = produce(
          conversationFixture(child.id, [turnFixture("child-turn")]),
          (draft) => {
            replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
          },
        );
        let canonical = initial;
        let childGeneration: number | null = 8;
        let rootGeneration = 3;
        let hostCurrent = true;
        const service = yield* buildDirectory({
          capability,
          isCurrent: () => Effect.succeed(hostCurrent),
          read: (input) => {
            assert.strictEqual(input.kind, "subagent_overview_item");
            return Deferred.succeed(admitted, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                commit_head: 1,
                value: {
                  kind: "subagent_overview_item",
                  projection_revision: 17,
                  item: { thread: { archived: false }, status: "done", evidence: null },
                },
              } as unknown as ProjectWorkspaceReadSnapshot),
            );
          },
          apply: () => Effect.die("selected hydration must not mutate overview authority"),
          requestOnHost: (() =>
            Effect.die("resident history needs no native read")) as RequestOnHost,
          resolve: ({ threadId, fidelity }) => {
            assert.strictEqual(fidelity, "durable");
            if (threadId === "root-a") return Effect.succeed(rootDirectoryEntry);
            return Effect.succeed({
              ...rootDirectoryEntry,
              durable: {
                ...rootDirectoryEntry.durable,
                threadId: child.id,
                parentThreadId: "root-a",
              },
              summary: { ...rootDirectoryEntry.summary, archived: false },
              canonical,
              snapshot: null,
            });
          },
          readConversation: (id) => {
            if (id === "root-a")
              return {
                generation: rootGeneration,
                historyCheckpoint: [rootGeneration, 0, 0],
                canonicalState: conversationFixture("root-a"),
                snapshot: null,
              };
            if (id !== child.id || childGeneration === null) return null;
            return {
              generation: childGeneration,
              historyCheckpoint: [childGeneration, 1, 13],
              canonicalState: canonical,
              snapshot: null,
            };
          },
        });
        const pending = yield* Effect.forkChild(
          service.hydrateSelected({ rootThreadId: "root-a", threadId: child.id }),
        );
        yield* Deferred.await(admitted);
        if (transition === "child replacement") childGeneration = 9;
        if (transition === "child retirement") childGeneration = null;
        if (transition === "root replacement") rootGeneration = 4;
        if (transition === "history release")
          canonical = {
            ...initial,
            turns: [],
            turnHistory: undefined,
            turnsPagination: undefined,
            resumeState: "needs_resume",
          };
        if (transition === "host reconnect") hostCurrent = false;
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(pending);
        assert.strictEqual(
          result.outcome,
          transition === "history release" ? "unavailable" : "failed",
        );
        assert.isFalse(result.canInteract);
        assert.strictEqual(result.fidelity, "metadata");
        if (transition !== "history release") {
          assert.isNull(result.checkpoint);
          assert.strictEqual(result.errorMessage, "Selected Thread changed while opening");
        }
      }),
    ),
  );
}

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

for (const kind of ["interacted", "interrupted", "completed"] as const) {
  it.effect(`does not infer an undiscovered child from resident ${kind} activity`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        let complete = false;
        let continuation: string | null = null;
        const requests: string[] = [];
        const canonicalState = produce(
          conversationFixture("root-a", [
            {
              ...turnFixture("parent-turn"),
              items: [
                {
                  type: "subAgentActivity",
                  id: "activity",
                  kind,
                  agentThreadId: "unrelated",
                  agentPath: "/root/unrelated",
                },
              ],
            },
          ]),
          (draft) => {
            replaceCanonicalHistoryDraft(draft, draft.turns, true, null);
          },
        );
        const service = yield* buildDirectory({
          capability,
          readConversation: (id) =>
            id === "root-a"
              ? { generation: 1, historyCheckpoint: [1, 0, 0], canonicalState, snapshot: null }
              : null,
          read: () =>
            Effect.succeed({
              commit_head: 1,
              contract_version: 1,
              store_epoch: "test-store",
              value: {
                kind: "subagent_overview_window",
                overview: {
                  universe: {
                    host_id: capability.hostId,
                    source_epoch: `${capability.hostId}:${capability.userAgent}`,
                    generation: capability.generation,
                    root_thread_id: "root-a",
                  },
                  active: { items: [], next_cursor: null, authority: { projection_revision: 1 } },
                  done: { items: [], next_cursor: null, authority: { projection_revision: 1 } },
                  known_active_count: 0,
                  known_done_count: 0,
                  discovery_complete: complete,
                  discovery_continuation: continuation,
                  projection_revision: 1,
                },
              },
            } satisfies ProjectWorkspaceReadSnapshot),
          apply: (input) =>
            Effect.sync(() => {
              if (input.intent.kind === "observe_subagent_discovery_page") {
                assert.deepEqual(input.intent.observations, []);
                complete = input.intent.complete;
                continuation = input.intent.continuation ?? null;
              }
              return {} as never;
            }),
          requestOnHost: ((_hostId: string, method: string) =>
            Effect.sync(() => {
              requests.push(method);
              assert.strictEqual(method, "thread/list");
              return { data: [], nextCursor: null, backwardsCursor: null };
            })) as RequestOnHost,
        });
        const result = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });
        assert.strictEqual(result.completeness, "complete");
        assert.deepEqual(requests, ["thread/list"]);
        assert.deepEqual(result.active.rows, []);
      }),
    ),
  );
}

it.effect(
  "refreshes metadata after app-server replacement without reading terminal child history",
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
          status: { status_type: "notLoaded", active_flags: [] },
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

        assert.deepEqual(requestMethods, ["thread/list"]);
        assert.deepEqual(operationKinds, [
          "observe_subagent_discovery_page",
          "observe_subagent_discovery_page",
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
          assert.strictEqual(method, "thread/list");
          return { data: [child], nextCursor: null, backwardsCursor: null };
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
      assert.deepEqual(requests, [], "notification admission does not wait for discovery");

      const result = yield* service.readOverview({ rootThreadId: "root-a", mode: "initial" });

      assert.strictEqual(result.completeness, "complete");
      assert.strictEqual(result.active.knownCount, 1);
      assert.deepEqual(
        result.active.rows.map((row) => row.threadId),
        ["child-a"],
      );
      assert.deepEqual(
        requests.map((request) => request.method),
        ["thread/list"],
      );
      assert.containSubset(requests[0], {
        params: { ancestorThreadId: "root-a", sourceKinds: ["subAgentThreadSpawn"] },
        options: { expectedHostId: "remote-a", expectedGeneration: 7 },
      });
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

it.effect.each(["overlapping", "delayed-snapshot"] as const)(
  "single-flights initial discovery when a concurrent overview is %s",
  (timing) =>
    Effect.scoped(
      Effect.gen(function* () {
        let complete = false;
        let observed = false;
        let requestCount = 0;
        const requestStarted = yield* Deferred.make<void>();
        const releaseRequest = yield* Deferred.make<void>();
        const overviewCaptured = yield* Deferred.make<void>();
        const releaseOverview = yield* Deferred.make<void>();
        let holdNextOverview = false;
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
                        status: { status_type: "active", active_flags: [] },
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
            Effect.gen(function* () {
              const response = {
                commit_head: observed ? 2 : 1,
                value: { kind: "subagent_overview_window", overview: overview() },
              } as unknown as ProjectWorkspaceReadSnapshot;
              if (holdNextOverview) {
                holdNextOverview = false;
                yield* Deferred.succeed(overviewCaptured, undefined);
                yield* Deferred.await(releaseOverview);
              }
              return response;
            }),
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
        holdNextOverview = timing === "delayed-snapshot";
        const second = yield* Effect.forkChild(
          service.readOverview({ rootThreadId: "root-a", mode: "initial" }),
        );
        if (timing === "delayed-snapshot") yield* Deferred.await(overviewCaptured);
        else yield* Effect.yieldNow;
        assert.strictEqual(requestCount, 1);
        yield* Deferred.succeed(releaseRequest, undefined);
        if (timing === "delayed-snapshot") {
          yield* Fiber.join(first);
          yield* Deferred.succeed(releaseOverview, undefined);
        }
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
                    status: { status_type: "active", active_flags: [] },
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
          status: { status_type: status === "done" ? "idle" : "active", active_flags: [] },
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

for (const storage of ["resident", "overlay"] as const) {
  it.effect(
    `repairs a stale state-db result using ${storage} spawn evidence before completing discovery`,
    () =>
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
                    status: { status_type: "active", active_flags: [] },
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
          const initial = conversationFixture("root-a", [
            {
              ...turnFixture("observed-spawn"),
              items: [
                {
                  type: "subAgentActivity",
                  id: "observed-spawn-item",
                  kind: "started",
                  agentThreadId: child.id,
                  agentPath: "/root/scout",
                },
              ],
            },
          ]);
          const resident = produce(initial, (draft) => {
            replaceCanonicalHistoryDraft(
              draft,
              storage === "overlay" ? [] : draft.turns,
              true,
              null,
            );
          });
          const canonicalState =
            storage === "overlay" ? { ...resident, turns: initial.turns } : resident;
          const service = yield* buildDirectory({
            capability,
            read,
            apply,
            requestOnHost,
            readConversation: (id) =>
              id === "root-a"
                ? { generation: 1, historyCheckpoint: [1, 0, 0], canonicalState, snapshot: null }
                : null,
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
}

it.effect(
  "repairs a missing nested child from resident spawn observations without scanning its parent",
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
                  status: { status_type: "active", active_flags: [] },
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
                    {
                      type: "subAgentActivity",
                      id: "unrelated-completed",
                      kind: "completed",
                      agentThreadId: "not-a-child",
                      agentPath: "/other",
                    },
                    {
                      type: "subAgentActivity",
                      id: "unrelated-interacted",
                      kind: "interacted",
                      agentThreadId: "not-a-child",
                      agentPath: "/other",
                    },
                    {
                      type: "subAgentActivity",
                      id: "unrelated-interrupted",
                      kind: "interrupted",
                      agentThreadId: "not-a-child",
                      agentPath: "/other",
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
        ]);
      }),
    ),
);

it.effect("completes direct-parent BFS when an older host lacks ancestor filtering", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const legacyCapability: CodexAppServerCapabilitySnapshot = {
        ...capability,
        userAgent: "codex-app-server/0.149.0",
        version: "0.149.0",
        flags: { ...capability.flags, subagentAncestorFilter: false, multiAgentV2Protocol: false },
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
                status: { status_type: "active", active_flags: [] },
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

const discoveryOverview = (
  items: Overview["active"]["items"],
  complete = false,
  nextCursor: string | null = null,
): Overview =>
  ({
    universe: {
      host_id: "remote-a",
      source_epoch: "remote-a:codex-app-server/0.150.0-alpha.12",
      generation: 7,
      root_thread_id: "root-a",
    },
    active: { items, next_cursor: nextCursor, authority: { projection_revision: 1 } },
    done: { items: [], next_cursor: null, authority: { projection_revision: 1 } },
    known_active_count: items.length,
    known_done_count: 0,
    discovery_complete: complete,
    discovery_continuation: null,
    projection_revision: 1,
  }) as Overview;

const discoveryItem = (threadId: string, statusType: "active" | "idle" = "active") =>
  ({
    thread: {
      thread_id: threadId,
      parent_thread_id: "root-a",
      thread_name: `Agent ${threadId}`,
      agent_nickname: `Agent ${threadId}`,
      thread_preview: threadId,
      archived: false,
      created_at: 100_000,
      updated_at: 120_000,
      recency_at: 120_000,
      status: { status_type: statusType, active_flags: [] },
    },
    status: "active",
    evidence: { kind: "notification", source_revision: 12, observed_at_ms: 120_000 },
  }) as unknown as Overview["active"]["items"][number];

it.effect("collects all raw Core pages before regrouping and limiting initial rows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cursors: Array<string | null> = [];
      const service = yield* buildDirectory({
        capability,
        observedSubagentThreadIds: [
          ...Array.from({ length: 34 }, (_, page) => `finished-${page}`),
          "running-a",
          "running-b",
        ],
        read: (query) =>
          Effect.sync(() => {
            assert.strictEqual(query.kind, "subagent_overview_window");
            if (query.kind !== "subagent_overview_window") throw new Error("Wrong query");
            const cursor = query.active_window.after ?? null;
            cursors.push(cursor);
            const page = Number(cursor ?? 0);
            const items =
              page === 34
                ? [discoveryItem("running-a"), discoveryItem("running-b")]
                : [discoveryItem(`finished-${page}`, "idle")];
            return {
              commit_head: 1,
              value: {
                kind: "subagent_overview_window",
                overview: discoveryOverview(items, true, page === 34 ? null : String(page + 1)),
              },
            } as ProjectWorkspaceReadSnapshot;
          }),
        apply: () => Effect.die("Unexpected mutation"),
        requestOnHost: (() =>
          Effect.die("Complete snapshot must not discover again")) as RequestOnHost,
      });
      const initial = yield* service.readOverview({ rootThreadId: "root-a", mode: "initial" });
      assert.include(cursors, "34");
      assert.deepEqual(
        initial.active.rows.map((row) => row.threadId),
        ["running-a", "running-b"],
      );
      assert.strictEqual(initial.done.rows.length, 10);
      assert.strictEqual(initial.done.knownCount, 34);
      assert.strictEqual(initial.done.totalCount, 34);
      assert.isNull(initial.done.continuation);
      const expanded = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });
      assert.strictEqual(expanded.done.rows.length, 34);
    }),
  ),
);

it.effect.each([
  "stable",
  "stale-system-error",
  "newer-active",
  "newer-system-error",
  "newer-evidence",
  "lost-cas",
  "listed-idle",
  "listed-newer-active",
  "incomplete",
  "replaced-host",
] as const)("conditionally reconciles absence with %s discovery authority", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      let complete = false;
      let hostCurrent = true;
      const registry = makeConversationEntityStateRegistry();
      const entity = registry.acquire(child.id);
      entity.installFollowerCanonicalState({
        ...conversationFixture(child.id),
        hostId: "remote-a",
        threadRuntimeStatus:
          mode === "stale-system-error"
            ? { type: "systemError" }
            : { type: "active", activeFlags: [] },
      });
      let evidence = discoveryItem(child.id).evidence!;
      let durableStatus: "active" | "idle" = "active";
      let reconciled = false;
      const attempted: unknown[] = [];
      const service = yield* buildDirectory({
        capability,
        entities: {
          ...registry,
          entity: registry.acquire,
          runCommand: (_id, operation) => operation,
          retire: () => Effect.void,
        },
        isCurrent: () => Effect.succeed(hostCurrent),
        read: (query) =>
          Effect.succeed({
            commit_head: 1,
            value:
              query.kind === "subagent_overview_item"
                ? {
                    kind: "subagent_overview_item",
                    projection_revision: 1,
                    item: { ...discoveryItem(child.id, durableStatus), evidence },
                  }
                : {
                    kind: "subagent_overview_window",
                    overview: discoveryOverview(
                      [{ ...discoveryItem(child.id, durableStatus), evidence }],
                      complete,
                    ),
                  },
          } as ProjectWorkspaceReadSnapshot),
        readConversation: (id) =>
          id === child.id
            ? {
                canonicalState: entity.readCanonicalState(),
                generation: entity.generation,
                historyCheckpoint: [1, 1, 1],
                snapshot: null,
              }
            : null,
        apply: (operation) =>
          Effect.sync(() => {
            if (operation.intent.kind === "observe_subagent_discovery_page")
              complete = operation.intent.complete;
            if (operation.intent.kind === "observe_subagent_status_evidence") {
              const intent = operation.intent;
              attempted.push(intent.precondition);
              assert.strictEqual(intent.evidence_kind, "reconciliation");
              assert.strictEqual(intent.status, "done");
              reconciled = mode !== "lost-cas";
              evidence =
                mode === "lost-cas"
                  ? { kind: "notification", source_revision: 13, observed_at_ms: 121_000 }
                  : {
                      kind: "reconciliation",
                      source_revision: intent.source_revision,
                      observed_at_ms: intent.observed_at_ms,
                    };
            }
            if (operation.intent.kind === "update_thread") {
              assert.isTrue(reconciled);
              assert.deepEqual(operation.intent.patch.status, {
                status_type: "idle",
                active_flags: [],
              });
              durableStatus = "idle";
            }
            return {} as never;
          }),
        requestOnHost: ((_host: string, method: string) =>
          Effect.sync(() => {
            assert.strictEqual(method, "thread/list");
            if (
              mode === "newer-active" ||
              mode === "newer-system-error" ||
              mode === "listed-newer-active"
            )
              entity.mutateCanonicalState((draft) => {
                draft.threadRuntimeStatus =
                  mode !== "newer-system-error"
                    ? { type: "active", activeFlags: ["waitingOnUserInput"] }
                    : { type: "systemError" };
              }, 121_000);
            if (mode === "newer-evidence")
              evidence = { ...evidence, source_revision: 13, observed_at_ms: 121_000 };
            if (mode === "replaced-host") hostCurrent = false;
            return {
              data:
                mode === "listed-idle" || mode === "listed-newer-active"
                  ? [{ ...child, status: { type: "idle" } }]
                  : [],
              nextCursor: mode === "incomplete" ? "repeat" : null,
            };
          })) as RequestOnHost,
      });
      const result = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });
      const shouldReconcile =
        mode === "stable" || mode === "stale-system-error" || mode === "listed-idle";
      assert.strictEqual(
        result.completeness,
        mode === "incomplete" || mode === "replaced-host" ? "incomplete" : "complete",
      );
      assert.strictEqual(reconciled, shouldReconcile);
      assert.strictEqual(durableStatus, shouldReconcile ? "idle" : "active");
      assert.strictEqual(
        entity.readCanonicalState()?.threadRuntimeStatus.type,
        shouldReconcile ? "idle" : mode === "newer-system-error" ? "systemError" : "active",
      );
      if (shouldReconcile) {
        assert.strictEqual(result.active.rows.length, 0);
        assert.strictEqual(
          result.done.rows.length,
          1,
          "An absent cached descendant remains visible as Done",
        );
      }
      assert.deepEqual(
        attempted,
        shouldReconcile || mode === "lost-cas"
          ? [
              {
                mode: "exact",
                evidence_kind: "notification",
                source_revision: 12,
                observed_at_ms: 120_000,
              },
            ]
          : [],
      );
    }),
  ),
);

it.effect.each(["completed", "failed", "interrupted"] as const)(
  "projects repaired %s turn metadata without attaching child history",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        let complete = false;
        let found = false;
        const methods: string[] = [];
        const service = yield* buildDirectory({
          capability,
          observedSubagentThreadIds: [child.id],
          read: () =>
            Effect.succeed({
              commit_head: 1,
              value: {
                kind: "subagent_overview_window",
                overview: discoveryOverview(
                  found ? [discoveryItem(child.id, "idle")] : [],
                  complete,
                ),
              },
            } as ProjectWorkspaceReadSnapshot),
          apply: (operation) =>
            Effect.sync(() => {
              if (operation.intent.kind === "observe_subagent_discovery_page") {
                found ||= operation.intent.observations.some((item) => item.thread_id === child.id);
                complete = operation.intent.complete;
              }
              return {} as never;
            }),
          requestOnHost: ((_host: string, method: string, params: unknown) =>
            Effect.sync(() => {
              methods.push(method);
              if (method === "thread/list") return { data: [], nextCursor: null };
              if (method === "thread/read") {
                assert.deepEqual(params, { threadId: child.id, includeTurns: false });
                return { thread: { ...child, status: { type: "idle" } } };
              }
              assert.strictEqual(method, "thread/turns/list");
              assert.deepEqual(params, {
                threadId: child.id,
                cursor: null,
                limit: 5,
                sortDirection: "asc",
                itemsView: "full",
              });
              return { data: [turnFixture("repaired-latest", status)], nextCursor: null };
            })) as RequestOnHost,
        });
        const overview = yield* service.readOverview({ rootThreadId: "root-a", mode: "expanded" });
        assert.strictEqual(overview.completeness, "complete");
        assert.strictEqual(overview.done.rows.length, status === "completed" ? 1 : 0);
        assert.strictEqual(overview.active.rows.length, 0);
        assert.deepEqual(methods, [
          "thread/list",
          "thread/list",
          "thread/read",
          "thread/turns/list",
        ]);
        const reread = yield* service.readKnownOverview({ rootThreadId: "root-a" });
        assert.strictEqual(reread.done.rows.length, status === "completed" ? 1 : 0);
      }),
    ),
);

it.effect("stops only freshly active native descendants while retained Core rows stay active", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const staleIds = ["absent-child", "not-loaded-child", "child-a"];
      const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
      const service = yield* buildDirectory({
        capability,
        read: (query) =>
          Effect.succeed({
            commit_head: 1,
            value:
              query.kind === "subagent_overview_item"
                ? {
                    kind: "subagent_overview_item",
                    projection_revision: 1,
                    item: discoveryItem(query.thread_id),
                  }
                : {
                    kind: "subagent_overview_window",
                    overview: discoveryOverview(staleIds.map((id) => discoveryItem(id))),
                  },
          } as ProjectWorkspaceReadSnapshot),
        apply: () => Effect.succeed({} as never),
        requestOnHost: ((_hostId: string, method: string, rawParams: unknown) =>
          Effect.sync(() => {
            const params = rawParams as Record<string, unknown>;
            requests.push({ method, params });
            if (method === "thread/list")
              return {
                data: [child, { ...child, id: "not-loaded-child", status: { type: "notLoaded" } }],
                nextCursor: null,
              };
            if (method === "thread/turns/list")
              return {
                data: [turnFixture("active-turn", "inProgress")],
                nextCursor: null,
                backwardsCursor: null,
              };
            if (method === "turn/interrupt") return {};
            throw new Error(`Unexpected request ${method}`);
          })) as RequestOnHost,
      });
      const result = yield* service.settleInterruptedSubtree("root-a");
      assert.deepEqual(result.interruptedThreadIds, ["child-a"]);
      assert.deepEqual(result.failed, []);
      assert.deepEqual(requests, [
        {
          method: "thread/list",
          params: {
            archived: false,
            cursor: null,
            limit: 200,
            modelProviders: null,
            ancestorThreadId: "root-a",
            sourceKinds: ["subAgentThreadSpawn"],
            sortDirection: "desc",
            sortKey: "created_at",
            useStateDbOnly: true,
          },
        },
        {
          method: "thread/turns/list",
          params: {
            threadId: "child-a",
            cursor: null,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          },
        },
        { method: "turn/interrupt", params: { threadId: "child-a", turnId: "active-turn" } },
      ]);
    }),
  ),
);

for (const ownership of ["main", "peer", "absent"] as const) {
  it.effect(
    `stops a canonical descendant with ${ownership} ownership through its actual interruption authority`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeMethods: string[] = [];
          const ownerRequests: unknown[] = [];
          const canonical = {
            ...conversationFixture(child.id),
            resumeState: "needs_resume" as const,
            threadRuntimeStatus: { type: "active" as const, activeFlags: [] },
          };
          const manager = {
            assertCurrent: () => undefined,
            stream: {
              getRole: () =>
                ownership === "main"
                  ? { role: "owner" }
                  : ownership === "peer"
                    ? { role: "follower", ownerClientId: "renderer-a" }
                    : null,
            },
            coordination: {
              requestThreadFollower: (input: unknown) => {
                ownerRequests.push(input);
                return Promise.resolve(
                  ownership === "absent"
                    ? { resultType: "error", error: "no-client-found" }
                    : { resultType: "success", result: { interruptedTurnId: "resident-turn" } },
                );
              },
            },
          } as unknown as NonNullable<
            ReturnType<CodexMainConversationManagers["Service"]["current"]>
          >;
          const service = yield* buildDirectory({
            capability,
            currentManager: () => manager,
            dispatchFollowerRequest: (hostId, request) =>
              Effect.sync(() => {
                ownerRequests.push({ hostId, request });
                return { interruptedTurnId: "resident-turn" };
              }),
            readConversation: (threadId) =>
              threadId === child.id
                ? {
                    canonicalState: canonical,
                    snapshot: null,
                    generation: 7,
                    historyCheckpoint: [0, 0, 0],
                  }
                : null,
            read: () =>
              Effect.succeed({
                commit_head: 1,
                value: {
                  kind: "subagent_overview_window",
                  overview: discoveryOverview([discoveryItem(child.id)]),
                },
              } as ProjectWorkspaceReadSnapshot),
            apply: () => Effect.succeed({} as never),
            requestOnHost: ((_hostId: string, method: string) =>
              Effect.sync(() => {
                nativeMethods.push(method);
                if (method === "thread/list") return { data: [child], nextCursor: null };
                if (method === "thread/turns/list")
                  return {
                    data: [turnFixture("native-turn", "inProgress")],
                    nextCursor: null,
                    backwardsCursor: null,
                  };
                if (method === "turn/interrupt") return {};
                throw new Error(`Unexpected request ${method}`);
              })) as RequestOnHost,
          });
          const result = yield* service.settleInterruptedSubtree("root-a");
          assert.deepEqual(result.interruptedThreadIds, [child.id]);
          assert.deepEqual(result.failed, []);
          assert.deepEqual(
            nativeMethods,
            ownership === "absent"
              ? ["thread/list", "thread/turns/list", "turn/interrupt"]
              : ["thread/list"],
          );
          assert.lengthOf(ownerRequests, ownership === "absent" ? 2 : 1);
          for (const request of ownerRequests)
            assert.deepEqual(request, {
              hostId: "remote-a",
              request: {
                method: "thread-follower-interrupt-turn",
                params: {
                  conversationId: child.id,
                  mode: "descendant-cleanup",
                },
              },
            });
        }),
      ),
  );
}
