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
import { CodexAttachments } from "./CodexAttachments";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";

export interface CodexAutoThreadTitleInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly pastedTextAttachments?: readonly CodexPromptTextAttachmentInput[] | undefined;
  readonly skipAutoTitleGeneration?: boolean | undefined;
}

export interface CodexAutoThreadTitleService {
  /**
   * Names an untitled native Thread after its opening prompt without delaying turn acceptance, on
   * its first turn or when it is materialized from metadata. Only Runtime chats generate titles.
   */
  readonly schedule: (input: CodexAutoThreadTitleInput) => Effect.Effect<void>;
}

export class CodexAutoThreadTitle extends Context.Service<
  CodexAutoThreadTitle,
  CodexAutoThreadTitleService
>()("nodex/main/codex-application/CodexAutoThreadTitle") {}

export const make: Effect.Effect<
  CodexAutoThreadTitleService,
  never,
  CodexAttachments | CodexThreadTitlePersistence | Scope.Scope
> = Effect.gen(function* () {
  const attachments = yield* CodexAttachments;
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

  const run = (input: CodexAutoThreadTitleInput) =>
    Effect.gen(function* () {
      if (input.skipAutoTitleGeneration === true) return;
      const prompt = cleanCodexAutoTitlePrompt(input.prompt, CODEX_THREAD_TITLE_PROMPT_MAX_CHARS);
      const excerpts = yield* readPastedTextExcerpts(input);
      const title = normalizeCodexManualThreadTitle(
        projectCodexMarkdownToPlainText(
          cleanCodexAutoTitlePrompt(
            [prompt, ...excerpts].filter(Boolean).join("\n\n"),
            CODEX_THREAD_TITLE_PROMPT_MAX_CHARS,
          ),
        ),
        CODEX_MANUAL_THREAD_TITLE_MAX_CHARS,
      );
      if (!title) return;
      yield* titles.set({
        threadId: input.threadId,
        name: title,
        normalization: "trim",
        onlyIfUntitled: true,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Automatic Thread title failed").pipe(
          Effect.annotateLogs({ threadId: input.threadId, cause: String(cause) }),
        ),
      ),
    );

  return CodexAutoThreadTitle.of({
    schedule: (input) =>
      Effect.forkIn(run(input), ownerScope, { startImmediately: true }).pipe(Effect.asVoid),
  });
});
