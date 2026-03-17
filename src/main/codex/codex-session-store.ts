import fs from "node:fs";
import path from "node:path";
import type {
  CodexItemView,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexThreadTokenUsage,
  CodexTokenUsageBreakdown,
  CodexToolCallSubtype,
  CodexTurnSummary,
} from "../../shared/types";

interface SessionIndexEntry {
  id: string;
  threadName: string | null;
  updatedAt: number | null;
}

interface SessionFileMatch {
  filePath: string;
  archived: boolean;
}

interface SessionThreadMaterializationInput {
  threadId: string;
  link: CodexThreadSummary;
}

interface ParsedSessionLine {
  timestamp: number;
  type: string;
  payload: Record<string, unknown> | null;
}

interface MutableTurnRecord {
  threadId: string;
  turnId: string;
  status: CodexTurnSummary["status"];
  errorMessage?: string;
  itemIds: string[];
  tokenUsage?: CodexThreadTokenUsage;
  createdAt: number;
  updatedAt: number;
}

const sessionFileCache = new Map<string, SessionFileMatch | null>();
const sessionIndexCache = new Map<string, SessionIndexEntry>();
let sessionIndexLoadedFromPath: string | null = null;
let sessionFileCacheHome: string | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;
  return process.cwd();
}

function resolveCodexHomeDir(): string {
  const envCodexHome = process.env.CODEX_HOME?.trim();
  if (envCodexHome) return envCodexHome;
  return path.join(resolveHomeDir(), ".codex");
}

function parseSessionIndexEntry(rawLine: string): SessionIndexEntry | null {
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    const candidate = asRecord(parsed);
    if (!candidate || typeof candidate.id !== "string") return null;
    return {
      id: candidate.id,
      threadName: typeof candidate.thread_name === "string"
        ? candidate.thread_name
        : typeof candidate.threadName === "string"
          ? candidate.threadName
          : null,
      updatedAt: parseIsoTimestamp(candidate.updated_at ?? candidate.updatedAt),
    };
  } catch {
    return null;
  }
}

function loadSessionIndexIfNeeded(): void {
  const indexPath = path.join(resolveCodexHomeDir(), "session_index.jsonl");
  if (sessionIndexLoadedFromPath === indexPath) return;

  sessionIndexCache.clear();
  sessionIndexLoadedFromPath = indexPath;

  if (!fs.existsSync(indexPath)) return;

  const raw = fs.readFileSync(indexPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = parseSessionIndexEntry(trimmed);
    if (!entry) continue;
    sessionIndexCache.set(entry.id, entry);
  }
}

function readSessionIndexEntry(threadId: string): SessionIndexEntry | null {
  loadSessionIndexIfNeeded();
  return sessionIndexCache.get(threadId) ?? null;
}

function resolveSessionSearchRoots(): SessionFileMatch[] {
  const codexHome = resolveCodexHomeDir();
  if (sessionFileCacheHome !== codexHome) {
    sessionFileCache.clear();
    sessionFileCacheHome = codexHome;
  }
  return [
    { filePath: path.join(codexHome, "sessions"), archived: false },
    { filePath: path.join(codexHome, "archived_sessions"), archived: true },
  ];
}

function findSessionFileInDirectory(directoryPath: string, threadId: string, archived: boolean): SessionFileMatch | null {
  if (!fs.existsSync(directoryPath)) return null;

  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nested = findSessionFileInDirectory(entryPath, threadId, archived);
      if (nested) return nested;
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("rollout-")) continue;
    if (!entry.name.includes(threadId)) continue;
    if (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl")) continue;
    return { filePath: entryPath, archived };
  }

  return null;
}

function resolveSessionFile(threadId: string): SessionFileMatch | null {
  if (sessionFileCache.has(threadId)) {
    return sessionFileCache.get(threadId) ?? null;
  }

  for (const root of resolveSessionSearchRoots()) {
    const match = findSessionFileInDirectory(root.filePath, threadId, root.archived);
    if (!match) continue;
    sessionFileCache.set(threadId, match);
    return match;
  }

  sessionFileCache.set(threadId, null);
  return null;
}

export function hasCodexSessionMaterialized(threadId: string): boolean {
  const match = resolveSessionFile(threadId);
  if (!match) return false;

  try {
    return fs.statSync(match.filePath).size > 0;
  } catch {
    return false;
  }
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

function parseTokenUsage(value: unknown): CodexThreadTokenUsage | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;

  const total = parseTokenUsageBreakdown(candidate.total ?? candidate.total_token_usage);
  const last = parseTokenUsageBreakdown(candidate.last ?? candidate.last_token_usage);
  if (!total || !last) return undefined;

  const modelContextWindow = candidate.modelContextWindow ?? candidate.model_context_window;
  return {
    total,
    last,
    modelContextWindow: modelContextWindow === null ? null : parseFiniteNumber(modelContextWindow),
  };
}

function parseTimestampFromLine(rawLine: string, fallback: number): number {
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    const candidate = asRecord(parsed);
    return parseIsoTimestamp(candidate?.timestamp) ?? fallback;
  } catch {
    return fallback;
  }
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function extractMessageText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;

  const parts = content.reduce<string[]>((acc, part) => {
    const candidate = asRecord(part);
    if (!candidate) return acc;
    if (typeof candidate.text === "string" && candidate.text.trim().length > 0) {
      acc.push(candidate.text);
    }
    return acc;
  }, []);

  if (parts.length === 0) return null;
  return normalizeText(parts.join("\n\n"));
}

function resolveToolSubtype(toolName: string): CodexToolCallSubtype {
  if (toolName === "exec_command") return "command";
  if (toolName === "apply_patch") return "fileChange";
  if (toolName.includes("search")) return "webSearch";
  return "generic";
}

function ensureTurn(
  turnsById: Map<string, MutableTurnRecord>,
  threadId: string,
  turnId: string,
  createdAt: number,
): MutableTurnRecord {
  const existing = turnsById.get(turnId);
  if (existing) {
    existing.createdAt = Math.min(existing.createdAt, createdAt);
    existing.updatedAt = Math.max(existing.updatedAt, createdAt);
    return existing;
  }

  const turn: MutableTurnRecord = {
    threadId,
    turnId,
    status: "completed",
    itemIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  turnsById.set(turnId, turn);
  return turn;
}

function addItemToTurn(turn: MutableTurnRecord, itemId: string, timestamp: number): void {
  if (!turn.itemIds.includes(itemId)) {
    turn.itemIds.push(itemId);
  }
  turn.updatedAt = Math.max(turn.updatedAt, timestamp);
}

function sortTurns(turnsById: Map<string, MutableTurnRecord>): CodexTurnSummary[] {
  return [...turnsById.values()]
    .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt || a.turnId.localeCompare(b.turnId))
    .map((turn) => ({
      threadId: turn.threadId,
      turnId: turn.turnId,
      status: turn.status,
      errorMessage: turn.errorMessage,
      itemIds: turn.itemIds,
      tokenUsage: turn.tokenUsage,
    }));
}

function finalizeThreadPreview(items: CodexItemView[], fallback: string): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    const candidate = normalizeText(item.markdownText ?? "");
    if (!candidate) continue;
    return candidate;
  }
  return fallback;
}

function parseSessionJsonl(
  raw: string,
  input: SessionThreadMaterializationInput,
  fileMatch: SessionFileMatch,
): CodexThreadDetail | null {
  const fallbackTimestamp = input.link.updatedAt || Date.now();
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const turnsById = new Map<string, MutableTurnRecord>();
  const items: CodexItemView[] = [];
  const toolIndexByCallId = new Map<string, number>();
  const sessionIndexEntry = readSessionIndexEntry(input.threadId);

  let currentTurnId = `turn-${input.threadId}`;
  let sessionTimestamp = fallbackTimestamp;
  let sessionCwd = input.link.cwd;
  let lastUpdatedAt = fallbackTimestamp;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    let parsedLine: ParsedSessionLine | null = null;
    try {
      const parsed = JSON.parse(rawLine) as unknown;
      const candidate = asRecord(parsed);
      if (!candidate || typeof candidate.type !== "string") continue;
      const timestamp = parseIsoTimestamp(candidate.timestamp) ?? parseTimestampFromLine(rawLine, fallbackTimestamp);
      parsedLine = {
        timestamp,
        type: candidate.type,
        payload: asRecord(candidate.payload),
      };
    } catch {
      continue;
    }

    const { timestamp, type, payload } = parsedLine;
    lastUpdatedAt = Math.max(lastUpdatedAt, timestamp);

    if (type === "session_meta") {
      const metaTimestamp = parseIsoTimestamp(payload?.timestamp);
      if (metaTimestamp !== null) {
        sessionTimestamp = metaTimestamp;
      }
      if (typeof payload?.cwd === "string" && payload.cwd.trim().length > 0) {
        sessionCwd = payload.cwd;
      }
      continue;
    }

    if (type === "event_msg") {
      const eventType = payload?.type;
      if (eventType === "task_started") {
        if (typeof payload?.turn_id === "string" && payload.turn_id.trim().length > 0) {
          currentTurnId = payload.turn_id;
        }
        ensureTurn(turnsById, input.threadId, currentTurnId, timestamp).status = "inProgress";
        continue;
      }

      if (eventType === "token_count") {
        const turn = ensureTurn(turnsById, input.threadId, currentTurnId, timestamp);
        const tokenUsage = parseTokenUsage(payload?.info);
        if (tokenUsage) {
          turn.tokenUsage = tokenUsage;
        }
        if (turn.status === "inProgress") {
          turn.status = "completed";
        }
        continue;
      }

      if (eventType === "agent_message" && typeof payload?.message === "string" && payload.message.trim().length > 0) {
        const turn = ensureTurn(turnsById, input.threadId, currentTurnId, timestamp);
        const itemId = `msg-${input.threadId}-${lineIndex}`;
        addItemToTurn(turn, itemId, timestamp);
        items.push({
          threadId: input.threadId,
          turnId: turn.turnId,
          itemId,
          type: "agentMessage",
          normalizedKind: "assistantMessage",
          role: "assistant",
          markdownText: normalizeText(payload.message),
          status: "completed",
          createdAt: timestamp,
          updatedAt: timestamp,
          rawItem: payload,
        });
      }
      continue;
    }

    if (type !== "response_item" || !payload) continue;

    const responseType = payload.type;
    const turn = ensureTurn(turnsById, input.threadId, currentTurnId, timestamp);

    if (responseType === "message") {
      const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
      if (!role) continue;
      const text = extractMessageText(payload.content);
      if (!text) continue;
      const itemId = `msg-${input.threadId}-${lineIndex}`;
      addItemToTurn(turn, itemId, timestamp);
      items.push({
        threadId: input.threadId,
        turnId: turn.turnId,
        itemId,
        type: role === "user" ? "userMessage" : "agentMessage",
        normalizedKind: role === "user" ? "userMessage" : "assistantMessage",
        role,
        markdownText: text,
        status: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
        rawItem: payload,
      });
      if (turn.status === "inProgress") {
        turn.status = "completed";
      }
      continue;
    }

    if (responseType === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? payload.summary.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];
      if (summary.length === 0) continue;
      const itemId = `reasoning-${input.threadId}-${lineIndex}`;
      addItemToTurn(turn, itemId, timestamp);
      items.push({
        threadId: input.threadId,
        turnId: turn.turnId,
        itemId,
        type: "reasoning",
        normalizedKind: "reasoning",
        markdownText: summary.join("\n"),
        status: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
        rawItem: payload,
      });
      if (turn.status === "inProgress") {
        turn.status = "completed";
      }
      continue;
    }

    if (responseType === "function_call" || responseType === "web_search_call") {
      const toolName = typeof payload.name === "string"
        ? payload.name
        : responseType === "web_search_call"
          ? "web_search"
          : "tool";
      const itemId = typeof payload.call_id === "string" && payload.call_id.trim().length > 0
        ? payload.call_id
        : `tool-${input.threadId}-${lineIndex}`;
      const item: CodexItemView = {
        threadId: input.threadId,
        turnId: turn.turnId,
        itemId,
        type: responseType,
        normalizedKind: responseType === "web_search_call" ? "toolCall" : "toolCall",
        status: "inProgress",
        toolCall: {
          subtype: responseType === "web_search_call" ? "webSearch" : resolveToolSubtype(toolName),
          toolName,
          args: parseJsonString(payload.arguments),
        },
        createdAt: timestamp,
        updatedAt: timestamp,
        rawItem: payload,
      };
      addItemToTurn(turn, itemId, timestamp);
      toolIndexByCallId.set(itemId, items.length);
      items.push(item);
      continue;
    }

    if (responseType === "function_call_output") {
      const callId = typeof payload.call_id === "string" && payload.call_id.trim().length > 0
        ? payload.call_id
        : `tool-output-${input.threadId}-${lineIndex}`;
      const existingIndex = toolIndexByCallId.get(callId);
      if (existingIndex !== undefined) {
        const existing = items[existingIndex];
        if (existing) {
          items[existingIndex] = {
            ...existing,
            status: "completed",
            updatedAt: timestamp,
            toolCall: existing.toolCall
              ? {
                  ...existing.toolCall,
                  result: parseJsonString(payload.output),
                }
              : undefined,
          };
          addItemToTurn(turn, callId, timestamp);
        }
        if (turn.status === "inProgress") {
          turn.status = "completed";
        }
        continue;
      }

      const itemId = callId;
      addItemToTurn(turn, itemId, timestamp);
      items.push({
        threadId: input.threadId,
        turnId: turn.turnId,
        itemId,
        type: "function_call_output",
        normalizedKind: "toolCall",
        status: "completed",
        toolCall: {
          subtype: "generic",
          toolName: "tool",
          result: parseJsonString(payload.output),
        },
        createdAt: timestamp,
        updatedAt: timestamp,
        rawItem: payload,
      });
      if (turn.status === "inProgress") {
        turn.status = "completed";
      }
    }
  }

  const turns = sortTurns(turnsById);
  if (turns.length === 0) return null;

  const updatedAt = sessionIndexEntry?.updatedAt ?? lastUpdatedAt;
  return {
    ...input.link,
    threadName: sessionIndexEntry?.threadName ?? input.link.threadName,
    threadPreview: finalizeThreadPreview(items, input.link.threadPreview),
    cwd: sessionCwd,
    archived: input.link.archived || fileMatch.archived,
    createdAt: input.link.createdAt || sessionTimestamp,
    updatedAt: updatedAt ?? input.link.updatedAt,
    turns,
    items,
  };
}

function parseLegacySessionJson(
  raw: string,
  input: SessionThreadMaterializationInput,
  fileMatch: SessionFileMatch,
): CodexThreadDetail | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const root = asRecord(parsed);
    if (!root) return null;

    const session = asRecord(root.session);
    const sessionTimestamp = parseIsoTimestamp(session?.timestamp) ?? input.link.updatedAt ?? Date.now();
    const turnId = `turn-${input.threadId}`;
    const items: CodexItemView[] = [];
    const itemIds: string[] = [];

    const rawItems = Array.isArray(root.items) ? root.items : [];
    rawItems.forEach((entry, index) => {
      const item = asRecord(entry);
      if (!item) return;
      const role = item.role === "user" || item.role === "assistant" ? item.role : null;
      if (!role) return;
      const text = extractMessageText(item.content);
      if (!text) return;
      const itemId = `msg-${input.threadId}-${index}`;
      itemIds.push(itemId);
      items.push({
        threadId: input.threadId,
        turnId,
        itemId,
        type: role === "user" ? "userMessage" : "agentMessage",
        normalizedKind: role === "user" ? "userMessage" : "assistantMessage",
        role,
        markdownText: text,
        status: "completed",
        createdAt: sessionTimestamp + index,
        updatedAt: sessionTimestamp + index,
        rawItem: item,
      });
    });

    if (items.length === 0) return null;

    const sessionIndexEntry = readSessionIndexEntry(input.threadId);
    return {
      ...input.link,
      threadName: sessionIndexEntry?.threadName ?? input.link.threadName,
      threadPreview: finalizeThreadPreview(items, input.link.threadPreview),
      archived: input.link.archived || fileMatch.archived,
      createdAt: input.link.createdAt || sessionTimestamp,
      updatedAt: sessionIndexEntry?.updatedAt ?? items[items.length - 1]?.updatedAt ?? sessionTimestamp,
      turns: [{
        threadId: input.threadId,
        turnId,
        status: "completed",
        itemIds,
      }],
      items,
    };
  } catch {
    return null;
  }
}

export function readCodexSessionThreadDetail(
  input: SessionThreadMaterializationInput,
): CodexThreadDetail | null {
  const match = resolveSessionFile(input.threadId);
  if (!match) return null;

  try {
    const raw = fs.readFileSync(match.filePath, "utf8");
    if (!raw.trim()) return null;

    if (match.filePath.endsWith(".jsonl")) {
      return parseSessionJsonl(raw, input, match);
    }

    return parseLegacySessionJson(raw, input, match);
  } catch {
    return null;
  }
}

export function resetCodexSessionStoreCaches(): void {
  sessionFileCache.clear();
  sessionIndexCache.clear();
  sessionFileCacheHome = null;
  sessionIndexLoadedFromPath = null;
}
