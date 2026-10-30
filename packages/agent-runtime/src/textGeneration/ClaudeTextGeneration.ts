/**
 * Claude text generation uses native structured output. Text-only utility tasks
 * use the CLI; image-bearing tasks use an SDK user message with image blocks.
 *
 * @module ClaudeTextGeneration
 */
import * as Effect from "effect/Effect";
import type { SDKUserMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeAgentSdk } from "../provider/ClaudeAgentSdk.ts";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeSettings, TextGenerationError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * Verbose mode wraps the result in an array of conversation messages.
 */
const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

/**
 * The Claude CLI validates `--json-schema` in its own JSON Schema dialect and refuses a schema
 * that declares another one, so a caller's `$schema` is dropped; the constraints are unchanged.
 */
const withoutDeclaredDialect = (schema: unknown): unknown => {
  if (typeof schema !== "object" || schema === null || !("$schema" in schema)) return schema;
  const { $schema: _dialect, ...constraints } = schema as Record<string, unknown>;
  return constraints;
};

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFoldEffect(
        () => "",
        (acc, chunk) =>
          Buffer.byteLength(acc) + Buffer.byteLength(chunk) > 1024 * 1024
            ? Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Utility output exceeded its transport budget.",
                }),
              )
            : Effect.succeed(acc + chunk),
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    images,
    outputSchema: outputSchemaJson,
    modelSelection,
    investigate,
    jsonSchema,
    maxOutputBytes,
    timeoutMs,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
    const catalog = yield* scopedModelCatalog;
    const resolvedModelSelection = {
      ...modelSelection,
      model: resolveClaudeModelSlug(catalog, modelSelection.model),
    };
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      withoutDeclaredDialect(jsonSchema ?? toJsonSchemaObject(outputSchemaJson)),
      "Failed to encode structured output schema.",
    );
    const caps = getClaudeCatalogModelCapabilities(catalog, resolvedModelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: resolvedModelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(resolvedModelSelection, "effort");
    const resolvedEffort = resolveClaudeCatalogEffort(
      catalog,
      resolvedModelSelection.model,
      rawEffortSelection,
    );
    const cliEffort = normalizeClaudeCatalogEffort(
      catalog,
      resolvedEffort,
      resolvedModelSelection.model,
    );
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    const thinking =
      thinkingDescriptor?.type === "boolean" ? thinkingDescriptor.currentValue : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      disableAllHooks: true,
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
    };
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      settings,
      "Failed to encode Claude CLI settings.",
    );

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      if (images?.length) {
        const sdk = yield* Effect.tryPromise({
          try: loadClaudeAgentSdk,
          catch: (cause) =>
            normalizeCliError("claude", operation, cause, "Failed to load Claude SDK"),
        });
        const binaryPath = claudeSettings.binaryPath
          ? yield* resolveClaudeSdkExecutablePath(claudeSettings.binaryPath, claudeEnvironment)
          : undefined;
        const userMessage: SDKUserMessage = {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...images.map((image) => ({
                type: "image" as const,
                source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
              })),
            ],
          },
        };
        const query = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              sdk.query({
                prompt: (async function* () {
                  yield userMessage;
                })(),
                options: {
                  cwd,
                  env: claudeEnvironment,
                  model: resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection),
                  permissionMode: "bypassPermissions",
                  allowDangerouslySkipPermissions: true,
                  persistSession: false,
                  settings,
                  ...(cliEffort ? { effort: cliEffort as NonNullable<Options["effort"]> } : {}),
                  ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
                  outputFormat: {
                    type: "json_schema",
                    schema: JSON.parse(jsonSchemaStr) as Record<string, unknown>,
                  },
                },
              }),
            catch: (cause) =>
              normalizeCliError("claude", operation, cause, "Failed to start Claude SDK query"),
          }),
          (query) => Effect.sync(() => query.close()),
        );
        return yield* Effect.tryPromise({
          try: async () => {
            for await (const message of query) {
              if (message.type !== "result") continue;
              if (message.subtype !== "success") throw new Error(message.errors.join("\n"));
              return JSON.stringify({ structured_output: message.structured_output });
            }
            throw new Error("Claude returned no structured result.");
          },
          catch: (cause) =>
            normalizeCliError("claude", operation, cause, "Claude image generation failed"),
        });
      }
      // Titles need only the supplied prompt, not configuration from the checkout.
      const workingDirectory =
        operation === "generateThreadTitle"
          ? yield* fileSystem
              .makeTempDirectoryScoped({ prefix: "nodex-claude-title-" })
              .pipe(
                Effect.mapError((cause) =>
                  normalizeCliError("claude", operation, cause, "Failed to create title directory"),
                ),
              )
          : cwd;
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsJson,
          "--dangerously-skip-permissions",
          // A utility task is not a conversation: it never joins the user's Claude history.
          "--no-session-persistence",
        ],
        { env: claudeEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: claudeEnvironment,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs ?? investigate?.timeoutMs ?? CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    if (
      Buffer.byteLength(JSON.stringify(envelope?.structured_output) ?? "") >
      (maxOutputBytes ?? 1024 * 1024)
    )
      return yield* new TextGenerationError({
        operation,
        detail: "Structured output exceeded its byte budget.",
      });
    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope?.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  return TextGenerationOperations.fromRunner("ClaudeTextGeneration", runClaudeJson, {
    supportsImages: true,
  });
});
