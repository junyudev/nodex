import {
  GIT_DRAFT_LIMITS,
  parseGitDraftOutput,
  type GitDraft,
  type GitDraftFailureCode,
} from "@nodex/agent-runtime/git-draft";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeProcessError } from "../platform/node/AgentRuntimeProcess";
import { ApplicationSettings } from "../settings/ApplicationSettings";

export class GitMessageGenerationError extends Schema.TaggedError<GitMessageGenerationError>()(
  "GitMessageGenerationError",
  {
    code: Schema.Literals(["no_writing_agent", "invalid_draft", "draft_failed"]),
    message: Schema.String,
  },
) {}

const failure = (code: GitDraftFailureCode) =>
  new GitMessageGenerationError({
    code,
    message: {
      no_writing_agent: "No Agent available to write this.",
      invalid_draft: "The Agent returned an invalid draft. Try again.",
      draft_failed: "The Agent couldn’t write a draft. Try again.",
    }[code],
  });

type DraftInput<Kind extends GitDraft["kind"]> = Omit<
  Extract<GitDraft, { kind: Kind }>,
  "instructions"
>;

interface Workspace {
  readonly cwd: string;
  readonly chatThreadId?: string;
}

const make = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeApplication;
  const settings = yield* ApplicationSettings;

  const generate = Effect.fn("GitMessageGeneration.generate")(function* (
    workspace: Workspace,
    draft: DraftInput<"commit"> | DraftInput<"pull-request">,
  ) {
    const snapshot = yield* settings
      .snapshot()
      .pipe(Effect.mapError(() => failure("draft_failed")));
    const instructions =
      draft.kind === "commit"
        ? snapshot.git.commitInstructions
        : snapshot.git.pullRequestInstructions;
    const output = yield* runtime
      .generateStructured({
        ...workspace,
        gitDraft: {
          ...draft,
          instructions: instructions.trim().slice(0, GIT_DRAFT_LIMITS.instructions),
        },
        writingModel: snapshot.agentRuntime.writingModel,
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            Schema.is(AgentRuntimeProcessError)(error.cause) &&
              error.cause.code === "no_writing_agent"
              ? "no_writing_agent"
              : "draft_failed",
          ),
        ),
      );
    const result = parseGitDraftOutput(draft.kind, output);
    if (!result) return yield* failure("invalid_draft");
    return result;
  });

  return {
    generateCommitMessage: Effect.fn("GitMessageGeneration.commit")(function* (
      workspace: Workspace,
      input: Omit<DraftInput<"commit">, "kind">,
    ) {
      const draft = yield* generate(workspace, { kind: "commit", ...input });
      if (!("subject" in draft)) return yield* failure("invalid_draft");
      return draft.body ? `${draft.subject}\n\n${draft.body}` : draft.subject;
    }),
    generatePullRequestMessage: Effect.fn("GitMessageGeneration.pullRequest")(function* (
      workspace: Workspace,
      input: Omit<DraftInput<"pull-request">, "kind">,
    ) {
      const draft = yield* generate(workspace, { kind: "pull-request", ...input });
      if (!("title" in draft)) return yield* failure("invalid_draft");
      return draft;
    }),
  };
});

export class GitMessageGeneration extends Context.Service<
  GitMessageGeneration,
  Effect.Success<typeof make>
>()("nodex/main/git-application/GitMessageGeneration") {
  static readonly live = Layer.effect(this, make);
}
