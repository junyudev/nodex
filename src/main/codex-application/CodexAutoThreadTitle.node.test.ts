import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { CodexLiveFileAttachment } from "../../shared/types";
import { CodexAttachments } from "./CodexAttachments";
import { make } from "./CodexAutoThreadTitle";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";

type TitleCall = Parameters<CodexThreadTitlePersistence["Service"]["set"]>[0];

const attachments = CodexAttachments.of({
  getTextExcerpts: () => Effect.succeed([]),
} as unknown as CodexAttachments["Service"]);

const titlePersistence = (calls: TitleCall[], completed: Deferred.Deferred<void>) =>
  CodexThreadTitlePersistence.of({
    set: (input) =>
      Effect.sync(() => {
        calls.push(input);
      }).pipe(Effect.andThen(Deferred.succeed(completed, undefined)), Effect.as(true)),
    setRequired: () => Effect.succeed(true),
    syncCommittedTitle: () => Effect.void,
  });

it.effect("names an untitled Thread after its opening prompt", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const calls: TitleCall[] = [];
    const autoTitle = yield* make.pipe(
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence(calls, completed)),
      Effect.provideService(CodexAttachments, attachments),
    );

    yield* autoTitle.schedule({ threadId: "thread-1", prompt: "  Prompt preview  " });
    yield* Deferred.await(completed);

    assert.deepEqual(calls, [
      {
        threadId: "thread-1",
        name: "Prompt preview",
        normalization: "trim",
        onlyIfUntitled: true,
      },
    ]);
  }),
);

it.effect("does not name a Thread when automatic titling is explicitly skipped", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const calls: TitleCall[] = [];
    const autoTitle = yield* make.pipe(
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence(calls, completed)),
      Effect.provideService(CodexAttachments, attachments),
    );

    yield* autoTitle.schedule({
      threadId: "thread-1",
      prompt: "Prompt preview",
      skipAutoTitleGeneration: true,
    });
    yield* Effect.yieldNow;

    assert.deepEqual(calls, []);
  }),
);

it.effect("names a Thread from raw and file-backed pasted excerpts", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const calls: TitleCall[] = [];
    const pastedAttachments = CodexAttachments.of({
      getTextExcerpts: (files: readonly CodexLiveFileAttachment[] | null | undefined) =>
        Effect.succeed((files ?? []).map(() => "file-backed excerpt")),
    } as unknown as CodexAttachments["Service"]);
    const autoTitle = yield* make.pipe(
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence(calls, completed)),
      Effect.provideService(CodexAttachments, pastedAttachments),
    );

    yield* autoTitle.schedule({
      threadId: "thread-added",
      prompt: "Prompt before paste",
      pastedTextAttachments: [
        { text: "raw pasted excerpt" },
        {
          file: {
            label: "Pasted text.txt",
            path: "/managed/pasted.txt",
            fsPath: "/managed/pasted.txt",
          },
          preview: "file-backed excerpt",
        },
      ],
    });
    yield* Deferred.await(completed);

    assert.strictEqual(
      calls[0]?.name,
      "Prompt before paste raw pasted excerpt file-backed excerpt",
    );
    assert.strictEqual(calls[0]?.onlyIfUntitled, true);
  }),
);
