import * as Cause from "effect/Cause";
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
const TITLE_MAX_INPUT_CHARACTERS = 8000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ClaudeTextGenerationError extends Schema.TaggedError<ClaudeTextGenerationError>()(
  "ClaudeTextGenerationError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface ClaudeStructuredGenerationInput<T> {
  readonly instanceConfigId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly schema: z.ZodType<T>;
  readonly model?: string;
  readonly effort?: ClaudeEffortLevel;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

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
    /**
     * Runs one ephemeral, tool-free helper session whose result must satisfy `schema`.
     * Callers own prompt construction and any further semantic validation.
     */
    readonly structured: <T>(
      input: ClaudeStructuredGenerationInput<T>,
    ) => Effect.Effect<T, ClaudeTextGenerationError>;
  }
>()("nodex/main/agent-backend/ClaudeTextGeneration") {}

export const make = Effect.gen(function* () {
  const sdk = yield* ClaudeSdk;
  const settings = yield* ApplicationSettings;
  const config = yield* MainConfig;

  const structured = <T>(input: ClaudeStructuredGenerationInput<T>) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!input.prompt.trim() || !input.instanceConfigId.trim()) {
          return yield* new ClaudeTextGenerationError({ message: "Nothing to generate" });
        }
        const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
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
            Effect.succeed({ behavior: "deny", message: "Helper generation does not use tools" }),
          ...(input.model ? { model: input.model } : {}),
          ...(isClaudeEffortLevel(input.effort) ? { effort: input.effort } : {}),
          outputSchema: z.toJSONSchema(input.schema),
        });
        let outputBytes = 0;
        let result: { readonly value: T } | null = null;
        let failure: string | null = null;
        yield* session.send(input.prompt);
        yield* session.messages.pipe(
          Stream.takeUntil((message) => message.type === "result"),
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              if (message.type !== "assistant" && message.type !== "result") return;
              outputBytes += Buffer.byteLength(JSON.stringify(message));
              if (outputBytes > maxOutputBytes) {
                return yield* new ClaudeTextGenerationError({
                  message: `Helper output exceeded its ${maxOutputBytes}-byte budget`,
                });
              }
              if (message.type !== "result") return;
              if (message.subtype !== "success" || message.is_error) {
                failure = "Claude could not complete the request";
                return;
              }
              const parsed = input.schema.safeParse(message.structured_output);
              if (parsed.success) result = { value: parsed.data };
              else failure = "Claude returned an invalid structured result";
            }),
          ),
        );
        if (result === null) {
          return yield* new ClaudeTextGenerationError({
            message: failure ?? "Claude returned no structured result",
          });
        }
        return (result as { readonly value: T }).value;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        orElse: () => Effect.fail(new ClaudeTextGenerationError({ message: "Claude timed out" })),
      }),
      Effect.catchCause((cause) => {
        const squashed = Cause.squash(cause);
        return Effect.fail(
          squashed instanceof ClaudeTextGenerationError
            ? squashed
            : new ClaudeTextGenerationError({
                message:
                  squashed instanceof Error && squashed.message
                    ? squashed.message
                    : "Claude helper failed",
                cause: squashed,
              }),
        );
      }),
    );

  return ClaudeTextGeneration.of({
    title: (input) =>
      input.prompt.length > TITLE_MAX_INPUT_CHARACTERS
        ? Effect.succeed(null)
        : structured({
            instanceConfigId: input.instanceConfigId,
            cwd: input.cwd,
            prompt: `Create a concise task title for this user request. Return the title JSON object. Do not answer or execute the request.\n\n${input.prompt}`,
            schema: Title,
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          }).pipe(
            Effect.map((value) => value.title),
            Effect.catch(() => Effect.succeed(null)),
          ),
    structured,
  });
});

export const layer = Layer.effect(ClaudeTextGeneration, make);
