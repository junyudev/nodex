import type {
  CodexItemView,
  CodexItemNormalizedKind,
  CodexThreadActiveFlag,
  CodexThreadStatusType,
  CodexThreadSummary,
  CodexThreadTokenUsage,
  CodexTokenUsageBreakdown,
  CodexTurnStatus,
  CodexTurnSummary,
  CodexUserInputQuestion,
} from "../../shared/types";
import { getDb } from "../kanban/db-service";

interface DbCodexCardThread {
  project_id: string;
  card_id: string;
  thread_id: string;
  thread_name: string | null;
  thread_preview: string;
  model_provider: string;
  cwd: string | null;
  status_type: string;
  status_active_flags_json: string;
  archived: number;
  created_at: number;
  updated_at: number;
  linked_at: string;
}

interface DbCodexThreadSnapshot {
  thread_id: string;
  turns_json: string;
  items_json: string;
  updated_at: number;
}

export interface UpsertCodexCardThreadInput {
  projectId: string;
  cardId: string;
  threadId: string;
  threadName?: string | null;
  threadPreview?: string;
  modelProvider?: string;
  cwd?: string | null;
  statusType?: CodexThreadStatusType;
  statusActiveFlags?: CodexThreadActiveFlag[];
  archived?: boolean;
  createdAt?: number;
  updatedAt?: number;
  linkedAt?: string;
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexTurnSummary[];
  items: CodexItemView[];
  updatedAt: number;
}

export interface UpsertCodexThreadSnapshotInput {
  threadId: string;
  turns: CodexTurnSummary[];
  items: CodexItemView[];
  updatedAt?: number;
}

function isStatusType(value: string): value is CodexThreadStatusType {
  return value === "notLoaded" || value === "idle" || value === "systemError" || value === "active";
}

function isTurnStatus(value: unknown): value is CodexTurnStatus {
  return value === "inProgress" || value === "completed" || value === "interrupted" || value === "failed";
}

function isItemNormalizedKind(value: unknown): value is CodexItemNormalizedKind {
  return (
    value === "userMessage" ||
    value === "assistantMessage" ||
    value === "reasoning" ||
    value === "plan" ||
    value === "userInputRequest" ||
    value === "commandExecution" ||
    value === "fileChange" ||
    value === "toolCall" ||
    value === "systemEvent"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
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

function parseUserInputQuestions(value: unknown): CodexUserInputQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const questions = value.reduce<CodexUserInputQuestion[]>((acc, entry) => {
    const candidate = asRecord(entry);
    if (!candidate) return acc;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.header !== "string" ||
      typeof candidate.question !== "string"
    ) {
      return acc;
    }

    const options = Array.isArray(candidate.options)
      ? candidate.options.reduce<NonNullable<CodexUserInputQuestion["options"]>>((optionAcc, option) => {
        const parsed = asRecord(option);
        if (!parsed) return optionAcc;
        if (typeof parsed.label !== "string" || typeof parsed.description !== "string") {
          return optionAcc;
        }
        optionAcc.push({
          label: parsed.label,
          description: parsed.description,
        });
        return optionAcc;
      }, [])
      : undefined;

    acc.push({
      id: candidate.id,
      header: candidate.header,
      question: candidate.question,
      isOther: Boolean(candidate.isOther),
      isSecret: Boolean(candidate.isSecret),
      options,
    });
    return acc;
  }, []);

  return questions.length > 0 ? questions : undefined;
}

function parseUserInputAnswers(value: unknown): Record<string, string[]> | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;

  const answers = Object.entries(candidate).reduce<Record<string, string[]>>((acc, [questionId, rawValue]) => {
    if (Array.isArray(rawValue)) {
      acc[questionId] = rawValue.filter((entry): entry is string => typeof entry === "string");
      return acc;
    }

    const nested = asRecord(rawValue);
    if (!nested || !Array.isArray(nested.answers)) return acc;
    acc[questionId] = nested.answers.filter((entry): entry is string => typeof entry === "string");
    return acc;
  }, {});

  return Object.keys(answers).length > 0 ? answers : undefined;
}

function parseTurns(raw: string): CodexTurnSummary[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.reduce<CodexTurnSummary[]>((acc, value) => {
      const candidate = asRecord(value);
      if (!candidate) return acc;

      const threadId = candidate.threadId;
      const turnId = candidate.turnId;
      if (typeof threadId !== "string" || typeof turnId !== "string") return acc;

      const status = isTurnStatus(candidate.status) ? candidate.status : "inProgress";
      const itemIds = Array.isArray(candidate.itemIds)
        ? candidate.itemIds.filter((itemId): itemId is string => typeof itemId === "string")
        : [];
      const errorMessage = typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined;
      const tokenUsage = parseThreadTokenUsage(candidate.tokenUsage ?? candidate.token_usage);

      acc.push({
        threadId,
        turnId,
        status,
        errorMessage,
        itemIds,
        tokenUsage,
      });
      return acc;
    }, []);
  } catch {
    return [];
  }
}

function parseItems(raw: string): CodexItemView[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.reduce<CodexItemView[]>((acc, value) => {
      const candidate = asRecord(value);
      if (!candidate) return acc;

      const threadId = candidate.threadId;
      const turnId = candidate.turnId;
      const itemId = candidate.itemId;
      const type = candidate.type;
      const createdAt = candidate.createdAt;
      const updatedAt = candidate.updatedAt;

      if (
        typeof threadId !== "string" ||
        typeof turnId !== "string" ||
        typeof itemId !== "string" ||
        typeof type !== "string" ||
        typeof createdAt !== "number" ||
        !Number.isFinite(createdAt) ||
        typeof updatedAt !== "number" ||
        !Number.isFinite(updatedAt)
      ) {
        return acc;
      }

      const normalizedKind = isItemNormalizedKind(candidate.normalizedKind)
        ? candidate.normalizedKind
        : null;
      const role = candidate.role === "assistant" || candidate.role === "user" ? candidate.role : undefined;
      if (!normalizedKind) return acc;

      acc.push({
        threadId,
        turnId,
        itemId,
        type,
        normalizedKind,
        status: isTurnStatus(candidate.status) ? candidate.status : undefined,
        role,
        toolCall: asRecord(candidate.toolCall) ? (candidate.toolCall as CodexItemView["toolCall"]) : undefined,
        markdownText: typeof candidate.markdownText === "string" ? candidate.markdownText : undefined,
        userInputQuestions: parseUserInputQuestions(candidate.userInputQuestions),
        userInputAnswers: parseUserInputAnswers(candidate.userInputAnswers),
        rawItem: candidate.rawItem,
        createdAt,
        updatedAt,
      });
      return acc;
    }, []);
  } catch {
    return [];
  }
}

function parseStatusActiveFlags(raw: string): CodexThreadActiveFlag[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is CodexThreadActiveFlag =>
        value === "waitingOnApproval" || value === "waitingOnUserInput",
    );
  } catch {
    return [];
  }
}

function rowToSummary(row: DbCodexCardThread): CodexThreadSummary {
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    cardId: row.card_id,
    threadName: row.thread_name,
    threadPreview: row.thread_preview,
    modelProvider: row.model_provider,
    cwd: row.cwd,
    statusType: isStatusType(row.status_type) ? row.status_type : "notLoaded",
    statusActiveFlags: parseStatusActiveFlags(row.status_active_flags_json),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedAt: row.linked_at,
  };
}

export function upsertCodexCardThreadLink(input: UpsertCodexCardThreadInput): CodexThreadSummary {
  const database = getDb();
  const nowMs = Date.now();
  const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : nowMs;
  const updatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : nowMs;
  const linkedAt = input.linkedAt || new Date().toISOString();

  database.prepare(`
    INSERT INTO codex_card_threads (
      project_id,
      card_id,
      thread_id,
      thread_name,
      thread_preview,
      model_provider,
      cwd,
      status_type,
      status_active_flags_json,
      archived,
      created_at,
      updated_at,
      linked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id = excluded.project_id,
      card_id = excluded.card_id,
      thread_name = excluded.thread_name,
      thread_preview = excluded.thread_preview,
      model_provider = excluded.model_provider,
      cwd = excluded.cwd,
      status_type = excluded.status_type,
      status_active_flags_json = excluded.status_active_flags_json,
      archived = excluded.archived,
      updated_at = excluded.updated_at,
      linked_at = excluded.linked_at
  `).run(
    input.projectId,
    input.cardId,
    input.threadId,
    input.threadName ?? null,
    input.threadPreview ?? "",
    input.modelProvider ?? "",
    input.cwd ?? null,
    input.statusType ?? "notLoaded",
    JSON.stringify(input.statusActiveFlags ?? []),
    input.archived ? 1 : 0,
    createdAt,
    updatedAt,
    linkedAt,
  );

  const record = getCodexCardThreadLink(input.threadId);
  if (!record) {
    throw new Error(`Could not read persisted Codex thread link ${input.threadId}`);
  }
  return record;
}

export function getCodexCardThreadLink(threadId: string): CodexThreadSummary | null {
  const database = getDb();
  const row = database.prepare(
    "SELECT * FROM codex_card_threads WHERE thread_id = ?"
  ).get(threadId) as DbCodexCardThread | undefined;
  if (!row) return null;
  return rowToSummary(row);
}

export function listCodexProjectThreads(
  projectId: string,
  opts?: { cardId?: string; includeArchived?: boolean },
): CodexThreadSummary[] {
  const database = getDb();
  const includeArchived = opts?.includeArchived === true;
  const byCard = opts?.cardId;

  if (byCard) {
    const rows = database.prepare(`
      SELECT * FROM codex_card_threads
      WHERE project_id = ?
        AND card_id = ?
        AND (? = 1 OR archived = 0)
      ORDER BY updated_at DESC
    `).all(projectId, byCard, includeArchived ? 1 : 0) as DbCodexCardThread[];
    return rows.map(rowToSummary);
  }

  const rows = database.prepare(`
    SELECT * FROM codex_card_threads
    WHERE project_id = ?
      AND (? = 1 OR archived = 0)
    ORDER BY updated_at DESC
  `).all(projectId, includeArchived ? 1 : 0) as DbCodexCardThread[];

  return rows.map(rowToSummary);
}

export function listCodexThreadLinks(opts?: { includeArchived?: boolean }): CodexThreadSummary[] {
  const database = getDb();
  const includeArchived = opts?.includeArchived === true;

  const rows = database.prepare(`
    SELECT * FROM codex_card_threads
    WHERE (? = 1 OR archived = 0)
    ORDER BY updated_at DESC
  `).all(includeArchived ? 1 : 0) as DbCodexCardThread[];

  return rows.map(rowToSummary);
}

export function updateCodexThreadName(threadId: string, threadName: string | null): CodexThreadSummary | null {
  const database = getDb();
  const result = database.prepare(
    "UPDATE codex_card_threads SET thread_name = ?, updated_at = ? WHERE thread_id = ?"
  ).run(threadName, Date.now(), threadId);

  if (result.changes === 0) return null;
  return getCodexCardThreadLink(threadId);
}

export function updateCodexThreadArchived(threadId: string, archived: boolean): CodexThreadSummary | null {
  const database = getDb();
  const result = database.prepare(
    "UPDATE codex_card_threads SET archived = ?, updated_at = ? WHERE thread_id = ?"
  ).run(archived ? 1 : 0, Date.now(), threadId);

  if (result.changes === 0) return null;
  return getCodexCardThreadLink(threadId);
}

export function updateCodexThreadStatus(
  threadId: string,
  statusType: CodexThreadStatusType,
  statusActiveFlags: CodexThreadActiveFlag[],
): CodexThreadSummary | null {
  const database = getDb();
  const result = database.prepare(
    "UPDATE codex_card_threads SET status_type = ?, status_active_flags_json = ?, updated_at = ? WHERE thread_id = ?"
  ).run(statusType, JSON.stringify(statusActiveFlags), Date.now(), threadId);

  if (result.changes === 0) return null;
  return getCodexCardThreadLink(threadId);
}

export function unlinkCodexThread(threadId: string): boolean {
  const database = getDb();
  const result = database
    .prepare("DELETE FROM codex_card_threads WHERE thread_id = ?")
    .run(threadId);

  return result.changes > 0;
}

export function upsertCodexThreadSnapshot(input: UpsertCodexThreadSnapshotInput): CodexThreadSnapshot {
  const database = getDb();
  const updatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now();

  database.prepare(`
    INSERT INTO codex_thread_snapshots (
      thread_id,
      turns_json,
      items_json,
      updated_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      turns_json = excluded.turns_json,
      items_json = excluded.items_json,
      updated_at = excluded.updated_at
  `).run(
    input.threadId,
    JSON.stringify(input.turns),
    JSON.stringify(input.items),
    updatedAt,
  );

  const snapshot = getCodexThreadSnapshot(input.threadId);
  if (!snapshot) {
    throw new Error(`Could not read persisted Codex thread snapshot ${input.threadId}`);
  }
  return snapshot;
}

export function getCodexThreadSnapshot(threadId: string): CodexThreadSnapshot | null {
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM codex_thread_snapshots WHERE thread_id = ?")
    .get(threadId) as DbCodexThreadSnapshot | undefined;
  if (!row) return null;

  return {
    threadId: row.thread_id,
    turns: parseTurns(row.turns_json),
    items: parseItems(row.items_json),
    updatedAt: row.updated_at,
  };
}

export function deleteCodexThreadSnapshot(threadId: string): boolean {
  const database = getDb();
  const result = database
    .prepare("DELETE FROM codex_thread_snapshots WHERE thread_id = ?")
    .run(threadId);
  return result.changes > 0;
}
