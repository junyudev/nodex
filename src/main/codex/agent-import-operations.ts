import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ExternalAgentConfigImportCompletedNotification } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigImportCompletedNotification";
import type { ExternalAgentConfigMigrationItem } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigMigrationItem";
import type { ExternalAgentConfigMigrationItemType } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigMigrationItemType";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  AgentImportApplyInput,
  AgentImportItemKind,
  AgentImportItemOutcome,
  AgentImportProgress,
  AgentImportResult,
  AgentImportScan,
  AgentImportSourceKind,
} from "../../shared/agent-import";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexExternalAgentImportRuntime } from "../codex-application/CodexExternalAgentImportRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";

const SCAN_TTL_MS = 10 * 60 * 1_000;
const SOURCE_LABELS: Record<AgentImportSourceKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const ITEM_LABELS: Record<AgentImportItemKind, string> = {
  commands: "Commands",
  hooks: "Hooks",
  instructions: "Instructions",
  memory: "Memory",
  mcpServers: "MCP servers",
  plugins: "Plugins",
  settings: "Settings",
  skills: "Skills",
  subagents: "Subagents",
};

const CLAUDE_ITEM_DESCRIPTIONS: Record<AgentImportItemKind, string> = {
  commands: "Convert Claude Code commands into Codex skills, keeping existing skills.",
  hooks: "Convert Claude Code hooks when Codex has no hooks.json yet.",
  instructions: "Convert CLAUDE.md into AGENTS.md when Codex doesn't have one yet.",
  memory: "Copy Claude Code project memory that Codex doesn't have yet.",
  mcpServers:
    "Add MCP servers Codex doesn't have yet. Credentials, headers, and env values are left out; some servers may need sign-in.",
  plugins: "Install plugins enabled in Claude Code, adding their marketplaces to Codex.",
  settings: "Translate supported Claude Code settings that Codex doesn't have yet.",
  skills: "Copy Claude Code skills that Codex doesn't have yet.",
  subagents: "Convert Claude Code subagents that Codex doesn't have yet.",
};

const DEFAULT_SELECTED_KINDS = new Set<AgentImportItemKind>(["instructions", "skills"]);

const SAFE_CONFIG_KEYS = [
  "features",
  "file_opener",
  "hide_agent_reasoning",
  "history",
  "memories",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "project_doc_fallback_filenames",
  "project_doc_max_bytes",
  "show_raw_agent_reasoning",
  "tui",
  "web_search",
] as const;

interface NativeCopyCandidate {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly label: string;
}

export interface ConfigEditCandidate {
  readonly keyPath: string;
  readonly value: unknown;
  readonly label: string;
}

type PendingImportItemPayload =
  | { readonly type: "claude"; readonly migrationItem: SetupMigrationItem }
  | { readonly type: "copies"; readonly copies: readonly NativeCopyCandidate[] }
  | { readonly type: "config"; readonly edits: readonly ConfigEditCandidate[] };

export interface PendingImportItem {
  readonly id: string;
  readonly kind: AgentImportItemKind;
  readonly label: string;
  readonly description: string;
  readonly count: number;
  readonly defaultSelected: boolean;
  readonly payload: PendingImportItemPayload;
}

export interface PendingImportScan {
  readonly scan: AgentImportScan;
  readonly sourceHome: string;
  readonly itemsById: ReadonlyMap<string, PendingImportItem>;
}

export interface AgentImportFileConfiguration {
  readonly codexHome: string;
  readonly sourceHomes?: Partial<Record<AgentImportSourceKind, string>>;
}

interface AgentImportEffectServices {
  readonly events: CodexApplicationEventHub["Service"];
  readonly externalImport: CodexExternalAgentImportRuntime["Service"];
  readonly gateway: CodexGateway["Service"];
}

class AgentImportOperationError extends Data.TaggedError("AgentImportOperationError")<{
  readonly operation: "apply" | "scan";
  readonly cause: unknown;
}> {}

const operationError = (
  operation: AgentImportOperationError["operation"],
  cause: unknown,
): AgentImportOperationError =>
  cause instanceof AgentImportOperationError
    ? cause
    : new AgentImportOperationError({ operation, cause });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SetupMigrationItem = ExternalAgentConfigMigrationItem & {
  readonly itemType: Exclude<ExternalAgentConfigMigrationItemType, "SESSIONS">;
};

function isSetupMigrationItem(item: ExternalAgentConfigMigrationItem): item is SetupMigrationItem {
  return item.itemType !== "SESSIONS";
}

function mapExternalItemKind(itemType: SetupMigrationItem["itemType"]): AgentImportItemKind {
  const kinds: Record<SetupMigrationItem["itemType"], AgentImportItemKind> = {
    AGENTS_MD: "instructions",
    COMMANDS: "commands",
    CONFIG: "settings",
    HOOKS: "hooks",
    MCP_SERVER_CONFIG: "mcpServers",
    MEMORY: "memory",
    PLUGINS: "plugins",
    SKILLS: "skills",
    SUBAGENTS: "subagents",
  };
  return kinds[itemType];
}

function migrationItemCount(item: SetupMigrationItem): number {
  if (!item.details) return 1;
  const kind = mapExternalItemKind(item.itemType);
  const collections: Partial<Record<AgentImportItemKind, readonly unknown[]>> = {
    commands: item.details.commands,
    hooks: item.details.hooks,
    memory: item.details.memory,
    mcpServers: item.details.mcpServers,
    plugins: item.details.plugins,
    skills: item.details.skills,
    subagents: item.details.subagents,
  };
  return Math.max(1, collections[kind]?.length ?? 1);
}

function createPendingItem(
  input: Omit<PendingImportItem, "id" | "defaultSelected">,
): PendingImportItem {
  return {
    ...input,
    id: randomUUID(),
    defaultSelected: DEFAULT_SELECTED_KINDS.has(input.kind),
  };
}

async function canonicalizeExistingDirectory(directoryPath: string): Promise<string> {
  const resolved = path.resolve(directoryPath);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) {
    throw new Error(`Agent import source is not a directory: ${resolved}`);
  }
  return await realpath(resolved);
}

async function canonicalizeDirectoryIfPresent(directoryPath: string): Promise<string> {
  try {
    return await canonicalizeExistingDirectory(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return path.resolve(directoryPath);
    throw error;
  }
}

function toJsonCompatible(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonCompatible);
  if (!isRecord(value)) throw new Error("Unsupported value in imported config.toml");
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toJsonCompatible(entry)]),
  );
}

async function readTomlRecord(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = parseToml(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function buildSafeConfigEdits(
  sourceConfig: Record<string, unknown>,
  targetConfig: Record<string, unknown>,
): ConfigEditCandidate[] {
  return SAFE_CONFIG_KEYS.flatMap((key): ConfigEditCandidate[] => {
    if (!Object.prototype.hasOwnProperty.call(sourceConfig, key)) return [];
    if (Object.prototype.hasOwnProperty.call(targetConfig, key)) return [];
    return [{ keyPath: key, label: key, value: toJsonCompatible(sourceConfig[key]) }];
  });
}

function buildMcpConfigEdits(
  sourceConfig: Record<string, unknown>,
  targetConfig: Record<string, unknown>,
): ConfigEditCandidate[] {
  const sourceServers = isRecord(sourceConfig.mcp_servers) ? sourceConfig.mcp_servers : {};
  const targetServers = isRecord(targetConfig.mcp_servers) ? targetConfig.mcp_servers : {};
  const missingServers = Object.fromEntries(
    Object.entries(sourceServers)
      .filter(([name]) => !Object.prototype.hasOwnProperty.call(targetServers, name))
      .map(([name, server]) => [name, sanitizeMcpServerConfig(server)]),
  );
  if (Object.keys(missingServers).length === 0) return [];
  return [
    {
      keyPath: "mcp_servers",
      label: Object.keys(missingServers).join(", "),
      value: toJsonCompatible(missingServers),
    },
  ];
}

async function revalidateConfigEdits(
  codexHome: string,
  edits: readonly ConfigEditCandidate[],
): Promise<{
  readonly edits: readonly ConfigEditCandidate[];
  readonly successCount: number;
  readonly skippedCount: number;
}> {
  const targetConfig = await readTomlRecord(path.join(codexHome, "config.toml"));
  const accepted: ConfigEditCandidate[] = [];
  let successCount = 0;
  let skippedCount = 0;
  for (const edit of edits) {
    if (edit.keyPath !== "mcp_servers") {
      if (Object.prototype.hasOwnProperty.call(targetConfig, edit.keyPath)) {
        skippedCount += 1;
        continue;
      }
      accepted.push(edit);
      successCount += 1;
      continue;
    }

    const incomingServers = isRecord(edit.value) ? edit.value : {};
    const targetServers = isRecord(targetConfig.mcp_servers) ? targetConfig.mcp_servers : {};
    const missingServers = Object.fromEntries(
      Object.entries(incomingServers).filter(
        ([name]) => !Object.prototype.hasOwnProperty.call(targetServers, name),
      ),
    );
    successCount += Object.keys(missingServers).length;
    skippedCount += Object.keys(incomingServers).length - Object.keys(missingServers).length;
    if (Object.keys(missingServers).length === 0) continue;
    accepted.push({ ...edit, value: missingServers });
  }
  return { edits: accepted, skippedCount, successCount };
}

function sanitizeMcpUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/auth|credential|key|secret|token/iu.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeMcpServerConfig(value: unknown): unknown {
  if (!isRecord(value)) return toJsonCompatible(value);
  const sanitized = Object.entries(value).flatMap(([key, entry]): Array<[string, unknown]> => {
    if (/auth|credential|env|header|oauth|password|secret|token/iu.test(key)) return [];
    if (key === "url" && typeof entry === "string") return [[key, sanitizeMcpUrl(entry)]];
    if (
      key === "args" &&
      Array.isArray(entry) &&
      entry.some(
        (argument) =>
          typeof argument === "string" && /auth|credential|key|secret|token/iu.test(argument),
      )
    ) {
      return [];
    }
    return [[key, toJsonCompatible(entry)]];
  });
  return Object.fromEntries(sanitized);
}

async function listMissingDirectoryCopies(
  sourceDirectories: readonly string[],
  targetDirectory: string,
): Promise<NativeCopyCandidate[]> {
  const copiesByTarget = new Map<string, NativeCopyCandidate>();
  for (const sourceDirectory of sourceDirectories) {
    let entries;
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const targetPath = path.join(targetDirectory, entry.name);
      if (existsSync(targetPath) || copiesByTarget.has(targetPath)) continue;
      copiesByTarget.set(targetPath, {
        label: entry.name,
        sourcePath: path.join(sourceDirectory, entry.name),
        targetPath,
      });
    }
  }
  return [...copiesByTarget.values()];
}

async function buildSingleFileCopy(
  sourcePath: string,
  targetPath: string,
  label: string,
): Promise<NativeCopyCandidate[]> {
  if (existsSync(targetPath)) return [];
  try {
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) return [];
    return [{ label, sourcePath, targetPath }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function copyDirectoryTreeExclusive(source: string, target: string): Promise<void> {
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Import source must be a real directory: ${source}`);
  }
  await mkdir(target, { mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not imported: ${path.join(source, entry.name)}`);
    }
    const sourceEntry = path.join(source, entry.name);
    const targetEntry = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryTreeExclusive(sourceEntry, targetEntry);
      continue;
    }
    if (!entry.isFile()) continue;
    const metadata = await stat(sourceEntry);
    await copyFile(sourceEntry, targetEntry, fsConstants.COPYFILE_EXCL);
    await chmod(targetEntry, 0o600 | (metadata.mode & 0o100));
  }
}

async function copyImportCandidate(
  candidate: NativeCopyCandidate,
): Promise<"imported" | "skipped"> {
  if (existsSync(candidate.targetPath)) return "skipped";
  await mkdir(path.dirname(candidate.targetPath), { recursive: true, mode: 0o700 });
  const metadata = await lstat(candidate.sourcePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Symbolic links are not imported: ${candidate.sourcePath}`);
  }
  if (metadata.isDirectory()) {
    const temporaryPath = `${candidate.targetPath}.import-${randomUUID()}`;
    try {
      await copyDirectoryTreeExclusive(candidate.sourcePath, temporaryPath);
      if (existsSync(candidate.targetPath)) return "skipped";
      await rename(temporaryPath, candidate.targetPath);
      return "imported";
    } finally {
      await rm(temporaryPath, { recursive: true, force: true });
    }
  }
  if (!metadata.isFile()) throw new Error(`Import source must be a file: ${candidate.sourcePath}`);
  try {
    await copyFile(candidate.sourcePath, candidate.targetPath, fsConstants.COPYFILE_EXCL);
    await chmod(candidate.targetPath, 0o600 | (metadata.mode & 0o100));
    return "imported";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "skipped";
    throw error;
  }
}

async function scanNativeHome(input: {
  readonly sourceHome: string;
  readonly codexHome: string;
}): Promise<readonly PendingImportItem[]> {
  if (input.sourceHome === input.codexHome) return [];
  const items: PendingImportItem[] = [];
  const targetSkillsHome = path.join(path.dirname(input.codexHome), ".agents", "skills");
  const sourceSkillsHomes = [
    path.join(input.sourceHome, "skills"),
    path.join(path.dirname(input.sourceHome), ".agents", "skills"),
  ];
  const [sourceConfig, targetConfig, skills, subagents, instructions, hooks] = await Promise.all([
    readTomlRecord(path.join(input.sourceHome, "config.toml")),
    readTomlRecord(path.join(input.codexHome, "config.toml")),
    listMissingDirectoryCopies(sourceSkillsHomes, targetSkillsHome),
    listMissingDirectoryCopies(
      [path.join(input.sourceHome, "agents")],
      path.join(input.codexHome, "agents"),
    ),
    buildSingleFileCopy(
      path.join(input.sourceHome, "AGENTS.md"),
      path.join(input.codexHome, "AGENTS.md"),
      "AGENTS.md",
    ),
    buildSingleFileCopy(
      path.join(input.sourceHome, "hooks.json"),
      path.join(input.codexHome, "hooks.json"),
      "hooks.json",
    ),
  ]);
  const safeConfigEdits = buildSafeConfigEdits(sourceConfig, targetConfig);
  const mcpConfigEdits = buildMcpConfigEdits(sourceConfig, targetConfig);
  if (instructions.length > 0) {
    items.push(
      createPendingItem({
        count: instructions.length,
        description: "Copy AGENTS.md, which your Codex home doesn't have yet.",
        kind: "instructions",
        label: ITEM_LABELS.instructions,
        payload: { copies: instructions, type: "copies" },
      }),
    );
  }
  if (skills.length > 0) {
    items.push(
      createPendingItem({
        count: skills.length,
        description: "Copy skills that Codex doesn't have yet.",
        kind: "skills",
        label: ITEM_LABELS.skills,
        payload: { copies: skills, type: "copies" },
      }),
    );
  }
  if (safeConfigEdits.length > 0) {
    items.push(
      createPendingItem({
        count: safeConfigEdits.length,
        description:
          "Add preferences your Codex config doesn't have yet. Model, provider, and permission settings are not copied.",
        kind: "settings",
        label: ITEM_LABELS.settings,
        payload: { edits: safeConfigEdits, type: "config" },
      }),
    );
  }
  if (mcpConfigEdits.length > 0) {
    const serverCount = isRecord(mcpConfigEdits[0]?.value)
      ? Object.keys(mcpConfigEdits[0].value).length
      : mcpConfigEdits.length;
    items.push(
      createPendingItem({
        count: serverCount,
        description:
          "Add MCP servers Codex doesn't have yet. Credentials, headers, and env values are left out; some servers may need sign-in.",
        kind: "mcpServers",
        label: ITEM_LABELS.mcpServers,
        payload: { edits: mcpConfigEdits, type: "config" },
      }),
    );
  }
  if (subagents.length > 0) {
    items.push(
      createPendingItem({
        count: subagents.length,
        description: "Copy subagents that your Codex home doesn't have yet.",
        kind: "subagents",
        label: ITEM_LABELS.subagents,
        payload: { copies: subagents, type: "copies" },
      }),
    );
  }
  if (hooks.length > 0) {
    items.push(
      createPendingItem({
        count: hooks.length,
        description: "Copy hooks.json, which your Codex home doesn't have yet.",
        kind: "hooks",
        label: ITEM_LABELS.hooks,
        payload: { copies: hooks, type: "copies" },
      }),
    );
  }

  return items;
}

function outcomeFromExternalResult(
  item: PendingImportItem,
  result: ExternalAgentConfigImportCompletedNotification["itemTypeResults"][number] | undefined,
): AgentImportItemOutcome {
  const messages = result?.failures.map((failure) => failure.message) ?? [];
  return {
    failureCount: result?.failures.length ?? 0,
    itemId: item.id,
    kind: item.kind,
    label: item.label,
    messages,
    skippedCount: Math.max(
      0,
      item.count - (result?.successes.length ?? 0) - (result?.failures.length ?? 0),
    ),
    successCount: result?.successes.length ?? 0,
  };
}

/**
 * Effect-native import engine. AgentImportRuntime owns coordination while this
 * module owns source discovery and the complete import transaction.
 */
class AgentImportOperations {
  private readonly codexHome: string;
  private readonly services: AgentImportEffectServices;
  private readonly resolveSourceHome: (sourceKind: AgentImportSourceKind) => string;

  constructor(options: AgentImportFileConfiguration, services: AgentImportEffectServices) {
    this.codexHome = path.resolve(options.codexHome);
    this.services = services;
    this.resolveSourceHome = (sourceKind) =>
      options.sourceHomes?.[sourceKind] ??
      (sourceKind === "codex" ? this.codexHome : path.join(homedir(), ".claude"));
  }

  makeImportId(): string {
    return randomUUID();
  }

  scan(
    sourceKind: AgentImportSourceKind,
    selectedSourceHome: string | undefined,
    now: number,
  ): Effect.Effect<PendingImportScan, AgentImportOperationError> {
    return Effect.gen({ self: this }, function* () {
      const claudeMigrations =
        sourceKind === "claude-code"
          ? yield* this.services.gateway
              .requestLocal("externalAgentConfig/detect", { includeHome: true, cwds: [] })
              .pipe(
                Effect.map(
                  (response) =>
                    response.items as unknown as readonly ExternalAgentConfigMigrationItem[],
                ),
              )
          : [];
      return yield* Effect.tryPromise(() =>
        this.scanFileSystem(sourceKind, selectedSourceHome, now, claudeMigrations),
      );
    }).pipe(Effect.mapError((cause) => operationError("scan", cause)));
  }

  private async scanFileSystem(
    sourceKind: AgentImportSourceKind,
    selectedSourceHome: string | undefined,
    now: number,
    claudeMigrations: readonly ExternalAgentConfigMigrationItem[],
  ): Promise<PendingImportScan> {
    if (sourceKind === "claude-code" && selectedSourceHome) {
      throw new Error("Claude Code custom homes are not supported by this runtime");
    }
    const requestedHome = selectedSourceHome ?? this.resolveSourceHome(sourceKind);
    const sourceHome = selectedSourceHome
      ? await canonicalizeExistingDirectory(requestedHome)
      : await canonicalizeDirectoryIfPresent(requestedHome);
    const targetHome = await canonicalizeDirectoryIfPresent(this.codexHome);

    let items: readonly PendingImportItem[];
    if (sourceKind === "claude-code") {
      const nativeMigrations = claudeMigrations
        .filter(isSetupMigrationItem)
        .filter(
          (migrationItem) =>
            migrationItem.itemType !== "CONFIG" && migrationItem.itemType !== "MCP_SERVER_CONFIG",
        );
      const [settings, localSettings, targetConfig] = await Promise.all([
        readJsonRecord(path.join(sourceHome, "settings.json")),
        readJsonRecord(path.join(sourceHome, "settings.local.json")),
        readTomlRecord(path.join(targetHome, "config.toml")),
      ]);
      const effectiveSettings = { ...settings, ...localSettings };
      const mcpEdits = buildMcpConfigEdits(
        { mcp_servers: effectiveSettings.mcpServers },
        targetConfig,
      );
      const mappedMigrations = nativeMigrations.map((migrationItem) => {
        const kind = mapExternalItemKind(migrationItem.itemType);
        return createPendingItem({
          count: migrationItemCount(migrationItem),
          description: CLAUDE_ITEM_DESCRIPTIONS[kind],
          kind,
          label: ITEM_LABELS[kind],
          payload: { migrationItem, type: "claude" },
        });
      });
      items =
        mcpEdits.length === 0
          ? mappedMigrations
          : [
              ...mappedMigrations,
              createPendingItem({
                count: isRecord(mcpEdits[0]?.value) ? Object.keys(mcpEdits[0].value).length : 1,
                description: CLAUDE_ITEM_DESCRIPTIONS.mcpServers,
                kind: "mcpServers",
                label: ITEM_LABELS.mcpServers,
                payload: { edits: mcpEdits, type: "config" },
              }),
            ];
    } else {
      items = await scanNativeHome({ codexHome: targetHome, sourceHome });
    }

    const scanId = randomUUID();
    const expiresAt = now + SCAN_TTL_MS;
    const scan: AgentImportScan = {
      expiresAt,
      items: items.map(({ id, kind, label, description, count, defaultSelected }) => ({
        count,
        defaultSelected,
        description,
        id,
        kind,
        label,
      })),
      scanId,
      sourceHome,
      sourceKind,
      sourceLabel: SOURCE_LABELS[sourceKind],
    };
    return {
      itemsById: new Map(items.map((item) => [item.id, item])),
      scan,
      sourceHome,
    };
  }
  apply(
    input: AgentImportApplyInput,
    pendingScan: PendingImportScan,
    importId: string,
    startedAt: number,
  ): Effect.Effect<AgentImportResult, AgentImportOperationError> {
    const selected = Effect.try({
      try: () => {
        const selectedIds = [...new Set(input.itemIds)];
        if (selectedIds.length === 0) throw new Error("Select at least one item to import");
        return selectedIds.map((itemId) => {
          const item = pendingScan.itemsById.get(itemId);
          if (!item) throw new Error("The selection no longer matches this scan. Scan again.");
          return item;
        });
      },
      catch: (cause) => operationError("apply", cause),
    });
    return Effect.gen({ self: this }, function* () {
      const selectedItems = yield* selected;
      this.emitProgress({
        activeItemLabel: selectedItems[0]?.label ?? null,
        completed: false,
        completedItems: 0,
        importId,
        sourceKind: pendingScan.scan.sourceKind,
        totalItems: selectedItems.length,
      });
      const result =
        pendingScan.scan.sourceKind === "claude-code"
          ? yield* this.applyClaudeItems(importId, pendingScan, selectedItems, startedAt)
          : yield* this.applyNativeItems(importId, pendingScan, selectedItems, startedAt);
      return result;
    }).pipe(Effect.mapError((cause) => operationError("apply", cause)));
  }

  private applyClaudeItems(
    importId: string,
    pendingScan: PendingImportScan,
    selectedItems: readonly PendingImportItem[],
    startedAt: number,
  ) {
    return Effect.gen({ self: this }, function* () {
      const claudeItems = selectedItems.filter((item) => item.payload.type === "claude");
      const nativeItems = selectedItems.filter((item) => item.payload.type !== "claude");
      const migrationItems = claudeItems.flatMap((item) =>
        item.payload.type === "claude" ? [item.payload.migrationItem] : [],
      );
      const completed =
        migrationItems.length > 0
          ? yield* this.services.externalImport.run(migrationItems, (progress) =>
              Effect.sync(() => {
                const completedTypes = new Set(
                  progress.itemTypeResults.map((result) => result.itemType),
                );
                const activeItem = claudeItems.find(
                  (item) =>
                    item.payload.type === "claude" &&
                    !completedTypes.has(item.payload.migrationItem.itemType),
                );
                this.emitProgress({
                  activeItemLabel: activeItem?.label ?? "Importing Claude Code setup",
                  completed: false,
                  completedItems: Math.min(completedTypes.size, claudeItems.length),
                  importId,
                  sourceKind: "claude-code",
                  totalItems: selectedItems.length,
                });
              }),
            )
          : { importId, itemTypeResults: [] };
      const externalOutcomes = claudeItems.map((item) => {
        if (item.payload.type !== "claude") return outcomeFromExternalResult(item, undefined);
        const migrationItem = item.payload.migrationItem;
        return outcomeFromExternalResult(
          item,
          completed.itemTypeResults.find((result) => result.itemType === migrationItem.itemType),
        );
      });
      const nativeOutcomes: AgentImportItemOutcome[] = [];
      for (const [index, item] of nativeItems.entries()) {
        this.emitProgress({
          activeItemLabel: item.label,
          completed: false,
          completedItems: claudeItems.length + index,
          importId,
          sourceKind: "claude-code",
          totalItems: selectedItems.length,
        });
        nativeOutcomes.push(yield* this.applyNativeItem(item));
      }
      const outcomes = selectedItems.map((item) => {
        const outcome =
          externalOutcomes.find((candidate) => candidate.itemId === item.id) ??
          nativeOutcomes.find((candidate) => candidate.itemId === item.id);
        if (!outcome) throw new Error("Missing import outcome for " + item.label);
        return outcome;
      });
      const result: AgentImportResult = {
        completedAt: startedAt,
        importId,
        outcomes,
        sourceKind: "claude-code",
        sourceLabel: pendingScan.scan.sourceLabel,
        startedAt,
      };
      this.emitCompletedProgress(result, selectedItems.length);
      return result;
    });
  }

  private applyNativeItems(
    importId: string,
    pendingScan: PendingImportScan,
    selectedItems: readonly PendingImportItem[],
    startedAt: number,
  ) {
    return Effect.gen({ self: this }, function* () {
      const outcomes: AgentImportItemOutcome[] = [];
      for (const [index, item] of selectedItems.entries()) {
        this.emitProgress({
          activeItemLabel: item.label,
          completed: false,
          completedItems: index,
          importId,
          sourceKind: pendingScan.scan.sourceKind,
          totalItems: selectedItems.length,
        });
        outcomes.push(yield* this.applyNativeItem(item));
      }
      const result: AgentImportResult = {
        completedAt: startedAt,
        importId,
        outcomes,
        sourceKind: pendingScan.scan.sourceKind,
        sourceLabel: pendingScan.scan.sourceLabel,
        startedAt,
      };
      this.emitCompletedProgress(result, selectedItems.length);
      return result;
    });
  }

  private applyNativeItem(item: PendingImportItem): Effect.Effect<AgentImportItemOutcome> {
    if (item.payload.type === "copies") {
      const copies = item.payload.copies;
      return Effect.tryPromise(() => this.importCopies(item, copies)).pipe(
        Effect.catch((cause) => Effect.succeed(this.failedItemOutcome(item, cause))),
      );
    }
    if (item.payload.type === "config") {
      const edits = item.payload.edits;
      return Effect.gen({ self: this }, function* () {
        const revalidated = yield* Effect.tryPromise(() =>
          revalidateConfigEdits(this.codexHome, edits),
        );
        if (revalidated.edits.length > 0) {
          yield* this.services.gateway.requestLocal("config/batchWrite", {
            edits: revalidated.edits.map((edit) => ({
              keyPath: edit.keyPath,
              mergeStrategy: "upsert" as const,
              value:
                edit.value as ClientRequestParamsByMethod["config/batchWrite"]["edits"][number]["value"],
            })),
            reloadUserConfig: true,
          });
        }
        return {
          failureCount: 0,
          itemId: item.id,
          kind: item.kind,
          label: item.label,
          messages: [],
          skippedCount: revalidated.skippedCount,
          successCount: revalidated.successCount,
        };
      }).pipe(Effect.catch((cause) => Effect.succeed(this.failedItemOutcome(item, cause))));
    }
    return Effect.succeed({
      failureCount: item.count,
      itemId: item.id,
      kind: item.kind,
      label: item.label,
      messages: ["Unsupported native import item"],
      skippedCount: 0,
      successCount: 0,
    });
  }

  private async importCopies(
    item: PendingImportItem,
    copies: readonly NativeCopyCandidate[],
  ): Promise<AgentImportItemOutcome> {
    const messages: string[] = [];
    let successCount = 0;
    let skippedCount = 0;
    for (const copy of copies) {
      try {
        const status = await copyImportCandidate(copy);
        if (status === "imported") successCount += 1;
        else skippedCount += 1;
      } catch (error) {
        messages.push(copy.label + ": " + this.errorMessage(error));
      }
    }
    return {
      failureCount: messages.length,
      itemId: item.id,
      kind: item.kind,
      label: item.label,
      messages,
      skippedCount,
      successCount,
    };
  }

  private emitCompletedProgress(result: AgentImportResult, totalItems: number): void {
    this.emitProgress({
      activeItemLabel: null,
      completed: true,
      completedItems: totalItems,
      importId: result.importId,
      sourceKind: result.sourceKind,
      totalItems,
    });
  }

  private emitProgress(progress: AgentImportProgress): void {
    this.services.events.publish({ kind: "agentImportProgress", value: progress });
  }

  private failedItemOutcome(item: PendingImportItem, cause: unknown): AgentImportItemOutcome {
    return {
      failureCount: item.count,
      itemId: item.id,
      kind: item.kind,
      label: item.label,
      messages: [this.errorMessage(cause)],
      skippedCount: 0,
      successCount: 0,
    };
  }

  private errorMessage(cause: unknown): string {
    if (cause instanceof Error && cause.message.trim()) return cause.message;
    if (typeof cause === "object" && cause !== null && "cause" in cause && cause.cause !== cause) {
      return this.errorMessage(cause.cause);
    }
    return String(cause);
  }
}

export const makeAgentImportOperations = (
  options: AgentImportFileConfiguration,
  services: AgentImportEffectServices,
) => new AgentImportOperations(options, services);

export const agentImportInternals = {
  SAFE_CONFIG_KEYS,
  buildMcpConfigEdits,
  buildSafeConfigEdits,
};
