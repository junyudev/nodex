import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  CodexStructuredThreadTitle,
  type CodexStructuredThreadTitleReconsiderationInput,
} from "./CodexStructuredThreadTitle";
import { CodexThreadDescriptionPersistence } from "./CodexThreadDescriptionPersistence";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { hasCodexThreadPurposeChangedSignal, make } from "./CodexThreadTitleReconsideration";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const signal = "::thread-purpose-changed{}";

const conversationMap = (state: { title: string; generatedTitle: string | null }) =>
  ConversationEntityMap.of({
    current: () =>
      ({
        readCanonicalState: () => ({
          title: state.title,
          generatedTitle: state.generatedTitle,
          cwd: "/repo",
        }),
        readSnapshot: () => ({
          ephemeral: false,
          source: null,
          cwd: "/repo",
          serviceName: "chatgpt",
        }),
      }) as never,
  } as unknown as ConversationEntityMap["Service"]);

const makeHarness = (state: { title: string; generatedTitle: string | null }) =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    const reconsidered: CodexStructuredThreadTitleReconsiderationInput[] = [];
    const titleWrites: Array<Parameters<CodexThreadTitlePersistence["Service"]["set"]>[0]> = [];
    const descriptionWrites: Array<{ readonly threadId: string; readonly description: string }> =
      [];
    const service = yield* make.pipe(
      Effect.provideService(
        CodexStructuredThreadTitle,
        CodexStructuredThreadTitle.of({
          generate: () => Effect.succeed(null),
          generateMetadata: () => Effect.succeed(null),
          reconsiderTitle: (input) =>
            Effect.sync(() => {
              reconsidered.push(input);
              return {
                title: "Replacement purpose",
                description: "Replacement purpose summary",
              };
            }),
        }),
      ),
      Effect.provideService(
        CodexThreadTitlePersistence,
        CodexThreadTitlePersistence.of({
          set: (input) =>
            Effect.sync(() => {
              titleWrites.push(input);
              return true;
            }).pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
          setRequired: () => Effect.succeed(true),
          syncCommittedTitle: () => Effect.void,
        }),
      ),
      Effect.provideService(
        CodexThreadDescriptionPersistence,
        CodexThreadDescriptionPersistence.of({
          set: (input) =>
            Effect.sync(() => {
              descriptionWrites.push(input);
            }),
          get: () => Effect.succeed(null),
        }),
      ),
      Effect.provideService(ConversationEntityMap, conversationMap(state)),
    );
    return { service, committed, reconsidered, titleWrites, descriptionWrites };
  });

it.effect("recognizes the checkpoint only as a standalone line", () =>
  Effect.sync(() => {
    assert.isTrue(hasCodexThreadPurposeChangedSignal(`done\n${signal}\nthanks`));
    assert.isFalse(hasCodexThreadPurposeChangedSignal(`prefix ${signal}`));
    assert.isFalse(hasCodexThreadPurposeChangedSignal(null));
  }),
);

it.effect("requires two consecutive signals and resets after an unsignaled turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      title: "Generated purpose",
      generatedTitle: "Generated purpose",
    });
    const observe = (lastAgentMessage: string | null) =>
      harness.service.observe({
        hostId: "remote-a",
        threadId: "thread-a",
        lastAgentMessage,
        hasPendingContinuation: false,
      });

    yield* observe(signal);
    yield* observe("ordinary follow-up");
    yield* observe(signal);
    yield* Effect.yieldNow;
    assert.lengthOf(harness.reconsidered, 0);

    yield* observe(signal);
    yield* Deferred.await(harness.committed);
    assert.deepEqual(harness.reconsidered, [
      {
        hostId: "remote-a",
        sourceThreadId: "thread-a",
        currentTitle: "Generated purpose",
        cwd: "/repo",
        serviceName: "chatgpt",
      },
    ]);
    assert.strictEqual(harness.titleWrites[0]?.expectedName, "Generated purpose");
    assert.strictEqual(harness.titleWrites[0]?.generated, true);
    assert.deepEqual(harness.descriptionWrites, [
      { threadId: "thread-a", description: "Replacement purpose summary" },
    ]);
  }),
);

it.effect("waits for pending continuation to clear after the second signal", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      title: "Generated purpose",
      generatedTitle: "Generated purpose",
    });
    yield* harness.service.observe({
      hostId: "local",
      threadId: "thread-a",
      lastAgentMessage: signal,
      hasPendingContinuation: false,
    });
    yield* harness.service.observe({
      hostId: "local",
      threadId: "thread-a",
      lastAgentMessage: signal,
      hasPendingContinuation: true,
    });
    yield* Effect.yieldNow;
    assert.lengthOf(harness.reconsidered, 0);

    yield* harness.service.observe({
      hostId: "local",
      threadId: "thread-a",
      lastAgentMessage: null,
      hasPendingContinuation: false,
    });
    yield* Deferred.await(harness.committed);
    assert.lengthOf(harness.reconsidered, 1);
  }),
);

it.effect("does not replace a title whose generated ownership was cleared", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ title: "Manual title", generatedTitle: null });
    const input = {
      hostId: "local",
      threadId: "thread-a",
      lastAgentMessage: signal,
      hasPendingContinuation: false,
    } as const;
    yield* harness.service.observe(input);
    yield* harness.service.observe(input);
    yield* Effect.yieldNow;
    assert.lengthOf(harness.reconsidered, 0);
    assert.lengthOf(harness.titleWrites, 0);
  }),
);
