import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { CodexLiveFileAttachment } from "../../shared/types";
import { CodexAttachments } from "./CodexAttachments";
import { CodexStructuredThreadTitle } from "./CodexStructuredThreadTitle";
import { make } from "./CodexAutoThreadTitle";
import { CodexThreadDescriptionPersistence } from "./CodexThreadDescriptionPersistence";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";

type TitleCall = Parameters<CodexThreadTitlePersistence["Service"]["set"]>[0];

const attachments = CodexAttachments.of({
  getTextExcerpts: () => Effect.succeed([]),
} as unknown as CodexAttachments["Service"]);

const descriptions = CodexThreadDescriptionPersistence.of({
  set: () => Effect.void,
  get: () => Effect.succeed(null),
});

const titlePersistence = (calls: TitleCall[], completed: Deferred.Deferred<void>) =>
  CodexThreadTitlePersistence.of({
    set: (input) => {
      return Effect.sync(() => {
        calls.push(input);
        return (
          input.name === "Generated title" ||
          (input.name === "Prompt preview" && calls.length === 2)
        );
      }).pipe(
        Effect.flatMap((done) => (done ? Deferred.succeed(completed, undefined) : Effect.void)),
        Effect.as(true),
      );
    },
    setRequired: () => Effect.succeed(true),
    syncCommittedTitle: () => Effect.void,
  });

it.effect("claims a local provisional title before persisting the generated title", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const calls: TitleCall[] = [];
    const structuredTitle = CodexStructuredThreadTitle.of({
      generate: () => Effect.succeed("Generated title"),
    });
    const autoTitle = yield* make.pipe(
      Effect.provideService(CodexStructuredThreadTitle, structuredTitle),
      Effect.provideService(CodexThreadDescriptionPersistence, descriptions),
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence(calls, completed)),
      Effect.provideService(CodexAttachments, attachments),
    );

    yield* autoTitle.scheduleFirstTurn({
      threadId: "thread-1",
      prompt: "  Prompt preview  ",
      cwd: "/repo",
    });
    yield* Deferred.await(completed);

    assert.deepEqual(
      calls.map(({ name, onlyIfUntitled, expectedName, persist }) => ({
        name,
        onlyIfUntitled,
        expectedName,
        persist,
      })),
      [
        {
          name: "Prompt preview",
          onlyIfUntitled: true,
          expectedName: undefined,
          persist: false,
        },
        {
          name: "Generated title",
          onlyIfUntitled: undefined,
          expectedName: "Prompt preview",
          persist: undefined,
        },
      ],
    );
  }),
);

it.effect("persists generated descriptions only after the title CAS commits", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const titleCalls: TitleCall[] = [];
    const descriptionCalls: Array<{ readonly threadId: string; readonly description: string }> = [];
    const structuredTitle = CodexStructuredThreadTitle.of({
      generate: () => Effect.succeed("Generated title"),
      generateMetadata: () =>
        Effect.succeed({ title: "Generated title", description: "Searchable summary" }),
    });
    const autoTitle = yield* make.pipe(
      Effect.provideService(CodexStructuredThreadTitle, structuredTitle),
      Effect.provideService(
        CodexThreadDescriptionPersistence,
        CodexThreadDescriptionPersistence.of({
          set: (input) =>
            Effect.sync(() => {
              descriptionCalls.push(input);
            }),
          get: () => Effect.succeed(null),
        }),
      ),
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence(titleCalls, completed)),
      Effect.provideService(CodexAttachments, attachments),
    );

    yield* autoTitle.scheduleFirstTurn({
      threadId: "thread-with-description",
      prompt: "Prompt preview",
      cwd: "/repo",
    });
    yield* Deferred.await(completed);
    yield* Effect.yieldNow;

    assert.deepEqual(descriptionCalls, [
      { threadId: "thread-with-description", description: "Searchable summary" },
    ]);
  }),
);

it.effect("restores the provisional title when structured generation fails", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const calls: TitleCall[] = [];
    const structuredTitle = CodexStructuredThreadTitle.of({
      generate: () => Effect.die(new Error("title service unavailable")),
    });
    const autoTitle = yield* make.pipe(
      Effect.provideService(CodexStructuredThreadTitle, structuredTitle),
      Effect.provideService(CodexThreadDescriptionPersistence, descriptions),
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence(calls, completed)),
      Effect.provideService(CodexAttachments, attachments),
    );

    yield* autoTitle.scheduleFirstTurn({
      threadId: "thread-1",
      prompt: "Prompt preview",
      cwd: null,
    });
    yield* Deferred.await(completed);

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1]?.name, "Prompt preview");
    assert.strictEqual(calls[1]?.expectedName, "Prompt preview");
  }),
);

it.effect("does not schedule title work when auto generation is explicitly skipped", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const calls: TitleCall[] = [];
    const structuredTitle = CodexStructuredThreadTitle.of({
      generate: () => Effect.succeed("unexpected"),
    });
    const autoTitle = yield* make.pipe(
      Effect.provideService(CodexStructuredThreadTitle, structuredTitle),
      Effect.provideService(CodexThreadDescriptionPersistence, descriptions),
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence(calls, completed)),
      Effect.provideService(CodexAttachments, attachments),
    );

    yield* autoTitle.scheduleFirstTurn({
      threadId: "thread-1",
      prompt: "Prompt preview",
      cwd: null,
      skipAutoTitleGeneration: true,
    });
    yield* Effect.yieldNow;

    assert.deepEqual(calls, []);
  }),
);

it.effect("feeds raw and file-backed pasted excerpts into the added-thread title path", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const calls: TitleCall[] = [];
    let generationPrompt = "";
    const structuredTitle = CodexStructuredThreadTitle.of({
      generate: ({ prompt }) =>
        Effect.sync(() => {
          generationPrompt = prompt;
          return "Generated title";
        }),
    });
    const pastedAttachments = CodexAttachments.of({
      getTextExcerpts: (files: readonly CodexLiveFileAttachment[] | null | undefined) =>
        Effect.succeed((files ?? []).map(() => "file-backed excerpt")),
    } as unknown as CodexAttachments["Service"]);
    const autoTitle = yield* make.pipe(
      Effect.provideService(CodexStructuredThreadTitle, structuredTitle),
      Effect.provideService(CodexThreadDescriptionPersistence, descriptions),
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence(calls, completed)),
      Effect.provideService(CodexAttachments, pastedAttachments),
    );

    yield* autoTitle.scheduleAddedThread({
      threadId: "thread-added",
      prompt: "Prompt before paste",
      cwd: "/repo",
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
      generationPrompt,
      "Prompt before paste\n\nraw pasted excerpt\n\nfile-backed excerpt",
    );
    assert.strictEqual(
      calls[0]?.name,
      "Prompt before paste raw pasted excerpt file-backed excerpt",
    );
    assert.strictEqual(calls[0]?.onlyIfUntitled, true);
  }),
);
