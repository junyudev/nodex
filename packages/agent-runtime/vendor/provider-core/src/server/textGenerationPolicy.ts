import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const TextGenerationPolicyKind = Schema.Literals([
  "default",
  "conventional_commits",
  "repo_conventions",
  "custom",
]);
export type TextGenerationPolicyKind = typeof TextGenerationPolicyKind.Type;

export const TextGenerationPolicy = Schema.Struct({
  kind: TextGenerationPolicyKind,
  commitInstructions: Schema.optional(Schema.String),
  changeRequestInstructions: Schema.optional(Schema.String),
  branchInstructions: Schema.optional(Schema.String),
  threadTitleInstructions: Schema.optional(Schema.String),
  inferRepositoryConventions: Schema.Boolean,
});
export type TextGenerationPolicy = typeof TextGenerationPolicy.Type;

/** The execution host supplies a live guard; runners invoke it immediately before native I/O. */
export const TextGenerationAdmission = Context.Reference<Effect.Effect<void, TextGenerationError>>(
  "provider-core/TextGenerationAdmission",
  { defaultValue: () => Effect.void },
);
export const assertTextGenerationAdmission = Effect.flatMap(
  TextGenerationAdmission,
  (check) => check,
);
