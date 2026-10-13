import type { CodexCanonicalTurnHeader } from "../../shared/types";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import {
  makeTestTurnPresentation,
  testSubmitPresentation,
} from "./CodexTurnPresentation.test-support";
import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import {
  CodexInternalThreadRegistry,
  make as makeInternalThreads,
} from "./CodexInternalThreadRegistry";
import { make } from "./CodexNotificationAdmission";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexTurnAuthority } from "./CodexTurnAuthority";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { produce } from "immer";
import { CoreModules } from "../core-runtime/CoreModules";

const thread = (input: {
  readonly id: string;
  readonly ephemeral?: boolean;
  readonly parentThreadId?: string | null;
  readonly threadSource?: string | null;
  readonly source?: Thread["source"];
}): Thread =>
  ({
    id: input.id,
    ephemeral: input.ephemeral ?? false,
    parentThreadId: input.parentThreadId ?? null,
    threadSource: input.threadSource ?? null,
    source: input.source ?? "appServer",
    turns: [],
  }) as unknown as Thread;

const startedThread = (value: Thread): CodexServerNotification => ({
  method: "thread/started",
  params: { thread: value },
});

const startedTurn = (threadId: string, turnId: string): CodexServerNotification => ({
  method: "turn/started",
  params: {
    threadId,
    turn: { id: turnId, status: "inProgress", items: [] } as unknown as Turn,
  },
});

const delta = (threadId: string): CodexServerNotification => ({
  method: "item/agentMessage/delta",
  params: { threadId, turnId: "turn-a", itemId: "message-a", delta: "next" },
});

const parentAuthority: FrozenNodexAgentTurnAuthority = {
  threadId: "parent",
  turnId: "parent-turn",
  rootThreadId: "parent",
  actorProjectId: "project-a",
  libraryId: "library-a",
  storeEpoch: "epoch-a",
  frozenAtMs: 1_785_491_085_000,
  readOnly: false,
  scope: "library",
  source: "builtin_full_access",
};

const makeHarness = (
  trace: string[],
  parentState?: CodexCanonicalConversationState,
  core?: CoreModules["Service"],
) =>
  Effect.gen(function* () {
    const internalThreads = yield* makeInternalThreads;
    const knownSubagents = new Set<string>();
    const fullFidelitySubagents = new Set<string>();
    const subagents = CodexSubagentDirectory.of({
      readOverview: () => Effect.die("unused"),
      readKnownOverview: () => Effect.die("unused"),
      hydrateSelected: ({ rootThreadId, threadId }) =>
        Effect.sync(() => {
          fullFidelitySubagents.add(threadId);
          return {
            rootThreadId,
            threadId,
            revision: 1,
            fidelity: "attachedSparse" as const,
            checkpoint: "1",
            canInteract: true,
            outcome: "ready" as const,
            errorMessage: null,
          };
        }),
      observeNotification: () => Effect.void,
      reconcileAfterReconnect: () => Effect.void,
      settleInterruptedSubtree: () => Effect.die("unused"),
      observe: (threadId) => {
        trace.push(`subagent:observe:${threadId}`);
        knownSubagents.add(threadId);
      },
      shouldDropDelta: (method, threadId) =>
        method === "item/agentMessage/delta" &&
        threadId !== null &&
        knownSubagents.has(threadId) &&
        !fullFidelitySubagents.has(threadId),
      clear: (threadId) => {
        knownSubagents.delete(threadId);
        fullFidelitySubagents.delete(threadId);
      },
    });
    const authority = CodexTurnAuthority.of({
      begin: () => Effect.die("unused"),
      bind: () => Effect.die("unused"),
      observeStarted: (threadId, turnId) =>
        Effect.sync(() => trace.push(`authority:observe:${threadId}:${turnId}`)),
      capture: (threadId, turnId) =>
        Effect.sync(() => {
          trace.push(`authority:capture:${threadId}:${turnId}`);
          return parentAuthority;
        }),
      inherit: (threadId, turnId, inherited) =>
        Effect.sync(() =>
          trace.push(`authority:inherit:${threadId}:${turnId}:${inherited.turnId}`),
        ),
      abort: () => undefined,
    });
    const conversations = ConversationEntityMap.of({
      registerThreadMetadata: () => {},
      readThreadMetadata: () => null,
      current: (threadId: string) =>
        threadId === "parent"
          ? ({
              readCanonicalState: () =>
                parentState ??
                ({
                  turns: [
                    {
                      ...({ turnId: "parent-turn", status: "inProgress" } satisfies Pick<
                        CodexCanonicalTurnHeader,
                        "turnId" | "status"
                      >),
                    },
                  ],
                } as unknown as CodexCanonicalConversationState),
            } as unknown as ReturnType<ConversationEntityMap["Service"]["entity"]>)
          : null,
    } as unknown as ConversationEntityMap["Service"]);
    const presentation = yield* makeTestTurnPresentation;
    const admission = yield* make.pipe(
      Effect.provideService(
        CoreModules,
        core ??
          ({
            workspace: {
              read: () => Effect.die("Unqualified legacy admission must not query Core"),
            },
          } as unknown as CoreModules["Service"]),
      ),
      Effect.provideService(CodexInternalThreadRegistry, internalThreads),
      Effect.provideService(CodexSubagentDirectory, subagents),
      Effect.provideService(CodexTurnAuthority, authority),
      Effect.provideService(CodexTurnPresentation, presentation),
      Effect.provideService(ConversationEntityMap, conversations),
    );
    return { admission, internalThreads, subagents, presentation };
  });

it.effect.each(["inProgress", "completed"] as const)(
  "subagent authority follows canonical parent status %s despite a stale legacy copy",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        const metadata = buildAgentActivityV2CorpusThread();
        const legacy = createCodexCanonicalHydratedConversationState(
          {
            ...metadata,
            id: "parent",
            turns: metadata.turns.map((turn) => ({ ...turn, id: "parent-turn", status })),
          },
          {
            hostId: "local",
            model: "fixture-model",
            reasoningEffort: null,
            cwd: "/work",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/work"],
          },
        );
        const canonical = produce(legacy, (draft) => {
          replaceCanonicalHistoryDraft(draft, legacy.turns, true);
        });
        const state = {
          ...canonical,
          turns:
            status === "completed"
              ? legacy.turns.map((turn) => ({ ...turn, status: "inProgress" as const }))
              : [],
        };
        const trace: string[] = [];
        const { admission } = yield* makeHarness(trace, state);
        yield* admission.decide({
          notification: startedThread(thread({ id: "child", parentThreadId: "parent" })),
          threadId: "child",
        });
        yield* admission.decide({
          notification: startedTurn("child", "child-turn"),
          threadId: "child",
        });
        assert.deepStrictEqual(
          trace,
          status === "inProgress"
            ? [
                "subagent:observe:child",
                "authority:capture:parent:parent-turn",
                "authority:inherit:child:child-turn:parent-turn",
              ]
            : ["subagent:observe:child", "authority:observe:child:child-turn"],
        );
      }),
    ),
);

it.effect(
  "admits a Core-linked root with a subagent label and keeps subsequent deltas free of Core reads",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const core = CoreModules.of({
        workspace: {
          read: (input: Parameters<CoreModules["Service"]["workspace"]["read"]>[0]) =>
            Effect.sync(() => {
              reads++;
              assert.deepStrictEqual(input, {
                kind: "codex_thread_session",
                thread_id: "created",
                expected_execution_host_id: "remote",
              });
              return {
                value: {
                  kind: "codex_thread_session",
                  thread: {
                    thread_id: "created",
                    backend_binding: { kind: "codex" },
                    execution_host_id: "remote",
                    parent_thread_id: null,
                    session_id: "session",
                    thread_source: "subagent",
                    status: { status_type: "idle", active_flags: [] },
                  },
                  session: {
                    id: "session",
                    project_id: null,
                    thread_id: "created",
                    display_title: "Created",
                    no_thread_fallback_title: "Created",
                  },
                },
              } as never;
            }),
        },
      } as unknown as CoreModules["Service"]);
      const test = yield* makeHarness([], undefined, core);
      const started = startedThread(thread({ id: "created", threadSource: "subagent" }));
      assert.deepStrictEqual(
        yield* test.admission.decide({
          notification: started,
          threadId: "created",
          hostId: "remote",
        }),
        { _tag: "Admit" },
      );
      assert.strictEqual(reads, 1);
      for (let index = 0; index < 30; index++)
        assert.deepStrictEqual(
          yield* test.admission.decide({
            notification: delta("created"),
            threadId: "created",
            hostId: "remote",
          }),
          { _tag: "Admit" },
        );
      assert.strictEqual(reads, 1);
    }),
);

it.effect("suppresses structured-title and non-sidebar helpers before visible projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const trace: string[] = [];
      const { admission, internalThreads } = yield* makeHarness(trace);
      const titleLease = yield* Scope.make();
      yield* internalThreads
        .leaseStructuredTitle("title-helper")
        .pipe(Effect.provideService(Scope.Scope, titleLease));

      assert.deepEqual(
        yield* admission.decide({
          notification: startedThread(
            thread({
              id: "title-helper",
              ephemeral: true,
              threadSource: "system",
            }),
          ),
          threadId: "title-helper",
        }),
        { _tag: "Drop", reason: "internal-thread", threadId: "title-helper" },
      );
      yield* Scope.close(titleLease, Exit.void);
      assert.strictEqual(
        (yield* admission.decide({
          notification: delta("title-helper"),
          threadId: "title-helper",
        }))._tag,
        "Drop",
      );

      assert.strictEqual(
        (yield* admission.decide({
          notification: startedThread(thread({ id: "system-helper", threadSource: "system" })),
          threadId: "system-helper",
        }))._tag,
        "Drop",
      );
    }),
  ),
);

it.effect("inherits parent authority and drops unopened child deltas", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const trace: string[] = [];
      const { admission, subagents } = yield* makeHarness(trace);
      const child = thread({
        id: "child",
        parentThreadId: "parent",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "parent",
              depth: 1,
              agent_path: null,
              agent_nickname: "worker",
              agent_role: null,
            },
          },
        },
      });

      assert.strictEqual(
        (yield* admission.decide({ notification: startedThread(child), threadId: "child" }))._tag,
        "Admit",
      );
      assert.strictEqual(
        (yield* admission.decide({ notification: delta("child"), threadId: "child" }))._tag,
        "Drop",
      );
      assert.strictEqual(
        (yield* admission.decide({
          notification: startedTurn("child", "child-turn"),
          threadId: "child",
        }))._tag,
        "Admit",
      );
      assert.deepEqual(trace, [
        "subagent:observe:child",
        "authority:capture:parent:parent-turn",
        "authority:inherit:child:child-turn:parent-turn",
      ]);

      yield* subagents.hydrateSelected({ rootThreadId: "parent", threadId: "child" });
      assert.strictEqual(
        (yield* admission.decide({ notification: delta("child"), threadId: "child" }))._tag,
        "Admit",
      );
    }),
  ),
);

it.effect("binds submit presentation only when notification user-message identity matches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { admission, presentation } = yield* makeHarness([]);
      const target = { kind: "thread", threadId: "origin-thread" } as const;
      const ticket = yield* presentation.capture(11, {
        target,
        presentation: testSubmitPresentation,
      });
      const claim = yield* presentation.claim(ticket, target, "origin-message");
      const launch = yield* presentation.begin(claim, target.threadId);
      yield* admission.decide({
        notification: startedTurn(target.threadId, "accepted-turn"),
        threadId: target.threadId,
      });
      assert.isNull(presentation.read(target.threadId, "accepted-turn"));
      yield* admission.decide({
        notification: {
          method: "item/started",
          params: {
            threadId: target.threadId,
            turnId: "accepted-turn",
            startedAtMs: 1,
            item: { type: "userMessage", id: "user-item", clientId: "origin-message", content: [] },
          },
        },
        threadId: target.threadId,
      });
      assert.equal(
        presentation.read(target.threadId, "accepted-turn")?.windowSessionId,
        "window-a",
      );
      yield* presentation.bind(launch, "accepted-turn");
    }),
  ),
);
