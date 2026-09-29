import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { createUuidV7 } from "../../shared/uuid-v7";
import { isClaudeEffortLevel, type ClaudeEffortLevel } from "../../shared/claude-models";
import { MainConfig } from "../app/MainConfig";
import { ClaudeSdk } from "../platform/node/ClaudeSdk";
import { ApplicationSettings } from "../settings/ApplicationSettings";

const Title = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !/[\r\n]/.test(value)),
});
const MAX_INPUT_CHARACTERS = 8000;
const MAX_OUTPUT_BYTES = 16 * 1024;

class ClaudeHelperOutputError extends Schema.TaggedError<ClaudeHelperOutputError>()(
  "ClaudeHelperOutputError",
  {},
) {}

export class ClaudeTextGeneration extends Context.Service<
  ClaudeTextGeneration,
  {
    /** An explicitly requested helper operation; ordinary prompts never invoke this service. */
    readonly title: (input: {
      readonly instanceConfigId: string;
      readonly cwd: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: ClaudeEffortLevel;
    }) => Effect.Effect<string | null>;
  }
>()("nodex/main/agent-backend/ClaudeTextGeneration") {}

export const make = Effect.gen(function* () {
  const sdk = yield* ClaudeSdk;
  const settings = yield* ApplicationSettings;
  const config = yield* MainConfig;
  return ClaudeTextGeneration.of({
    title: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (
            !input.prompt.trim() ||
            input.prompt.length > MAX_INPUT_CHARACTERS ||
            !input.instanceConfigId.trim()
          )
            return null;
          const { instance, environment } = yield* settings.claudeLaunchConfiguration(
            input.instanceConfigId,
          );
          const session = yield* sdk.open({
            instance,
            environment: { ...config.environment, ...environment },
            cwd: input.cwd,
            sessionId: createUuidV7(),
            resume: false,
            persistSession: false,
            purpose: "helper",
            permissionMode: "dontAsk",
            canUseTool: () =>
              Effect.succeed({ behavior: "deny", message: "Title generation does not use tools" }),
            ...(input.model ? { model: input.model } : {}),
            ...(isClaudeEffortLevel(input.effort) ? { effort: input.effort } : {}),
            outputSchema: z.toJSONSchema(Title),
          });
          let outputBytes = 0;
          let title: string | null = null;
          yield* session.send(
            `Create a concise task title for this user request. Return the title JSON object. Do not answer or execute the request.\n\n${input.prompt}`,
          );
          yield* session.messages.pipe(
            Stream.takeUntil((message) => message.type === "result"),
            Stream.runForEach((message) =>
              Effect.gen(function* () {
                if (message.type !== "assistant" && message.type !== "result") return;
                outputBytes += Buffer.byteLength(JSON.stringify(message));
                if (outputBytes > MAX_OUTPUT_BYTES) return yield* new ClaudeHelperOutputError();
                if (message.type !== "result" || message.subtype !== "success" || message.is_error)
                  return;
                const parsed = Title.safeParse(message.structured_output);
                if (parsed.success) title = parsed.data.title;
              }),
            ),
          );
          return title;
        }),
      ).pipe(
        Effect.timeout("30 seconds"),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
  });
});

export const layer = Layer.effect(ClaudeTextGeneration, make);
