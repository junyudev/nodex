import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { CodexCommandOutputUpdate } from "../../shared/codex-conversation-state/codex-command-output-queue";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexFrameTextDeltaUpdate } from "../../shared/codex-conversation-state/codex-frame-text-delta-queue";
import {
  CodexConversationDeltaBufferRuntime,
  make,
  type CodexConversationDeltaBufferRuntimeOptions,
} from "./CodexConversationDeltaBufferRuntime";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";
import {
  CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES,
  CODEX_LIVE_TURN_OVERFLOW_ITEM_ID,
} from "../../shared/codex-conversation-state/codex-live-turn-residency";

const frame = (delta: string): CodexFrameTextDeltaUpdate => ({
  conversationId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  target: { type: "agentMessage" },
  delta,
});

const output = (delta: string, conversationId = "thread-1"): CodexCommandOutputUpdate => ({
  conversationId,
  turnId: "turn-1",
  itemId: "command-1",
  delta,
});

const observeCommits = (
  conversations: ConversationEntityMap["Service"],
  threadId: string,
  frameCommits: string[],
  outputCommits: string[] = [],
): void => {
  const aggregate = conversations.entity(threadId);
  const commitFrameTextDeltas = aggregate.commitFrameTextDeltas;
  const commitCommandOutputDeltas = aggregate.commitCommandOutputDeltas;
  Object.defineProperties(aggregate, {
    commitFrameTextDeltas: {
      configurable: true,
      value: (input: Parameters<typeof commitFrameTextDeltas>[0]) => {
        frameCommits.push(
          ...input.updates.map((update) => `${threadId}:${update.delta}:${input.observedAtMs}`),
        );
        return commitFrameTextDeltas(input);
      },
    },
    commitCommandOutputDeltas: {
      configurable: true,
      value: (input: Parameters<typeof commitCommandOutputDeltas>[0]) => {
        outputCommits.push(...input.updates.map((update) => `${threadId}:${update.delta}`));
        return commitCommandOutputDeltas(input);
      },
    },
  });
};

const withRuntime = <A, E>(
  use: (
    runtime: CodexConversationDeltaBufferRuntime["Service"],
    conversations: ConversationEntityMap["Service"],
  ) => Effect.Effect<A, E>,
  options: CodexConversationDeltaBufferRuntimeOptions = {},
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(conversationRuntimeMapLive, ownerScope);
    const conversations = Context.get(context, ConversationEntityMap);
    const runtime = yield* make(options).pipe(
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(
        CodexRendererConversationRegistry,
        makeCodexRendererConversationRegistryState(),
      ),
    );
    const result = yield* use(runtime, conversations);
    yield* Scope.close(ownerScope, Exit.void);
    return result;
  });

it.effect("drains one Thread synchronously and keeps another Thread scheduled", () =>
  withRuntime((runtime, conversations) =>
    Effect.gen(function* () {
      const commits: string[] = [];
      observeCommits(conversations, "thread-1", commits);
      observeCommits(conversations, "thread-2", commits);
      runtime.enqueueFrameText(frame("a"));
      runtime.enqueueFrameText({ ...frame("b"), conversationId: "thread-2" });
      runtime.drainFrameText("thread-1", 1_000);
      assert.deepEqual(commits, ["thread-1:a:1000"]);
      yield* TestClock.adjust("20 millis");
      assert.strictEqual(commits.length, 2);
      assert.isTrue(commits[1]?.startsWith("thread-2:b:"));
    }),
  ),
);

it.effect("clear removes only the addressed global-queue entries before the timer fires", () =>
  withRuntime((runtime, conversations) =>
    Effect.gen(function* () {
      const commits: string[] = [];
      observeCommits(conversations, "thread-1", commits);
      runtime.enqueueFrameText(frame("discard"));
      runtime.clear("thread-1");
      yield* TestClock.adjust("1 second");
      assert.deepEqual(commits, []);
    }),
  ),
);

it.effect("cuts the bounded frame batch under cross-Thread pressure without losing deltas", () =>
  withRuntime(
    (runtime, conversations) =>
      Effect.gen(function* () {
        const commits: string[] = [];
        observeCommits(conversations, "thread-1", commits);
        observeCommits(conversations, "thread-2", commits);

        runtime.enqueueFrameText(frame("a"));
        runtime.enqueueFrameText({ ...frame("b"), conversationId: "thread-2" });
        runtime.enqueueFrameText({ ...frame("cd"), conversationId: "thread-2" });
        runtime.enqueueFrameText({ ...frame("xyz"), conversationId: "thread-2" });

        assert.deepEqual(
          commits.map((entry) => entry.split(":").slice(0, 2).join(":")),
          ["thread-1:a", "thread-2:b", "thread-2:cd", "thread-2:xyz"],
        );
        yield* TestClock.adjust("1 second");
        assert.strictEqual(commits.length, 4);
      }),
    {
      maxBufferedFrameKeys: 1,
      maxBufferedFrameCodeUnitsPerKey: 2,
      maxBufferedFrameCodeUnits: 2,
    },
  ),
);

it.effect("collapses an individually over-budget pressure delta before it becomes resident", () =>
  withRuntime(
    (runtime, conversations) =>
      Effect.sync(() => {
        const protocol: Thread = {
          model: null,
          reasoningEffort: null,
          id: "thread-1",
          extra: null,
          sessionId: "session-1",
          forkedFromId: null,
          parentThreadId: null,
          preview: "",
          ephemeral: false,
          section: null,
          sectionEnteredAt: null,
          projectId: null,
          historyMode: "paginated",
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          recencyAt: 1,
          status: { type: "active", activeFlags: [] },
          path: null,
          cwd: "/repo",
          cliVersion: "test",
          source: "unknown",
          canAcceptDirectInput: true,
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [
            {
              id: "turn-1",
              status: "inProgress",
              error: null,
              itemsView: "full",
              startedAt: 1,
              completedAt: null,
              durationMs: null,
              items: [
                {
                  questions: null,
                  type: "agentMessage",
                  id: "item-1",
                  text: "",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                },
              ],
            },
          ],
        };
        conversations.entity("thread-1").acceptCanonicalState(
          createCodexCanonicalHydratedConversationState(protocol, {
            model: "gpt-test",
            reasoningEffort: "high",
            cwd: "/repo",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/repo"],
          }),
        );

        runtime.enqueueFrameText(frame("x".repeat(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES + 1_024)));

        const turn = conversations.current("thread-1")?.readCanonicalState()?.turns[0];
        assert.strictEqual(turn?.items[0]?.id, CODEX_LIVE_TURN_OVERFLOW_ITEM_ID);
        assert.isAtMost(
          Buffer.byteLength(JSON.stringify(turn), "utf8"),
          CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES,
        );
      }),
    {
      maxBufferedFrameCodeUnitsPerKey: 2,
      maxBufferedFrameCodeUnits: 2,
    },
  ),
);

it.effect("bounds command output globally by keys, updates, and UTF-8 bytes", () =>
  withRuntime(
    (runtime, conversations) =>
      Effect.gen(function* () {
        const frameCommits: string[] = [];
        const outputCommits: string[] = [];
        observeCommits(conversations, "thread-1", frameCommits, outputCommits);
        observeCommits(conversations, "thread-2", frameCommits, outputCommits);

        runtime.enqueueCommandOutput(output("ab"));
        runtime.enqueueCommandOutput(output("cd", "thread-2"));
        runtime.enqueueCommandOutput(output("😀😀😀", "thread-2"));

        assert.deepEqual(outputCommits, ["thread-1:ab", "thread-2:cd", "thread-2:😀😀😀"]);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(outputCommits.length, 3);
      }),
    {
      maxBufferedOutputKeys: 1,
      maxBufferedOutputUpdates: 1,
      maxBufferedOutputUtf8Bytes: 4,
    },
  ),
);
