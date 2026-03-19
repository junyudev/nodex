import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parse as parseToml } from "smol-toml";
import type { CollaborationModeListResponse } from "@nodex/codex-app-server-protocol/v2/CollaborationModeListResponse";
import type { CommandExecutionRequestApprovalParams } from "@nodex/codex-app-server-protocol/v2/CommandExecutionRequestApprovalParams";
import type { CommandExecutionRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/CommandExecutionRequestApprovalResponse";
import type { GetAccountRateLimitsResponse } from "@nodex/codex-app-server-protocol/v2/GetAccountRateLimitsResponse";
import type { GetAccountResponse } from "@nodex/codex-app-server-protocol/v2/GetAccountResponse";
import type { LoginAccountResponse } from "@nodex/codex-app-server-protocol/v2/LoginAccountResponse";
import type { CancelLoginAccountResponse } from "@nodex/codex-app-server-protocol/v2/CancelLoginAccountResponse";
import type { FileChangeRequestApprovalParams } from "@nodex/codex-app-server-protocol/v2/FileChangeRequestApprovalParams";
import type { FileChangeRequestApprovalResponse } from "@nodex/codex-app-server-protocol/v2/FileChangeRequestApprovalResponse";
import type { ModelListResponse } from "@nodex/codex-app-server-protocol/v2/ModelListResponse";
import type { ThreadReadResponse } from "@nodex/codex-app-server-protocol/v2/ThreadReadResponse";
import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
import type { ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2/ThreadStartResponse";
import type { ThreadUnarchiveResponse } from "@nodex/codex-app-server-protocol/v2/ThreadUnarchiveResponse";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2/TurnStartParams";
import type { TurnStartResponse } from "@nodex/codex-app-server-protocol/v2/TurnStartResponse";
import type { TurnSteerParams } from "@nodex/codex-app-server-protocol/v2/TurnSteerParams";
import type { TurnSteerResponse } from "@nodex/codex-app-server-protocol/v2/TurnSteerResponse";
import type { ToolRequestUserInputParams } from "@nodex/codex-app-server-protocol/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputResponse } from "@nodex/codex-app-server-protocol/v2/ToolRequestUserInputResponse";
import type {
  CardRunInTarget,
  CodexAccountIdentity,
  CodexAccountSnapshot,
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexCollaborationModeKind,
  CodexCollaborationModePreset,
  CodexEvent,
  CodexItemView,
  CodexModelOption,
  CodexPermissionMode,
  CodexRateLimitsSnapshot,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
  CodexThreadActiveFlag,
  CodexThreadDetail,
  CodexThreadStatusType,
  CodexThreadSummary,
  CodexThreadStartProgressPhase,
  CodexThreadStartProgressStream,
  CodexThreadTokenUsage,
  CodexTokenUsageBreakdown,
  CodexTurnStartOptions,
  CodexTurnStatus,
  CodexThreadStartForCardInput,
  CodexTurnSummary,
  CodexUserInputRequest,
  ManagedWorktreeRecord,
  WorktreeEnvironmentOption,
  WorktreeStartMode,
} from "../../shared/types";
import {
  canMergeSyntheticTextDuplicate,
  isSyntheticCodexItemId,
  mergeCodexItemView,
  resolveCodexItemPrimaryIdentityKey,
  resolveCodexItemTextIdentityKey,
} from "../../shared/codex-item-identity";
import * as dbService from "../kanban/db-service";
import { getKanbanDir } from "../kanban/config";
import {
  deleteCodexThreadSnapshot,
  getCodexCardThreadLink,
  getCodexThreadSnapshot,
  listCodexThreadLinks,
  listCodexProjectThreads,
  unlinkCodexThread,
  updateCodexThreadArchived,
  updateCodexThreadName,
  updateCodexThreadStatus,
  upsertCodexCardThreadLink,
  upsertCodexThreadSnapshot,
} from "./codex-link-repository";
import {
  CodexAppServerClient,
  CodexRpcError,
  type CodexServerRequest,
  type CodexServerNotification,
} from "./codex-app-server-client";
import { hasCodexSessionMaterialized, readCodexSessionThreadDetail } from "./codex-session-store";
import { createManagedWorktree, removeManagedWorktree } from "./git-worktree-service";
import { normalizeThreadItem } from "./codex-item-normalizer";
import { resolveCodexRuntime, type ResolvedCodexRuntime } from "./codex-runtime";
import {
  listWorktreeEnvironmentOptions,
  readWorktreeEnvironmentDefinition,
} from "./worktree-environment-service";
import { getLogger } from "../logging/logger";

const codexLogger = getLogger({ subsystem: "codex", component: "service" });
const require = createRequire(import.meta.url);

interface ThreadRef {
  projectId: string;
  cardId: string;
  cwd: string | null;
}

interface PendingApproval {
  request: CodexApprovalRequest;
  resolve: (value: CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse) => void;
  reject: (reason?: unknown) => void;
}

interface PendingUserInput {
  request: CodexUserInputRequest;
  resolve: (value: { answers: Record<string, { answers: string[] }> }) => void;
  reject: (reason?: unknown) => void;
}

interface ParsedThreadStatus {
  statusType: CodexThreadStatusType;
  statusActiveFlags: CodexThreadActiveFlag[];
}

type StartTurnOverrides = CodexTurnStartOptions;

interface ResolvedThreadRunLocation {
  cwd: string;
  runInTarget: CardRunInTarget;
  createdManagedWorktree: boolean;
}

interface ThreadStartProgressUpdate {
  phase: CodexThreadStartProgressPhase;
  message: string;
  stream?: CodexThreadStartProgressStream;
  outputDelta?: string;
  clearOutput?: boolean;
}

interface CodexPermissionConfigSnapshot {
  source: "project" | "user" | "none";
  configPath: string | null;
  displayPath: string | null;
  sandboxMode: string | null;
  approvalPolicy: string | null;
  parseError: string | null;
}

type CodexApprovalPolicy = "on-request" | "never";

type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      readOnlyAccess:
        | {
            type: "restricted";
            includePlatformDefaults: boolean;
            readableRoots: string[];
          }
        | {
            type: "fullAccess";
          };
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

interface StructuredThreadTitleClient {
  startThread: (params: Record<string, unknown>) => Promise<unknown>;
  startTurn: (params: Record<string, unknown>) => Promise<unknown>;
  interruptTurn: (params: { threadId: string; turnId: string }) => Promise<unknown>;
  onNotification: (handler: (notification: { method: string; params: unknown }) => void) => () => void;
}

interface RunStructuredThreadTitleInput {
  prompt: string;
  cwd: string | null;
  model: string;
  effort: CodexReasoningEffort | null;
  schema: Record<string, unknown>;
  config: Record<string, unknown> | null;
  timeoutMs?: number;
  client: StructuredThreadTitleClient;
  parse: (raw: string | null | undefined) => string | null;
}

interface GenerateThreadTitleAdapterInput {
  prompt: string;
  cwd: string | null;
  appServerConnection: {
    startThread: (params: Record<string, unknown>) => Promise<unknown>;
    startTurn: (params: Record<string, unknown>) => Promise<unknown>;
    interruptTurn: (params: { threadId: string; turnId: string }) => Promise<unknown>;
    registerInternalNotificationHandler: (
      handler: (notification: { method: string; params: unknown }) => void,
    ) => () => void;
  };
}

type CodexServiceOptions = {
  runtime?: ResolvedCodexRuntime;
};

type DefaultCodexRuntimeOptions = {
  isPackaged: boolean;
  projectRootPath?: string;
  resourcesPath?: string;
};

const THREAD_TITLE_MIN_LENGTH = 18;
const THREAD_TITLE_MAX_LENGTH = 36;
const THREAD_TITLE_PROMPT_MAX_CHARS = 2_000;
const THREAD_TITLE_TIMEOUT_MS = 30_000;
const THREAD_TITLE_MODEL = "gpt-5.1-codex-mini";
const THREAD_TITLE_REASONING_EFFORT: CodexReasoningEffort = "low";
const THREAD_START_EXPERIMENTAL_RAW_EVENTS = false;
const THREAD_START_PERSIST_EXTENDED_HISTORY = true;
const THREAD_RESUME_PERSIST_EXTENDED_HISTORY = true;
const WORKTREE_SETUP_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const WORKTREE_LOG_STATUS_MESSAGE = "Creating a worktree and running setup.";
const THREAD_TITLE_PROMPT_PATH = path.resolve(process.cwd(), "scripts", "generate-thread-title.md");
const THREAD_TITLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: {
      type: "string",
      minLength: 18,
      maxLength: 36,
    },
  },
};

function normalizeGeneratedThreadTitle(rawTitle: string): string | null {
  let title = (rawTitle.replace(/\r\n/g, "\n").split("\n").find((line) => line.trim().length > 0) ?? "").trim();
  if (!title) return null;

  title = title.replace(/^title[:\s]+/i, "");
  title = title.replace(/^[`"'\u201c\u201d\u2018\u2019]+|[`"'\u201c\u201d\u2018\u2019]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/[.?!]+$/g, "").trim();
  if (!title) return null;
  if (title.length < THREAD_TITLE_MIN_LENGTH) return null;
  if (title.length > THREAD_TITLE_MAX_LENGTH) {
    return `${title.slice(0, THREAD_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return title;
}

function parseGeneratedThreadTitleResponse(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    const candidate = asRecord(parsed);
    if (typeof candidate?.title === "string") {
      return normalizeGeneratedThreadTitle(candidate.title);
    }
  } catch {
    return normalizeGeneratedThreadTitle(text);
  }

  return normalizeGeneratedThreadTitle(text);
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  if (value > 10_000_000_000) return Math.floor(value);
  return Math.floor(value * 1000);
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function parseTokenUsageBreakdown(value: unknown): CodexTokenUsageBreakdown | null {
  const candidate = asRecord(value);
  if (!candidate) return null;

  const totalTokens = parseFiniteNumber(candidate.totalTokens ?? candidate.total_tokens);
  const inputTokens = parseFiniteNumber(candidate.inputTokens ?? candidate.input_tokens);
  const cachedInputTokens = parseFiniteNumber(candidate.cachedInputTokens ?? candidate.cached_input_tokens);
  const outputTokens = parseFiniteNumber(candidate.outputTokens ?? candidate.output_tokens);
  const reasoningOutputTokens = parseFiniteNumber(
    candidate.reasoningOutputTokens ?? candidate.reasoning_output_tokens,
  );

  if (
    totalTokens === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null
  ) {
    return null;
  }

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

function parseThreadTokenUsage(value: unknown): CodexThreadTokenUsage | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;

  const total = parseTokenUsageBreakdown(candidate.total);
  const last = parseTokenUsageBreakdown(candidate.last);
  if (!total || !last) return undefined;

  const modelContextWindow = candidate.modelContextWindow ?? candidate.model_context_window;
  return {
    total,
    last,
    modelContextWindow: modelContextWindow === null ? null : parseFiniteNumber(modelContextWindow),
  };
}

function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;
  return homedir();
}

function resolveCodexHomeDir(): string {
  const envCodexHome = process.env.CODEX_HOME?.trim();
  if (envCodexHome) return envCodexHome;
  return path.join(resolveHomeDir(), ".codex");
}

function parseThreadStatusType(value: unknown): CodexThreadStatusType | null {
  if (value === "active" || value === "idle" || value === "systemError" || value === "notLoaded") {
    return value;
  }
  if (value === "system_error") return "systemError";
  if (value === "not_loaded") return "notLoaded";
  return null;
}

function parseThreadActiveFlags(value: unknown): CodexThreadActiveFlag[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (flag): flag is CodexThreadActiveFlag =>
      flag === "waitingOnApproval" || flag === "waitingOnUserInput",
  );
}

function parseThreadStatus(status: unknown): ParsedThreadStatus {
  const directStatus = parseThreadStatusType(status);
  if (directStatus) {
    return {
      statusType: directStatus,
      statusActiveFlags: [],
    };
  }

  if (typeof status !== "object" || status === null) {
    return { statusType: "notLoaded", statusActiveFlags: [] };
  }

  const candidate = status as {
    type?: unknown;
    status?: unknown;
    isActive?: unknown;
    activeFlags?: unknown;
    active_flags?: unknown;
  };
  const statusType = parseThreadStatusType(candidate.type) ?? parseThreadStatusType(candidate.status);
  if (statusType === "active") {
    const activeFlags = parseThreadActiveFlags(candidate.activeFlags ?? candidate.active_flags);
    return {
      statusType: "active",
      statusActiveFlags: activeFlags,
    };
  }

  if (statusType) {
    return {
      statusType,
      statusActiveFlags: [],
    };
  }

  if (typeof candidate.isActive === "boolean") {
    return {
      statusType: candidate.isActive ? "active" : "idle",
      statusActiveFlags: [],
    };
  }

  return { statusType: "notLoaded", statusActiveFlags: [] };
}

function isRolloutMaterializationError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) return false;
  const message = error.message.toLowerCase();

  const isLegacyRolloutError =
    message.includes("failed to load rollout") &&
    (message.includes("empty session file") || message.includes("materialized") || message.includes("is empty"));
  if (isLegacyRolloutError) return true;

  // Newer app-server responses can skip "failed to load rollout" and directly report
  // includeTurns preconditions before the first user turn is materialized.
  const isPreMaterializedThreadError =
    message.includes("not materialized yet") ||
    (message.includes("includeturns") && message.includes("before first user message")) ||
    message.includes("includeturns is unavailable");

  return isPreMaterializedThreadError;
}

function isThreadNotFoundError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) return false;
  const message = error.message.toLowerCase();
  return message.includes("thread not found") || (message.includes("thread") && message.includes("not found"));
}

function isPathWithin(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function truncateLastLines(value: string, maxLines = 12): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(lines.length - maxLines).join("\n");
}

function previewText(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function createTextUserInput(text: string): TurnStartParams["input"][number] {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function resolveDefaultCodexRuntime(): ResolvedCodexRuntime {
  const resolveRuntimeOptions = (): DefaultCodexRuntimeOptions => {
    try {
      const electronModule = require("electron") as { app?: { isPackaged?: boolean } };
      const isPackaged = Boolean(electronModule.app?.isPackaged);
      return {
        isPackaged,
        projectRootPath: isPackaged ? undefined : process.cwd(),
        resourcesPath: process.resourcesPath,
      };
    } catch {
      return {
        isPackaged: false,
        projectRootPath: process.cwd(),
        resourcesPath: process.resourcesPath,
      };
    }
  };

  const buildDeferredRuntime = (options: DefaultCodexRuntimeOptions): ResolvedCodexRuntime => {
    if (!options.isPackaged) {
      const projectRootPath = options.projectRootPath?.trim();
      if (!projectRootPath) {
        throw new Error("Unpackaged Codex runtime resolution requires a project root path");
      }

      const runtimeRoot = path.join(projectRootPath, ".generated", "codex-runtime", "bin");
      return {
        source: "staged",
        binaryPath: path.join(runtimeRoot, "codex"),
        additionalSearchPaths: [runtimeRoot],
        version: null,
        metadataPath: path.join(runtimeRoot, "runtime.json"),
        missingBinaryMessage: "Pinned Codex runtime is missing or incomplete. Run `bun run stage:codex-runtime:mac`.",
      };
    }

    const resourcesPath = options.resourcesPath?.trim();
    if (!resourcesPath) {
      throw new Error("Packaged Codex runtime resolution requires process.resourcesPath");
    }

    const runtimeRoot = path.join(resourcesPath, "bin");
    return {
      source: "bundled",
      binaryPath: path.join(runtimeRoot, "codex"),
      additionalSearchPaths: [runtimeRoot],
      version: null,
      metadataPath: path.join(runtimeRoot, "runtime.json"),
      missingBinaryMessage: "Bundled Codex runtime is missing or corrupted. Reinstall Nodex.",
    };
  };

  const runtimeOptions = resolveRuntimeOptions();

  try {
    return resolveCodexRuntime(runtimeOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Codex runtime is missing or incomplete under")) {
      return buildDeferredRuntime(runtimeOptions);
    }
    throw error;
  }
}

function appendOutputTail(currentTail: string, chunk: string, maxChars = 64_000): string {
  const merged = `${currentTail}${chunk}`;
  if (merged.length <= maxChars) return merged;
  return merged.slice(merged.length - maxChars);
}

function runWorktreeSetupScript(input: {
  script: string;
  cwd: string;
  onOutput?: (output: { stream: "stdout" | "stderr"; data: string }) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    codexLogger.info("Starting worktree setup script", {
      cwd: input.cwd,
      scriptPreview: previewText(input.script, 200),
    });
    const child = spawn(
      "bash",
      ["-euo", "pipefail", "-c", input.script],
      {
        cwd: input.cwd,
        env: process.env,
        windowsHide: true,
      },
    );
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutTail = "";
    let stderrTail = "";
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 250).unref();
    }, WORKTREE_SETUP_SCRIPT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (!text) return;
      stdoutTail = appendOutputTail(stdoutTail, text);
      input.onOutput?.({ stream: "stdout", data: text });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (!text) return;
      stderrTail = appendOutputTail(stderrTail, text);
      input.onOutput?.({ stream: "stderr", data: text });
    });

    child.on("error", (error) => {
      clearTimeout(timeoutId);
      codexLogger.error("Worktree setup script process errored", {
        cwd: input.cwd,
        durationMs: Date.now() - startedAt,
        error,
      });
      reject(new Error(`Worktree environment setup script failed.\n${String(error)}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);

      const trailingStdout = stdoutDecoder.end();
      if (trailingStdout) {
        stdoutTail = appendOutputTail(stdoutTail, trailingStdout);
        input.onOutput?.({ stream: "stdout", data: trailingStdout });
      }

      const trailingStderr = stderrDecoder.end();
      if (trailingStderr) {
        stderrTail = appendOutputTail(stderrTail, trailingStderr);
        input.onOutput?.({ stream: "stderr", data: trailingStderr });
      }

      if (code === 0 && !timedOut) {
        codexLogger.info("Worktree setup script completed", {
          cwd: input.cwd,
          durationMs: Date.now() - startedAt,
        });
        resolve();
        return;
      }

      const timeoutLine = timedOut
        ? `Setup script timed out after ${Math.round(WORKTREE_SETUP_SCRIPT_TIMEOUT_MS / 1000)}s.`
        : "";
      const output = [timeoutLine, truncateLastLines(stdoutTail), truncateLastLines(stderrTail)]
        .filter((chunk) => chunk.length > 0)
        .join("\n");
      const detail = output ? `\n${output}` : "";
      codexLogger.error("Worktree setup script failed", {
        cwd: input.cwd,
        durationMs: Date.now() - startedAt,
        timedOut,
        exitCode: code,
        output,
      });
      reject(new Error(`Worktree environment setup script failed.${detail}`));
    });
  });
}

function isNewerLinkTime(currentLinkedAt: string, candidateLinkedAt: string): boolean {
  const currentMs = Date.parse(currentLinkedAt);
  const candidateMs = Date.parse(candidateLinkedAt);
  if (Number.isFinite(currentMs) && Number.isFinite(candidateMs)) {
    return candidateMs > currentMs;
  }
  return candidateLinkedAt > currentLinkedAt;
}

function makeTurnStatus(value: unknown): CodexTurnStatus {
  if (value === "completed" || value === "interrupted" || value === "failed" || value === "inProgress") {
    return value;
  }
  if (value === "in_progress") return "inProgress";
  return "inProgress";
}

function resolveNotificationTurnStatus(method: string): CodexTurnStatus | null {
  if (method === "turn/started") return "inProgress";
  if (method === "turn/completed") return "completed";
  if (method === "turn/interrupted") return "interrupted";
  if (method === "turn/failed") return "failed";
  return null;
}

function asTerminalTurnStatus(status: CodexTurnStatus): Exclude<CodexTurnStatus, "inProgress"> | null {
  if (status === "inProgress") return null;
  return status;
}

function mergeTurnSummaries(
  incomingTurns: CodexTurnSummary[],
  cachedTurns: CodexTurnSummary[],
): CodexTurnSummary[] {
  if (cachedTurns.length === 0) return incomingTurns;
  if (incomingTurns.length === 0) return cachedTurns;

  const cachedByTurnId = new Map(cachedTurns.map((turn) => [turn.turnId, turn]));
  const seen = new Set<string>();

  const merged = incomingTurns.map((turn) => {
    seen.add(turn.turnId);
    const cached = cachedByTurnId.get(turn.turnId);
    if (!cached) return turn;

    const mergedItemIds = Array.from(new Set([...turn.itemIds, ...cached.itemIds]));
    return {
      ...cached,
      ...turn,
      errorMessage: turn.errorMessage ?? cached.errorMessage,
      itemIds: mergedItemIds,
      tokenUsage: turn.tokenUsage ?? cached.tokenUsage,
    };
  });

  for (const cached of cachedTurns) {
    if (seen.has(cached.turnId)) continue;
    merged.push(cached);
  }

  return merged;
}

function mergeItemViews(
  incomingItems: CodexItemView[],
  cachedItems: CodexItemView[],
): CodexItemView[] {
  return dedupeItemViews([...cachedItems, ...incomingItems]).sort(
    (a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt,
  );
}

function dedupeItemViews(items: CodexItemView[]): CodexItemView[] {
  if (items.length < 2) return items;

  const dedupedByPrimaryKey = new Map<string, CodexItemView>();
  const nonSyntheticByTextKey = new Map<string, string>();
  const syntheticByTextKey = new Map<string, string>();

  const remapTextIndexes = (fromPrimaryKey: string, toPrimaryKey: string): void => {
    for (const [textKey, primaryKey] of nonSyntheticByTextKey.entries()) {
      if (primaryKey !== fromPrimaryKey) continue;
      nonSyntheticByTextKey.set(textKey, toPrimaryKey);
    }
    for (const [textKey, primaryKey] of syntheticByTextKey.entries()) {
      if (primaryKey !== fromPrimaryKey) continue;
      syntheticByTextKey.set(textKey, toPrimaryKey);
    }
  };

  const registerTextKey = (item: CodexItemView, primaryKey: string): void => {
    const textKey = resolveCodexItemTextIdentityKey(item);
    if (!textKey) return;
    if (isSyntheticCodexItemId(item.itemId)) {
      if (!syntheticByTextKey.has(textKey)) syntheticByTextKey.set(textKey, primaryKey);
      return;
    }
    nonSyntheticByTextKey.set(textKey, primaryKey);
  };

  for (const item of items) {
    const primaryKey = resolveCodexItemPrimaryIdentityKey(item);
    const existingPrimary = dedupedByPrimaryKey.get(primaryKey);
    if (existingPrimary) {
      dedupedByPrimaryKey.set(primaryKey, mergeCodexItemView(existingPrimary, item));
      registerTextKey(item, primaryKey);
      continue;
    }

    const textKey = resolveCodexItemTextIdentityKey(item);
    const fallbackPrimaryKey = textKey
      ? (
          isSyntheticCodexItemId(item.itemId)
            ? nonSyntheticByTextKey.get(textKey)
            : syntheticByTextKey.get(textKey)
        )
      : undefined;

    if (!fallbackPrimaryKey) {
      dedupedByPrimaryKey.set(primaryKey, item);
      registerTextKey(item, primaryKey);
      continue;
    }

    const fallback = dedupedByPrimaryKey.get(fallbackPrimaryKey);
    if (!fallback || !canMergeSyntheticTextDuplicate(fallback, item)) {
      dedupedByPrimaryKey.set(primaryKey, item);
      registerTextKey(item, primaryKey);
      continue;
    }

    const merged = mergeCodexItemView(fallback, item);
    const fallbackIsSynthetic = isSyntheticCodexItemId(fallback.itemId);
    const incomingIsSynthetic = isSyntheticCodexItemId(item.itemId);
    const keepPrimaryKey = fallbackIsSynthetic && !incomingIsSynthetic ? primaryKey : fallbackPrimaryKey;

    if (keepPrimaryKey !== fallbackPrimaryKey) {
      dedupedByPrimaryKey.delete(fallbackPrimaryKey);
    }
    dedupedByPrimaryKey.set(keepPrimaryKey, merged);
    if (keepPrimaryKey !== fallbackPrimaryKey) {
      remapTextIndexes(fallbackPrimaryKey, keepPrimaryKey);
    }
    registerTextKey(merged, keepPrimaryKey);
  }

  return Array.from(dedupedByPrimaryKey.values());
}

function emptyAccountSnapshot(): CodexAccountSnapshot {
  return {
    account: null,
    requiresOpenAiAuth: true,
    pendingLogin: null,
    rateLimits: null,
  };
}

function parseRateLimitsSnapshot(value: unknown): CodexRateLimitsSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const primary =
    typeof candidate.primary === "object" && candidate.primary !== null
      ? {
          usedPercent:
            typeof (candidate.primary as Record<string, unknown>).usedPercent === "number"
              ? (candidate.primary as Record<string, unknown>).usedPercent as number
              : 0,
          windowDurationMins:
            typeof (candidate.primary as Record<string, unknown>).windowDurationMins === "number"
              ? (candidate.primary as Record<string, unknown>).windowDurationMins as number
              : undefined,
          resetsAt:
            typeof (candidate.primary as Record<string, unknown>).resetsAt === "number"
              ? normalizeTimestamp((candidate.primary as Record<string, unknown>).resetsAt)
              : undefined,
        }
      : undefined;

  const secondary =
    typeof candidate.secondary === "object" && candidate.secondary !== null
      ? {
          usedPercent:
            typeof (candidate.secondary as Record<string, unknown>).usedPercent === "number"
              ? (candidate.secondary as Record<string, unknown>).usedPercent as number
              : 0,
          windowDurationMins:
            typeof (candidate.secondary as Record<string, unknown>).windowDurationMins === "number"
              ? (candidate.secondary as Record<string, unknown>).windowDurationMins as number
              : undefined,
          resetsAt:
            typeof (candidate.secondary as Record<string, unknown>).resetsAt === "number"
              ? normalizeTimestamp((candidate.secondary as Record<string, unknown>).resetsAt)
              : undefined,
        }
      : undefined;

  const credits =
    typeof candidate.credits === "object" && candidate.credits !== null
      ? {
          hasCredits: Boolean((candidate.credits as Record<string, unknown>).hasCredits),
          unlimited: Boolean((candidate.credits as Record<string, unknown>).unlimited),
          balance:
            typeof (candidate.credits as Record<string, unknown>).balance === "string"
              ? (candidate.credits as Record<string, unknown>).balance as string
              : undefined,
        }
      : undefined;

  return {
    limitId: typeof candidate.limitId === "string" ? candidate.limitId : undefined,
    limitName: typeof candidate.limitName === "string" ? candidate.limitName : undefined,
    primary,
    secondary,
    credits,
    planType: typeof candidate.planType === "string" ? candidate.planType : undefined,
  };
}

function parseAccountIdentity(value: unknown): CodexAccountIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "apiKey") {
    return { type: "apiKey" };
  }
  if (candidate.type === "chatgpt") {
    return {
      type: "chatgpt",
      email: typeof candidate.email === "string" ? candidate.email : "",
      planType: typeof candidate.planType === "string" ? candidate.planType : "unknown",
    };
  }
  return null;
}

function parseReasoningEffort(value: unknown): CodexReasoningEffort | null {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return null;
}

function parseCollaborationModeKind(value: unknown): CodexCollaborationModeKind | null {
  if (value === "default" || value === "plan") return value;
  return null;
}

function parseReasoningEffortOption(value: unknown): CodexReasoningEffortOption | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const reasoningEffort = parseReasoningEffort(candidate.reasoningEffort ?? candidate.reasoning_effort);
  if (!reasoningEffort) return null;

  return {
    reasoningEffort,
    description: typeof candidate.description === "string" ? candidate.description : "",
  };
}

function parseCollaborationModePreset(value: unknown): CodexCollaborationModePreset | null {
  const candidate = asRecord(value);
  if (!candidate) return null;

  const mode = parseCollaborationModeKind(
    candidate.mode
      ?? candidate.mode_kind
      ?? candidate.modeKind
      ?? candidate.kind,
  );
  if (!mode) return null;

  const name = typeof candidate.name === "string" && candidate.name.trim().length > 0
    ? candidate.name.trim()
    : mode === "plan"
      ? "Plan"
      : "Default";

  const model = candidate.model === null
    ? null
    : typeof candidate.model === "string" && candidate.model.trim().length > 0
      ? candidate.model
      : null;

  const rawReasoningEffort = Object.prototype.hasOwnProperty.call(candidate, "reasoningEffort")
    ? candidate.reasoningEffort
    : (
      Object.prototype.hasOwnProperty.call(candidate, "reasoning_effort")
        ? candidate.reasoning_effort
        : undefined
    );
  let reasoningEffort: CodexReasoningEffort | null | undefined;
  if (rawReasoningEffort === null) {
    reasoningEffort = null;
  } else if (rawReasoningEffort === undefined) {
    reasoningEffort = undefined;
  } else {
    reasoningEffort = parseReasoningEffort(rawReasoningEffort);
    if (!reasoningEffort) reasoningEffort = undefined;
  }

  return {
    name,
    mode,
    model,
    reasoningEffort,
  };
}

function parseModelOption(value: unknown): CodexModelOption | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.model !== "string") return null;

  const rawSupportedReasoningEfforts = candidate.supportedReasoningEfforts ?? candidate.supported_reasoning_efforts;
  const supportedReasoningEfforts = Array.isArray(rawSupportedReasoningEfforts)
    ? rawSupportedReasoningEfforts
        .map(parseReasoningEffortOption)
        .filter((option): option is CodexReasoningEffortOption => option !== null)
    : [];

  const defaultReasoningEffort =
    parseReasoningEffort(candidate.defaultReasoningEffort ?? candidate.default_reasoning_effort) ??
    supportedReasoningEfforts[0]?.reasoningEffort ??
    "high";

  return {
    id: candidate.id,
    model: candidate.model,
    displayName:
      typeof candidate.displayName === "string"
        ? candidate.displayName
        : typeof candidate.display_name === "string"
          ? candidate.display_name
          : candidate.id,
    description: typeof candidate.description === "string" ? candidate.description : "",
    hidden: Boolean(candidate.hidden),
    supportedReasoningEfforts,
    defaultReasoningEffort,
    isDefault: Boolean(candidate.isDefault ?? candidate.is_default),
  };
}

export class CodexService extends EventEmitter {
  private readonly logger = codexLogger;
  private readonly client: CodexAppServerClient;

  private readonly projectPermissionMode = new Map<string, CodexPermissionMode>();
  private readonly collaborationModePresets = new Map<CodexCollaborationModeKind, CodexCollaborationModePreset>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly turnByThread = new Map<string, Map<string, CodexTurnSummary>>();
  private readonly itemByThreadTurn = new Map<string, Map<string, CodexItemView>>();

  private accountSnapshot: CodexAccountSnapshot = emptyAccountSnapshot();
  private threadTitlePromptTemplate: string | null | undefined = undefined;
  private syntheticItemIdCounter = 0;

  constructor(options?: CodexServiceOptions) {
    super();

    const runtime = options?.runtime ?? resolveDefaultCodexRuntime();

    this.client = new CodexAppServerClient({
      binaryPath: runtime.binaryPath,
      additionalSearchPaths: runtime.additionalSearchPaths,
      missingBinaryMessage: runtime.missingBinaryMessage,
      clientInfo: {
        name: "nodex",
        title: "Nodex",
        version: "0.5.0",
      },
    });

    this.client.setServerRequestHandler(async (request) => this.handleServerRequest(request));

    this.client.on("connection", (connection) => {
      this.emitEvent({ type: "connection", connection });
    });

    this.client.on("notification", ({ method, params }: CodexServerNotification) => {
      void this.handleNotification(method, params);
    });

    this.client.on("stderr", (line: string) => {
      if (!line.trim()) return;
      this.logger.warn("Received Codex stderr line", { line });
      this.emitEvent({ type: "error", message: "Codex stderr", detail: line.trim() });
    });

    this.client.on("protocolError", (message: string) => {
      this.logger.error("Received Codex protocol error", { message });
      this.emitEvent({ type: "error", message });
    });
  }

  private emitEvent(event: CodexEvent): void {
    this.emit("event", event);
  }

  private emitThreadStartProgress(input: {
    projectId: string;
    cardId: string;
    phase: CodexThreadStartProgressPhase;
    message: string;
    stream?: CodexThreadStartProgressStream;
    outputDelta?: string;
    clearOutput?: boolean;
  }): void {
    this.emitEvent({
      type: "threadStartProgress",
      projectId: input.projectId,
      cardId: input.cardId,
      phase: input.phase,
      message: input.message,
      stream: input.stream,
      outputDelta: input.outputDelta,
      clearOutput: input.clearOutput,
      updatedAt: Date.now(),
    });
  }

  private getPermissionMode(projectId: string | null): CodexPermissionMode {
    if (!projectId) return "custom";
    return this.projectPermissionMode.get(projectId) ?? "custom";
  }

  private buildTurnPermissionOverrides(
    mode: CodexPermissionMode,
    workspacePath: string | null,
  ): { approvalPolicy?: CodexApprovalPolicy; sandboxPolicy?: CodexSandboxPolicy } {
    if (mode === "custom") {
      return {};
    }

    if (mode === "full-access") {
      return {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      };
    }

    if (!workspacePath) {
      return {
        approvalPolicy: "on-request",
      };
    }

    return {
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [workspacePath],
        readOnlyAccess: {
          type: "fullAccess",
        },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
  }

  private findProjectCodexConfig(projectId: string): { configPath: string; displayPath: string } | null {
    const project = dbService.getProject(projectId);
    const workspacePath = project?.workspacePath?.trim();
    if (!workspacePath) return null;

    const workspaceConfigPath = path.join(workspacePath, "config.toml");
    if (existsSync(workspaceConfigPath)) {
      return {
        configPath: workspaceConfigPath,
        displayPath: "config.toml",
      };
    }

    let currentDir = workspacePath;
    for (;;) {
      const candidate = path.join(currentDir, ".codex", "config.toml");
      if (existsSync(candidate)) {
        const relativePath = path.relative(workspacePath, candidate);
        return {
          configPath: candidate,
          displayPath: relativePath.length > 0 ? relativePath : ".codex/config.toml",
        };
      }

      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        return null;
      }
      currentDir = parent;
    }
  }

  private readCodexPermissionConfig(projectId: string): CodexPermissionConfigSnapshot {
    const projectConfig = this.findProjectCodexConfig(projectId);
    const userConfigPath = path.join(resolveCodexHomeDir(), "config.toml");
    const isExplicitCodexHome = Boolean(process.env.CODEX_HOME?.trim());
    const normalizedUserConfigPath = path.resolve(userConfigPath);
    const projectConfigPath = projectConfig?.configPath ? path.resolve(projectConfig.configPath) : null;
    const effectiveProjectConfig =
      projectConfigPath !== null && projectConfigPath === normalizedUserConfigPath ? null : projectConfig;
    const configPath = effectiveProjectConfig?.configPath ?? (existsSync(userConfigPath) ? userConfigPath : null);
    const displayPath = effectiveProjectConfig?.displayPath ??
      (configPath ? (isExplicitCodexHome ? "$CODEX_HOME/config.toml" : "~/.codex/config.toml") : null);

    if (!configPath) {
      return {
        source: "none",
        configPath: null,
        displayPath: null,
        sandboxMode: null,
        approvalPolicy: null,
        parseError: null,
      };
    }

    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = parseToml(raw) as Record<string, unknown>;
      const sandboxMode = typeof parsed.sandbox_mode === "string" ? parsed.sandbox_mode : null;
      const approvalPolicy = typeof parsed.approval_policy === "string" ? parsed.approval_policy : null;

      return {
        source: effectiveProjectConfig ? "project" : "user",
        configPath,
        displayPath,
        sandboxMode,
        approvalPolicy,
        parseError: null,
      };
    } catch (error) {
      return {
        source: effectiveProjectConfig ? "project" : "user",
        configPath,
        displayPath,
        sandboxMode: null,
        approvalPolicy: null,
        parseError: error instanceof Error ? error.message : "Unknown parse error",
      };
    }
  }

  getCustomPermissionModeDescription(projectId: string): string {
    const snapshot = this.readCodexPermissionConfig(projectId);
    const sourceLabel = snapshot.source === "project" ? "Project config" : "User config";
    const pathLabel = snapshot.displayPath ?? "config.toml";

    if (snapshot.parseError) {
      return `Could not parse ${sourceLabel} (${pathLabel}): ${snapshot.parseError}. Codex will fall back to its built-in permission defaults.`;
    }

    if (snapshot.source === "none") {
      return "No project or user Codex config was found. Codex will fall back to its built-in permission defaults.";
    }

    const sandboxLabel = snapshot.sandboxMode ?? "unset";
    const approvalLabel = snapshot.approvalPolicy ?? "unset";

    if (!snapshot.sandboxMode && !snapshot.approvalPolicy) {
      return `${sourceLabel} (${pathLabel}) sets neither sandbox_mode nor approval_policy, so Codex will use its built-in permission defaults.`;
    }

    return `${sourceLabel} (${pathLabel}): sandbox_mode=${sandboxLabel}; approval_policy=${approvalLabel}.`;
  }

  setProjectPermissionMode(projectId: string, mode: CodexPermissionMode): void {
    this.projectPermissionMode.set(projectId, mode);
  }

  getProjectPermissionMode(projectId: string): CodexPermissionMode {
    return this.getPermissionMode(projectId);
  }

  getConnectionState() {
    return this.client.getState();
  }

  async shutdown(): Promise<void> {
    this.logger.info("Shutting down Codex service", {
      pendingApprovals: this.pendingApprovals.size,
      pendingUserInputs: this.pendingUserInputs.size,
    });
    for (const pending of this.pendingApprovals.values()) {
      pending.reject(new Error("Codex service shutting down"));
    }
    this.pendingApprovals.clear();

    for (const pending of this.pendingUserInputs.values()) {
      pending.reject(new Error("Codex service shutting down"));
    }
    this.pendingUserInputs.clear();

    await this.client.stop();
  }

  private async ensureClientReady(): Promise<void> {
    await this.client.start();
  }

  async readAccountSnapshot(): Promise<CodexAccountSnapshot> {
    await this.ensureClientReady();

    const accountResult = await this.client.request<"account/read", GetAccountResponse>("account/read", {
      refreshToken: false,
    });

    const rateLimitResult = await this.client.request<"account/rateLimits/read", GetAccountRateLimitsResponse>(
      "account/rateLimits/read",
    ).catch(() => ({ rateLimits: null, rateLimitsByLimitId: null }));

    this.accountSnapshot = {
      account: parseAccountIdentity(accountResult.account ?? null),
      requiresOpenAiAuth: Boolean(accountResult.requiresOpenaiAuth),
      pendingLogin: this.accountSnapshot.pendingLogin ?? null,
      rateLimits: parseRateLimitsSnapshot(rateLimitResult.rateLimits ?? null),
    };

    this.logger.info("Read Codex account snapshot", {
      accountType: this.accountSnapshot.account?.type ?? null,
      requiresOpenAiAuth: this.accountSnapshot.requiresOpenAiAuth,
      hasRateLimits: Boolean(this.accountSnapshot.rateLimits),
    });
    this.emitEvent({ type: "account", account: this.accountSnapshot });
    return this.accountSnapshot;
  }

  async startAccountLogin(
    input: { type: "chatgpt" } | { type: "apiKey"; apiKey: string },
  ): Promise<{ type: "apiKey" } | { type: "chatgpt"; loginId: string; authUrl: string }> {
    await this.ensureClientReady();

    if (input.type === "apiKey") {
      await this.client.request("account/login/start", {
        type: "apiKey",
        apiKey: input.apiKey,
      });
      await this.readAccountSnapshot();
      return { type: "apiKey" };
    }

    const result = await this.client.request<"account/login/start", LoginAccountResponse>(
      "account/login/start",
      { type: "chatgpt" },
    );

    const response: { type: "chatgpt"; loginId: string; authUrl: string } = {
      type: "chatgpt",
      loginId: result.type === "chatgpt" ? result.loginId : "",
      authUrl: result.type === "chatgpt" ? result.authUrl : "",
    };

    this.accountSnapshot = {
      ...this.accountSnapshot,
      pendingLogin: {
        loginId: response.loginId,
        authUrl: response.authUrl,
      },
    };

    this.emitEvent({ type: "account", account: this.accountSnapshot });
    return response;
  }

  async cancelAccountLogin(loginId: string): Promise<{ status: "canceled" | "notFound" }> {
    await this.ensureClientReady();

    const result = await this.client.request<"account/login/cancel", CancelLoginAccountResponse>("account/login/cancel", {
      loginId,
    });

    if (this.accountSnapshot.pendingLogin?.loginId === loginId) {
      this.accountSnapshot = {
        ...this.accountSnapshot,
        pendingLogin: null,
      };
      this.emitEvent({ type: "account", account: this.accountSnapshot });
    }

    return {
      status: result.status === "canceled" ? "canceled" : "notFound",
    };
  }

  async logoutAccount(): Promise<boolean> {
    await this.ensureClientReady();
    await this.client.request("account/logout");
    this.accountSnapshot = emptyAccountSnapshot();
    this.emitEvent({ type: "account", account: this.accountSnapshot });
    return true;
  }

  async listProjectThreads(
    projectId: string,
    opts?: { cardId?: string; includeArchived?: boolean },
  ): Promise<CodexThreadSummary[]> {
    return listCodexProjectThreads(projectId, opts);
  }

  async listWorktreeEnvironments(projectId: string): Promise<WorktreeEnvironmentOption[]> {
    const project = dbService.getProject(projectId);
    const workspacePath = project?.workspacePath?.trim();
    if (!workspacePath) return [];
    try {
      return await listWorktreeEnvironmentOptions(workspacePath);
    } catch {
      return [];
    }
  }

  async listManagedWorktrees(): Promise<ManagedWorktreeRecord[]> {
    const managedRoot = path.resolve(getKanbanDir(), "worktrees");
    const links = listCodexThreadLinks({ includeArchived: true });
    const recordsByPath = links.reduce<Map<string, ManagedWorktreeRecord>>((acc, link) => {
      const cwd = link.cwd?.trim();
      if (!cwd) return acc;

      const resolvedPath = path.resolve(cwd);
      if (!isPathWithin(managedRoot, resolvedPath)) return acc;

      const existing = acc.get(resolvedPath);
      if (existing && !isNewerLinkTime(existing.linkedAt, link.linkedAt)) {
        return acc;
      }

      const project = dbService.getProject(link.projectId);
      const card = dbService.getCardSync(link.projectId, link.cardId);

      acc.set(resolvedPath, {
        threadId: link.threadId,
        projectId: link.projectId,
        projectName: project?.name ?? null,
        cardId: link.cardId,
        cardTitle: card?.title ?? null,
        threadName: link.threadName,
        path: resolvedPath,
        exists: existsSync(resolvedPath),
        linkedAt: link.linkedAt,
      });
      return acc;
    }, new Map<string, ManagedWorktreeRecord>());

    const records = Array.from(recordsByPath.values());

    records.sort((left, right) => right.linkedAt.localeCompare(left.linkedAt));
    return records;
  }

  /** Remove a managed worktree directory. Returns true if deletion was performed. */
  async deleteManagedWorktree(threadId: string): Promise<boolean> {
    const managedRoot = path.resolve(getKanbanDir(), "worktrees");
    const link = getCodexCardThreadLink(threadId);
    if (!link) return false;

    const cwd = link.cwd?.trim();
    if (!cwd) return false;

    const resolvedPath = path.resolve(cwd);
    if (!isPathWithin(managedRoot, resolvedPath)) return false;

    await removeManagedWorktree(resolvedPath);

    const linkedThreadIds = listCodexThreadLinks({ includeArchived: true })
      .filter((candidate) => {
        const candidateCwd = candidate.cwd?.trim();
        if (!candidateCwd) return false;
        return path.resolve(candidateCwd) === resolvedPath;
      })
      .map((candidate) => candidate.threadId);

    const threadIdsToUnlink = Array.from(new Set([threadId, ...linkedThreadIds]));

    let removedAnyLink = false;
    for (const linkedThreadId of threadIdsToUnlink) {
      removedAnyLink = unlinkCodexThread(linkedThreadId) || removedAnyLink;
    }

    return removedAnyLink;
  }

  async listModels(): Promise<CodexModelOption[]> {
    await this.ensureClientReady();

    const result = await this.client.request<"model/list", ModelListResponse>("model/list", {});

    return result.data
      .map(parseModelOption)
      .filter((option): option is CodexModelOption => option !== null);
  }

  async listCollaborationModes(): Promise<CodexCollaborationModePreset[]> {
    await this.ensureClientReady();

    const result = await this.client.request<"collaborationMode/list", CollaborationModeListResponse>("collaborationMode/list", {});
    const presets = result.data
      .map(parseCollaborationModePreset)
      .filter((preset): preset is CodexCollaborationModePreset => preset !== null)
      .filter((preset) => preset.mode === "default" || preset.mode === "plan");

    this.collaborationModePresets.clear();
    for (const preset of presets) {
      if (this.collaborationModePresets.has(preset.mode)) continue;
      this.collaborationModePresets.set(preset.mode, preset);
    }

    return presets;
  }

  private buildCollaborationModePayload(input: {
    collaborationMode?: CodexCollaborationModeKind;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
  }): { mode: CodexCollaborationModeKind; settings: { model: string; reasoning_effort: CodexReasoningEffort | null; developer_instructions: null } } | null {
    const selectedMode = input.collaborationMode;
    if (!selectedMode) return null;

    const preset = this.collaborationModePresets.get(selectedMode);
    const model = preset?.model ?? input.model ?? "";
    const reasoningEffort = preset?.reasoningEffort !== undefined
      ? preset.reasoningEffort
      : (input.reasoningEffort ?? null);

    return {
      mode: selectedMode,
      settings: {
        model,
        reasoning_effort: reasoningEffort,
        developer_instructions: null,
      },
    };
  }

  private parseThreadRef(threadId: string): ThreadRef | null {
    const link = getCodexCardThreadLink(threadId);
    if (!link) return null;
    return {
      projectId: link.projectId,
      cardId: link.cardId,
      cwd: link.cwd,
    };
  }

  private async resolveThreadRunLocation(input: {
    projectId: string;
    cardId: string;
    threadTitle?: string | null;
    worktreeStartMode?: WorktreeStartMode;
    worktreeBranchPrefix?: string | null;
    onProgress?: (update: ThreadStartProgressUpdate) => void;
  }): Promise<ResolvedThreadRunLocation> {
    const cardRecord = await dbService.getCard(input.projectId, input.cardId);
    if (!cardRecord) {
      throw new Error(`Card '${input.cardId}' not found in project '${input.projectId}'`);
    }

    const runInTarget = cardRecord.runInTarget ?? "localProject";

    if (runInTarget === "cloud") {
      throw new Error("Cloud run target is not available yet. Choose Local project or New worktree.");
    }

    const workspacePath = this.parseWorkspacePath(input.projectId);

    if (runInTarget === "newWorktree") {
      const managedRoot = path.resolve(getKanbanDir(), "worktrees");
      const persistedWorktreePath = cardRecord.runInWorktreePath?.trim();
      if (persistedWorktreePath) {
        const resolvedPersistedPath = path.resolve(persistedWorktreePath);
        if (isPathWithin(managedRoot, resolvedPersistedPath) && existsSync(resolvedPersistedPath)) {
          return {
            cwd: resolvedPersistedPath,
            runInTarget,
            createdManagedWorktree: false,
          };
        }
      }

      input.onProgress?.({
        phase: "creatingWorktree",
        message: WORKTREE_LOG_STATUS_MESSAGE,
        clearOutput: true,
      });
      input.onProgress?.({
        phase: "creatingWorktree",
        message: WORKTREE_LOG_STATUS_MESSAGE,
        stream: "info",
        outputDelta: "[info] Starting worktree creation\n",
      });

      const createdWorktree = await createManagedWorktree({
        repositoryPath: workspacePath,
        serverDir: getKanbanDir(),
        projectId: input.projectId,
        cardId: input.cardId,
        threadTitle: input.threadTitle?.trim() || cardRecord.title.trim() || cardRecord.id,
        branchPrefix: input.worktreeBranchPrefix,
        preferredBaseBranch: cardRecord.runInBaseBranch ?? null,
        mode: input.worktreeStartMode ?? "detachedHead",
        onLog: (output) => {
          if (!output.data) return;
          input.onProgress?.({
            phase: "creatingWorktree",
            message: WORKTREE_LOG_STATUS_MESSAGE,
            stream: output.stream,
            outputDelta: output.data,
          });
        },
      });
      const resolvedWorktreePath = path.resolve(createdWorktree.cwd);
      input.onProgress?.({
        phase: "creatingWorktree",
        message: WORKTREE_LOG_STATUS_MESSAGE,
        stream: "info",
        outputDelta: `Worktree created at ${resolvedWorktreePath}\n`,
      });

      const selectedEnvironmentPath = cardRecord.runInEnvironmentPath?.trim() || null;
      if (selectedEnvironmentPath) {
        try {
          const environmentDefinition = await readWorktreeEnvironmentDefinition({
            workspacePath,
            environmentPath: selectedEnvironmentPath,
          });
          if (environmentDefinition.setupScript) {
            input.onProgress?.({
              phase: "runningSetup",
              message: WORKTREE_LOG_STATUS_MESSAGE,
              stream: "info",
              outputDelta: `Running setup script ${environmentDefinition.path}\n`,
            });
            await runWorktreeSetupScript({
              script: environmentDefinition.setupScript,
              cwd: resolvedWorktreePath,
              onOutput: (output) => {
                if (!output.data) return;
                input.onProgress?.({
                  phase: "runningSetup",
                  message: WORKTREE_LOG_STATUS_MESSAGE,
                  stream: output.stream,
                  outputDelta: output.data,
                });
              },
            });
            input.onProgress?.({
              phase: "runningSetup",
              message: WORKTREE_LOG_STATUS_MESSAGE,
              stream: "info",
              outputDelta: "Setup script completed\n",
            });
          }
        } catch (error) {
          await removeManagedWorktree(resolvedWorktreePath).catch(() => undefined);
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Failed to set up new worktree using environment '${selectedEnvironmentPath}': ${errorMessage}`,
          );
        }
      }

      const updated = await dbService.updateCard(
        input.projectId,
        cardRecord.status,
        input.cardId,
        { runInWorktreePath: resolvedWorktreePath },
      );
      if (updated.status !== "updated") {
        await removeManagedWorktree(resolvedWorktreePath).catch(() => undefined);
        throw new Error(`Card '${input.cardId}' no longer exists while persisting managed worktree path`);
      }
      return {
        cwd: resolvedWorktreePath,
        runInTarget,
        createdManagedWorktree: true,
      };
    }

    const localOverride = cardRecord.runInLocalPath?.trim();
    if (!localOverride) {
      return {
        cwd: workspacePath,
        runInTarget: "localProject",
        createdManagedWorktree: false,
      };
    }

    const resolvedLocalPath = path.isAbsolute(localOverride)
      ? localOverride
      : path.resolve(workspacePath, localOverride);
    if (!existsSync(resolvedLocalPath)) {
      throw new Error(`Run-in local folder does not exist: ${resolvedLocalPath}`);
    }

    return {
      cwd: resolvedLocalPath,
      runInTarget: "localProject",
      createdManagedWorktree: false,
    };
  }

  private asTurnSummary(threadId: string, turn: unknown): CodexTurnSummary | null {
    if (typeof turn !== "object" || turn === null) return null;
    const candidate = turn as Record<string, unknown>;
    if (typeof candidate.id !== "string") return null;

    const items = Array.isArray(candidate.items) ? candidate.items : [];
    const itemIds = items
      .map((item) => {
        if (typeof item !== "object" || item === null) return null;
        const i = item as Record<string, unknown>;
        return typeof i.id === "string" ? i.id : null;
      })
      .filter((value): value is string => Boolean(value));

    const errorMessage =
      typeof candidate.error === "object" && candidate.error !== null
        ? typeof (candidate.error as Record<string, unknown>).message === "string"
          ? (candidate.error as Record<string, unknown>).message as string
          : undefined
        : undefined;
    const tokenUsage = parseThreadTokenUsage(candidate.tokenUsage ?? candidate.token_usage);

    return {
      threadId,
      turnId: candidate.id,
      status: makeTurnStatus(candidate.status),
      errorMessage,
      itemIds,
      tokenUsage,
    };
  }

  private mergeTurn(threadId: string, turn: CodexTurnSummary): void {
    const byTurn = this.turnByThread.get(threadId) ?? new Map<string, CodexTurnSummary>();
    const existing = byTurn.get(turn.turnId);
    if (!existing) {
      byTurn.set(turn.turnId, turn);
      this.turnByThread.set(threadId, byTurn);
      return;
    }

    const mergedItemIds = Array.from(new Set([...existing.itemIds, ...turn.itemIds]));
    byTurn.set(turn.turnId, {
      ...existing,
      ...turn,
      errorMessage: turn.errorMessage ?? existing.errorMessage,
      itemIds: mergedItemIds,
      tokenUsage: turn.tokenUsage ?? existing.tokenUsage,
    });
    this.turnByThread.set(threadId, byTurn);
  }

  private listKnownTurns(threadId: string): CodexTurnSummary[] {
    const byTurn = this.turnByThread.get(threadId);
    if (!byTurn) return [];
    return Array.from(byTurn.values());
  }

  private getKnownTurn(threadId: string, turnId: string): CodexTurnSummary | null {
    const byTurn = this.turnByThread.get(threadId);
    if (!byTurn) return null;
    return byTurn.get(turnId) ?? null;
  }

  private getInterruptTargetTurnId(threadId: string): string | null {
    const turns = this.listKnownTurns(threadId);
    if (turns.length === 0) return null;

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn?.status === "inProgress") return turn.turnId;
    }

    return turns[turns.length - 1]?.turnId ?? null;
  }

  private markThreadAsActive(threadId: string): void {
    const updated = updateCodexThreadStatus(threadId, "active", []);
    if (updated) {
      this.emitEvent({ type: "threadSummary", thread: updated });
    }
    this.emitEvent({
      type: "threadStatus",
      threadId,
      statusType: "active",
      statusActiveFlags: [],
    });
  }

  private seedTurnWithOptimisticUserMessage(
    threadId: string,
    turnId: string,
    promptText: string,
    itemId?: string,
  ): CodexItemView {
    const createdAt = Date.now();
    const item: CodexItemView = {
      threadId,
      turnId,
      itemId: itemId ?? `item-${++this.syntheticItemIdCounter}`,
      type: "userMessage",
      normalizedKind: "userMessage",
      status: "completed",
      role: "user",
      markdownText: promptText,
      createdAt,
      updatedAt: createdAt,
    };

    const turn = this.getKnownTurn(threadId, turnId);
    if (turn && !turn.itemIds.includes(item.itemId)) {
      this.mergeTurn(threadId, {
        ...turn,
        itemIds: [...turn.itemIds, item.itemId],
      });
    }

    this.mergeItem(item);
    return item;
  }

  private syncThreadStatusFromKnownTurns(threadId: string): void {
    const hasInProgressTurn = this.listKnownTurns(threadId).some((turn) => turn.status === "inProgress");
    const statusType: CodexThreadStatusType = hasInProgressTurn ? "active" : "idle";
    const updated = updateCodexThreadStatus(threadId, statusType, []);
    if (updated) {
      this.emitEvent({ type: "threadSummary", thread: updated });
    }
    this.emitEvent({
      type: "threadStatus",
      threadId,
      statusType,
      statusActiveFlags: [],
    });
  }

  private async resolveInterruptTurnId(threadId: string, turnId?: string): Promise<string | null> {
    if (typeof turnId === "string" && turnId.trim().length > 0) return turnId;

    const cachedTurnId = this.getInterruptTargetTurnId(threadId);
    if (cachedTurnId) return cachedTurnId;

    await this.readThread(threadId, true).catch(() => null);
    return this.getInterruptTargetTurnId(threadId);
  }

  private reconcileTurnItemsToTerminalStatus(
    threadId: string,
    turnId: string,
    turnStatus: CodexTurnStatus,
  ): CodexItemView[] {
    const terminalStatus = asTerminalTurnStatus(turnStatus);
    if (!terminalStatus) return [];

    const key = `${threadId}:${turnId}`;
    const byItem = this.itemByThreadTurn.get(key);
    if (!byItem || byItem.size === 0) return [];

    const now = Date.now();
    const updatedItems: CodexItemView[] = [];

    for (const [itemKey, item] of byItem.entries()) {
      if (item.status !== "inProgress") continue;
      const nextItem: CodexItemView = {
        ...item,
        status: terminalStatus,
        updatedAt: Math.max(item.updatedAt, now),
      };
      byItem.set(itemKey, nextItem);
      updatedItems.push(nextItem);
    }

    if (updatedItems.length === 0) return [];
    this.itemByThreadTurn.set(key, byItem);
    return updatedItems;
  }

  private reconcileDetailItemsToTerminalTurnStatus(detail: CodexThreadDetail): CodexThreadDetail {
    if (detail.items.length === 0 || detail.turns.length === 0) return detail;

    const terminalTurnStatuses = new Map<string, Exclude<CodexTurnStatus, "inProgress">>();
    for (const turn of detail.turns) {
      const terminalStatus = asTerminalTurnStatus(turn.status);
      if (!terminalStatus) continue;
      terminalTurnStatuses.set(turn.turnId, terminalStatus);
    }
    if (terminalTurnStatuses.size === 0) return detail;

    let changed = false;
    const now = Date.now();
    const nextItems = detail.items.map((item) => {
      if (item.status !== "inProgress") return item;
      const terminalStatus = terminalTurnStatuses.get(item.turnId);
      if (!terminalStatus) return item;
      changed = true;
      return {
        ...item,
        status: terminalStatus,
        updatedAt: Math.max(item.updatedAt, now),
      };
    });

    if (!changed) return detail;
    return {
      ...detail,
      items: nextItems,
    };
  }

  private mergeItem(item: CodexItemView): void {
    const key = `${item.threadId}:${item.turnId}`;
    const byItem = this.itemByThreadTurn.get(key) ?? new Map<string, CodexItemView>();
    const primaryKey = resolveCodexItemPrimaryIdentityKey(item);

    let existingKey: string | null = null;
    let existing: CodexItemView | undefined = byItem.get(primaryKey);
    if (!existing) {
      for (const [candidateKey, candidate] of byItem.entries()) {
        if (!canMergeSyntheticTextDuplicate(candidate, item)) continue;
        existing = candidate;
        existingKey = candidateKey;
        break;
      }
    } else {
      existingKey = primaryKey;
    }

    const mergedItem = existing
      ? {
          ...mergeCodexItemView(existing, item),
          updatedAt: Date.now(),
        }
      : item;

    if (existingKey && existingKey !== primaryKey) {
      byItem.delete(existingKey);
    }
    byItem.set(
      primaryKey,
      mergedItem,
    );
    this.itemByThreadTurn.set(key, byItem);
  }

  private hydrateThreadDetail(detail: CodexThreadDetail): void {
    for (const turn of detail.turns) {
      this.mergeTurn(detail.threadId, turn);
    }

    for (const item of detail.items) {
      this.mergeItem(item);
    }
  }

  private mergeWithPersistedSnapshot(
    threadId: string,
    liveDetail: CodexThreadDetail | null,
  ): CodexThreadDetail | null {
    const link = getCodexCardThreadLink(threadId);
    const baseDetail = liveDetail ?? (link
      ? {
          ...link,
          turns: [] as CodexTurnSummary[],
          items: [] as CodexItemView[],
        }
      : null);

    if (!baseDetail) return null;

    const sessionDetail = link
      ? readCodexSessionThreadDetail({
          threadId,
          link,
        })
      : null;

    const withSessionRecovery = sessionDetail
      ? {
          ...baseDetail,
          threadName: sessionDetail.threadName ?? baseDetail.threadName,
          threadPreview: sessionDetail.threadPreview || baseDetail.threadPreview,
          cwd: sessionDetail.cwd ?? baseDetail.cwd,
          updatedAt: Math.max(baseDetail.updatedAt, sessionDetail.updatedAt),
          turns: mergeTurnSummaries(baseDetail.turns, sessionDetail.turns),
          items: mergeItemViews(baseDetail.items, sessionDetail.items),
        }
      : baseDetail;

    const snapshot = sessionDetail ? null : getCodexThreadSnapshot(threadId);
    if (!snapshot) return withSessionRecovery;

    return {
      ...withSessionRecovery,
      updatedAt: Math.max(withSessionRecovery.updatedAt, snapshot.updatedAt),
      turns: mergeTurnSummaries(withSessionRecovery.turns, snapshot.turns),
      items: mergeItemViews(withSessionRecovery.items, snapshot.items),
    };
  }

  private persistThreadSnapshot(threadId: string): void {
    if (hasCodexSessionMaterialized(threadId)) {
      deleteCodexThreadSnapshot(threadId);
      return;
    }

    const detail = this.serializeThreadDetail(threadId);
    if (!detail) return;

    try {
      upsertCodexThreadSnapshot({
        threadId,
        turns: detail.turns,
        items: detail.items,
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.emitEvent({
        type: "error",
        message: `Could not persist thread snapshot for ${threadId}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildThreadDetailFromRead(thread: unknown): CodexThreadDetail | null {
    if (typeof thread !== "object" || thread === null) return null;
    const candidate = thread as Record<string, unknown>;

    if (typeof candidate.id !== "string") return null;
    const threadId = candidate.id;

    const link = getCodexCardThreadLink(threadId);
    if (!link) return null;

    const turns = Array.isArray(candidate.turns) ? candidate.turns : [];
    const turnSummaries: CodexTurnSummary[] = [];
    const itemViews: CodexItemView[] = [];

    for (const turn of turns) {
      const turnSummary = this.asTurnSummary(threadId, turn);
      if (!turnSummary) continue;
      turnSummaries.push(turnSummary);
      this.mergeTurn(threadId, turnSummary);

      const turnRecord = turn as Record<string, unknown>;
      const items = Array.isArray(turnRecord.items) ? turnRecord.items : [];
      for (const item of items) {
        const itemView = normalizeThreadItem(item, threadId, turnSummary.turnId);
        if (!itemView) continue;
        this.mergeItem(itemView);
        itemViews.push(itemView);
      }
    }

    return {
      ...link,
      turns: turnSummaries,
      items: itemViews,
    };
  }

  private upsertLinkFromThread(
    thread: unknown,
    fallbackRef?: ThreadRef,
    fallbackCwd?: string | null,
  ): CodexThreadSummary | null {
    if (typeof thread !== "object" || thread === null) return null;
    const candidate = thread as Record<string, unknown>;
    if (typeof candidate.id !== "string") return null;

    const existing = getCodexCardThreadLink(candidate.id);
    const ref = fallbackRef ??
      (existing
        ? {
            projectId: existing.projectId,
            cardId: existing.cardId,
          }
        : null);

    if (!ref) return null;

    const parsedStatus = parseThreadStatus(candidate.status);

    return upsertCodexCardThreadLink({
      projectId: ref.projectId,
      cardId: ref.cardId,
      threadId: candidate.id,
      threadName: typeof candidate.name === "string" ? candidate.name : null,
      threadPreview: typeof candidate.preview === "string" ? candidate.preview : "",
      modelProvider: typeof candidate.modelProvider === "string" ? candidate.modelProvider : "",
      cwd: typeof candidate.cwd === "string"
        ? candidate.cwd
        : (existing?.cwd ?? (fallbackCwd?.trim() || null)),
      statusType: parsedStatus.statusType,
      statusActiveFlags: parsedStatus.statusActiveFlags,
      archived: existing?.archived ?? false,
      createdAt: normalizeTimestamp(candidate.createdAt),
      updatedAt: normalizeTimestamp(candidate.updatedAt),
      linkedAt: existing?.linkedAt,
    });
  }

  private parseWorkspacePath(projectId: string): string {
    const project = dbService.getProject(projectId);
    if (!project) {
      throw new Error(`Project '${projectId}' not found`);
    }

    const workspacePath = project.workspacePath?.trim();
    if (!workspacePath) {
      throw new Error(`Project '${projectId}' must configure workspace path before using Codex threads`);
    }

    return workspacePath;
  }

  private readThreadTitlePromptTemplate(): string | null {
    if (this.threadTitlePromptTemplate !== undefined) {
      return this.threadTitlePromptTemplate;
    }

    try {
      const template = readFileSync(THREAD_TITLE_PROMPT_PATH, "utf8").trim();
      if (!template) {
        this.threadTitlePromptTemplate = null;
        return null;
      }
      this.threadTitlePromptTemplate = template;
      return template;
    } catch (error) {
      this.threadTitlePromptTemplate = null;
      this.emitEvent({
        type: "error",
        message: "Could not read thread title prompt template",
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildThreadTitleGenerationPrompt(template: string, userPrompt: string): string {
    const marker = "<USER_PROMPT>";
    if (!template.includes(marker)) {
      return `${template}\n\n${userPrompt}`;
    }
    return template.replace(marker, userPrompt);
  }

  private async runStructuredThreadTitle(input: RunStructuredThreadTitleInput): Promise<string | null> {
    const timeoutMs = input.timeoutMs ?? THREAD_TITLE_TIMEOUT_MS;
    return await new Promise<string | null>((resolve, reject) => {
      let isSettled = false;
      let bufferedAssistantText = "";
      let timeoutHandle: NodeJS.Timeout | null = null;
      let activeThreadId: string | null = null;
      let activeTurnId: string | null = null;
      let unsubscribe: (() => void) | null = null;

      const complete = (title: string | null) => {
        if (isSettled) return;
        isSettled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        resolve(title);
      };

      const fail = (error: unknown) => {
        if (isSettled) return;
        isSettled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        reject(error);
      };

      const parseEventThreadId = (eventParams: Record<string, unknown> | null): string | null => {
        if (!eventParams) return null;
        if (typeof eventParams.threadId === "string") return eventParams.threadId;
        const thread = asRecord(eventParams.thread);
        if (typeof thread?.id === "string") return thread.id;
        return null;
      };

      const parseEventTurnId = (eventParams: Record<string, unknown> | null): string | null => {
        if (!eventParams) return null;
        if (typeof eventParams.turnId === "string") return eventParams.turnId;
        const turn = asRecord(eventParams.turn);
        if (typeof turn?.id === "string") return turn.id;
        return null;
      };

      const parseThreadIdFromStartResult = (startResult: unknown): string | null => {
        const resultRecord = asRecord(startResult);
        if (!resultRecord) return null;
        if (typeof resultRecord.threadId === "string") return resultRecord.threadId;
        const thread = asRecord(resultRecord.thread);
        if (typeof thread?.id === "string") return thread.id;
        if (typeof resultRecord.id === "string") return resultRecord.id;
        return null;
      };

      const parseTurnIdFromStartResult = (startResult: unknown): string | null => {
        const resultRecord = asRecord(startResult);
        if (!resultRecord) return null;
        if (typeof resultRecord.turnId === "string") return resultRecord.turnId;
        const turn = asRecord(resultRecord.turn);
        if (typeof turn?.id === "string") return turn.id;
        if (typeof resultRecord.id === "string") return resultRecord.id;
        return null;
      };

      const isEventForActiveThreadAndTurn = (eventParams: Record<string, unknown> | null): boolean => {
        const eventThreadId = parseEventThreadId(eventParams);
        if (!activeThreadId || !eventThreadId || eventThreadId !== activeThreadId) {
          return false;
        }

        const eventTurnId = parseEventTurnId(eventParams);
        if (activeTurnId && (!eventTurnId || eventTurnId !== activeTurnId)) {
          return false;
        }

        return true;
      };

      unsubscribe = input.client.onNotification(({ method, params }) => {
        if (isSettled) return;
        if (
          method !== "turn/started" &&
          method !== "item/agentMessage/delta" &&
          method !== "item/completed" &&
          method !== "turn/completed"
        ) {
          return;
        }

        const eventParams = asRecord(params);
        if (!isEventForActiveThreadAndTurn(eventParams)) return;

        if (method === "turn/started") {
          const eventThreadId = parseEventThreadId(eventParams);
          const eventTurnId = parseEventTurnId(eventParams);
          if (!activeThreadId && eventThreadId) activeThreadId = eventThreadId;
          if (!activeTurnId && eventTurnId) activeTurnId = eventTurnId;
          return;
        }

        if (method === "item/agentMessage/delta") {
          const deltaText = typeof eventParams?.delta === "string"
            ? eventParams.delta
            : typeof asRecord(eventParams?.item)?.delta === "string"
              ? asRecord(eventParams?.item)?.delta as string
              : "";
          if (deltaText) bufferedAssistantText += deltaText;
          return;
        }

        if (method === "item/completed") {
          const item = asRecord(eventParams?.item);
          const itemType = typeof item?.type === "string" ? item.type : "";
          if (itemType !== "agentMessage") return;
          const itemText = typeof item?.text === "string"
            ? item.text
            : typeof item?.markdownText === "string"
              ? item.markdownText
              : "";
          bufferedAssistantText = itemText;
          return;
        }

        const status = typeof eventParams?.status === "string"
          ? eventParams.status
          : typeof asRecord(eventParams?.turn)?.status === "string"
            ? asRecord(eventParams?.turn)?.status as string
            : "";
        if (status !== "completed") {
          fail(new Error("Structured turn did not complete."));
          return;
        }
        try {
          complete(input.parse(bufferedAssistantText));
        } catch (error) {
          fail(error);
        }
      });

      timeoutHandle = setTimeout(() => {
        if (activeThreadId && activeTurnId) {
          void input.client.interruptTurn({ threadId: activeThreadId, turnId: activeTurnId }).catch(() => undefined);
        }
        fail(new Error("Timed out while generating thread title"));
      }, timeoutMs);

      void (async () => {
        const threadConfig = input.effort === null
          ? (input.config ?? null)
          : { ...(input.config ?? {}), model_reasoning_effort: input.effort };

        const startedThread = await input.client.startThread({
          model: input.model,
          modelProvider: null,
          cwd: input.cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          config: threadConfig,
          baseInstructions: null,
          developerInstructions: null,
          personality: null,
          ephemeral: true,
          experimentalRawEvents: false,
          dynamicTools: null,
          persistExtendedHistory: false,
        });

        activeThreadId = parseThreadIdFromStartResult(startedThread);
        if (!activeThreadId) {
          throw new Error("thread/start did not return a valid thread id");
        }

        const startedTurn = await input.client.startTurn({
          threadId: activeThreadId,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
          cwd: null,
          approvalPolicy: null,
          sandboxPolicy: null,
          model: null,
          effort: null,
          summary: "auto",
          personality: null,
          outputSchema: input.schema,
          collaborationMode: null,
        });

        activeTurnId = parseTurnIdFromStartResult(startedTurn);
        if (!activeTurnId) {
          throw new Error("turn/start did not return a valid turn id");
        }
      })().catch((error) => {
        fail(error);
      });
    });
  }

  private async generateThreadTitleWithStructuredTurn(input: {
    prompt: string;
    cwd: string | null;
    client: StructuredThreadTitleClient;
  }): Promise<string | null> {
    const userPrompt = input.prompt.trim();
    if (!userPrompt) return null;

    const promptTemplate = this.readThreadTitlePromptTemplate();
    if (!promptTemplate) return null;

    const truncatedPrompt = userPrompt.length > THREAD_TITLE_PROMPT_MAX_CHARS
      ? userPrompt.slice(0, THREAD_TITLE_PROMPT_MAX_CHARS)
      : userPrompt;
    const titlePrompt = this.buildThreadTitleGenerationPrompt(promptTemplate, truncatedPrompt);

    return await this.runStructuredThreadTitle({
      prompt: titlePrompt,
      cwd: input.cwd,
      model: THREAD_TITLE_MODEL,
      effort: THREAD_TITLE_REASONING_EFFORT,
      schema: THREAD_TITLE_SCHEMA,
      config: { web_search: "disabled" },
      timeoutMs: THREAD_TITLE_TIMEOUT_MS,
      client: input.client,
      parse: parseGeneratedThreadTitleResponse,
    });
  }

  private async generateThreadTitleViaAdapter(input: GenerateThreadTitleAdapterInput): Promise<string | null> {
    return await this.generateThreadTitleWithStructuredTurn({
      prompt: input.prompt,
      cwd: input.cwd,
      client: {
        startThread: (params) => input.appServerConnection.startThread(params),
        startTurn: (params) => input.appServerConnection.startTurn(params),
        interruptTurn: (params) => input.appServerConnection.interruptTurn(params),
        onNotification: (handler) => input.appServerConnection.registerInternalNotificationHandler(handler),
      },
    });
  }

  private async generateThreadTitleForPrompt(firstPrompt: string, cwd: string): Promise<string | null> {
    return await this.generateThreadTitleViaAdapter({
      prompt: firstPrompt,
      cwd,
      appServerConnection: {
        startThread: (params) => this.client.request("thread/start", params as ThreadStartParams),
        startTurn: (params) => this.client.request("turn/start", params as TurnStartParams),
        interruptTurn: (params) => this.client.request("turn/interrupt", params),
        registerInternalNotificationHandler: (handler) => {
          this.client.on("notification", handler);
          return () => {
            this.client.off("notification", handler);
          };
        },
      },
    });
  }

  private queueGeneratedThreadTitle(input: { threadId: string; firstPrompt: string; cwd: string }): void {
    const firstPrompt = input.firstPrompt.trim();
    if (!firstPrompt) return;

    void (async () => {
      const initialLink = getCodexCardThreadLink(input.threadId);
      if (!initialLink) return;
      if (initialLink.threadName?.trim()) return;

      const generatedTitle = await this.generateThreadTitleForPrompt(firstPrompt, input.cwd);
      if (!generatedTitle) return;

      const latestLink = getCodexCardThreadLink(input.threadId);
      if (!latestLink) return;
      if (latestLink.threadName?.trim()) return;

      await this.client.request("thread/name/set", {
        threadId: input.threadId,
        name: generatedTitle,
      });

      const updated = updateCodexThreadName(input.threadId, generatedTitle);
      if (updated) {
        this.emitEvent({ type: "threadSummary", thread: updated });
      }
    })().catch((error) => {
      this.emitEvent({
        type: "error",
        message: `Could not auto-generate thread title for ${input.threadId}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async readThreadAfterStart(threadId: string): Promise<CodexThreadDetail | null> {
    let startReadError: unknown;

    try {
      return await this.readThread(threadId, true);
    } catch (error) {
      if (!isRolloutMaterializationError(error)) throw error;
      startReadError = error;
    }

    try {
      const fallback = await this.readThread(threadId, false);
      if (fallback) return fallback;
    } catch (fallbackError) {
      if (!isRolloutMaterializationError(fallbackError)) throw fallbackError;
    }

    const serialized = this.serializeThreadDetail(threadId);
    if (serialized) return serialized;

    throw startReadError instanceof Error
      ? startReadError
      : new Error("Thread was created but could not be loaded");
  }

  async startThreadForCard(input: CodexThreadStartForCardInput): Promise<CodexThreadDetail> {
    await this.ensureClientReady();

    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("Thread start requires a non-empty prompt");
    }
    const explicitThreadName = input.threadName?.trim() || null;
    const startedAt = Date.now();

    this.logger.info("Starting Codex thread for card", {
      projectId: input.projectId,
      cardId: input.cardId,
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? this.getPermissionMode(input.projectId),
      reasoningEffort: input.reasoningEffort ?? null,
      collaborationMode: input.collaborationMode ?? null,
      worktreeStartMode: input.worktreeStartMode ?? null,
      hasExplicitThreadName: Boolean(explicitThreadName),
      promptLength: prompt.length,
      promptPreview: previewText(prompt),
    });

    let hasThreadStartProgress = false;
    try {
      const runLocation = await this.resolveThreadRunLocation({
        projectId: input.projectId,
        cardId: input.cardId,
        threadTitle: explicitThreadName,
        worktreeStartMode: input.worktreeStartMode,
        worktreeBranchPrefix: input.worktreeBranchPrefix,
        onProgress: (update) => {
          hasThreadStartProgress = true;
          this.emitThreadStartProgress({
            projectId: input.projectId,
            cardId: input.cardId,
            phase: update.phase,
            message: update.message,
            stream: update.stream,
            outputDelta: update.outputDelta,
            clearOutput: update.clearOutput,
          });
        },
      });
      const permissionMode = input.permissionMode ?? this.getPermissionMode(input.projectId);
      const turnPermissionOverrides = this.buildTurnPermissionOverrides(permissionMode, runLocation.cwd);
      this.logger.info("Resolved Codex thread run location", {
        projectId: input.projectId,
        cardId: input.cardId,
        cwd: runLocation.cwd,
        runInTarget: runLocation.runInTarget,
        createdManagedWorktree: runLocation.createdManagedWorktree,
      });

      if (runLocation.createdManagedWorktree) {
        this.emitThreadStartProgress({
          projectId: input.projectId,
          cardId: input.cardId,
          phase: "startingThread",
          message: "Starting thread in prepared worktree.",
          stream: "info",
          outputDelta: "[info] Starting thread\n",
        });
      }

      const threadStartParams: ThreadStartParams = {
        cwd: runLocation.cwd,
        model: input.model ?? null,
        experimentalRawEvents: THREAD_START_EXPERIMENTAL_RAW_EVENTS,
        persistExtendedHistory: THREAD_START_PERSIST_EXTENDED_HISTORY,
      };
      const threadStart = await this.client.request<"thread/start", ThreadStartResponse>("thread/start", threadStartParams);

      const link = this.upsertLinkFromThread(threadStart.thread, {
        projectId: input.projectId,
        cardId: input.cardId,
        cwd: runLocation.cwd,
      }, runLocation.cwd);

      if (!link) {
        throw new Error("Codex thread/start returned an invalid thread payload");
      }

      this.logger.info("Created Codex thread", {
        projectId: input.projectId,
        cardId: input.cardId,
        threadId: link.threadId,
        cwd: runLocation.cwd,
      });

      if (explicitThreadName) {
        await this.client.request("thread/name/set", {
          threadId: link.threadId,
          name: explicitThreadName,
        });
        updateCodexThreadName(link.threadId, explicitThreadName);
      }

      const collaborationMode = this.buildCollaborationModePayload({
        collaborationMode: input.collaborationMode,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });

      const turnStartParams: TurnStartParams = {
        threadId: link.threadId,
        input: [createTextUserInput(prompt)],
        cwd: runLocation.cwd,
        ...turnPermissionOverrides,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      };
      const turnStart = await this.client.request<"turn/start", TurnStartResponse>("turn/start", turnStartParams);
      const startedTurn = this.asTurnSummary(link.threadId, turnStart.turn);
      if (startedTurn) {
        this.mergeTurn(link.threadId, startedTurn);
        const optimisticUserItem = this.seedTurnWithOptimisticUserMessage(link.threadId, startedTurn.turnId, prompt);
        this.persistThreadSnapshot(link.threadId);
        this.emitEvent({ type: "itemUpsert", item: optimisticUserItem });
        this.logger.info("Started first Codex turn", {
          threadId: link.threadId,
          turnId: startedTurn.turnId,
          durationMs: Date.now() - startedAt,
        });
      }
      this.markThreadAsActive(link.threadId);

      const detail = await this.readThreadAfterStart(link.threadId);
      if (!detail) {
        throw new Error("Thread was created but could not be loaded");
      }

      if (!explicitThreadName) {
        this.queueGeneratedThreadTitle({
          threadId: link.threadId,
          firstPrompt: prompt,
          cwd: runLocation.cwd,
        });
      }

      if (runLocation.createdManagedWorktree) {
        this.emitThreadStartProgress({
          projectId: input.projectId,
          cardId: input.cardId,
          phase: "ready",
          message: "Worktree ready.",
          stream: "info",
          outputDelta: "[info] Worktree ready.\n",
        });
      }

      this.logger.info("Codex thread for card is ready", {
        threadId: link.threadId,
        projectId: input.projectId,
        cardId: input.cardId,
        durationMs: Date.now() - startedAt,
      });
      return detail;
    } catch (error) {
      this.logger.error("Failed to start Codex thread for card", {
        projectId: input.projectId,
        cardId: input.cardId,
        durationMs: Date.now() - startedAt,
        error,
      });
      if (hasThreadStartProgress) {
        const detail = error instanceof Error ? error.message : String(error);
        this.emitThreadStartProgress({
          projectId: input.projectId,
          cardId: input.cardId,
          phase: "failed",
          message: "Worktree setup failed.",
          stream: "stderr",
          outputDelta: `[stderr] ${detail}\n`,
        });
      }
      throw error;
    }
  }

  async readThread(threadId: string, includeTurns = true): Promise<CodexThreadDetail | null> {
    await this.ensureClientReady();
    try {
      return await this.readThreadWithTurnsFlag(threadId, includeTurns);
    } catch (error) {
      if (!includeTurns || !isRolloutMaterializationError(error)) throw error;
      return this.readThreadWithTurnsFlag(threadId, false);
    }
  }

  private async readThreadWithTurnsFlag(
    threadId: string,
    includeTurns: boolean,
  ): Promise<CodexThreadDetail | null> {
    const result = await this.client.request<"thread/read", ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns,
    });

    this.upsertLinkFromThread(result.thread);
    const liveDetail = this.buildThreadDetailFromRead(result.thread);
    const mergedDetail = this.mergeWithPersistedSnapshot(threadId, liveDetail);
    if (!mergedDetail) return null;
    const reconciledDetail = this.reconcileDetailItemsToTerminalTurnStatus(mergedDetail);

    this.hydrateThreadDetail(reconciledDetail);
    this.persistThreadSnapshot(threadId);
    return reconciledDetail;
  }

  async resumeThread(threadId: string): Promise<CodexThreadDetail | null> {
    await this.ensureClientReady();
    this.logger.info("Resuming Codex thread", { threadId });

    const resumeParams: ThreadResumeParams = {
      threadId,
      persistExtendedHistory: THREAD_RESUME_PERSIST_EXTENDED_HISTORY,
    };
    await this.client.request("thread/resume", resumeParams);

    return this.readThread(threadId, true);
  }

  async setThreadName(threadId: string, name: string): Promise<boolean> {
    await this.ensureClientReady();
    await this.client.request("thread/name/set", {
      threadId,
      name,
    });

    updateCodexThreadName(threadId, name);
    const updated = getCodexCardThreadLink(threadId);
    if (updated) {
      this.emitEvent({ type: "threadSummary", thread: updated });
    }
    return true;
  }

  async archiveThread(threadId: string): Promise<boolean> {
    await this.ensureClientReady();
    await this.client.request("thread/archive", { threadId });
    updateCodexThreadArchived(threadId, true);
    this.emitEvent({ type: "threadArchivedState", threadId, archived: true });
    return true;
  }

  async unarchiveThread(threadId: string): Promise<CodexThreadSummary | null> {
    await this.ensureClientReady();
    const result = await this.client.request<"thread/unarchive", ThreadUnarchiveResponse>("thread/unarchive", { threadId });

    const summary = this.upsertLinkFromThread(result.thread) ?? updateCodexThreadArchived(threadId, false);
    if (summary) {
      this.emitEvent({ type: "threadSummary", thread: summary });
      this.emitEvent({ type: "threadArchivedState", threadId, archived: false });
    }

    return summary;
  }

  async startTurn(
    threadId: string,
    prompt: string,
    overrides?: StartTurnOverrides,
  ): Promise<CodexTurnSummary | null> {
    await this.ensureClientReady();

    const promptText = prompt.trim();
    if (!promptText) {
      throw new Error("Turn start requires a non-empty prompt");
    }

    const threadRef = this.parseThreadRef(threadId);
    const workspacePath = threadRef?.cwd?.trim()
      || (threadRef ? this.parseWorkspacePath(threadRef.projectId) : null);
    const permissionMode = overrides?.permissionMode ?? this.getPermissionMode(threadRef?.projectId ?? null);
    const turnPermissionOverrides = this.buildTurnPermissionOverrides(permissionMode, workspacePath);
    const collaborationMode = this.buildCollaborationModePayload({
      collaborationMode: overrides?.collaborationMode,
      model: overrides?.model,
      reasoningEffort: overrides?.reasoningEffort,
    });
    const startedAt = Date.now();

    this.logger.info("Starting Codex turn", {
      threadId,
      projectId: threadRef?.projectId ?? null,
      cardId: threadRef?.cardId ?? null,
      cwd: workspacePath,
      permissionMode,
      model: overrides?.model ?? null,
      reasoningEffort: overrides?.reasoningEffort ?? null,
      collaborationMode: overrides?.collaborationMode ?? null,
      promptLength: promptText.length,
      promptPreview: previewText(promptText),
    });

    const startTurnRequest = () => {
      const turnStartParams: TurnStartParams = {
        threadId,
        ...(workspacePath ? { cwd: workspacePath } : {}),
        ...turnPermissionOverrides,
        ...(overrides?.model ? { model: overrides.model } : {}),
        ...(overrides?.reasoningEffort ? { effort: overrides.reasoningEffort } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
        input: [createTextUserInput(promptText)],
      };
      return this.client.request<"turn/start", TurnStartResponse>("turn/start", turnStartParams);
    };

    let turnStartResult: TurnStartResponse;
    try {
      turnStartResult = await startTurnRequest();
    } catch (error) {
      if (!isThreadNotFoundError(error)) throw error;

      this.logger.warn("Codex turn start hit missing thread; attempting resume", { threadId, error });
      await this.client.request("thread/resume", {
        threadId,
        persistExtendedHistory: THREAD_RESUME_PERSIST_EXTENDED_HISTORY,
      });
      turnStartResult = await startTurnRequest();
    }

    const startedTurn = this.asTurnSummary(threadId, turnStartResult.turn);
    if (startedTurn) {
      this.mergeTurn(threadId, startedTurn);
      const optimisticUserItem = this.seedTurnWithOptimisticUserMessage(threadId, startedTurn.turnId, promptText);
      this.persistThreadSnapshot(threadId);
      this.markThreadAsActive(threadId);
      this.emitEvent({ type: "itemUpsert", item: optimisticUserItem });
      this.logger.info("Started Codex turn", {
        threadId,
        turnId: startedTurn.turnId,
        durationMs: Date.now() - startedAt,
      });
      return startedTurn;
    }

    this.markThreadAsActive(threadId);
    const detail = await this.readThread(threadId, true);
    if (!detail || detail.turns.length === 0) return null;
    this.logger.info("Started Codex turn via fallback thread read", {
      threadId,
      durationMs: Date.now() - startedAt,
    });
    return detail.turns[detail.turns.length - 1];
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string,
    prompt: string,
    optimisticItemId?: string,
  ): Promise<{ turnId: string } | null> {
    await this.ensureClientReady();

    const promptText = prompt.trim();
    if (!promptText) {
      throw new Error("Turn steer requires a non-empty prompt");
    }

    this.logger.info("Steering Codex turn", {
      threadId,
      expectedTurnId,
      promptLength: promptText.length,
      promptPreview: previewText(promptText),
      optimisticItemId: optimisticItemId ?? null,
    });

    const steerParams: TurnSteerParams = {
      threadId,
      expectedTurnId,
      input: [createTextUserInput(promptText)],
    };
    const result = await this.client.request<"turn/steer", TurnSteerResponse>("turn/steer", steerParams);

    if (typeof result.turnId !== "string") {
      this.logger.warn("Codex turn steer returned no turn id", { threadId, expectedTurnId });
      return null;
    }
    const optimisticUserItem = this.seedTurnWithOptimisticUserMessage(
      threadId,
      result.turnId,
      promptText,
      optimisticItemId,
    );
    this.persistThreadSnapshot(threadId);
    this.emitEvent({ type: "itemUpsert", item: optimisticUserItem });
    this.logger.info("Steered Codex turn", {
      threadId,
      expectedTurnId,
      turnId: result.turnId,
    });
    return { turnId: result.turnId };
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<boolean> {
    await this.ensureClientReady();

    const resolvedTurnId = await this.resolveInterruptTurnId(threadId, turnId);
    if (!resolvedTurnId) {
      throw new Error("Could not determine which turn to interrupt");
    }

    this.logger.warn("Interrupting Codex turn", {
      threadId,
      requestedTurnId: turnId ?? null,
      resolvedTurnId,
    });

    await this.client.request("turn/interrupt", {
      threadId,
      turnId: resolvedTurnId,
    });

    const knownTurn = this.getKnownTurn(threadId, resolvedTurnId);
    if (!knownTurn || knownTurn.status !== "inProgress") {
      return true;
    }

    const interruptedTurn: CodexTurnSummary = {
      ...knownTurn,
      status: "interrupted",
    };
    this.mergeTurn(threadId, interruptedTurn);
    this.syncThreadStatusFromKnownTurns(threadId);
    const reconciledItems = this.reconcileTurnItemsToTerminalStatus(threadId, resolvedTurnId, "interrupted");
    this.persistThreadSnapshot(threadId);
    this.emitEvent({ type: "turn", turn: interruptedTurn });
    for (const item of reconciledItems) {
      this.emitEvent({ type: "itemUpsert", item });
    }
    return true;
  }

  async respondToApproval(requestId: string, decision: CodexApprovalDecision): Promise<boolean> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;

    this.logger.info("Resolving Codex approval request", {
      requestId,
      decision,
      kind: pending.request.kind,
      threadId: pending.request.threadId,
      turnId: pending.request.turnId,
    });
    pending.resolve({ decision });
    this.pendingApprovals.delete(requestId);
    this.emitEvent({ type: "approvalResolved", requestId, decision });
    return true;
  }

  async respondToUserInput(
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<boolean> {
    const pending = this.pendingUserInputs.get(requestId);
    if (!pending) return false;

    const normalizedAnswers = Object.entries(answers).reduce<Record<string, { answers: string[] }>>(
      (acc, [questionId, values]) => {
        if (!Array.isArray(values)) {
          acc[questionId] = { answers: [] };
          return acc;
        }
        acc[questionId] = {
          answers: values.filter((value): value is string => typeof value === "string"),
        };
        return acc;
      },
      {},
    );
    const transcriptAnswers = Object.entries(normalizedAnswers).reduce<Record<string, string[]>>((acc, [questionId, value]) => {
      acc[questionId] = value.answers;
      return acc;
    }, {});

    pending.resolve({ answers: normalizedAnswers });
    this.pendingUserInputs.delete(requestId);
    this.logger.info("Resolving Codex user-input request", {
      requestId,
      threadId: pending.request.threadId,
      turnId: pending.request.turnId,
      questionCount: pending.request.questions.length,
      answeredQuestionCount: Object.keys(normalizedAnswers).length,
    });
    const resolvedItem = this.upsertResolvedUserInputItem(pending.request, transcriptAnswers);
    if (resolvedItem) {
      this.persistThreadSnapshot(pending.request.threadId);
      this.emitEvent({ type: "itemUpsert", item: resolvedItem });
    }
    this.emitEvent({ type: "userInputResolved", requestId });
    return true;
  }

  private upsertResolvedUserInputItem(
    request: CodexUserInputRequest,
    answers: Record<string, string[]>,
  ): CodexItemView | null {
    const key = `${request.threadId}:${request.turnId}`;
    const byItem = this.itemByThreadTurn.get(key) ?? new Map<string, CodexItemView>();
    const itemKey = resolveCodexItemPrimaryIdentityKey({
      turnId: request.turnId,
      itemId: request.itemId,
    });
    const existing = byItem.get(itemKey);
    const existingRawItem = asRecord(existing?.rawItem);
    const questionCount = request.questions.length;
    const now = Date.now();
    const next: CodexItemView = {
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      type: existing?.type ?? "request_user_input",
      normalizedKind: "userInputRequest",
      status: "completed",
      markdownText: questionCount === 1 ? "Asked 1 question" : `Asked ${questionCount} questions`,
      userInputQuestions: request.questions,
      userInputAnswers: answers,
      rawItem: {
        ...(existingRawItem ?? {}),
        id: request.itemId,
        type: existing?.type ?? "request_user_input",
        questions: request.questions,
        answers,
        status: "completed",
      },
      createdAt: existing?.createdAt ?? request.createdAt,
      updatedAt: now,
    };

    byItem.set(itemKey, existing ? mergeCodexItemView(existing, next) : next);
    this.itemByThreadTurn.set(key, byItem);
    return byItem.get(itemKey) ?? null;
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
    this.logger.info("Handling Codex server request", {
      requestId: String(request.id),
      method: request.method,
    });

    if (request.method === "item/commandExecution/requestApproval") {
      return this.handleApprovalRequest(
        String(request.id),
        request.params as CommandExecutionRequestApprovalParams,
        "command",
      );
    }

    if (request.method === "item/fileChange/requestApproval") {
      return this.handleApprovalRequest(
        String(request.id),
        request.params as FileChangeRequestApprovalParams,
        "file",
      );
    }

    if (request.method === "item/tool/requestUserInput") {
      return this.handleRequestUserInput(String(request.id), request.params as ToolRequestUserInputParams);
    }

    if (request.method === "item/tool/call") {
      throw new Error("Dynamic tool calls are not supported in this Nodex release");
    }

    throw new Error(`Unsupported server request method: ${request.method}`);
  }

  private async handleApprovalRequest(
    requestId: string,
    params: CommandExecutionRequestApprovalParams | FileChangeRequestApprovalParams,
    kind: "command" | "file",
  ): Promise<CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse> {
    const threadId = params.threadId;
    const turnId = params.turnId;
    const itemId = params.itemId;

    if (!threadId || !turnId || !itemId) {
      return { decision: "decline" as const };
    }

    const ref = this.parseThreadRef(threadId);

    const payload: CodexApprovalRequest = {
      requestId,
      kind,
      projectId: ref?.projectId ?? null,
      cardId: ref?.cardId ?? null,
      threadId,
      turnId,
      itemId,
      reason: params.reason ?? undefined,
      command: "command" in params ? params.command ?? undefined : undefined,
      cwd: "cwd" in params ? params.cwd ?? undefined : undefined,
      createdAt: Date.now(),
    };

    const mode = this.getPermissionMode(ref?.projectId ?? null);
    this.logger.info("Received Codex approval request", {
      requestId,
      kind,
      projectId: payload.projectId,
      cardId: payload.cardId,
      threadId,
      turnId,
      itemId,
      mode,
      command: payload.command ?? null,
      cwd: payload.cwd ?? null,
      reason: payload.reason ?? null,
    });
    if (mode === "full-access") {
      this.logger.warn("Auto-accepting Codex approval request due to full-access mode", {
        requestId,
        kind,
        threadId,
        turnId,
      });
      this.emitEvent({ type: "approvalResolved", requestId, decision: "accept" });
      return { decision: "accept" };
    }

    this.emitEvent({ type: "approvalRequested", request: payload });

    return await new Promise<CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse>((resolve, reject) => {
      this.pendingApprovals.set(requestId, {
        request: payload,
        resolve,
        reject,
      });
    });
  }

  private async handleRequestUserInput(
    requestId: string,
    params: ToolRequestUserInputParams,
  ): Promise<ToolRequestUserInputResponse> {
    const threadId = params.threadId;
    const turnId = params.turnId;
    const itemId = params.itemId;

    if (!threadId || !turnId || !itemId) {
      throw new Error("Invalid tool request_user_input payload");
    }

    const ref = this.parseThreadRef(threadId);
    const questions = params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther,
      isSecret: question.isSecret,
      options: question.options?.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    }));

    const payload: CodexUserInputRequest = {
      requestId,
      projectId: ref?.projectId ?? null,
      cardId: ref?.cardId ?? null,
      threadId,
      turnId,
      itemId,
      questions,
      createdAt: Date.now(),
    };

    this.logger.info("Received Codex user-input request", {
      requestId,
      projectId: payload.projectId,
      cardId: payload.cardId,
      threadId,
      turnId,
      itemId,
      questionCount: questions.length,
      questionIds: questions.map((question) => question.id),
    });
    this.emitEvent({ type: "userInputRequested", request: payload });

    return await new Promise<{ answers: Record<string, { answers: string[] }> }>((resolve, reject) => {
      this.pendingUserInputs.set(requestId, {
        request: payload,
        resolve,
        reject,
      });
    });
  }

  private upsertStreamingItemDelta(input: {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    type: "agentMessage" | "plan";
  }): void {
    const key = `${input.threadId}:${input.turnId}`;
    const byItem = this.itemByThreadTurn.get(key) ?? new Map<string, CodexItemView>();
    const itemKey = resolveCodexItemPrimaryIdentityKey({
      turnId: input.turnId,
      itemId: input.itemId,
    });
    const now = Date.now();
    const existing = byItem.get(itemKey);
    const nextText = `${existing?.markdownText ?? ""}${input.delta}`;
    const next: CodexItemView = existing
      ? {
          ...existing,
          markdownText: nextText,
          updatedAt: now,
        }
      : {
          threadId: input.threadId,
          turnId: input.turnId,
          itemId: input.itemId,
          type: input.type,
          role: "assistant",
          normalizedKind: input.type === "plan" ? "plan" : "assistantMessage",
          markdownText: input.delta,
          createdAt: now,
          updatedAt: now,
        };

    byItem.set(itemKey, next);
    this.itemByThreadTurn.set(key, byItem);
    this.persistThreadSnapshot(input.threadId);
    this.emitEvent({ type: "itemUpsert", item: next });
    this.emitEvent({
      type: "itemDelta",
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId,
      delta: input.delta,
    });
  }

  private resolvePendingServerRequest(requestId: string): void {
    let emittedApprovalResolved = false;
    let emittedUserInputResolved = false;

    this.logger.info("Resolving pending Codex server request from server notification", {
      requestId,
      pendingApproval: this.pendingApprovals.has(requestId),
      pendingUserInput: this.pendingUserInputs.has(requestId),
    });

    const pendingApproval = this.pendingApprovals.get(requestId);
    if (pendingApproval) {
      pendingApproval.resolve({ decision: "cancel" });
      this.pendingApprovals.delete(requestId);
      this.emitEvent({ type: "approvalResolved", requestId, decision: "cancel" });
      emittedApprovalResolved = true;
    }

    const pendingUserInput = this.pendingUserInputs.get(requestId);
    if (pendingUserInput) {
      pendingUserInput.resolve({ answers: {} });
      this.pendingUserInputs.delete(requestId);
      this.emitEvent({ type: "userInputResolved", requestId });
      emittedUserInputResolved = true;
    }

    if (!emittedApprovalResolved) {
      this.emitEvent({ type: "approvalResolved", requestId, decision: "cancel" });
    }
    if (!emittedUserInputResolved) {
      this.emitEvent({ type: "userInputResolved", requestId });
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (method === "thread/started") {
      const thread =
        typeof params === "object" && params !== null
          ? (params as Record<string, unknown>).thread
          : null;

      const summary = this.upsertLinkFromThread(thread);
      if (summary) {
        this.logger.info("Received Codex thread started notification", {
          threadId: summary.threadId,
          projectId: summary.projectId,
          cardId: summary.cardId,
        });
        this.emitEvent({ type: "threadSummary", thread: summary });
      }
      return;
    }

    if (method === "thread/status/changed") {
      const payload =
        typeof params === "object" && params !== null
          ? params as Record<string, unknown>
          : null;

      if (!payload || typeof payload.threadId !== "string") return;

      const parsed = parseThreadStatus(payload.status);
      this.logger.info("Received Codex thread status change", {
        threadId: payload.threadId,
        statusType: parsed.statusType,
        statusActiveFlags: parsed.statusActiveFlags,
      });
      const updated = updateCodexThreadStatus(payload.threadId, parsed.statusType, parsed.statusActiveFlags);
      if (updated) {
        this.emitEvent({ type: "threadSummary", thread: updated });
      }
      this.emitEvent({
        type: "threadStatus",
        threadId: payload.threadId,
        statusType: parsed.statusType,
        statusActiveFlags: parsed.statusActiveFlags,
      });
      return;
    }

    if (method === "thread/archived" || method === "thread/unarchived") {
      const payload =
        typeof params === "object" && params !== null
          ? params as Record<string, unknown>
          : null;
      if (!payload || typeof payload.threadId !== "string") return;
      const archived = method === "thread/archived";
      this.logger.info("Received Codex thread archived state change", {
        threadId: payload.threadId,
        archived,
      });
      const updated = updateCodexThreadArchived(payload.threadId, archived);
      if (updated) {
        this.emitEvent({ type: "threadSummary", thread: updated });
      }
      this.emitEvent({ type: "threadArchivedState", threadId: payload.threadId, archived });
      return;
    }

    if (method === "thread/name/updated") {
      const payload =
        typeof params === "object" && params !== null
          ? params as Record<string, unknown>
          : null;
      if (!payload || typeof payload.threadId !== "string") return;
      const name = typeof payload.threadName === "string" ? payload.threadName : null;
      const updated = updateCodexThreadName(payload.threadId, name);
      if (updated) {
        this.emitEvent({ type: "threadSummary", thread: updated });
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const payload = asRecord(params);
      if (!payload || typeof payload.threadId !== "string" || typeof payload.turnId !== "string") return;

      const tokenUsage = parseThreadTokenUsage(payload.tokenUsage ?? payload.token_usage);
      if (!tokenUsage) return;

      const turn = this.getKnownTurn(payload.threadId, payload.turnId) ?? {
        threadId: payload.threadId,
        turnId: payload.turnId,
        status: "inProgress" as const,
        itemIds: [],
      };

      const nextTurn: CodexTurnSummary = {
        ...turn,
        tokenUsage,
      };

      this.mergeTurn(payload.threadId, nextTurn);
      this.persistThreadSnapshot(payload.threadId);
      this.emitEvent({ type: "turn", turn: nextTurn });
      return;
    }

    if (
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "turn/interrupted" ||
      method === "turn/failed"
    ) {
      const payload =
        typeof params === "object" && params !== null
          ? params as Record<string, unknown>
          : null;
      if (!payload) return;

      const fallbackStatus = resolveNotificationTurnStatus(method);
      const turnRecord = (() => {
        if (typeof payload.turn === "object" && payload.turn !== null) {
          return { ...(payload.turn as Record<string, unknown>) };
        }
        if (typeof payload.turnId === "string") {
          return {
            id: payload.turnId,
            status: payload.status,
          } as Record<string, unknown>;
        }
        return null;
      })();
      if (!turnRecord) return;
      if (!Object.prototype.hasOwnProperty.call(turnRecord, "status")) {
        turnRecord.status = payload.status;
      }
      if (turnRecord.status === undefined && fallbackStatus) {
        turnRecord.status = fallbackStatus;
      }

      const threadId =
        typeof payload.threadId === "string"
          ? payload.threadId
          : typeof turnRecord.threadId === "string"
            ? turnRecord.threadId
            : null;
      if (!threadId) return;

      const turn = this.asTurnSummary(threadId, turnRecord);
      if (!turn) return;
      this.logger.info("Received Codex turn lifecycle notification", {
        threadId,
        turnId: turn.turnId,
        status: turn.status,
      });
      this.mergeTurn(threadId, turn);
      this.syncThreadStatusFromKnownTurns(threadId);
      const reconciledItems = this.reconcileTurnItemsToTerminalStatus(threadId, turn.turnId, turn.status);
      this.persistThreadSnapshot(threadId);
      this.emitEvent({ type: "turn", turn });
      for (const item of reconciledItems) {
        this.emitEvent({ type: "itemUpsert", item });
      }
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const payload =
        typeof params === "object" && params !== null
          ? params as Record<string, unknown>
          : null;
      if (!payload) return;
      if (typeof payload.threadId !== "string" || typeof payload.turnId !== "string") return;

      const lifecycleStatus = method === "item/started" ? "inProgress" as const : "completed" as const;
      const normalizedItem = normalizeThreadItem(payload.item, payload.threadId, payload.turnId);
      if (!normalizedItem) return;
      const item = normalizedItem.status
        ? normalizedItem
        : {
            ...normalizedItem,
            status: lifecycleStatus,
          };
      this.mergeItem(item);
      this.persistThreadSnapshot(payload.threadId);
      this.emitEvent({ type: "itemUpsert", item });
      return;
    }

    if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      const payload =
        typeof params === "object" && params !== null
          ? params as Record<string, unknown>
          : null;
      if (!payload) return;
      if (
        typeof payload.threadId !== "string" ||
        typeof payload.turnId !== "string" ||
        typeof payload.itemId !== "string" ||
        typeof payload.delta !== "string"
      ) {
        return;
      }
      this.upsertStreamingItemDelta({
        threadId: payload.threadId,
        turnId: payload.turnId,
        itemId: payload.itemId,
        delta: payload.delta,
        type: method === "item/plan/delta" ? "plan" : "agentMessage",
      });
      return;
    }

    if (method === "serverRequest/resolved") {
      const payload = asRecord(params);
      const requestId = payload?.requestId ?? payload?.request_id;
      if (requestId === undefined || requestId === null) return;
      this.resolvePendingServerRequest(String(requestId));
      return;
    }

    if (method === "account/rateLimits/updated") {
      const payload =
        typeof params === "object" && params !== null
          ? params as Record<string, unknown>
          : null;

      const parsed = parseRateLimitsSnapshot(payload?.rateLimits ?? null);
      this.accountSnapshot = {
        ...this.accountSnapshot,
        rateLimits: parsed,
      };
      this.emitEvent({ type: "rateLimits", rateLimits: parsed });
      this.emitEvent({ type: "account", account: this.accountSnapshot });
      return;
    }

    if (method === "account/updated") {
      await this.readAccountSnapshot().catch(() => {
        // keep previous state
      });
      return;
    }

    if (method === "account/login/completed") {
      this.accountSnapshot = {
        ...this.accountSnapshot,
        pendingLogin: null,
      };
      this.emitEvent({ type: "account", account: this.accountSnapshot });
      await this.readAccountSnapshot().catch(() => {
        // keep previous state
      });
      return;
    }

    if (method === "error") {
      const payload =
        typeof params === "object" && params !== null
          ? params as Record<string, unknown>
          : null;
      const message =
        typeof payload?.error === "object" && payload.error !== null
          ? typeof (payload.error as Record<string, unknown>).message === "string"
            ? (payload.error as Record<string, unknown>).message as string
            : "Codex error"
          : "Codex error";
      this.emitEvent({ type: "error", message });
    }
  }

  serializeThreadDetail(threadId: string): CodexThreadDetail | null {
    const link = getCodexCardThreadLink(threadId);
    if (!link) return null;

    const inMemoryTurns = Array.from(this.turnByThread.get(threadId)?.values() ?? []);

    const inMemoryItems: CodexItemView[] = [];
    for (const turn of inMemoryTurns) {
      const key = `${threadId}:${turn.turnId}`;
      const byItem = this.itemByThreadTurn.get(key);
      if (!byItem) continue;
      const ordered = Array.from(byItem.values()).sort((a, b) => a.createdAt - b.createdAt);
      inMemoryItems.push(...ordered);
    }

    const sessionDetail = readCodexSessionThreadDetail({
      threadId,
      link,
    });
    const snapshot = sessionDetail ? null : getCodexThreadSnapshot(threadId);
    const recoveredTurns = mergeTurnSummaries(sessionDetail?.turns ?? [], snapshot?.turns ?? []);
    const recoveredItems = mergeItemViews(sessionDetail?.items ?? [], snapshot?.items ?? []);
    const turns = mergeTurnSummaries(inMemoryTurns, recoveredTurns);
    const items = mergeItemViews(inMemoryItems, recoveredItems);

    return {
      ...link,
      threadName: sessionDetail?.threadName ?? link.threadName,
      threadPreview: sessionDetail?.threadPreview || link.threadPreview,
      cwd: sessionDetail?.cwd ?? link.cwd,
      updatedAt: Math.max(link.updatedAt, sessionDetail?.updatedAt ?? 0, snapshot?.updatedAt ?? 0),
      turns,
      items,
    };
  }
}

export const codexService = new CodexService();

export function isRetryableCodexError(error: unknown): boolean {
  return error instanceof CodexRpcError && error.retryable;
}
