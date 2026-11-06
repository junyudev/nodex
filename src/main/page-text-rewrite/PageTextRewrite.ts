import { readModelPolicyFailure } from "../../shared/model-policy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { readMarkdown } from "../../shared/nodex-markdown";
import {
  PAGE_TEXT_REWRITE_LIMITS,
  type PageTextRewriteFailure,
  type PageTextRewriteInput,
} from "../../shared/page-text-rewrite";
import {
  AgentRuntimeApplication,
  agentRuntimeFailureReason,
} from "../agent-runtime/AgentRuntimeApplication";
import { MainConfig } from "../app/MainConfig";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  buildPageTextRewritePrompt,
  PAGE_TEXT_REWRITE_OUTPUT_SCHEMA,
  stripPageTextRewriteFence,
} from "./rewrite-prompt";
import { selectPageTextRewriteModel } from "./rewrite-model";

export class PageTextRewriteError extends Schema.TaggedError<PageTextRewriteError>()(
  "PageTextRewriteError",
  {
    code: Schema.Literals([
      "model_off",
      "credit_requires_person",
      "invalid_input",
      "unavailable",
      "busy",
      "timeout",
      "auth",
      "rate_limit",
      "invalid_output",
      "generation_failed",
    ]),
    message: Schema.String,
  },
) {}

/** Never expose provider stderr: it can contain the selection or private runtime details. */
export const rewriteGenerationFailure = (error: unknown): PageTextRewriteFailure => {
  const policy = readModelPolicyFailure(error);
  if (policy) return policy;
  const reason = agentRuntimeFailureReason(error);
  if (/401|unauthori[sz]ed|not (?:logged|signed) in|api key|authentication/i.test(reason))
    return { code: "auth", message: "Sign in to the rewrite Agent and try again" };
  if (/timed? ?out|deadline/i.test(reason))
    return { code: "timeout", message: "The rewrite timed out. Try again" };
  if (/rate.?limit|\b429\b/i.test(reason))
    return { code: "rate_limit", message: "The rewrite Agent is rate limited. Try again shortly" };
  return { code: "generation_failed", message: "The rewrite failed. Try again" };
};

const Output = z.object({ markdown: z.string().max(PAGE_TEXT_REWRITE_LIMITS.output) }).strict();

export const make = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeApplication;
  const settings = yield* ApplicationSettings;
  const config = yield* MainConfig;
  const generate = Effect.fn("PageTextRewrite.generate")(
    function* (input: PageTextRewriteInput) {
      const preference = (yield* settings.snapshot()).inbox;
      let providers = yield* runtime.catalog();
      let modelSelection = selectPageTextRewriteModel(providers, preference);
      if (!modelSelection) {
        providers = yield* runtime.catalog({ refresh: true });
        modelSelection = selectPageTextRewriteModel(providers, preference);
      }
      if (!modelSelection)
        return yield* new PageTextRewriteError({
          code: "unavailable",
          message: "Connect a Codex or Claude Agent to rewrite text",
        });
      const prompt = buildPageTextRewritePrompt(input);
      if (prompt.length > 262_144)
        return yield* new PageTextRewriteError({
          code: "invalid_input",
          message: "Select less text to rewrite",
        });
      const output = yield* runtime.generateStructured({
        cwd: config.nodexHome,
        prompt,
        modelSelection,
        outputSchema: PAGE_TEXT_REWRITE_OUTPUT_SCHEMA,
        maxOutputBytes: 262_144,
        timeoutMs: PAGE_TEXT_REWRITE_LIMITS.timeoutMs,
      });
      return yield* Effect.try({
        try: () => {
          const markdown = stripPageTextRewriteFence(Output.parse(output).markdown, input.markdown);
          if (!markdown.trim() || Buffer.byteLength(markdown) > PAGE_TEXT_REWRITE_LIMITS.output)
            throw new Error("Empty or oversized rewrite");
          readMarkdown(markdown, "exact");
          return markdown;
        },
        catch: () =>
          new PageTextRewriteError({
            code: "invalid_output",
            message: "The Agent returned an invalid rewrite. Try again",
          }),
      });
    },
    Effect.mapError((error) =>
      Schema.is(PageTextRewriteError)(error)
        ? error
        : new PageTextRewriteError(rewriteGenerationFailure(error)),
    ),
    Effect.timeoutOrElse({
      duration: PAGE_TEXT_REWRITE_LIMITS.timeoutMs,
      orElse: () =>
        Effect.fail(
          new PageTextRewriteError({
            code: "timeout",
            message: "The rewrite timed out. Try again",
          }),
        ),
    }),
  );
  return { generate };
});

export class PageTextRewrite extends Context.Service<
  PageTextRewrite,
  Effect.Success<typeof make>
>()("nodex/main/page-text-rewrite/PageTextRewrite") {
  static readonly live = Layer.effect(this, make);
}
