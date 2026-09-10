import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  CodexLiveFileAttachment,
  CodexPastedTextAttachment,
  CodexThreadGoalDraftInput,
  CodexThreadGoalFrozenDraft,
  CodexThreadGoalMaterializedDraft,
} from "../../shared/types";
import {
  PastedTextAttachmentManager,
  ThreadGoalAttachmentDirectoryManager,
  readThreadGoalEditableObjective,
  type MaterializedPastedTextAttachmentSources,
} from "../thread-goal-attachments";

export class CodexAttachmentsError extends Schema.TaggedError<CodexAttachmentsError>()(
  "CodexAttachmentsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new CodexAttachmentsError({ operation, cause }),
  });

export class CodexAttachments extends Context.Service<
  CodexAttachments,
  {
    readonly createPastedText: (input: {
      readonly text: string;
      readonly hostId?: string;
    }) => Effect.Effect<CodexPastedTextAttachment, CodexAttachmentsError>;
    readonly readPastedText: (
      file: CodexLiveFileAttachment,
    ) => Effect.Effect<string, CodexAttachmentsError>;
    readonly getTextExcerpts: (
      files: readonly CodexLiveFileAttachment[] | null | undefined,
    ) => Effect.Effect<readonly string[], CodexAttachmentsError>;
    readonly removePastedText: (
      file: CodexLiveFileAttachment,
    ) => Effect.Effect<void, CodexAttachmentsError>;
    readonly materializePastedText: (
      attachments: CodexThreadGoalDraftInput["pastedTextAttachments"],
    ) => Effect.Effect<MaterializedPastedTextAttachmentSources, CodexAttachmentsError>;
    readonly cleanupGoalSources: (
      draft: CodexThreadGoalDraftInput | CodexThreadGoalFrozenDraft | null | undefined,
      fallbackHostId?: string,
    ) => Effect.Effect<void, CodexAttachmentsError>;
    readonly materializeGoal: (
      draft: CodexThreadGoalDraftInput | CodexThreadGoalFrozenDraft,
    ) => Effect.Effect<CodexThreadGoalMaterializedDraft, CodexAttachmentsError>;
    readonly cleanupMaterializedGoal: (
      attachmentDirectory: string | null,
    ) => Effect.Effect<void, CodexAttachmentsError>;
    readonly readEditableObjective: (
      objective: string,
    ) => Effect.Effect<string, CodexAttachmentsError>;
  }
>()("nodex/main/codex-application/CodexAttachments") {}

export const live = (attachmentsRoot: string): Layer.Layer<CodexAttachments> =>
  Layer.effect(
    CodexAttachments,
    Effect.gen(function* () {
      const pastedText = new PastedTextAttachmentManager({ attachmentsRoot });
      const goals = new ThreadGoalAttachmentDirectoryManager({ attachmentsRoot });
      yield* attempt("cleanup-pending-pasted-text", () => pastedText.cleanupPendingRemovals()).pipe(
        Effect.ignore,
        Effect.forkScoped,
      );
      return CodexAttachments.of({
        createPastedText: (input) =>
          attempt("create-pasted-text", () => pastedText.createRawSource(input)),
        readPastedText: (file) => attempt("read-pasted-text", () => pastedText.readRawSource(file)),
        getTextExcerpts: (files) =>
          attempt("get-pasted-text-excerpts", () => pastedText.getTextExcerpts(files)),
        removePastedText: (file) =>
          attempt("remove-pasted-text", () => pastedText.remove(file.path)),
        materializePastedText: (attachments) =>
          attempt("materialize-pasted-text", () => pastedText.materializeSources(attachments)),
        cleanupGoalSources: (draft, fallbackHostId) =>
          attempt("cleanup-goal-sources", () =>
            pastedText.cleanupGoalSources(draft, fallbackHostId),
          ),
        materializeGoal: (draft) =>
          attempt("materialize-goal", () => goals.materializeDraft(draft)),
        cleanupMaterializedGoal: (attachmentDirectory) =>
          attachmentDirectory === null
            ? Effect.void
            : attempt("cleanup-materialized-goal", () =>
                goals.removeDirectory(attachmentDirectory),
              ),
        readEditableObjective: (objective) =>
          attempt("read-editable-objective", () =>
            readThreadGoalEditableObjective({ attachmentsRoot, objective }),
          ),
      });
    }),
  );
