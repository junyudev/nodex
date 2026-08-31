import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ExternalAgentConfigImportCompletedNotification } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigImportCompletedNotification";
import type { ExternalAgentConfigMigrationItem } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigMigrationItem";
import type { ExternalAgentConfigMigrationItemType } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigMigrationItemType";
import type { ThreadForkResponse } from "@nodex/codex-app-server-protocol/v2/ThreadForkResponse";
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
import { resolveCodexCanonicalHydratedCwd } from "../../shared/codex-conversation-state/codex-conversation-state";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexExternalAgentImportRuntime } from "../codex-application/CodexExternalAgentImportRuntime";
import { CodexSidebarSyncRuntime } from "../codex-application/CodexSidebarSyncRuntime";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { ThreadCreationRuntime } from "../codex-application/ThreadCreationRuntime";
import { CodexThreadTitlePersistence } from "../codex-application/CodexThreadTitlePersistence";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { getLogger } from "../logging/logger";
import { buildCodexThreadConfigOverrides } from "./codex-thread-capabilities";

const SCAN_TTL_MS = 10 * 60 * 1_000;
const SESSION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SESSION_FILES = 50;
const MAX_SESSION_DISCOVERY_FILES = 5_000;
const SESSION_HEADER_READ_BYTES = 256 * 1_024;

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
  sessions: "Recent conversations",
  settings: "Safe settings",
  skills: "Skills",
  subagents: "Subagents",
};

const CLAUDE_ITEM_DESCRIPTIONS: Record<AgentImportItemKind, string> = {
  commands: "Convert missing Claude Code commands into Nodex agent skills.",
  hooks: "Import hooks only where Nodex has no conflicting hook setup.",
  instructions: "Import Claude instructions without replacing existing Nodex instructions.",
  memory: "Import detected memory entries without replacing existing Nodex memory.",
  mcpServers: "Import missing MCP server definitions. Connections may require reauthorization.",
  plugins: "Import selected local and marketplace plugins.",
  sessions: "Convert recent Claude Code conversations into Nodex-owned thread history.",
  settings: "Translate supported, missing Claude Code settings into native agent configuration.",
  skills: "Import missing skills without replacing existing Nodex skills.",
  subagents: "Import missing subagent definitions without replacing existing definitions.",
};

const DEFAULT_SELECTED_KINDS = new Set<AgentImportItemKind>(["instructions", "sessions", "skills"]);

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

export interface NativeSessionCandidate {
  readonly sourcePath: string;
  readonly sourceContentSha256: string;
  readonly sourceThreadId: string;
  readonly cwd: string;
  readonly title: string | null;
}

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
  | { readonly type: "claude"; readonly migrationItem: ExternalAgentConfigMigrationItem }
  | { readonly type: "sessions"; readonly sessions: readonly NativeSessionCandidate[] }
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

interface SessionImportLedgerEntry {
  readonly sourceKind: AgentImportSourceKind;
  readonly sourcePath: string;
  readonly sourceContentSha256: string;
  readonly targetThreadId: string;
  readonly importedAt: number;
}

interface SessionImportLedger {
  readonly version: 1;
  readonly sessions: readonly SessionImportLedgerEntry[];
}

interface NativeScanResult {
  readonly items: readonly PendingImportItem[];
  readonly skippedAlreadyImportedSessions: number;
}

export interface AgentImportFileConfiguration {
  readonly runtimeStateHome: string;
  readonly sourceHomes?: Partial<Record<AgentImportSourceKind, string>>;
}

interface AgentImportEffectServices {
  readonly capabilities: CodexAppServerCapabilities["Service"];
  readonly events: CodexApplicationEventHub["Service"];
  readonly externalImport: CodexExternalAgentImportRuntime["Service"];
  readonly gateway: CodexGateway["Service"];
  readonly sidebarSync: CodexSidebarSyncRuntime["Service"];
  readonly threadDirectory: CodexThreadDirectory["Service"];
  readonly threadStarts: ThreadCreationRuntime["Service"];
  readonly threadTitles: CodexThreadTitlePersistence["Service"];
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

function isAgentImportSourceKind(value: unknown): value is AgentImportSourceKind {
  return value === "claude-code" || value === "codex";
}

function mapExternalItemKind(itemType: ExternalAgentConfigMigrationItemType): AgentImportItemKind {
  const kinds: Record<ExternalAgentConfigMigrationItemType, AgentImportItemKind> = {
    AGENTS_MD: "instructions",
    COMMANDS: "commands",
    CONFIG: "settings",
    HOOKS: "hooks",
    MCP_SERVER_CONFIG: "mcpServers",
    MEMORY: "memory",
    PLUGINS: "plugins",
    SESSIONS: "sessions",
    SKILLS: "skills",
    SUBAGENTS: "subagents",
  };
  return kinds[itemType];
}

function migrationItemCount(item: ExternalAgentConfigMigrationItem): number {
  if (!item.details) return 1;
  const kind = mapExternalItemKind(item.itemType);
  const collections: Partial<Record<AgentImportItemKind, readonly unknown[]>> = {
    commands: item.details.commands,
    hooks: item.details.hooks,
    memory: item.details.memory,
    mcpServers: item.details.mcpServers,
    plugins: item.details.plugins,
    sessions: item.details.sessions,
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

function defaultSourceHome(sourceKind: AgentImportSourceKind): string {
  if (sourceKind === "claude-code") return path.join(homedir(), ".claude");
  const configured = process.env.CODEX_HOME?.trim();
  return path.resolve(configured || path.join(homedir(), ".codex"));
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

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseSessionHeader(raw: string): {
  readonly sourceThreadId: string;
  readonly cwd: string;
} | null {
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
      continue;
    }
    const sourceThreadId = typeof parsed.payload.id === "string" ? parsed.payload.id.trim() : "";
    const cwd = typeof parsed.payload.cwd === "string" ? parsed.payload.cwd.trim() : "";
    if (!sourceThreadId || !path.isAbsolute(cwd)) return null;
    return { cwd: path.resolve(cwd), sourceThreadId };
  }
  return null;
}

async function readSessionIndex(home: string): Promise<Map<string, string>> {
  const indexPath = path.join(home, "session_index.jsonl");
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }

  const titles = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (!isRecord(entry) || typeof entry.id !== "string") continue;
      const title =
        typeof entry.thread_name === "string"
          ? entry.thread_name.trim()
          : typeof entry.name === "string"
            ? entry.name.trim()
            : "";
      if (title) titles.set(entry.id, title);
    } catch {
      continue;
    }
  }
  return titles;
}

async function collectRecentJsonlFiles(root: string, cutoff: number): Promise<string[]> {
  if (!existsSync(root)) return [];
  const discovered: Array<{ filePath: string; modifiedAt: number }> = [];
  const pending = [root];
  let visited = 0;

  while (pending.length > 0 && visited < MAX_SESSION_DISCOVERY_FILES) {
    const current = pending.pop();
    if (!current) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SESSION_DISCOVERY_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== ".jsonl") continue;
      const metadata = await stat(entryPath);
      if (metadata.mtimeMs < cutoff) continue;
      discovered.push({ filePath: entryPath, modifiedAt: metadata.mtimeMs });
    }
  }

  return discovered
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, MAX_SESSION_FILES)
    .map(({ filePath }) => filePath);
}

function sessionLedgerPath(runtimeStateHome: string): string {
  return path.join(runtimeStateHome, "imports", "session-imports-v1.json");
}

function parseSessionLedger(value: unknown): SessionImportLedger {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) {
    return { version: 1, sessions: [] };
  }
  const sessions = value.sessions.flatMap((entry): SessionImportLedgerEntry[] => {
    if (!isRecord(entry)) return [];
    if (!isAgentImportSourceKind(entry.sourceKind)) return [];
    if (
      typeof entry.sourcePath !== "string" ||
      typeof entry.sourceContentSha256 !== "string" ||
      typeof entry.targetThreadId !== "string" ||
      typeof entry.importedAt !== "number"
    ) {
      return [];
    }
    return [
      {
        importedAt: entry.importedAt,
        sourceContentSha256: entry.sourceContentSha256,
        sourceKind: entry.sourceKind,
        sourcePath: entry.sourcePath,
        targetThreadId: entry.targetThreadId,
      },
    ];
  });
  return { version: 1, sessions };
}

async function readSessionLedger(runtimeStateHome: string): Promise<SessionImportLedger> {
  try {
    return parseSessionLedger(
      JSON.parse(await readFile(sessionLedgerPath(runtimeStateHome), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, sessions: [] };
    }
    throw error;
  }
}

async function writeSessionLedger(
  runtimeStateHome: string,
  entries: readonly SessionImportLedgerEntry[],
): Promise<void> {
  const targetPath = sessionLedgerPath(runtimeStateHome);
  const targetDirectory = path.dirname(targetPath);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(targetDirectory, `.session-imports-${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, sessions: entries }, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function hasImportedSession(
  ledger: SessionImportLedger,
  sourceKind: AgentImportSourceKind,
  session: NativeSessionCandidate,
): boolean {
  return ledger.sessions.some(
    (entry) =>
      entry.sourceKind === sourceKind &&
      entry.sourcePath === session.sourcePath &&
      entry.sourceContentSha256 === session.sourceContentSha256,
  );
}

async function discoverSessions(input: {
  readonly sourceHome: string;
  readonly sourceKind: AgentImportSourceKind;
  readonly runtimeStateHome: string;
  readonly now: number;
}): Promise<{ sessions: NativeSessionCandidate[]; skipped: number }> {
  const [ledger, titles] = await Promise.all([
    readSessionLedger(input.runtimeStateHome),
    readSessionIndex(input.sourceHome),
  ]);
  const roots = [
    path.join(input.sourceHome, "sessions"),
    path.join(input.sourceHome, "archived_sessions"),
  ];
  const discovered = (
    await Promise.all(
      roots.map((root) => collectRecentJsonlFiles(root, input.now - SESSION_LOOKBACK_MS)),
    )
  )
    .flat()
    .slice(0, MAX_SESSION_FILES);
  const sessions: NativeSessionCandidate[] = [];
  let skipped = 0;

  for (const sourcePath of discovered) {
    const canonicalSourcePath = await realpath(sourcePath);
    const header = parseSessionHeader(
      await readFilePrefix(canonicalSourcePath, SESSION_HEADER_READ_BYTES),
    );
    if (!header) continue;
    const session: NativeSessionCandidate = {
      cwd: header.cwd,
      sourceContentSha256: await hashFile(canonicalSourcePath),
      sourcePath: canonicalSourcePath,
      sourceThreadId: header.sourceThreadId,
      title: titles.get(header.sourceThreadId) ?? null,
    };
    if (hasImportedSession(ledger, input.sourceKind, session)) {
      skipped += 1;
      continue;
    }
    sessions.push(session);
  }
  return { sessions, skipped };
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
  runtimeStateHome: string,
  edits: readonly ConfigEditCandidate[],
): Promise<{
  readonly edits: readonly ConfigEditCandidate[];
  readonly successCount: number;
  readonly skippedCount: number;
}> {
  const targetConfig = await readTomlRecord(path.join(runtimeStateHome, "config.toml"));
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
  readonly sourceKind: "codex";
  readonly runtimeStateHome: string;
  readonly now: number;
}): Promise<NativeScanResult> {
  const targetSkillsHome = path.join(path.dirname(input.runtimeStateHome), ".agents", "skills");
  const sourceSkillsHomes = [
    path.join(input.sourceHome, "skills"),
    path.join(path.dirname(input.sourceHome), ".agents", "skills"),
  ];
  const [sessions, sourceConfig, targetConfig, skills, subagents, instructions, hooks] =
    await Promise.all([
      discoverSessions(input),
      readTomlRecord(path.join(input.sourceHome, "config.toml")),
      readTomlRecord(path.join(input.runtimeStateHome, "config.toml")),
      listMissingDirectoryCopies(sourceSkillsHomes, targetSkillsHome),
      listMissingDirectoryCopies(
        [path.join(input.sourceHome, "agents")],
        path.join(input.runtimeStateHome, "agents"),
      ),
      buildSingleFileCopy(
        path.join(input.sourceHome, "AGENTS.md"),
        path.join(input.runtimeStateHome, "AGENTS.md"),
        "AGENTS.md",
      ),
      buildSingleFileCopy(
        path.join(input.sourceHome, "hooks.json"),
        path.join(input.runtimeStateHome, "hooks.json"),
        "hooks.json",
      ),
    ]);
  const safeConfigEdits = buildSafeConfigEdits(sourceConfig, targetConfig);
  const mcpConfigEdits = buildMcpConfigEdits(sourceConfig, targetConfig);
  const items: PendingImportItem[] = [];

  if (sessions.sessions.length > 0) {
    items.push(
      createPendingItem({
        count: sessions.sessions.length,
        description: `Copy ${sessions.sessions.length} recent conversation${sessions.sessions.length === 1 ? "" : "s"} into Nodex-owned history.`,
        kind: "sessions",
        label: ITEM_LABELS.sessions,
        payload: { sessions: sessions.sessions, type: "sessions" },
      }),
    );
  }
  if (instructions.length > 0) {
    items.push(
      createPendingItem({
        count: instructions.length,
        description: "Import AGENTS.md only when Nodex does not already own one.",
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
        description: `Import ${skills.length} missing skill${skills.length === 1 ? "" : "s"} without replacing existing skills.`,
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
        description: "Import model-independent preferences that are absent from the Nodex config.",
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
          "Import missing MCP server definitions. Credentials and OAuth state are never copied.",
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
        description: "Import missing subagent definitions without replacing local definitions.",
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
        description: "Import hooks only when Nodex does not already own a hooks file.",
        kind: "hooks",
        label: ITEM_LABELS.hooks,
        payload: { copies: hooks, type: "copies" },
      }),
    );
  }

  return { items, skippedAlreadyImportedSessions: sessions.skipped };
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
  private readonly runtimeStateHome: string;
  private readonly services: AgentImportEffectServices;
  private readonly resolveSourceHome: (sourceKind: AgentImportSourceKind) => string;
  private readonly logger = getLogger({ component: "agent-import" });

  constructor(options: AgentImportFileConfiguration, services: AgentImportEffectServices) {
    this.runtimeStateHome = path.resolve(options.runtimeStateHome);
    this.services = services;
    this.resolveSourceHome = (sourceKind) =>
      options.sourceHomes?.[sourceKind] ?? defaultSourceHome(sourceKind);
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
    const targetHome = await canonicalizeDirectoryIfPresent(this.runtimeStateHome);
    if (sourceHome === targetHome) {
      throw new Error("The selected source is already Nodex's writable agent home");
    }

    let items: readonly PendingImportItem[];
    let skippedAlreadyImportedSessions = 0;
    if (sourceKind === "claude-code") {
      const nativeMigrations = claudeMigrations.filter(
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
      const result = await scanNativeHome({
        now,
        runtimeStateHome: targetHome,
        sourceHome,
        sourceKind,
      });
      items = result.items;
      skippedAlreadyImportedSessions = result.skippedAlreadyImportedSessions;
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
      skippedAlreadyImportedSessions,
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
          if (!item) throw new Error("The selected import item does not belong to this scan");
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
      if (result.importedThreadIds.length > 0) {
        yield* this.services.sidebarSync.sync({ policy: "force", reason: "host-message" });
      }
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
                  activeItemLabel: activeItem?.label ?? "Importing Claude Code data",
                  completed: false,
                  completedItems: Math.min(completedTypes.size, claudeItems.length),
                  importId,
                  sourceKind: "claude-code",
                  totalItems: selectedItems.length,
                });
              }),
            )
          : { importId, itemTypeResults: [] };
      const importedThreadIds = completed.itemTypeResults.flatMap((result) =>
        result.itemType === "SESSIONS"
          ? result.successes.flatMap((success) => (success.target ? [success.target] : []))
          : [],
      );
      yield* Effect.forEach(
        importedThreadIds,
        (threadId) =>
          this.services.threadDirectory
            .resolve({
              threadId,
              fidelity: "metadata",
              hostId: this.services.gateway.localHostId,
            })
            .pipe(
              Effect.flatMap((entry) =>
                entry
                  ? Effect.void
                  : Effect.fail(
                      operationError(
                        "apply",
                        new Error("Imported Thread was not found: " + threadId),
                      ),
                    ),
              ),
              Effect.catch((cause) =>
                Effect.sync(() => {
                  this.logger.warn("Could not materialize an imported Claude Code Thread", {
                    threadId,
                    error: cause,
                  });
                }),
              ),
            ),
        { concurrency: 1, discard: true },
      );

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
        nativeOutcomes.push(
          yield* this.applyNativeItem("claude-code", item, importedThreadIds, startedAt),
        );
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
        importedThreadIds,
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
      const importedThreadIds: string[] = [];
      for (const [index, item] of selectedItems.entries()) {
        this.emitProgress({
          activeItemLabel: item.label,
          completed: false,
          completedItems: index,
          importId,
          sourceKind: pendingScan.scan.sourceKind,
          totalItems: selectedItems.length,
        });
        outcomes.push(
          yield* this.applyNativeItem(
            pendingScan.scan.sourceKind,
            item,
            importedThreadIds,
            startedAt,
          ),
        );
      }
      const result: AgentImportResult = {
        completedAt: startedAt,
        importId,
        importedThreadIds,
        outcomes,
        sourceKind: pendingScan.scan.sourceKind,
        sourceLabel: pendingScan.scan.sourceLabel,
        startedAt,
      };
      this.emitCompletedProgress(result, selectedItems.length);
      return result;
    });
  }

  private applyNativeItem(
    sourceKind: AgentImportSourceKind,
    item: PendingImportItem,
    importedThreadIds: string[],
    startedAt: number,
  ): Effect.Effect<AgentImportItemOutcome> {
    if (item.payload.type === "sessions") {
      return this.importSessions(
        sourceKind,
        item,
        item.payload.sessions,
        importedThreadIds,
        startedAt,
      );
    }
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
          revalidateConfigEdits(this.runtimeStateHome, edits),
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

  private importSessions(
    sourceKind: AgentImportSourceKind,
    item: PendingImportItem,
    sessions: readonly NativeSessionCandidate[],
    importedThreadIds: string[],
    startedAt: number,
  ): Effect.Effect<AgentImportItemOutcome> {
    return Effect.gen({ self: this }, function* () {
      const ledger = yield* Effect.tryPromise(() => readSessionLedger(this.runtimeStateHome));
      const nextEntries = [...ledger.sessions];
      const messages: string[] = [];
      let successCount = 0;
      let skippedCount = 0;

      for (const session of sessions) {
        yield* Effect.gen({ self: this }, function* () {
          if (hasImportedSession({ version: 1, sessions: nextEntries }, sourceKind, session)) {
            skippedCount += 1;
            return;
          }
          const currentHash = yield* Effect.tryPromise(() => hashFile(session.sourcePath));
          if (currentHash !== session.sourceContentSha256) {
            return yield* Effect.fail(
              operationError(
                "apply",
                new Error(
                  (session.title ?? session.sourceThreadId) + ": source changed after scanning",
                ),
              ),
            );
          }
          const targetThreadId = yield* this.importSession(session);
          importedThreadIds.push(targetThreadId);
          nextEntries.push({
            importedAt: startedAt,
            sourceContentSha256: session.sourceContentSha256,
            sourceKind,
            sourcePath: session.sourcePath,
            targetThreadId,
          });
          successCount += 1;
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              messages.push(this.errorMessage(cause));
            }),
          ),
        );
      }
      if (successCount > 0) {
        yield* Effect.tryPromise(() => writeSessionLedger(this.runtimeStateHome, nextEntries)).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              messages.push(this.errorMessage(cause));
            }),
          ),
        );
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
    }).pipe(Effect.catch((cause) => Effect.succeed(this.failedItemOutcome(item, cause))));
  }

  private importSession(session: NativeSessionCandidate) {
    return Effect.gen({ self: this }, function* () {
      const capability = yield* this.services.capabilities.forHost(
        this.services.gateway.localHostId,
      );
      if (!capability.flags.paginatedHistory) {
        return yield* Effect.fail(
          operationError(
            "apply",
            new Error("Native session import requires bounded paginated history support"),
          ),
        );
      }

      let createdThreadId: string | null = null;
      const cwd = existsSync(session.cwd) ? session.cwd : homedir();
      const operation = Effect.gen({ self: this }, function* () {
        const response = (yield* this.services.gateway.requestLocal(
          "thread/fork",
          {
            cwd,
            excludeTurns: true,
            path: session.sourcePath,
            threadId: session.sourceThreadId,
            threadSource: "user",
            config:
              buildCodexThreadConfigOverrides() as ClientRequestParamsByMethod["thread/fork"]["config"],
          },
          codexGatewayGenerationFence(capability),
        )) as unknown as ThreadForkResponse;
        const threadId = response.thread.id.trim();
        if (!threadId) {
          return yield* Effect.fail(
            operationError("apply", new Error("Imported rollout did not return a Thread id")),
          );
        }
        createdThreadId = threadId;
        if (response.thread.historyMode !== "paginated" || response.thread.turns.length !== 0) {
          return yield* Effect.fail(
            operationError(
              "apply",
              new Error("Imported rollout violated the metadata-only paginated history contract"),
            ),
          );
        }
        const effectiveCwd =
          resolveCodexCanonicalHydratedCwd({
            fallbackCwd: cwd,
            requestedCwd: cwd,
            responseCwd: response.cwd,
            threadCwd: response.thread.cwd,
          }) ?? cwd;
        yield* this.services.threadDirectory.acceptImportResult({
          response: {
            ...response,
            thread: { ...response.thread, cwd: effectiveCwd },
          },
          capability,
          executionHostId: this.services.gateway.localHostId,
          fallbackCwd: effectiveCwd,
        });
        if (session.title && !response.thread.name?.trim()) {
          yield* this.services.threadTitles.setRequired({
            threadId,
            name: session.title,
            normalization: "trim",
          });
        }
        return threadId;
      });
      return yield* this.services.threadStarts
        .materialize(capability.hostId, capability.generation, operation, (threadId) => threadId)
        .pipe(
          Effect.onError(() =>
            createdThreadId
              ? this.services.gateway
                  .requestLocal(
                    "thread/delete",
                    { threadId: createdThreadId },
                    codexGatewayGenerationFence(capability),
                  )
                  .pipe(Effect.ignore)
              : Effect.void,
          ),
        );
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
  parseSessionHeader,
  parseSessionLedger,
};
