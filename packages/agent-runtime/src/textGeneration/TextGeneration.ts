import { TextGenerationAdmission } from "@nodex/provider-core/server/textGenerationPolicy";
import { RuntimeModelPolicy } from "../nodex/ModelPolicy.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, ProviderInstanceId } from "@nodex/runtime-contracts";
import {
  automaticModelCatalog,
  projectModelPolicyCatalog,
} from "../../../../src/shared/model-policy.ts";
import type { ProviderTextGeneration } from "@nodex/provider-core/server/textGeneration";
import { TextGenerationError } from "@nodex/runtime-contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@nodex/provider-core/server/driver";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@nodex/provider-core/server/textGeneration";

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
type WithAutomaticChoice<Port> = Port extends (input: infer Input) => infer Output
  ? (input: Input & { readonly automatic?: true }) => Output
  : Port;
type PolicyAwareTextGeneration = {
  [Key in keyof ProviderTextGeneration]: WithAutomaticChoice<ProviderTextGeneration[Key]>;
};
export class TextGeneration extends Context.Service<TextGeneration, PolicyAwareTextGeneration>()(
  "nodex/runtime/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateStructured"
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const policy = yield* RuntimeModelPolicy;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const run = <
    Input extends { readonly modelSelection: ModelSelection; readonly automatic?: true },
    Output,
  >(
    operation: TextGenerationOp,
    input: Input,
    generate: (
      generation: ProviderTextGeneration,
      input: Input,
    ) => Effect.Effect<Output, TextGenerationError>,
  ) =>
    Effect.gen(function* () {
      let selection = input.modelSelection;
      if (input.automatic) {
        const providers = yield* Effect.forEach(
          yield* registry.listInstances,
          (instance) => instance.snapshot.getSnapshot,
        );
        const { policy: current } = yield* policy.current;
        const eligible = automaticModelCatalog(
          projectModelPolicyCatalog(providers, current),
        ).filter(
          (provider) =>
            provider.enabled &&
            provider.installed &&
            provider.status === "ready" &&
            provider.auth.status !== "unauthenticated" &&
            provider.supportsTextGeneration !== false &&
            provider.models.length > 0,
        );
        const provider =
          eligible.find((provider) => provider.instanceId === selection.instanceId) ?? eligible[0];
        const model =
          provider?.models.find((model) => model.slug === selection.model) ??
          provider?.models.find((model) => model.isDefault) ??
          provider?.models[0];
        if (provider && model)
          selection = {
            instanceId: provider.instanceId,
            model: model.slug,
            ...(provider.instanceId === selection.instanceId && model.slug === selection.model
              ? { options: selection.options }
              : {}),
          };
      }
      yield* policy
        .assert(selection, input.automatic ? "automatic" : "person")
        .pipe(
          Effect.mapError(
            (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
          ),
        );
      const generation = yield* resolveInstance(registry, operation, selection.instanceId);
      const admission = policy
        .assert(selection, input.automatic ? "automatic" : "person")
        .pipe(
          Effect.mapError(
            (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
          ),
        );
      return yield* policy
        .withUtility(
          selection,
          admission.pipe(
            Effect.andThen(generate(generation, { ...input, modelSelection: selection })),
            Effect.provideService(TextGenerationAdmission, admission),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof TextGenerationError
              ? cause
              : new TextGenerationError({ operation, detail: cause.message, cause }),
          ),
        );
    });
  return TextGeneration.of({
    generateStructured: (input) =>
      run("generateStructured", input, (generation, input) =>
        generation.generateStructured
          ? generation.generateStructured(input)
          : Effect.fail(
              new TextGenerationError({
                operation: "generateStructured",
                detail: input.images?.length
                  ? "This Agent cannot read images here. Structured generation is unavailable."
                  : "This provider does not support structured generation.",
              }),
            ),
      ),
    generateCommitMessage: (input) =>
      run("generateCommitMessage", input, (generation, input) =>
        generation.generateCommitMessage(input),
      ),
    generatePrContent: (input) =>
      run("generatePrContent", input, (generation, input) => generation.generatePrContent(input)),
    generateBranchName: (input) =>
      run("generateBranchName", input, (generation, input) => generation.generateBranchName(input)),
    generateReviewGuide: (input) =>
      run("generateReviewGuide", input, (generation, input) =>
        generation.generateReviewGuide(input),
      ),
    // Nodex configures no source-control hosts, so titles carry no fetched link context.
    generateThreadTitle: (input) =>
      run("generateThreadTitle", input, (generation, input) =>
        generation.generateThreadTitle(input),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
