import { assertTextGenerationAdmission } from "@nodex/provider-core/server/textGenerationPolicy";
import {
  restrictions as claudeModelRestrictions,
  verifyClaudeModelPolicy,
} from "../nodex/ClaudeModelPolicy.ts";
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

import { type ClaudeSettings, TextGenerationError } from "@nodex/runtime-contracts";
import { resolveSpawnCommand } from "@nodex/runtime-shared/shell";

import * as TextGenerationOperations from "@nodex/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@nodex/provider-core/server/textGenerationUtils";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@nodex/runtime-shared/model";
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
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
/** Reading the web changes nothing either, so a request that asks for it may also search. */
const WEB_READ_TOOLS = ["WebSearch", "WebFetch"];
const ClaudeResult = Schema.Struct({
  subtype: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(Schema.NullOr(Schema.String)),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
  api_error_status: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isClaudeResultMessage = Schema.is(Schema.Struct({ type: Schema.Literal("result") }));
const decodeClaudeResult = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ ...ClaudeResult.fields, type: Schema.Literal("result") }),
    Schema.Struct({ ...ClaudeResult.fields, structured_output: Schema.Unknown }),
  ]),
);

const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJsonString = Schema.encodeEffect(JsonString);
const decodeClaudeStdout = Schema.decodeOption(JsonString);

const readClaudeResult = Effect.fn("readClaudeResult")(function* (
  operation: TextGenerationOperations.Operation,
  result: typeof ClaudeResult.Type | undefined,
  transportFailure?: string,
) {
  // Claude can label an API error "success" and put the reason in result.
  if (
    result &&
    (result.is_error || (result.subtype !== undefined && result.subtype !== "success"))
  ) {
    const reason = result.result?.trim() || result.errors?.join("\n").trim();
    const status = result.api_error_status;
    // These statuses drive the sign-in and rate-limit messages in callers.
    const statusLabel = status === 401 || status === 429 ? ` (HTTP ${status})` : "";
    const fallback =
      status == null
        ? (transportFailure ?? "Claude request failed.")
        : `Claude request failed (HTTP ${status}).`;
    return yield* new TextGenerationError({
      operation,
      detail: reason ? reason + statusLabel : fallback,
    });
  }
  if (transportFailure) {
    return yield* new TextGenerationError({ operation, detail: transportFailure });
  }
  if (result?.structured_output === undefined) {
    return yield* new TextGenerationError({
      operation,
      detail: "Claude finished without a structured answer.",
    });
  }
  return result.structured_output;
});

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
   * Run a Claude utility query and return its schema-validated result.
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
    webSearch,
    isolated,
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
    const readTools = webSearch ? [...READ_ONLY_TOOLS, ...WEB_READ_TOOLS] : READ_ONLY_TOOLS;
    const settings = {
      disableAllHooks: true,
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
    };
    const nativeModelPolicy = yield* claudeModelRestrictions(resolvedModelSelection, catalog).pipe(
      Effect.mapError(
        (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
      ),
    );
    const useSdk = Boolean(images?.length || claudeSettings.isolated);

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      const policySdk = yield* Effect.tryPromise({
        try: loadClaudeAgentSdk,
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not inspect Claude model restrictions.",
            cause,
          }),
      });
      yield* Effect.tryPromise({
        try: () =>
          verifyClaudeModelPolicy(
            {
              cwd,
              ...(isolated || claudeSettings.isolated ? { settingSources: [] } : {}),
              managedSettings: nativeModelPolicy,
            },
            policySdk.resolveSettings,
          ),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Claude model restrictions could not be verified.",
            cause,
          }),
      });
      if (useSdk) {
        const sdk = yield* Effect.tryPromise({
          try: loadClaudeAgentSdk,
          catch: (cause) =>
            new TextGenerationError({ operation, detail: "Failed to load Claude SDK.", cause }),
        });
        const binaryPath =
          claudeSettings.binaryPath && !claudeSettings.isolated
            ? yield* resolveClaudeSdkExecutablePath(claudeSettings.binaryPath, claudeEnvironment)
            : undefined;
        const userMessage: SDKUserMessage = {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...(images ?? []).map((image) => ({
                type: "image" as const,
                source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
              })),
            ],
          },
        };
        yield* assertTextGenerationAdmission;
        const query = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              sdk.query({
                prompt: (async function* () {
                  yield userMessage;
                })(),
                options: {
                  cwd,
                  managedSettings: nativeModelPolicy,
                  env: claudeEnvironment,
                  ...(isolated || claudeSettings.isolated ? { settingSources: [] } : {}),
                  ...(isolated
                    ? {
                        strictMcpConfig: true,
                        extraArgs: { "disable-slash-commands": null },
                      }
                    : {}),
                  model: resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection),
                  permissionMode: "dontAsk",
                  tools: readTools,
                  allowedTools: readTools,
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
              new TextGenerationError({
                operation,
                detail: "Failed to start Claude SDK query.",
                cause,
              }),
          }),
          (query) => Effect.sync(() => query.close()),
        );
        const result = yield* Effect.tryPromise({
          try: async () => {
            for await (const message of query) {
              if (message.type === "result") return message;
            }
            return undefined;
          },
          catch: (cause) =>
            new TextGenerationError({ operation, detail: "Claude SDK query failed.", cause }),
        });
        return yield* readClaudeResult(operation, result);
      }
      const settingsJson = yield* encodeJsonForOperation(
        operation,
        settings,
        "Failed to encode Claude CLI settings.",
      );
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
          ...(isolated
            ? ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
            : []),
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsJson,
          "--managed-settings",
          JSON.stringify(nativeModelPolicy),
          "--permission-mode",
          "dontAsk",
          "--tools",
          readTools.join(","),
          "--allowedTools",
          readTools.join(","),
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

      yield* assertTextGenerationAdmission;
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

      const output = Option.getOrUndefined(decodeClaudeStdout(stdout));
      const envelope = Array.isArray(output) ? output.findLast(isClaudeResultMessage) : output;
      const result = Option.getOrUndefined(decodeClaudeResult(envelope));
      if (exitCode !== 0) {
        // Stdout may contain the entire conversation, including the prompt.
        const stderrDetail = stderr.trim();
        return yield* readClaudeResult(
          operation,
          result,
          stderrDetail
            ? `Claude CLI command failed: ${stderrDetail}`
            : `Claude CLI command failed with code ${exitCode}.`,
        );
      }
      if (result === undefined) {
        return yield* new TextGenerationError({
          operation,
          detail: "Claude CLI returned unexpected output format.",
        });
      }
      return yield* readClaudeResult(operation, result);
    });

    const structuredOutput = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs ?? investigate?.timeoutMs ?? CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: `Claude ${useSdk ? "SDK" : "CLI"} request timed out.`,
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    if (Buffer.byteLength(JSON.stringify(structuredOutput) ?? "") > (maxOutputBytes ?? 1024 * 1024))
      return yield* new TextGenerationError({
        operation,
        detail: "Structured output exceeded its byte budget.",
      });
    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(structuredOutput).pipe(
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
