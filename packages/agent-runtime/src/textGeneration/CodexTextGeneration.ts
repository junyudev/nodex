import { assertTextGenerationAdmission } from "@nodex/provider-core/server/textGenerationPolicy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parse as parseToml, type TomlTable, type TomlValue } from "smol-toml";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ServerProviderModel,
  TextGenerationError,
} from "@nodex/runtime-contracts";
import { resolveSpawnCommand } from "@nodex/runtime-shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { inferImageExtension } from "../imageMime.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@nodex/provider-core/server/pathExpansion";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import * as TextGenerationOperations from "@nodex/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@nodex/provider-core/server/textGenerationUtils";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@nodex/runtime-shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as HostProcess from "@nodex/runtime-shared/HostProcess";

const CODEX_TIMEOUT_MS = 180_000;
const UTILITY_SECRET_PREFIX = "NODEX_CODEX_UTILITY_SECRET_";
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * An isolated request skips config.toml, which also says where Codex sends requests. These keys
 * carry that over: the selected provider, endpoints, sign-in and credential storage. Everything
 * else in the file is a customization the request leaves out.
 */
const connectionKeys = [
  "model_provider",
  "openai_base_url",
  "chatgpt_base_url",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
  "cli_auth_credentials_store",
] as const;

const providerConnectionKeys = [
  "name",
  "base_url",
  "model_catalog_url",
  "env_key",
  "project_id",
  "location",
  "credential_file",
  "wire_api",
  "requires_openai_auth",
  "supports_websockets",
  "supports_standalone_web_search",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "websocket_connect_timeout_ms",
] as const;

function asTomlTable(value: TomlValue | undefined): TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as TomlTable)
    : {};
}

function pickConfig(table: TomlTable, keys: readonly string[]): TomlTable {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = table[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/** A TOML basic string; JSON's escapes are TOML's, and TOML also forbids a raw DEL. */
const tomlString = (value: string) => JSON.stringify(value).replaceAll("\u007f", "\\u007F");

/** The inline TOML literal Codex parses from a `--config key=value` override. */
function tomlLiteral(value: TomlValue): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" && !Number.isFinite(value))
    return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, item]) => `${tomlString(key)} = ${tomlLiteral(item)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

function configOverride(key: string, value: TomlValue): string[] {
  return ["--config", `${key}=${tomlLiteral(value)}`];
}

function validateArgvUrls(table: TomlTable, keys: readonly string[]) {
  for (const key of keys) {
    const value = table[key];
    if (typeof value !== "string") continue;
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Codex endpoint contains URL components that may hold credentials.");
    }
  }
}

function isolatedConnectionConfig(source: string, environment: NodeJS.ProcessEnv) {
  const userConfig = parseToml(source, { integersAsBigInt: true });
  const config = pickConfig(userConfig, connectionKeys);
  validateArgvUrls(config, ["openai_base_url", "chatgpt_base_url"]);

  const secretEnvironment: NodeJS.ProcessEnv = {};
  const bindSecret = (value: string) => {
    const name = `${UTILITY_SECRET_PREFIX}${crypto.randomUUID().replaceAll("-", "_")}`;
    secretEnvironment[name] = value;
    return name;
  };
  // Only the selected provider connects, so another provider's table is never forwarded.
  const selected = Object.entries(asTomlTable(userConfig.model_providers)).filter(
    ([id]) => id === config.model_provider,
  );
  const providers = selected.map(([id, value]) => {
    const provider = asTomlTable(value);
    const connection = pickConfig(provider, providerConnectionKeys);
    validateArgvUrls(connection, ["base_url", "model_catalog_url"]);

    // Codex overlays env headers on static headers when the referenced value is present.
    // Move static values into the child environment to keep them out of process arguments.
    const envHeaders = new Map(
      Object.entries(asTomlTable(provider.env_http_headers)).flatMap(([header, name]) =>
        typeof name === "string" ? [[header.toLowerCase(), name] as const] : [],
      ),
    );
    for (const [header, value] of Object.entries(asTomlTable(provider.http_headers))) {
      const name = envHeaders.get(header.toLowerCase());
      if (typeof value !== "string") continue;
      const override = name ? environment[name] : undefined;
      if (typeof override === "string" && override.trim()) continue;
      if (value.trim()) envHeaders.set(header.toLowerCase(), bindSecret(value));
    }
    if (envHeaders.size > 0) connection.env_http_headers = Object.fromEntries(envHeaders);
    if (
      connection.env_key === undefined &&
      typeof provider.experimental_bearer_token === "string" &&
      provider.experimental_bearer_token.trim()
    ) {
      connection.env_key = bindSecret(provider.experimental_bearer_token);
    }

    // Arbitrary query parameters and credential-command arguments may contain secrets and
    // Codex has no env indirection for them. Omit those settings from CLI overrides.
    const auth = asTomlTable(provider.auth);
    const gateway = asTomlTable(provider.gateway_oauth);
    const aws = asTomlTable(provider.aws);
    const hasArgs = (command: TomlValue | undefined) => {
      if (command === undefined) return false;
      if (typeof command !== "object" || Array.isArray(command)) return true;
      const args = asTomlTable(command).args;
      return args !== undefined && !(Array.isArray(args) && args.length === 0);
    };
    validateArgvUrls(gateway, [
      "authorization_url",
      "device_authorization_url",
      "token_url",
      "resource",
    ]);
    if (provider.auth !== undefined && !hasArgs(provider.auth)) connection.auth = auth;
    if (provider.gateway_oauth !== undefined && !hasArgs(gateway.credential_export)) {
      connection.gateway_oauth = gateway;
    }
    if (
      provider.aws !== undefined &&
      !hasArgs(aws.credential_export) &&
      !hasArgs(aws.auth_refresh)
    ) {
      connection.aws = aws;
    }
    return [id, connection] as const;
  });
  if (providers.length > 0) config.model_providers = Object.fromEntries(providers);

  return {
    args: Object.entries(config).flatMap(([key, value]) => configOverride(key, value)),
    environment: secretEnvironment,
  };
}

/**
 * Build a Codex text-generation closure bound to a specific `CodexSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@nodex/runtime-contracts").ProviderSetupError,
    Scope.Scope
  >,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

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
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeTempFileDir = (filePath: string): Effect.Effect<void> =>
    fileSystem
      .remove(path.dirname(filePath), { recursive: true })
      .pipe(Effect.catch(() => Effect.void));

  // Each request owns a fresh Scope, so temporary files cannot inherit a closed
  // background Scope and are released even if a later allocation or write fails.
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string | Uint8Array,
    suffix?: string,
  ): Effect.Effect<string, TextGenerationError, Scope.Scope> =>
    Effect.acquireRelease(
      fileSystem.makeTempFile({ prefix: `nodex-${prefix}-${process.pid}-`, suffix }),
      removeTempFileDir,
    ).pipe(
      Effect.tap((filePath) =>
        typeof content === "string"
          ? fileSystem.writeFileString(filePath, content)
          : fileSystem.writeFile(filePath, content),
      ),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to write temp file.",
            cause,
          }),
      ),
    );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const readIsolatedConnectionConfig = Effect.fn("readIsolatedConnectionConfig")(function* (
    operation: TextGenerationOperations.Operation,
    configPath: string,
    environment: NodeJS.ProcessEnv,
  ) {
    const configSource = yield* fileSystem
      .readFileString(configPath)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.fail(
                new TextGenerationError({ operation, detail: "Could not read Codex config.toml." }),
              ),
        ),
      );
    if (configSource === undefined) return undefined;
    return yield* Effect.try({
      try: () => isolatedConnectionConfig(configSource, environment),
      // TOML parse errors can include the original line, including credential values.
      catch: () =>
        new TextGenerationError({
          operation,
          detail: "Could not prepare isolated Codex connection settings from config.toml.",
        }),
    });
  });

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    attachments,
    images,
    investigate,
    jsonSchema,
    maxOutputBytes,
    timeoutMs,
    webSearch,
    isolated,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"] | Scope.Scope
  > {
    const imagePaths = yield* materializeImageAttachments(attachments);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      jsonSchema ?? toJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "");
    for (const image of images ?? []) {
      const imagePath = yield* writeTempFile(
        operation,
        "codex-image",
        Buffer.from(image.data, "base64"),
        inferImageExtension({ mimeType: image.mediaType }),
      );
      imagePaths.push(imagePath);
    }

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              (cause) => new TextGenerationError({ operation, detail: cause.detail }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const model =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        models.find(
          (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
        )?.slug ??
        requestedModel;
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = resolved ? undefined : getCodexServiceTierOptionValue(modelSelection);
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const hostHome = yield* HostProcess.HomeDirectory;
      const configuredHome = expandHomePath(effectiveConfig.homePath, hostHome);
      const codexHome =
        configuredHome ||
        effectiveEnvironment.CODEX_HOME ||
        path.join(effectiveEnvironment.HOME || hostHome, ".codex");
      // Isolation drops customizations while retaining the endpoint and auth of the selected
      // installation. Managed Codex already supplies its own connection through its launch args.
      const connection =
        isolated && !resolved
          ? yield* readIsolatedConnectionConfig(
              operation,
              path.resolve(cwd, codexHome, "config.toml"),
              effectiveEnvironment,
            )
          : undefined;
      const spawnCommand = yield* resolveSpawnCommand(
        effectiveConfig.binaryPath || "codex",
        [
          "exec",
          ...(isolated
            ? [
                "--ignore-user-config",
                "--config",
                "skills.include_instructions=false",
                "--config",
                "project_doc_max_bytes=0",
                ...(connection?.args ?? []),
              ]
            : []),
          ...codexExecLaunchArgs(launchArgs),
          ...(connection && Object.keys(connection.environment).length > 0
            ? configOverride("shell_environment_policy.exclude", [`${UTILITY_SECRET_PREFIX}*`])
            : []),
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--config",
          'approval_policy="never"',
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          ...(webSearch ? ["--config", 'web_search="live"'] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: {
          ...effectiveEnvironment,
          ...connection?.environment,
          ...(configuredHome ? { CODEX_HOME: configuredHome } : {}),
        },
        cwd,
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
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
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
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    yield* runCodexCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs ?? investigate?.timeoutMs ?? CODEX_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
            ),
          onSome: () => Effect.void,
        }),
      ),
    );

    const outputInfo = yield* fileSystem
      .stat(outputPath)
      .pipe(
        Effect.mapError((cause) =>
          normalizeCliError("codex", operation, cause, "Cannot inspect utility output"),
        ),
      );
    if (outputInfo.size > BigInt(maxOutputBytes ?? 1024 * 1024))
      return yield* new TextGenerationError({
        operation,
        detail: "Structured output exceeded its byte budget.",
      });
    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

    return yield* fileSystem.readFileString(outputPath).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to read Codex output file.",
            cause,
          }),
      ),
      Effect.flatMap(decodeOutput),
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Codex returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  }, Effect.scoped);

  return TextGenerationOperations.fromRunner("CodexTextGeneration", runCodexJson, {
    supportsImages: true,
    enforcesJsonSchema: true,
  });
});
