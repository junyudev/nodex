import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCodexAppServerReleaseLock,
  resolveCodexAppServerReleaseLockPath,
} from "./agent-runtime-release-lock";
import { fingerprintCodexSchemaTree } from "./codex-schema-fingerprint";
import { withPinnedCodexSchemaTool } from "./codex-schema-tool";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const protocolPackagePath = resolve(projectRoot, "packages/codex-app-server-protocol");
const schemasOutputPath = resolve(protocolPackagePath, "src");
const runtimeSchemasOutputPath = resolve(protocolPackagePath, "runtime-schemas");
const effectPackagePath = resolve(projectRoot, "packages/effect-codex-app-server");
const effectSchemasOutputPath = resolve(effectPackagePath, "src/_generated");
const effectSchemaGeneratorPath = resolve(effectPackagePath, "scripts/generate.ts");

type CodexSchemasCommand = "generate" | "verify";

type CliOptions = {
  command: CodexSchemasCommand;
};

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

type RuntimeSchemaRoot = {
  bundleFile: string;
  outputFile: string;
  rootName: string;
};

const runtimeSchemaRoots: readonly RuntimeSchemaRoot[] = [
  {
    bundleFile: "codex_app_server_protocol.schemas.json",
    outputFile: "JSONRPCMessage.schema.json",
    rootName: "JSONRPCMessage",
  },
  {
    bundleFile: "codex_app_server_protocol.schemas.json",
    outputFile: "ServerNotification.schema.json",
    rootName: "ServerNotification",
  },
  {
    bundleFile: "codex_app_server_protocol.schemas.json",
    outputFile: "ServerRequest.schema.json",
    rootName: "ServerRequest",
  },
  {
    bundleFile: "codex_app_server_protocol.schemas.json",
    outputFile: "ClientRequest.schema.json",
    rootName: "ClientRequest",
  },
  {
    bundleFile: "codex_app_server_protocol.schemas.json",
    outputFile: "CommandExecutionApprovalDecision.schema.json",
    rootName: "CommandExecutionApprovalDecision",
  },
  {
    bundleFile: "codex_app_server_protocol.schemas.json",
    outputFile: "FileChangeApprovalDecision.schema.json",
    rootName: "FileChangeApprovalDecision",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "CollabAgentState.schema.json",
    rootName: "CollabAgentState",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "CollabAgentTool.schema.json",
    rootName: "CollabAgentTool",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "CollabAgentToolCallStatus.schema.json",
    rootName: "CollabAgentToolCallStatus",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "GuardianApprovalReview.schema.json",
    rootName: "GuardianApprovalReview",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "ThreadItem.schema.json",
    rootName: "ThreadItem",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "ModeKind.schema.json",
    rootName: "ModeKind",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "ReasoningEffort.schema.json",
    rootName: "ReasoningEffort",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "ThreadActiveFlag.schema.json",
    rootName: "ThreadActiveFlag",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "ThreadGoal.schema.json",
    rootName: "ThreadGoal",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "ThreadGoalStatus.schema.json",
    rootName: "ThreadGoalStatus",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "ThreadStatus.schema.json",
    rootName: "ThreadStatus",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "ThreadTokenUsage.schema.json",
    rootName: "ThreadTokenUsage",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "TokenUsageBreakdown.schema.json",
    rootName: "TokenUsageBreakdown",
  },
  {
    bundleFile: "codex_app_server_protocol.v2.schemas.json",
    outputFile: "TurnStatus.schema.json",
    rootName: "TurnStatus",
  },
];

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function parseLocalJsonPointer(reference: string): string[] {
  if (!reference.startsWith("#/")) {
    throw new Error(`Codex schema contains unsupported non-local reference: ${reference}`);
  }

  return reference.slice(2).split("/").map(unescapeJsonPointerSegment);
}

function resolveJsonPointer(document: JsonObject, reference: string): JsonValue {
  const path = parseLocalJsonPointer(reference);
  let current: JsonValue = document;

  for (const segment of path) {
    if (!isJsonObject(current) || !(segment in current)) {
      throw new Error(`Codex schema contains unresolved reference: ${reference}`);
    }
    current = current[segment];
  }

  return current;
}

function flatDefinitionName(reference: string): string {
  return parseLocalJsonPointer(reference)
    .map((segment) => encodeURIComponent(segment))
    .join("__");
}

function rewriteSchemaNode(
  value: JsonValue,
  document: JsonObject,
  definitions: Map<string, JsonValue>,
  referenceNames: Map<string, string>,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteSchemaNode(entry, document, definitions, referenceNames));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const reference = value.$ref;
  if (typeof reference === "string") {
    let definitionName = referenceNames.get(reference);
    if (!definitionName) {
      definitionName = flatDefinitionName(reference);
      const previousReference = [...referenceNames.entries()].find(
        ([, name]) => name === definitionName,
      )?.[0];
      if (previousReference && previousReference !== reference) {
        throw new Error(
          `Codex schema references ${previousReference} and ${reference} with the same flattened name ${definitionName}.`,
        );
      }
      referenceNames.set(reference, definitionName);
      definitions.set(definitionName, {});
      const referencedValue = resolveJsonPointer(document, reference);
      definitions.set(
        definitionName,
        rewriteSchemaNode(referencedValue, document, definitions, referenceNames),
      );
    }

    const rewritten: JsonObject = {
      ...value,
      $ref: `#/definitions/${escapeJsonPointerSegment(definitionName)}`,
    };
    return Object.fromEntries(
      Object.entries(rewritten).map(([key, entry]) => [
        key,
        key === "$ref" ? entry : rewriteSchemaNode(entry, document, definitions, referenceNames),
      ]),
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      rewriteSchemaNode(entry, document, definitions, referenceNames),
    ]),
  );
}

export function extractJsonSchemaRoot(bundle: JsonObject, rootName: string): JsonObject {
  const definitionsValue = bundle.definitions;
  if (!isJsonObject(definitionsValue)) {
    throw new Error("Codex schema bundle does not contain an object-valued definitions field.");
  }

  const rootValue = definitionsValue[rootName];
  if (!isJsonObject(rootValue)) {
    throw new Error(`Codex schema bundle does not define ${rootName}.`);
  }

  const definitions = new Map<string, JsonValue>();
  const rewrittenRoot = rewriteSchemaNode(rootValue, bundle, definitions, new Map());
  if (!isJsonObject(rewrittenRoot)) {
    throw new Error(`Codex schema root ${rootName} is not an object.`);
  }

  const schemaDeclaration = bundle.$schema;
  if (typeof schemaDeclaration !== "string") {
    throw new Error("Codex schema bundle does not declare its JSON Schema dialect.");
  }

  return {
    $schema: schemaDeclaration,
    title: rootName,
    ...rewrittenRoot,
    definitions: Object.fromEntries(
      [...definitions.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

export function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

function readJsonObject(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8")) as JsonValue;
  if (!isJsonObject(value)) {
    throw new Error(`Expected ${path} to contain a JSON object.`);
  }
  return value;
}

function runCodexSchemaGenerator(
  schemaToolPath: string,
  kind: "generate-json-schema" | "generate-ts",
  outputPath: string,
): void {
  execFileSync(schemaToolPath, ["app-server", kind, "--experimental", "--out", outputPath], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function generateRuntimeSchemas(jsonSchemaPath: string, outputPath: string): void {
  mkdirSync(outputPath, { recursive: true });
  const bundles = new Map<string, JsonObject>();

  for (const root of runtimeSchemaRoots) {
    let bundle = bundles.get(root.bundleFile);
    if (!bundle) {
      bundle = readJsonObject(join(jsonSchemaPath, root.bundleFile));
      bundles.set(root.bundleFile, bundle);
    }

    const extracted = extractJsonSchemaRoot(bundle, root.rootName);
    writeFileSync(join(outputPath, root.outputFile), stableJson(extracted));
  }
}

type GeneratedArtifacts = {
  effectSchemasPath: string;
  runtimeSchemasPath: string;
  typescriptPath: string;
};

function generateArtifacts(parentPath: string, schemaToolPath: string): GeneratedArtifacts {
  const schemaSourcePath = join(parentPath, "schema-source");
  const typescriptPath = join(schemaSourcePath, "ts");
  const jsonSchemaPath = join(schemaSourcePath, "json");
  const runtimeSchemasPath = join(parentPath, "runtime-schemas");
  const effectSchemasPath = join(parentPath, "effect-schemas");

  runCodexSchemaGenerator(schemaToolPath, "generate-ts", typescriptPath);
  runCodexSchemaGenerator(schemaToolPath, "generate-json-schema", jsonSchemaPath);
  const lock = readCodexAppServerReleaseLock(resolveCodexAppServerReleaseLockPath(projectRoot));
  const fingerprint = fingerprintCodexSchemaTree(schemaSourcePath);
  if (fingerprint !== lock.protocolSchema.sha256) {
    throw new Error(
      `Codex schema fingerprint ${fingerprint} does not match release lock ${lock.protocolSchema.sha256}`,
    );
  }
  generateRuntimeSchemas(jsonSchemaPath, runtimeSchemasPath);
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      effectSchemaGeneratorPath,
      jsonSchemaPath,
      typescriptPath,
      effectSchemasPath,
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );
  rmSync(jsonSchemaPath, { recursive: true, force: true });

  return { effectSchemasPath, runtimeSchemasPath, typescriptPath };
}

type DirectoryReplacement = {
  generatedPath: string;
  targetPath: string;
};

function replaceGeneratedDirectories(
  replacements: readonly DirectoryReplacement[],
  stagingPath: string,
): void {
  const backups: Array<{ backupPath: string; targetPath: string }> = [];
  const installed: DirectoryReplacement[] = [];

  try {
    for (const [index, replacement] of replacements.entries()) {
      if (!existsSync(replacement.targetPath)) continue;
      const backupPath = join(stagingPath, `backup-${index}`);
      renameSync(replacement.targetPath, backupPath);
      backups.push({ backupPath, targetPath: replacement.targetPath });
    }

    for (const replacement of replacements) {
      renameSync(replacement.generatedPath, replacement.targetPath);
      installed.push(replacement);
    }
  } catch (error) {
    for (const replacement of installed.reverse()) {
      if (existsSync(replacement.targetPath)) {
        renameSync(replacement.targetPath, replacement.generatedPath);
      }
    }
    for (const backup of backups.reverse()) {
      if (existsSync(backup.backupPath)) {
        renameSync(backup.backupPath, backup.targetPath);
      }
    }
    throw error;
  }
}

export async function generateSchemas(): Promise<void> {
  await withPinnedCodexSchemaTool(projectRoot, (schemaToolPath) => {
    const stagingPath = mkdtempSync(join(protocolPackagePath, ".codex-schema-stage-"));
    try {
      const generated = generateArtifacts(stagingPath, schemaToolPath);
      replaceGeneratedDirectories(
        [
          { generatedPath: generated.typescriptPath, targetPath: schemasOutputPath },
          { generatedPath: generated.runtimeSchemasPath, targetPath: runtimeSchemasOutputPath },
          { generatedPath: generated.effectSchemasPath, targetPath: effectSchemasOutputPath },
        ],
        stagingPath,
      );
    } finally {
      rmSync(stagingPath, { recursive: true, force: true });
    }
  });
}

function readDirectoryFileMap(rootPath: string): Map<string, string> {
  const result = new Map<string, string>();
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of readdirSync(current)) {
      const absolutePath = join(current, entry);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      const relativePath = relative(rootPath, absolutePath);
      result.set(relativePath, readFileSync(absolutePath, "utf8"));
    }
  }

  return result;
}

function verifyDirectory(expectedPath: string, actualPath: string): void {
  const expected = readDirectoryFileMap(expectedPath);
  const actual = readDirectoryFileMap(actualPath);

  if (expected.size !== actual.size) {
    throw new Error(
      `Committed ${relative(projectRoot, expectedPath)} is out of date: expected ${expected.size} files, got ${actual.size}. Run pnpm run codex:schemas:generate.`,
    );
  }

  for (const [relativePath, expectedContent] of expected.entries()) {
    const actualContent = actual.get(relativePath);
    if (actualContent === undefined) {
      throw new Error(
        `Committed ${relative(projectRoot, expectedPath)} is missing ${relativePath}. Run pnpm run codex:schemas:generate.`,
      );
    }
    if (actualContent !== expectedContent) {
      throw new Error(
        `Committed Codex schema output differs at ${relative(projectRoot, join(expectedPath, relativePath))}. Run pnpm run codex:schemas:generate.`,
      );
    }
  }
}

export async function verifySchemas(): Promise<void> {
  await withPinnedCodexSchemaTool(projectRoot, (schemaToolPath) => {
    const tempPath = mkdtempSync(join(tmpdir(), "nodex-codex-schemas-"));
    try {
      const generated = generateArtifacts(tempPath, schemaToolPath);
      verifyDirectory(schemasOutputPath, generated.typescriptPath);
      verifyDirectory(runtimeSchemasOutputPath, generated.runtimeSchemasPath);
      verifyDirectory(effectSchemasOutputPath, generated.effectSchemasPath);
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  });
}

function parseCliOptions(argv: string[]): CliOptions {
  const args = argv.filter((value) => value !== "--");
  const command = args[0];

  if (command !== "generate" && command !== "verify") {
    throw new Error('Expected "generate" or "verify".');
  }

  if (args.length > 1) {
    throw new Error(`Unexpected extra arguments: ${args.slice(1).join(" ")}`);
  }

  return { command };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.command === "generate") {
    await generateSchemas();
    return;
  }

  await verifySchemas();
  console.log("Committed app-server protocol package matches the pinned Agent runtime.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
