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
  scope: "library",
  source: "builtin_full_access",
};

const makeHarness = (trace: string[]) =>
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
      beginLifecycle: () => Effect.die("unused"),
      reconcileLifecycle: () => Effect.die("unused"),
      settleInterruptedSubtree: () => Effect.die("unused"),
      shouldDeferLifecycleNotification: () => Effect.succeed(false),
      releaseLifecycleQuarantine: () => {},
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
      current: (threadId: string) =>
        threadId === "parent"
          ? ({
              readCanonicalState: () =>
                ({
                  turns: [{ protocol: { id: "parent-turn", status: "inProgress" } }],
                }) as unknown as CodexCanonicalConversationState,
            } as unknown as ReturnType<ConversationEntityMap["Service"]["entity"]>)
          : null,
    } as unknown as ConversationEntityMap["Service"]);
    const admission = yield* make.pipe(
      Effect.provideService(CodexInternalThreadRegistry, internalThreads),
      Effect.provideService(CodexSubagentDirectory, subagents),
      Effect.provideService(CodexTurnAuthority, authority),
      Effect.provideService(ConversationEntityMap, conversations),
    );
    return { admission, internalThreads, subagents };
  });

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
