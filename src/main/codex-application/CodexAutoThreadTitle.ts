import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import {
  CODEX_PASTED_TEXT_EXCERPT_MAX_CHARS,
  cleanCodexAutoTitlePrompt,
  CODEX_MANUAL_THREAD_TITLE_MAX_CHARS,
  CODEX_THREAD_TITLE_PROMPT_MAX_CHARS,
  normalizeCodexManualThreadTitle,
  projectCodexMarkdownToPlainText,
} from "../../shared/codex-thread-title";
import type { CodexPromptTextAttachmentInput } from "../../shared/types";
import type { CodexGeneratedThreadMetadata } from "../codex/thread-title-generator";
import { CodexAttachments } from "./CodexAttachments";
import { CodexStructuredThreadTitle } from "./CodexStructuredThreadTitle";
import { CodexThreadDescriptionPersistence } from "./CodexThreadDescriptionPersistence";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";

export interface CodexAutoThreadTitleInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly cwd: string | null;
  readonly serviceName?: string | null;
  /** Pasted sources are bounded to the same excerpt budget as CodexElectron. */
  readonly pastedTextAttachments?: readonly CodexPromptTextAttachmentInput[];
}

export interface CodexFirstTurnReadyTitleInput extends CodexAutoThreadTitleInput {
  readonly skipAutoTitleGeneration?: boolean;
}

export type CodexThreadAddedTitleInput = CodexAutoThreadTitleInput;

export interface CodexAutoThreadTitleService {
  /** Schedules the first-turn title workflow without delaying turn acceptance. */
  readonly scheduleFirstTurn: (input: CodexFirstTurnReadyTitleInput) => Effect.Effect<void>;
  /** Handles Threads materialized from metadata when no first-turn callback exists. */
  readonly scheduleAddedThread: (input: CodexThreadAddedTitleInput) => Effect.Effect<void>;
}

export class CodexAutoThreadTitle extends Context.Service<
  CodexAutoThreadTitle,
  CodexAutoThreadTitleService
>()("nodex/main/codex-application/CodexAutoThreadTitle") {}

export const make: Effect.Effect<
  CodexAutoThreadTitleService,
  never,
  | CodexAttachments
  | CodexStructuredThreadTitle
  | CodexThreadDescriptionPersistence
  | CodexThreadTitlePersistence
  | Scope.Scope
> = Effect.gen(function* () {
  const attachments = yield* CodexAttachments;
  const structuredTitle = yield* CodexStructuredThreadTitle;
  const descriptions = yield* CodexThreadDescriptionPersistence;
  const titles = yield* CodexThreadTitlePersistence;
  const ownerScope = yield* Scope.Scope;

  const readPastedTextExcerpts = (input: CodexAutoThreadTitleInput) =>
    Effect.forEach(input.pastedTextAttachments ?? [], (attachment) => {
      if ("text" in attachment) {
        return Effect.succeed(attachment.text.trim().slice(0, CODEX_PASTED_TEXT_EXCERPT_MAX_CHARS));
      }

      return attachments.getTextExcerpts([attachment.file]).pipe(
        Effect.map((excerpts) => excerpts[0] ?? ""),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read pasted text excerpt for automatic Thread title").pipe(
            Effect.annotateLogs({ threadId: input.threadId, cause: String(cause) }),
            Effect.andThen(Effect.succeed("")),
          ),
        ),
      );
    }).pipe(Effect.map((excerpts) => excerpts.filter((excerpt) => excerpt.trim().length > 0)));

  const run = (input: CodexFirstTurnReadyTitleInput | CodexThreadAddedTitleInput) =>
    Effect.gen(function* () {
      if ("skipAutoTitleGeneration" in input && input.skipAutoTitleGeneration === true) {
        return;
      }

      const prompt = cleanCodexAutoTitlePrompt(input.prompt, CODEX_THREAD_TITLE_PROMPT_MAX_CHARS);
      const pastedTextExcerpts = yield* readPastedTextExcerpts(input);
      const generationPrompt = cleanCodexAutoTitlePrompt(
        [prompt, ...pastedTextExcerpts].filter(Boolean).join("\n\n"),
        CODEX_THREAD_TITLE_PROMPT_MAX_CHARS,
      );
      const provisionalTitle = normalizeCodexManualThreadTitle(
        projectCodexMarkdownToPlainText(generationPrompt),
        CODEX_MANUAL_THREAD_TITLE_MAX_CHARS,
      );
      if (!generationPrompt || !provisionalTitle) {
        return;
      }

      const restoreProvisionalTitle = titles.set({
        threadId: input.threadId,
        name: provisionalTitle,
        normalization: "trim",
        expectedName: provisionalTitle,
      });

      const generateMetadata = structuredTitle.generateMetadata
        ? structuredTitle.generateMetadata({
            prompt: generationPrompt,
            cwd: input.cwd,
            ...(input.serviceName?.trim() ? { serviceName: input.serviceName.trim() } : {}),
          })
        : structuredTitle
            .generate({
              prompt: generationPrompt,
              cwd: input.cwd,
              ...(input.serviceName?.trim() ? { serviceName: input.serviceName.trim() } : {}),
            })
            .pipe(
              Effect.map((title): CodexGeneratedThreadMetadata | null =>
                title === null ? null : { title, description: null },
              ),
            );

      const persistDescription = (
        metadata: CodexGeneratedThreadMetadata,
        committed: boolean,
      ): Effect.Effect<boolean> =>
        !committed || !metadata.description
          ? Effect.succeed(committed)
          : descriptions.set({ threadId: input.threadId, description: metadata.description }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not persist automatic Thread description").pipe(
                  Effect.annotateLogs({ threadId: input.threadId, cause: String(cause) }),
                  Effect.andThen(Effect.succeed(undefined)),
                ),
              ),
              Effect.as(committed),
            );

      yield* titles
        .set({
          threadId: input.threadId,
          name: provisionalTitle,
          normalization: "trim",
          onlyIfUntitled: true,
          persist: false,
        })
        .pipe(
          Effect.flatMap((claimed) =>
            claimed ? generateMetadata : Effect.succeed<CodexGeneratedThreadMetadata | null>(null),
          ),
          Effect.flatMap((metadata) =>
            metadata
              ? titles
                  .set({
                    threadId: input.threadId,
                    name: metadata.title,
                    normalization: "trim",
                    expectedName: provisionalTitle,
                  })
                  .pipe(Effect.flatMap((committed) => persistDescription(metadata, committed)))
              : restoreProvisionalTitle,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Automatic Thread title generation failed").pipe(
              Effect.annotateLogs({ threadId: input.threadId, cause: String(cause) }),
              Effect.andThen(restoreProvisionalTitle),
              Effect.ignore,
            ),
          ),
          Effect.ignore,
        );
    });

  const schedule = (input: CodexFirstTurnReadyTitleInput | CodexThreadAddedTitleInput) =>
    Effect.forkIn(run(input), ownerScope, { startImmediately: true }).pipe(Effect.asVoid);

  return CodexAutoThreadTitle.of({
    scheduleFirstTurn: schedule,
    scheduleAddedThread: schedule,
  });
});
