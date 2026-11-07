/**
 * The text generation operations every provider shares. A provider supplies a
 * runner that sends one prompt and decodes the reply; prompts, linked source
 * control context, and output sanitizing live here so providers cannot drift
 * on them.
 *
 * @module textGeneration/TextGenerationOperations
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@nodex/runtime-contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@nodex/runtime-shared/git";
import { extractJsonObject } from "@nodex/runtime-shared/schemaJson";

import type { ProviderTextGeneration, StructuredGenerationInput } from "./textGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildReviewGuidePrompt,
} from "./textGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
} from "./textGenerationUtils.ts";

export type Operation = keyof ProviderTextGeneration;

/** One prompt for a provider to run. */
export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly images?: StructuredGenerationInput["images"];
  readonly webSearch?: StructuredGenerationInput["webSearch"];
  /**
   * The run sees only what Nodex supplies, never the user's personal Agent environment or project
   * instruction files. OpenCode cannot leave its own behind, so its sessions refuse every tool instead.
   */
  readonly isolated?: boolean;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  /** The user's attachments, already listed in the prompt. Providers that accept images send them. */
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /**
   * Set when the model must investigate `cwd` before answering with read-only tools,
   * over as many turns as it needs. All utility runs enforce read-only execution and
   * never prompt for approval. Absent, the prompt carries everything needed. A runner
   * without investigation capabilities fails rather than answering blind.
   */
  readonly investigate?: { readonly timeoutMs: number } | undefined;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly maxOutputBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

/** How long an investigating run may take; a large change needs far longer than a title. */
const INVESTIGATION_TIMEOUT_MS = 15 * 60_000;

/** The refusal a runner gives when it has no read-only tool mode to investigate with. */
export const investigationUnsupported = (operation: Operation, provider: string) =>
  new TextGenerationError({
    operation,
    detail: `${provider} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set.`,
  });

/** Runs one request and decodes the reply as its `outputSchema`. */
export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/**
 * For a runner with no read-only tool mode: it answers prompts that carry everything, and
 * refuses an investigation rather than answering one blind.
 */
export const withoutInvestigation =
  (provider: string, run: Runner): Runner =>
  (request) =>
    request.investigate
      ? Effect.fail(investigationUnsupported(request.operation, provider))
      : run(request);

/** Decodes the JSON object in a text reply, which models often wrap in prose. */
export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  // Each request builds its own output schema, so the decoder cannot be hoisted.
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

/** A provider that cannot enforce a schema only knows the shape its prompt asks for. */
const promptForJsonSchema = (prompt: string, schema: StructuredGenerationInput["outputSchema"]) =>
  `${prompt}\n\nReply with only a JSON object that satisfies this JSON Schema, with no prose or code fences:\n${JSON.stringify(schema)}`;

/** The text generation service over `run`. `name` prefixes each operation's span. */
export function fromRunner(
  name: string,
  run: Runner,
  options: {
    readonly supportsImages?: boolean;
    /** The runner hands `jsonSchema` to its provider, which holds the reply to it. */
    readonly enforcesJsonSchema?: boolean;
  } = {},
): ProviderTextGeneration {
  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    `${name}.generateCommitMessage`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      }),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    `${name}.generatePrContent`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generatePrContent",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      }),
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    `${name}.generateBranchName`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBranchName",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      }),
    });
    return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
  });

  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = Effect.fn(
    `${name}.generateReviewGuide`,
  )(function* (input) {
    return yield* run({
      operation: "generateReviewGuide",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      investigate: { timeoutMs: INVESTIGATION_TIMEOUT_MS },
      ...buildReviewGuidePrompt(input),
    });
  });

  return {
    generateStructured: (input) => {
      if (input.images?.length && !options.supportsImages)
        return Effect.fail(
          new TextGenerationError({
            operation: "generateStructured",
            detail: "This Agent cannot read images here. Choose an Agent that supports images.",
          }),
        );
      return run({
        ...input,
        prompt: options.enforcesJsonSchema
          ? input.prompt
          : promptForJsonSchema(input.prompt, input.outputSchema),
        operation: "generateStructured",
        isolated: true,
        outputSchema: Schema.Unknown,
        jsonSchema: input.outputSchema,
      });
    },
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateReviewGuide,
  } satisfies ProviderTextGeneration;
}
