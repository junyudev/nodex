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
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";

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
    );
    const result = yield* use(runtime, conversations);
    yield* Scope.close(ownerScope, Exit.void);
    return result;
  });

it.effect("completion drains every Thread in the manager prose batch", () =>
  withRuntime((runtime, conversations) =>
    Effect.gen(function* () {
      const commits: string[] = [];
      observeCommits(conversations, "thread-1", commits);
      observeCommits(conversations, "thread-2", commits);
      runtime.enqueueFrameText(frame("a"));
      runtime.enqueueFrameText({ ...frame("b"), conversationId: "thread-2" });
      runtime.drainBeforeCompletion("thread-1", 1_000);
      assert.strictEqual(commits.length, 2);
      assert.strictEqual(commits[0], "thread-1:a:1000");
      assert.isTrue(commits[1]?.startsWith("thread-2:b:"));
      yield* TestClock.adjust("20 millis");
      assert.strictEqual(commits.length, 2);
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

it.effect("coalesces each Thread's prose until the fallback timer", () =>
  withRuntime((runtime, conversations) =>
    Effect.gen(function* () {
      const commits: string[] = [];
      observeCommits(conversations, "thread-1", commits);
      observeCommits(conversations, "thread-2", commits);
      runtime.enqueueFrameText(frame("a"));
      runtime.enqueueFrameText({ ...frame("b"), conversationId: "thread-2" });
      runtime.enqueueFrameText({ ...frame("cd"), conversationId: "thread-2" });
      runtime.enqueueFrameText({ ...frame("xyz"), conversationId: "thread-2" });
      assert.deepEqual(commits, []);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(
        commits.map((entry) => entry.split(":").slice(0, 2).join(":")),
        ["thread-1:a", "thread-2:bcdxyz"],
      );
    }),
  ),
);

it.effect("commits a large buffered delta on the explicit completion drain", () =>
  withRuntime((runtime, conversations) =>
    Effect.sync(() => {
      const protocol: Thread = {
        model: null,
        reasoningEffort: null,
        id: "thread-1",
        environments: null,
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
        originator: null,
        source: "unknown",
        canAcceptDirectInput: true,
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        daybreakEnabled: null,
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
          hostId: "local",
          ...{
            model: "gpt-test",
            reasoningEffort: "high",
            cwd: "/repo",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/repo"],
          },
        }),
      );

      runtime.enqueueFrameText(frame("x".repeat(2 * 1024 * 1024 + 1_024)));
      runtime.drainBeforeCompletion("thread-1", 1000);

      const turn = conversations.current("thread-1")?.readCanonicalState()?.turns[0];
      assert.strictEqual(turn?.items[0]?.type, "agentMessage");
      assert.isAbove(Buffer.byteLength(JSON.stringify(turn), "utf8"), 2 * 1024 * 1024);
    }),
  ),
);

it.effect("flushes all command keys at the timer while coalescing each item's output", () =>
  withRuntime((runtime, conversations) =>
    Effect.gen(function* () {
      const outputCommits: string[] = [];
      observeCommits(conversations, "thread-1", [], outputCommits);
      observeCommits(conversations, "thread-2", [], outputCommits);
      runtime.enqueueCommandOutput(output("ab"));
      runtime.enqueueCommandOutput(output("cd", "thread-2"));
      runtime.enqueueCommandOutput(output("😀😀😀", "thread-2"));
      assert.deepEqual(outputCommits, []);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(outputCommits, ["thread-1:ab", "thread-2:cd😀😀😀"]);
    }),
  ),
);

it.effect(
  "completion flushes all queued command bytes before prose and leaves no timer replay",
  () =>
    withRuntime((runtime, conversations) =>
      Effect.gen(function* () {
        const commits: string[] = [];
        observeCommits(conversations, "thread-1", commits, commits);
        observeCommits(conversations, "thread-2", commits, commits);
        runtime.enqueueFrameText(frame("prose"));
        runtime.enqueueCommandOutput(output("same\n"));
        runtime.enqueueCommandOutput(output("same\n"));
        runtime.enqueueCommandOutput(output("other", "thread-2"));
        runtime.drainBeforeCompletion("thread-1", 1_000);
        assert.deepEqual(commits, [
          "thread-1:same\nsame\n",
          "thread-2:other",
          "thread-1:prose:1000",
        ]);
        yield* TestClock.adjust("100 millis");
        assert.strictEqual(commits.length, 3);
        runtime.enqueueCommandOutput(output("later"));
        yield* TestClock.adjust("100 millis");
        assert.strictEqual(commits.at(-1), "thread-1:later");
      }),
    ),
);
