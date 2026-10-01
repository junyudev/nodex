#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  distributeObjectUnions,
  parseCodexNotificationEntries,
  parseCodexRequestEntries,
  type CodexMethodEntry,
} from "../../../scripts/codex-schema-generator.ts";

const JsonSchemaDocument = Schema.StructWithRest(
  Schema.Struct({
    definitions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const decodeJsonSchemaDocument = Schema.decodeEffect(Schema.fromJsonString(JsonSchemaDocument));

const [jsonSchemaInputPath, typescriptInputPath, generatedOutputPath] = process.argv.slice(2);
if (!jsonSchemaInputPath || !typescriptInputPath || !generatedOutputPath) {
  throw new Error("Usage: generate.ts <json-schema-input> <typescript-input> <generated-output>");
}

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
  readonly namespacesOutputPath: string;
}

type MethodEntry = CodexMethodEntry;

interface JsonSchemaFile {
  readonly namespace?: string;
  readonly exportName: string;
  readonly fileName: string;
  readonly sourcePath: string;
  readonly qualifiedName: string;
}

class GeneratorError extends Schema.TaggedError<GeneratorError>()("GeneratorError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

const ManualSchemas: Record<string, Schema.Json> = {
  GetAuthStatusParams: {
    type: "object",
    title: "GetAuthStatusParams",
    properties: {
      includeToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
      refreshToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
  },
  GetConversationSummaryParams: {
    title: "GetConversationSummaryParams",
    oneOf: [
      {
        type: "object",
        properties: {
          rolloutPath: { type: "string" },
        },
        required: ["rolloutPath"],
      },
      {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
    ],
  },
  GetConversationSummaryResponse: {
    type: "object",
    title: "GetConversationSummaryResponse",
    properties: {
      summary: {},
    },
    required: ["summary"],
  },
  GitDiffToRemoteParams: {
    type: "object",
    title: "GitDiffToRemoteParams",
    properties: {
      cwd: { type: "string" },
    },
    required: ["cwd"],
  },
  GitDiffToRemoteResponse: {
    type: "object",
    title: "GitDiffToRemoteResponse",
    properties: {
      sha: { type: "string" },
      diff: { type: "string" },
    },
    required: ["sha", "diff"],
  },
  GetAuthStatusResponse: {
    type: "object",
    title: "GetAuthStatusResponse",
    properties: {
      authMethod: {
        anyOf: [{}, { type: "null" }],
      },
      authToken: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      requiresOpenaiAuth: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
    required: ["authMethod", "authToken", "requiresOpenaiAuth"],
  },
};

const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.resolve(generatedOutputPath);
  return {
    generatedDir,
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
    namespacesOutputPath: path.join(generatedDir, "namespaces.gen.ts"),
  } satisfies GeneratedPaths;
});

const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();
  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

const readText = Effect.fn("readText")(function* (sourcePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new GeneratorError({
          detail: `Failed to read ${sourcePath}`,
          cause,
        }),
    ),
  );
});

function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}

function normalizeNullableTypes(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(normalizeNullableTypes);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, child]) => [
    key,
    normalizeNullableTypes(child),
  ]);
  const normalizedObject = Object.fromEntries(normalizedEntries) as Record<string, Schema.Json>;
  const typeValue = normalizedObject.type;

  if (!Array.isArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => typeof entry === "string");
  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");
  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }
  const nonNullType = nonNullTypes[0]!;

  const nextObject: Record<string, Schema.Json> = {};
  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [
      {
        ...nextObject,
        type: nonNullType,
      },
      { type: "null" },
    ],
  };
}

function stripNullDefaults(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(stripNullDefaults);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "default" && child === null))
      .map(([key, child]) => [key, stripNullDefaults(child)]),
  ) as Schema.Json;
}

function toPascalCaseMethod(method: string) {
  return method
    .split("/")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

function resolveSchemaTypeName(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  if (rawTypeName === "undefined") {
    return "undefined";
  }

  const candidates = [
    rawTypeName,
    `V2${rawTypeName}`,
    `V1${rawTypeName}`,
    `SerdeJson${rawTypeName}`,
  ];
  for (const candidate of candidates) {
    if (generatedSchemaNames.has(candidate)) {
      return candidate;
    }
  }

  const nestedCandidates = [...generatedSchemaNames]
    .filter((candidate) => candidate.endsWith(`__${rawTypeName}`))
    .toSorted((left, right) => {
      const leftRank = left.startsWith("V2") ? 0 : left.startsWith("V1") ? 1 : 2;
      const rightRank = right.startsWith("V2") ? 0 : right.startsWith("V1") ? 1 : 2;
      return leftRank - rightRank || left.localeCompare(right);
    });
  if (nestedCandidates[0]) {
    return nestedCandidates[0];
  }

  throw new Error(`Unable to resolve schema type name: ${rawTypeName}`);
}

function renderResolvedType(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  return rawTypeName
    .split("|")
    .map((part) => part.trim())
    .map((part) =>
      part === "null" || part === "undefined"
        ? part
        : `CodexSchema.${resolveSchemaTypeName(part, generatedSchemaNames)}`,
    )
    .join(" | ");
}

function renderResolvedSchema(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  const parts = rawTypeName.split("|").map((part) => part.trim());
  if (parts.length === 1) {
    return parts[0] === "undefined"
      ? "undefined"
      : `CodexSchema.${resolveSchemaTypeName(parts[0]!, generatedSchemaNames)}`;
  }
  const nonNullish = parts.filter((part) => part !== "null" && part !== "undefined");
  if (nonNullish.length === 1) {
    let resolved = `CodexSchema.${resolveSchemaTypeName(nonNullish[0]!, generatedSchemaNames)}`;
    if (parts.includes("null")) {
      resolved = `Schema.NullOr(${resolved})`;
    }
    if (parts.includes("undefined")) {
      resolved = `Schema.UndefinedOr(${resolved})`;
    }
    return resolved;
  }
  throw new Error(`Unsupported protocol type union: ${rawTypeName}`);
}

function resolveResponseTypeName(
  method: string,
  paramsType: string | undefined,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  const overrides: Record<string, string> = {
    "account/gatewayOAuth/read": "GatewayOAuthReadResponse",
    "account/gatewayOAuth/login": "GatewayOAuthLoginResponse",
    "account/gatewayOAuth/cancel": "GatewayOAuthCancelResponse",
    "account/logout": "LogoutAccountResponse",
    "account/rateLimits/read": "GetAccountRateLimitsResponse",
    "account/usage/read": "GetAccountTokenUsageResponse",
    "account/workspaceMessages/read": "GetWorkspaceMessagesResponse",
    "config/batchWrite": "ConfigWriteResponse",
    "config/mcpServer/reload": "McpServerRefreshResponse",
    "config/value/write": "ConfigWriteResponse",
    "configRequirements/read": "ConfigRequirementsReadResponse",
    "externalAgentConfig/import/readHistories": "ExternalAgentConfigImportHistoriesReadResponse",
  };

  const override = overrides[method];
  if (override) {
    return resolveSchemaTypeName(override, generatedSchemaNames);
  }

  if (paramsType && paramsType !== "undefined") {
    const fromParams = paramsType.replace(/\s*\|\s*null/g, "").replace(/Params$/, "Response");
    try {
      return resolveSchemaTypeName(fromParams, generatedSchemaNames);
    } catch {
      // Fall through to method-based lookup.
    }
  }

  return resolveSchemaTypeName(`${toPascalCaseMethod(method)}Response`, generatedSchemaNames);
}

function renderMethodConstants(constantName: string, entries: ReadonlyArray<MethodEntry>) {
  return [
    `export const ${constantName} = {`,
    ...entries.map(
      (entry) => `  ${JSON.stringify(entry.method)}: ${JSON.stringify(entry.method)},`,
    ),
    "} as const;",
    "",
  ].join("\n");
}

function renderTypeInterface(
  interfaceName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export interface ${interfaceName} {`,
    ...entries.map((entry) => `  readonly ${JSON.stringify(entry.method)}: ${typeName(entry)};`),
    "}",
    "",
  ].join("\n");
}

function renderSchemaMap(
  constantName: string,
  entries: ReadonlyArray<MethodEntry>,
  schemaExpression: (entry: MethodEntry) => string,
) {
  return [
    `export const ${constantName} = {`,
    ...entries.map((entry) => {
      return `  ${JSON.stringify(entry.method)}: ${schemaExpression(entry)},`;
    }),
    "} as const;",
    "",
  ].join("\n");
}

function renderSchemaTypeReference(schemaName: string) {
  return schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`;
}

function exportNameForPath(filePath: string): string {
  const relative = filePath.replace(/\.json$/, "");
  if (!relative.includes("/")) {
    return relative;
  }

  const [namespace, name] = relative.split("/", 2) as [string, string];
  const namespacePrefix = namespace
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
  return `${namespacePrefix}${name}`;
}

function buildJsonSchemaFiles(rootPath: string): ReadonlyArray<JsonSchemaFile> {
  return readdirSync(rootPath, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.startsWith("codex_app_server_protocol."),
    )
    .map((entry) => {
      const sourcePath = join(entry.parentPath, entry.name);
      const relativePath = relative(rootPath, sourcePath).split("\\").join("/");
      const parts = relativePath.split("/");
      if (parts.length > 1) {
        return {
          namespace: parts[0]!,
          exportName: exportNameForPath(relativePath),
          fileName: entry.name,
          sourcePath,
          qualifiedName: relativePath.replace(/\.json$/, ""),
        } satisfies JsonSchemaFile;
      }
      return {
        exportName: exportNameForPath(relativePath),
        fileName: entry.name,
        sourcePath,
        qualifiedName: relativePath.replace(/\.json$/, ""),
      } satisfies JsonSchemaFile;
    });
}

function rewriteExternalRefs(
  value: Schema.Json,
  localDefinitionNames: ReadonlyMap<string, string>,
  currentNamespace: string | undefined,
  exportNameByQualifiedName: ReadonlyMap<string, string>,
): Schema.Json {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      rewriteExternalRefs(entry, localDefinitionNames, currentNamespace, exportNameByQualifiedName),
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/definitions/")) {
        const definitionName = child.slice("#/definitions/".length);
        const localRewrite = localDefinitionNames.get(definitionName);
        if (localRewrite) {
          return [key, `#/definitions/${localRewrite}`];
        }

        const candidates = [
          ...(currentNamespace ? [`${currentNamespace}/${definitionName}`] : []),
          definitionName,
          definitionName.replace(/^v[12]\//, ""),
          definitionName.replace(/^serde_json\//, ""),
          `v2/${definitionName}`,
          `v1/${definitionName}`,
          `serde_json/${definitionName}`,
        ];

        const rewritten = candidates
          .map((candidate) => exportNameByQualifiedName.get(candidate))
          .find((candidate) => candidate !== undefined);

        if (!rewritten) {
          throw new Error(`Missing rewritten definition for ref: ${child}`);
        }

        return [key, `#/definitions/${rewritten}`];
      }

      return [
        key,
        rewriteExternalRefs(
          child,
          localDefinitionNames,
          currentNamespace,
          exportNameByQualifiedName,
        ),
      ];
    }),
  ) as Schema.Json;
}

const generateFiles = Effect.fn("generateFiles")(function* () {
  yield* ensureGeneratedDir();

  const jsonSchemaFiles = buildJsonSchemaFiles(jsonSchemaInputPath).toSorted((left, right) =>
    left.exportName.localeCompare(right.exportName),
  );

  const exportNameByQualifiedName = new Map(
    jsonSchemaFiles.map((file) => [file.qualifiedName, file.exportName]),
  );
  const aggregateSchemas: Record<string, Schema.Json> = {};

  for (const file of jsonSchemaFiles) {
    const raw = yield* readText(file.sourcePath);
    const parsed = yield* decodeJsonSchemaDocument(raw);
    const localDefinitionNames = new Map(
      Object.keys(parsed.definitions ?? {}).map((definitionName) => [
        definitionName,
        `${file.exportName}__${definitionName.replace(/[^A-Za-z0-9]/g, "")}`,
      ]),
    );

    for (const [definitionName, definitionSchema] of Object.entries(parsed.definitions ?? {})) {
      aggregateSchemas[localDefinitionNames.get(definitionName)!] = distributeObjectUnions(
        stripNullDefaults(
          normalizeNullableTypes(
            rewriteExternalRefs(
              definitionSchema,
              localDefinitionNames,
              file.namespace,
              exportNameByQualifiedName,
            ),
          ),
        ),
      ) as Schema.Json;
    }

    const topLevelSchema: Record<string, Schema.Json> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== "definitions") {
        topLevelSchema[key] = value;
      }
    }

    aggregateSchemas[file.exportName] = distributeObjectUnions(
      stripNullDefaults(
        normalizeNullableTypes(
          rewriteExternalRefs(
            topLevelSchema,
            localDefinitionNames,
            file.namespace,
            exportNameByQualifiedName,
          ),
        ),
      ),
    ) as Schema.Json;
  }

  for (const [name, schema] of Object.entries(ManualSchemas)) {
    if (!(name in aggregateSchemas)) {
      aggregateSchemas[name] = stripNullDefaults(normalizeNullableTypes(schema));
    }
  }

  const generator = makeJsonSchemaGenerator();
  for (const [name, schema] of Object.entries(aggregateSchemas).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    generator.addSchema(name, schema as never);
  }

  const generatedEntries = new Map<string, string>();
  const output = generator.generate("openapi-3.1", aggregateSchemas as never, false).trim();
  if (output.length > 0) {
    for (const entry of collectSchemaEntries(output)) {
      if (!generatedEntries.has(entry.name)) {
        generatedEntries.set(entry.name, entry.code);
      }
    }
  }

  const generatedSchemaNames = new Set(generatedEntries.keys());
  const clientRequestRaw = yield* readText(join(typescriptInputPath, "ClientRequest.ts"));
  const clientNotificationRaw = yield* readText(join(typescriptInputPath, "ClientNotification.ts"));
  const serverRequestRaw = yield* readText(join(typescriptInputPath, "ServerRequest.ts"));
  const serverNotificationRaw = yield* readText(join(typescriptInputPath, "ServerNotification.ts"));

  const clientRequestEntries = parseCodexRequestEntries(clientRequestRaw);
  const clientNotificationEntries = parseCodexNotificationEntries(clientNotificationRaw);
  const serverRequestEntries = parseCodexRequestEntries(serverRequestRaw);
  const serverNotificationEntries = parseCodexNotificationEntries(serverNotificationRaw);

  const prelude = ["// Generated from the staged Nodex Codex runtime. Do not edit manually.", ""];

  const schemaOutput = [
    ...prelude,
    'import * as Schema from "effect/Schema";',
    "",
    [...generatedEntries.values()].join("\n\n"),
    "",
  ].join("\n");

  const metaOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    'import * as Schema from "effect/Schema";',
    "",
    renderMethodConstants("CLIENT_REQUEST_METHODS", clientRequestEntries),
    renderMethodConstants("CLIENT_NOTIFICATION_METHODS", clientNotificationEntries),
    renderMethodConstants("SERVER_REQUEST_METHODS", serverRequestEntries),
    renderMethodConstants("SERVER_NOTIFICATION_METHODS", serverNotificationEntries),
    "export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;",
    "export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;",
    "export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;",
    "export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;",
    "",
    renderTypeInterface("ClientRequestParamsByMethod", clientRequestEntries, (entry) =>
      renderResolvedType(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderTypeInterface("ClientRequestResponsesByMethod", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ClientNotificationParamsByMethod", clientNotificationEntries, (entry) =>
      renderResolvedType(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderTypeInterface("ServerRequestParamsByMethod", serverRequestEntries, (entry) =>
      renderResolvedType(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderTypeInterface("ServerRequestResponsesByMethod", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerNotificationParamsByMethod", serverNotificationEntries, (entry) =>
      renderResolvedType(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_REQUEST_PARAMS", clientRequestEntries, (entry) =>
      renderResolvedSchema(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap(
      "CLIENT_REQUEST_RESPONSES",
      clientRequestEntries,
      (entry) =>
        `CodexSchema.${resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames)}`,
    ),
    renderSchemaMap("CLIENT_NOTIFICATION_PARAMS", clientNotificationEntries, (entry) =>
      renderResolvedSchema(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_PARAMS", serverRequestEntries, (entry) =>
      renderResolvedSchema(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap(
      "SERVER_REQUEST_RESPONSES",
      serverRequestEntries,
      (entry) =>
        `CodexSchema.${resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames)}`,
    ),
    renderSchemaMap("SERVER_NOTIFICATION_PARAMS", serverNotificationEntries, (entry) =>
      renderResolvedSchema(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
  ].join("\n");

  const namespaceGroups = new Map<string, Array<JsonSchemaFile>>();
  for (const file of jsonSchemaFiles) {
    if (!file.namespace) {
      continue;
    }
    const current = namespaceGroups.get(file.namespace) ?? [];
    current.push(file);
    namespaceGroups.set(file.namespace, current);
  }

  const namespacesOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    ...[...namespaceGroups.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([namespace, files]) => {
        const constantName = namespace.replace(/[^A-Za-z0-9]/g, "");
        return [
          `export const ${constantName} = {`,
          ...files
            .toSorted((left, right) => left.fileName.localeCompare(right.fileName))
            .map(
              (file) =>
                `  ${JSON.stringify(file.fileName.replace(/\.json$/, ""))}: CodexSchema.${file.exportName},`,
            ),
          "} as const;",
          "",
        ].join("\n");
      }),
  ].join("\n");

  const fs = yield* FileSystem.FileSystem;
  const { generatedDir, metaOutputPath, namespacesOutputPath, schemaOutputPath } =
    yield* getGeneratedPaths();
  yield* fs.writeFileString(schemaOutputPath, schemaOutput);
  yield* fs.writeFileString(metaOutputPath, metaOutput);
  yield* fs.writeFileString(namespacesOutputPath, namespacesOutput);

  yield* Effect.log("Generated Effect Codex App Server schemas from the staged runtime");

  yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.flatMap((spawner) =>
      spawner.spawn(ChildProcess.make("vp", ["fmt", generatedDir, "--write"])),
    ),
    Effect.flatMap((child) => child.exitCode),
    Effect.tap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new GeneratorError({
              detail: `vp fmt failed with exit code ${code}`,
            }),
          ),
    ),
  );
});

generateFiles().pipe(
  Effect.scoped,
  // This file is a standalone schema-generator entry point; its root layer owns all resources.
  // oxlint-disable-next-line effecttsgo/strict-effect-provide
  Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
  NodeRuntime.runMain,
);
