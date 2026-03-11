import Database from "better-sqlite3";
import type { Card } from "../../shared/types";
import type {
  HistoryEntry as PublicHistoryEntry,
  HistoryPanelDescriptionDelta,
  HistoryPanelEntry as PublicHistoryPanelEntry,
  HistoryPanelFieldChange,
  HistoryPanelSnapshot,
  HistoryPanelSnapshotField,
} from "../../shared/ipc-api";
import { getDb } from "./db-service";
import { dbNotifier } from "./db-notifier";
import { getHistoryRetention } from "./config";
import * as descriptionRevisionService from "./description-revision-service";

export type HistoryOperation = "create" | "update" | "delete" | "move";

interface HistoryEntry extends PublicHistoryEntry {
  previousDescriptionRevisionId: number | null;
  newDescriptionRevisionId: number | null;
  snapshotDescriptionRevisionId: number | null;
}

export type StoredHistoryEntry = PublicHistoryEntry;
export type StoredHistoryPanelEntry = PublicHistoryPanelEntry;

const FIELD_ORDER = [
  "title",
  "description",
  "priority",
  "estimate",
  "tags",
  "dueDate",
  "scheduledStart",
  "scheduledEnd",
  "isAllDay",
  "assignee",
  "agentBlocked",
  "agentStatus",
  "order",
  "created",
  "id",
];

interface DbHistoryRow {
  id: number;
  project_id: string;
  operation: string;
  card_id: string;
  column_id: string;
  timestamp: string;
  previous_values: string | null;
  new_values: string | null;
  from_column_id: string | null;
  to_column_id: string | null;
  from_order: number | null;
  to_order: number | null;
  card_snapshot: string | null;
  previous_description_revision_id: number | null;
  new_description_revision_id: number | null;
  snapshot_description_revision_id: number | null;
  session_id: string | null;
  group_id: string | null;
  is_undone: number;
  undo_of: number | null;
}

interface DbCard {
  id: string;
  project_id: string;
  column_id: string;
  title: string;
  description: string;
  description_revision_id: number | null;
  priority: string;
  estimate: string | null;
  tags: string;
  due_date: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  is_all_day: number;
  recurrence_json: string | null;
  reminders_json: string;
  schedule_timezone: string | null;
  assignee: string | null;
  agent_blocked: number;
  agent_status: string | null;
  run_in_target: string;
  run_in_local_path: string | null;
  run_in_base_branch: string | null;
  run_in_worktree_path: string | null;
  run_in_environment_path: string | null;
  revision: number;
  created: string;
  order: number;
}

// getDb imported from db-service.ts (shared module-level singleton)

function dbCardToCard(row: DbCard): Card {
  const runInTarget = row.run_in_target === "new_worktree"
    ? "newWorktree"
    : row.run_in_target === "cloud"
      ? "cloud"
      : "localProject";
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority as Card["priority"],
    estimate: (row.estimate as Card["estimate"]) || undefined,
    tags: JSON.parse(row.tags) as string[],
    dueDate: row.due_date ? new Date(row.due_date) : undefined,
    scheduledStart: row.scheduled_start ? new Date(row.scheduled_start) : undefined,
    scheduledEnd: row.scheduled_end ? new Date(row.scheduled_end) : undefined,
    isAllDay: row.is_all_day === 1,
    recurrence: row.recurrence_json ? JSON.parse(row.recurrence_json) : undefined,
    reminders: row.reminders_json ? (JSON.parse(row.reminders_json) as Card["reminders"]) : [],
    scheduleTimezone: row.schedule_timezone || undefined,
    assignee: row.assignee || undefined,
    agentBlocked: row.agent_blocked === 1,
    agentStatus: row.agent_status || undefined,
    runInTarget,
    runInLocalPath: row.run_in_local_path || undefined,
    runInBaseBranch: row.run_in_base_branch || undefined,
    runInWorktreePath: row.run_in_worktree_path || undefined,
    runInEnvironmentPath: row.run_in_environment_path || undefined,
    revision: row.revision,
    created: new Date(row.created),
    order: row.order,
  };
}

function parseHistoryDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

function toDateOnlyString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split("T")[0];
  if (typeof value === "string") return value.split("T")[0];
  return null;
}

function toIsoStringOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function toRunInTargetDbValue(value: Card["runInTarget"]): string {
  if (value === "newWorktree") return "new_worktree";
  if (value === "cloud") return "cloud";
  return "local_project";
}

function rowToHistoryEntry(database: Database.Database, row: DbHistoryRow): HistoryEntry {
  const previousValues = row.previous_values
    ? JSON.parse(row.previous_values) as Record<string, unknown>
    : null;
  const newValues = row.new_values
    ? JSON.parse(row.new_values) as Record<string, unknown>
    : null;
  if (previousValues && row.previous_description_revision_id !== null) {
    previousValues.description = descriptionRevisionService.reconstructDescription(
      database,
      row.previous_description_revision_id,
    );
  }
  if (newValues && row.new_description_revision_id !== null) {
    newValues.description = descriptionRevisionService.reconstructDescription(
      database,
      row.new_description_revision_id,
    );
  }

  const cardSnapshot = row.card_snapshot
    ? ({
        revision: 1,
        ...(JSON.parse(row.card_snapshot) as Record<string, unknown>),
        description: row.snapshot_description_revision_id !== null
          ? descriptionRevisionService.reconstructDescription(
            database,
            row.snapshot_description_revision_id,
          )
          : "",
      } as Card)
    : null;

  return {
    id: row.id,
    projectId: row.project_id,
    operation: row.operation as HistoryOperation,
    cardId: row.card_id,
    columnId: row.column_id,
    timestamp: row.timestamp,
    previousValues,
    newValues,
    fromColumnId: row.from_column_id,
    toColumnId: row.to_column_id,
    fromOrder: row.from_order,
    toOrder: row.to_order,
    cardSnapshot,
    previousDescriptionRevisionId: row.previous_description_revision_id,
    newDescriptionRevisionId: row.new_description_revision_id,
    snapshotDescriptionRevisionId: row.snapshot_description_revision_id,
    sessionId: row.session_id,
    groupId: row.group_id,
    isUndone: row.is_undone === 1,
    undoOf: row.undo_of,
  };
}

function cardToSnapshot(card: Card): string {
  const rest = { ...card };
  delete (rest as Partial<Card>).description;
  return JSON.stringify({
    ...rest,
    dueDate: rest.dueDate?.toISOString(),
    scheduledStart: rest.scheduledStart?.toISOString(),
    scheduledEnd: rest.scheduledEnd?.toISOString(),
    created: rest.created.toISOString(),
  });
}

function stripDescription<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const rest = { ...value };
  delete rest.description;
  return rest;
}

function toPublicHistoryEntry(entry: HistoryEntry): StoredHistoryEntry {
  return {
    id: entry.id,
    projectId: entry.projectId,
    operation: entry.operation,
    cardId: entry.cardId,
    columnId: entry.columnId,
    timestamp: entry.timestamp,
    previousValues: entry.previousValues,
    newValues: entry.newValues,
    fromColumnId: entry.fromColumnId,
    toColumnId: entry.toColumnId,
    fromOrder: entry.fromOrder,
    toOrder: entry.toOrder,
    cardSnapshot: entry.cardSnapshot,
    sessionId: entry.sessionId,
    groupId: entry.groupId,
    isUndone: entry.isUndone,
    undoOf: entry.undoOf,
  };
}

function toHistoryPanelEntry(
  database: Database.Database,
  row: DbHistoryRow,
): StoredHistoryPanelEntry {
  const previousValues = parseHistoryValues(row.previous_values);
  const newValues = parseHistoryValues(row.new_values);
  const snapshotValues = parseHistoryValues(row.card_snapshot);
  const fieldChanges = buildFieldChanges(previousValues, newValues);
  const snapshot = buildSnapshot(database, snapshotValues, row.snapshot_description_revision_id);
  const descriptionChange = descriptionRevisionService.buildDescriptionDeltaView(
    database,
    row.previous_description_revision_id,
    row.new_description_revision_id,
  );

  return {
    id: row.id,
    projectId: row.project_id,
    operation: row.operation as HistoryOperation,
    cardId: row.card_id,
    columnId: row.column_id,
    timestamp: row.timestamp,
    sessionId: row.session_id,
    groupId: row.group_id,
    isUndone: row.is_undone === 1,
    undoOf: row.undo_of,
    summary: describePanelEntry(
      row.operation as HistoryOperation,
      fieldChanges,
      descriptionChange,
      row.from_column_id,
      row.to_column_id,
      snapshot,
    ),
    fieldChanges,
    move: row.operation === "move"
      ? {
          fromColumnId: row.from_column_id,
          toColumnId: row.to_column_id,
          fromOrder: row.from_order,
          toOrder: row.to_order,
        }
      : null,
    descriptionChange,
    snapshot,
  };
}

function parseHistoryValues(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  return JSON.parse(raw) as Record<string, unknown>;
}

function buildFieldChanges(
  previousValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null,
): HistoryPanelFieldChange[] {
  const previousKeys = Object.keys(previousValues ?? {});
  const newKeys = Object.keys(newValues ?? {});
  const merged = new Set([...previousKeys, ...newKeys]);

  return [...merged]
    .sort(compareFieldKeys)
    .map((field) => ({
      field,
      before: previousValues?.[field],
      after: newValues?.[field],
    }));
}

function buildSnapshot(
  database: Database.Database,
  snapshotValues: Record<string, unknown> | null,
  snapshotDescriptionRevisionId: number | null,
): HistoryPanelSnapshot | null {
  if (!snapshotValues && snapshotDescriptionRevisionId === null) return null;

  const orderedFields = snapshotValues
    ? Object.keys(snapshotValues).sort(compareFieldKeys)
    : [];

  const fields: HistoryPanelSnapshotField[] = orderedFields.map((field) => ({
    field,
    value: snapshotValues?.[field],
  }));

  return {
    fields,
    description: descriptionRevisionService.buildDescriptionSnapshotView(
      database,
      snapshotDescriptionRevisionId,
    ),
  };
}

function compareFieldKeys(left: string, right: string): number {
  const leftIndex = FIELD_ORDER.indexOf(left);
  const rightIndex = FIELD_ORDER.indexOf(right);
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
  if (leftIndex === -1) return 1;
  if (rightIndex === -1) return -1;
  return leftIndex - rightIndex;
}

function describePanelEntry(
  operation: HistoryOperation,
  fieldChanges: HistoryPanelFieldChange[],
  descriptionChange: HistoryPanelDescriptionDelta | null,
  fromColumnId: string | null,
  toColumnId: string | null,
  snapshot: HistoryPanelSnapshot | null,
): string | null {
  if (operation === "update") {
    if (descriptionChange && fieldChanges.length === 0) {
      return `Description: ${describeBlockChangeSummary(descriptionChange)}`;
    }

    if (descriptionChange) {
      return `Description + ${fieldChanges.length} field${fieldChanges.length > 1 ? "s" : ""}`;
    }

    if (fieldChanges.length === 1) {
      return `Changed ${fieldChanges[0]?.field ?? "field"}`;
    }

    if (fieldChanges.length > 1) {
      return `Changed ${fieldChanges.length} fields`;
    }

    return "Updated card";
  }

  if (operation === "move") {
    return `${fromColumnId ?? "Unknown"} -> ${toColumnId ?? "Unknown"}`;
  }

  if (operation === "create") {
    if (snapshot?.description) {
      return `${snapshot.description.blockCount} description block${snapshot.description.blockCount === 1 ? "" : "s"}`;
    }
    return "Card created";
  }

  if (operation === "delete") {
    if (snapshot?.description) {
      return `${snapshot.description.blockCount} description block${snapshot.description.blockCount === 1 ? "" : "s"} removed`;
    }
    return "Card deleted";
  }

  return null;
}

function describeBlockChangeSummary(change: HistoryPanelDescriptionDelta): string {
  const counts = countDescriptionChangeKinds(change.blocks);
  const parts: string[] = [];
  if (counts.replaced > 0) parts.push(`${counts.replaced} replaced`);
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  if (parts.length === 0) return "No block changes";
  return parts.join(", ");
}

function countDescriptionChangeKinds(
  blocks: HistoryPanelDescriptionDelta["blocks"],
): Record<"added" | "removed" | "replaced", number> {
  return blocks.reduce(
    (counts, block) => {
      counts[block.changeType] += 1;
      return counts;
    },
    { added: 0, removed: 0, replaced: 0 },
  );
}

// === Recording Functions ===

export function recordCreate(
  card: Card,
  projectId: string,
  columnId: string,
  snapshotDescriptionRevisionId: number | null,
  sessionId?: string,
  groupId?: string,
): number {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO history (
      project_id, operation, card_id, column_id, timestamp,
      new_values, card_snapshot, new_description_revision_id, snapshot_description_revision_id, session_id, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const newValues = stripDescription(card as unknown as Record<string, unknown>);
  const result = stmt.run(
    projectId,
    "create",
    card.id,
    columnId,
    new Date().toISOString(),
    JSON.stringify(newValues),
    cardToSnapshot(card),
    snapshotDescriptionRevisionId,
    snapshotDescriptionRevisionId,
    sessionId || null,
    groupId || null,
  );

  afterRecord(projectId);
  return result.lastInsertRowid as number;
}

export function recordUpdate(
  cardId: string,
  projectId: string,
  columnId: string,
  previousValues: Partial<Card>,
  newValues: Partial<Card>,
  previousDescriptionRevisionId: number | null,
  newDescriptionRevisionId: number | null,
  sessionId?: string,
  groupId?: string,
): number {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO history (
      project_id, operation, card_id, column_id, timestamp,
      previous_values, new_values, previous_description_revision_id, new_description_revision_id, session_id, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const storedPreviousValues = stripDescription(previousValues as Record<string, unknown>);
  const storedNewValues = stripDescription(newValues as Record<string, unknown>);
  const result = stmt.run(
    projectId,
    "update",
    cardId,
    columnId,
    new Date().toISOString(),
    JSON.stringify(storedPreviousValues),
    JSON.stringify(storedNewValues),
    previousDescriptionRevisionId,
    newDescriptionRevisionId,
    sessionId || null,
    groupId || null,
  );

  afterRecord(projectId);
  return result.lastInsertRowid as number;
}

export function recordDelete(
  card: Card,
  projectId: string,
  columnId: string,
  snapshotDescriptionRevisionId: number | null,
  sessionId?: string,
  groupId?: string,
): number {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO history (
      project_id, operation, card_id, column_id, timestamp,
      previous_values, card_snapshot, previous_description_revision_id, snapshot_description_revision_id, session_id, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const previousValues = stripDescription(card as unknown as Record<string, unknown>);
  const result = stmt.run(
    projectId,
    "delete",
    card.id,
    columnId,
    new Date().toISOString(),
    JSON.stringify(previousValues),
    cardToSnapshot(card),
    snapshotDescriptionRevisionId,
    snapshotDescriptionRevisionId,
    sessionId || null,
    groupId || null,
  );

  afterRecord(projectId);
  return result.lastInsertRowid as number;
}

export function recordMove(
  cardId: string,
  projectId: string,
  fromColumnId: string,
  toColumnId: string,
  fromOrder: number,
  toOrder: number,
  sessionId?: string,
  groupId?: string,
): number {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO history (
      project_id, operation, card_id, column_id, timestamp,
      from_column_id, to_column_id, from_order, to_order, session_id, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    projectId,
    "move",
    cardId,
    toColumnId,
    new Date().toISOString(),
    fromColumnId,
    toColumnId,
    fromOrder,
    toOrder,
    sessionId || null,
    groupId || null,
  );

  afterRecord(projectId);
  return result.lastInsertRowid as number;
}

// === Query Functions ===

export function getRecentHistory(projectId: string, limit = 50, offset = 0): StoredHistoryEntry[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM history
    WHERE project_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ? OFFSET ?
  `);
  const rows = stmt.all(projectId, limit, offset) as DbHistoryRow[];
  return rows.map((row) => toPublicHistoryEntry(rowToHistoryEntry(database, row)));
}

export function getCardHistory(projectId: string, cardId: string): StoredHistoryEntry[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM history
    WHERE project_id = ? AND card_id = ?
    ORDER BY timestamp DESC, id DESC
  `);
  const rows = stmt.all(projectId, cardId) as DbHistoryRow[];
  return rows.map((row) => toPublicHistoryEntry(rowToHistoryEntry(database, row)));
}

export function getCardHistoryPanelEntries(
  projectId: string,
  cardId: string,
): StoredHistoryPanelEntry[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM history
    WHERE project_id = ? AND card_id = ?
    ORDER BY timestamp DESC, id DESC
  `);
  const rows = stmt.all(projectId, cardId) as DbHistoryRow[];
  return rows.map((row) => toHistoryPanelEntry(database, row));
}

function getHistoryEntry(historyId: number): HistoryEntry | null {
  const database = getDb();
  const stmt = database.prepare("SELECT * FROM history WHERE id = ?");
  const row = stmt.get(historyId) as DbHistoryRow | undefined;
  return row ? rowToHistoryEntry(database, row) : null;
}

// === Undo/Redo Target Selection ===

export function getUndoTarget(projectId: string, sessionId?: string): HistoryEntry | null {
  const database = getDb();

  if (sessionId) {
    const stmt = database.prepare(`
      SELECT * FROM history
      WHERE project_id = ? AND session_id = ? AND is_undone = 0 AND undo_of IS NULL
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `);
    const row = stmt.get(projectId, sessionId) as DbHistoryRow | undefined;
    return row ? rowToHistoryEntry(database, row) : null;
  }

  const stmt = database.prepare(`
    SELECT * FROM history
    WHERE project_id = ? AND is_undone = 0 AND undo_of IS NULL
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `);
  const row = stmt.get(projectId) as DbHistoryRow | undefined;
  return row ? rowToHistoryEntry(database, row) : null;
}

export function getRedoTarget(projectId: string, sessionId?: string): HistoryEntry | null {
  const database = getDb();

  if (sessionId) {
    const stmt = database.prepare(`
      SELECT * FROM history
      WHERE project_id = ? AND session_id = ? AND is_undone = 1 AND undo_of IS NULL
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `);
    const row = stmt.get(projectId, sessionId) as DbHistoryRow | undefined;
    return row ? rowToHistoryEntry(database, row) : null;
  }

  const stmt = database.prepare(`
    SELECT * FROM history
    WHERE project_id = ? AND is_undone = 1 AND undo_of IS NULL
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `);
  const row = stmt.get(projectId) as DbHistoryRow | undefined;
  return row ? rowToHistoryEntry(database, row) : null;
}

// === Undo/Redo Execution ===

export function executeUndo(
  historyId: number
): { success: boolean; entry?: HistoryEntry; error?: string } {
  return executeUndoWithGrouping(historyId);
}

export function executeRedo(
  historyId: number
): { success: boolean; entry?: HistoryEntry; error?: string } {
  return executeRedoWithGrouping(historyId);
}

export function executeUndoWithGrouping(
  historyId: number,
): { success: boolean; entry?: HistoryEntry; error?: string } {
  const database = getDb();
  const entry = getHistoryEntry(historyId);

  if (!entry) return { success: false, error: "History entry not found" };
  if (entry.isUndone) return { success: false, error: "Operation already undone" };

  const entries = resolveUndoEntries(entry);
  if (entries.length === 0) {
    return { success: false, error: "No undoable entries found" };
  }

  try {
    database.transaction(() => {
      for (const current of entries) {
        switch (current.operation) {
          case "create":
            undoCreate(database, current);
            break;
          case "update":
            undoUpdate(database, current);
            break;
          case "delete":
            undoDelete(database, current);
            break;
          case "move":
            undoMove(database, current);
            break;
        }

        database
          .prepare("UPDATE history SET is_undone = 1 WHERE id = ?")
          .run(current.id);
      }
    })();

    notifyEntries(entry.projectId, "undo", entries);
    return { success: true, entry };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Undo failed",
    };
  }
}

export function executeRedoWithGrouping(
  historyId: number,
): { success: boolean; entry?: HistoryEntry; error?: string } {
  const database = getDb();
  const entry = getHistoryEntry(historyId);

  if (!entry) return { success: false, error: "History entry not found" };
  if (!entry.isUndone) return { success: false, error: "Operation not undone" };

  const entries = resolveRedoEntries(entry);
  if (entries.length === 0) {
    return { success: false, error: "No redoable entries found" };
  }

  try {
    database.transaction(() => {
      for (const current of entries) {
        switch (current.operation) {
          case "create":
            redoCreate(database, current);
            break;
          case "update":
            redoUpdate(database, current);
            break;
          case "delete":
            redoDelete(database, current);
            break;
          case "move":
            redoMove(database, current);
            break;
        }

        database
          .prepare("UPDATE history SET is_undone = 0 WHERE id = ?")
          .run(current.id);
      }
    })();

    notifyEntries(entry.projectId, "redo", entries);
    return { success: true, entry };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Redo failed",
    };
  }
}

function resolveUndoEntries(entry: HistoryEntry): HistoryEntry[] {
  const grouped = getGroupEntries(entry, "undo");
  if (grouped.length > 0) return grouped;
  return [entry];
}

function resolveRedoEntries(entry: HistoryEntry): HistoryEntry[] {
  const grouped = getGroupEntries(entry, "redo");
  if (grouped.length > 0) return grouped;
  return [entry];
}

function getGroupEntries(
  entry: HistoryEntry,
  mode: "undo" | "redo",
): HistoryEntry[] {
  if (!entry.groupId) return [];

  const database = getDb();
  const isUndone = mode === "undo" ? 0 : 1;
  const order = mode === "undo"
    ? "ORDER BY timestamp DESC, id DESC"
    : "ORDER BY timestamp ASC, id ASC";

  const rows = database.prepare(
    `
      SELECT * FROM history
      WHERE project_id = ? AND group_id = ? AND undo_of IS NULL AND is_undone = ?
      ${order}
    `
  ).all(entry.projectId, entry.groupId, isUndone) as DbHistoryRow[];

  return rows.map((row) => rowToHistoryEntry(database, row));
}

function notifyEntries(
  projectId: string,
  changeType: "undo" | "redo",
  entries: HistoryEntry[],
): void {
  const seen = new Set<string>();
  const queueNotify = (columnId: string, cardId: string) => {
    const key = `${columnId}:${cardId}`;
    if (seen.has(key)) return;
    seen.add(key);
    dbNotifier.notifyChange(projectId, changeType, columnId, cardId);
  };

  for (const entry of entries) {
    queueNotify(entry.columnId, entry.cardId);
    if (entry.fromColumnId) queueNotify(entry.fromColumnId, entry.cardId);
    if (entry.toColumnId) queueNotify(entry.toColumnId, entry.cardId);
  }
}

// === Undo Helpers ===

function undoCreate(database: Database.Database, entry: HistoryEntry): void {
  const card = database
    .prepare('SELECT "order" FROM cards WHERE id = ?')
    .get(entry.cardId) as { order: number } | undefined;

  if (!card) return;

  database.prepare("DELETE FROM cards WHERE id = ?").run(entry.cardId);
  database
    .prepare(
      `UPDATE cards SET "order" = "order" - 1 WHERE project_id = ? AND column_id = ? AND "order" > ?`
    )
    .run(entry.projectId, entry.columnId, card.order);
}

function undoUpdate(database: Database.Database, entry: HistoryEntry): void {
  if (!entry.previousValues) return;

  const prev = entry.previousValues as Partial<Card>;
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (prev.title !== undefined) {
    fields.push("title = ?");
    values.push(prev.title);
  }
  if (prev.description !== undefined) {
    fields.push("description = ?");
    values.push(prev.description);
  }
  if (entry.previousDescriptionRevisionId !== null) {
    fields.push("description_revision_id = ?");
    values.push(entry.previousDescriptionRevisionId);
  }
  if (prev.priority !== undefined) {
    fields.push("priority = ?");
    values.push(prev.priority);
  }
  if (prev.estimate !== undefined) {
    fields.push("estimate = ?");
    values.push(prev.estimate || null);
  }
  if (prev.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(prev.tags));
  }
  if (prev.dueDate !== undefined) {
    fields.push("due_date = ?");
    values.push(toDateOnlyString(prev.dueDate));
  }
  if (prev.scheduledStart !== undefined) {
    fields.push("scheduled_start = ?");
    values.push(toIsoStringOrNull(prev.scheduledStart));
  }
  if (prev.scheduledEnd !== undefined) {
    fields.push("scheduled_end = ?");
    values.push(toIsoStringOrNull(prev.scheduledEnd));
  }
  if (prev.isAllDay !== undefined) {
    fields.push("is_all_day = ?");
    values.push(prev.isAllDay ? 1 : 0);
  }
  if (prev.recurrence !== undefined) {
    fields.push("recurrence_json = ?");
    values.push(prev.recurrence ? JSON.stringify(prev.recurrence) : null);
  }
  if (prev.reminders !== undefined) {
    fields.push("reminders_json = ?");
    values.push(JSON.stringify(prev.reminders));
  }
  if (prev.scheduleTimezone !== undefined) {
    fields.push("schedule_timezone = ?");
    values.push(prev.scheduleTimezone || null);
  }
  if (prev.assignee !== undefined) {
    fields.push("assignee = ?");
    values.push(prev.assignee || null);
  }
  if (prev.agentBlocked !== undefined) {
    fields.push("agent_blocked = ?");
    values.push(prev.agentBlocked ? 1 : 0);
  }
  if (prev.agentStatus !== undefined) {
    fields.push("agent_status = ?");
    values.push(prev.agentStatus || null);
  }
  if (prev.runInTarget !== undefined) {
    fields.push("run_in_target = ?");
    values.push(toRunInTargetDbValue(prev.runInTarget));
  }
  if (prev.runInLocalPath !== undefined) {
    fields.push("run_in_local_path = ?");
    values.push(prev.runInLocalPath || null);
  }
  if (prev.runInBaseBranch !== undefined) {
    fields.push("run_in_base_branch = ?");
    values.push(prev.runInBaseBranch || null);
  }
  if (prev.runInWorktreePath !== undefined) {
    fields.push("run_in_worktree_path = ?");
    values.push(prev.runInWorktreePath || null);
  }
  if (prev.runInEnvironmentPath !== undefined) {
    fields.push("run_in_environment_path = ?");
    values.push(prev.runInEnvironmentPath || null);
  }

  if (fields.length > 0) {
    values.push(entry.cardId);
    database
      .prepare(`UPDATE cards SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  }
}

function undoDelete(database: Database.Database, entry: HistoryEntry): void {
  if (!entry.cardSnapshot) return;

  const snapshot = entry.cardSnapshot;

  database
    .prepare(
      `UPDATE cards SET "order" = "order" + 1 WHERE project_id = ? AND column_id = ? AND "order" >= ?`
    )
    .run(entry.projectId, entry.columnId, snapshot.order);

  const dueDate = snapshot.dueDate;
  const scheduledStart = snapshot.scheduledStart;
  const scheduledEnd = snapshot.scheduledEnd;
  const created = snapshot.created;

  database
    .prepare(`
      INSERT INTO cards (
        id, project_id, column_id, title, description, description_revision_id, priority, estimate,
        tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
        assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      snapshot.id,
      entry.projectId,
      entry.columnId,
      snapshot.title,
      snapshot.description,
      entry.snapshotDescriptionRevisionId,
      snapshot.priority,
      snapshot.estimate || null,
      JSON.stringify(snapshot.tags),
      toDateOnlyString(dueDate),
      toIsoStringOrNull(scheduledStart),
      toIsoStringOrNull(scheduledEnd),
      snapshot.isAllDay ? 1 : 0,
      snapshot.recurrence ? JSON.stringify(snapshot.recurrence) : null,
      JSON.stringify(snapshot.reminders ?? []),
      snapshot.scheduleTimezone || null,
      snapshot.assignee || null,
      snapshot.agentBlocked ? 1 : 0,
      snapshot.agentStatus || null,
      toRunInTargetDbValue(snapshot.runInTarget),
      snapshot.runInLocalPath || null,
      snapshot.runInBaseBranch || null,
      snapshot.runInWorktreePath || null,
      snapshot.runInEnvironmentPath || null,
      typeof created === "string" ? created : created.toISOString(),
      snapshot.order
    );
}

function undoMove(database: Database.Database, entry: HistoryEntry): void {
  if (!entry.fromColumnId || entry.fromOrder === null) return;

  const card = database
    .prepare("SELECT * FROM cards WHERE id = ?")
    .get(entry.cardId) as DbCard | undefined;

  if (!card) return;

  const currentOrder = card.order;
  const currentColumnId = card.column_id;
  const targetColumnId = entry.fromColumnId;
  const targetOrder = entry.fromOrder;

  if (currentColumnId === targetColumnId) {
    if (targetOrder > currentOrder) {
      database
        .prepare(
          `UPDATE cards SET "order" = "order" - 1
           WHERE project_id = ? AND column_id = ? AND "order" > ? AND "order" <= ?`
        )
        .run(entry.projectId, currentColumnId, currentOrder, targetOrder);
    } else if (targetOrder < currentOrder) {
      database
        .prepare(
          `UPDATE cards SET "order" = "order" + 1
           WHERE project_id = ? AND column_id = ? AND "order" >= ? AND "order" < ?`
        )
        .run(entry.projectId, currentColumnId, targetOrder, currentOrder);
    }
    database
      .prepare('UPDATE cards SET "order" = ? WHERE id = ?')
      .run(targetOrder, entry.cardId);
  } else {
    database
      .prepare(
        `UPDATE cards SET "order" = "order" - 1
         WHERE project_id = ? AND column_id = ? AND "order" > ?`
      )
      .run(entry.projectId, currentColumnId, currentOrder);

    database
      .prepare(
        `UPDATE cards SET "order" = "order" + 1
         WHERE project_id = ? AND column_id = ? AND "order" >= ?`
      )
      .run(entry.projectId, targetColumnId, targetOrder);

    database
      .prepare('UPDATE cards SET column_id = ?, "order" = ? WHERE id = ?')
      .run(targetColumnId, targetOrder, entry.cardId);
  }
}

// === Redo Helpers ===

function redoCreate(database: Database.Database, entry: HistoryEntry): void {
  if (!entry.cardSnapshot) return;

  const snapshot = entry.cardSnapshot;

  const maxOrderRow = database
    .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
    .get(entry.projectId, entry.columnId) as { maxOrder: number | null } | undefined;
  const maxOrder = maxOrderRow?.maxOrder ?? -1;
  const order = Math.min(Math.max(snapshot.order, 0), maxOrder + 1);

  database
    .prepare(
      `UPDATE cards SET "order" = "order" + 1 WHERE project_id = ? AND column_id = ? AND "order" >= ?`
    )
    .run(entry.projectId, entry.columnId, order);

  const dueDate = snapshot.dueDate;
  const scheduledStart = snapshot.scheduledStart;
  const scheduledEnd = snapshot.scheduledEnd;
  const created = snapshot.created;

  database
    .prepare(`
      INSERT INTO cards (
        id, project_id, column_id, title, description, description_revision_id, priority, estimate,
        tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
        assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      snapshot.id,
      entry.projectId,
      entry.columnId,
      snapshot.title,
      snapshot.description,
      entry.snapshotDescriptionRevisionId,
      snapshot.priority,
      snapshot.estimate || null,
      JSON.stringify(snapshot.tags),
      toDateOnlyString(dueDate),
      toIsoStringOrNull(scheduledStart),
      toIsoStringOrNull(scheduledEnd),
      snapshot.isAllDay ? 1 : 0,
      snapshot.recurrence ? JSON.stringify(snapshot.recurrence) : null,
      JSON.stringify(snapshot.reminders ?? []),
      snapshot.scheduleTimezone || null,
      snapshot.assignee || null,
      snapshot.agentBlocked ? 1 : 0,
      snapshot.agentStatus || null,
      toRunInTargetDbValue(snapshot.runInTarget),
      snapshot.runInLocalPath || null,
      snapshot.runInBaseBranch || null,
      snapshot.runInWorktreePath || null,
      snapshot.runInEnvironmentPath || null,
      typeof created === "string" ? created : created.toISOString(),
      order
    );
}

function redoUpdate(database: Database.Database, entry: HistoryEntry): void {
  if (!entry.newValues) return;

  const newVals = entry.newValues as Partial<Card>;
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (newVals.title !== undefined) {
    fields.push("title = ?");
    values.push(newVals.title);
  }
  if (newVals.description !== undefined) {
    fields.push("description = ?");
    values.push(newVals.description);
  }
  if (entry.newDescriptionRevisionId !== null) {
    fields.push("description_revision_id = ?");
    values.push(entry.newDescriptionRevisionId);
  }
  if (newVals.priority !== undefined) {
    fields.push("priority = ?");
    values.push(newVals.priority);
  }
  if (newVals.estimate !== undefined) {
    fields.push("estimate = ?");
    values.push(newVals.estimate || null);
  }
  if (newVals.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(newVals.tags));
  }
  if (newVals.dueDate !== undefined) {
    fields.push("due_date = ?");
    values.push(toDateOnlyString(newVals.dueDate));
  }
  if (newVals.scheduledStart !== undefined) {
    fields.push("scheduled_start = ?");
    values.push(toIsoStringOrNull(newVals.scheduledStart));
  }
  if (newVals.scheduledEnd !== undefined) {
    fields.push("scheduled_end = ?");
    values.push(toIsoStringOrNull(newVals.scheduledEnd));
  }
  if (newVals.isAllDay !== undefined) {
    fields.push("is_all_day = ?");
    values.push(newVals.isAllDay ? 1 : 0);
  }
  if (newVals.recurrence !== undefined) {
    fields.push("recurrence_json = ?");
    values.push(newVals.recurrence ? JSON.stringify(newVals.recurrence) : null);
  }
  if (newVals.reminders !== undefined) {
    fields.push("reminders_json = ?");
    values.push(JSON.stringify(newVals.reminders));
  }
  if (newVals.scheduleTimezone !== undefined) {
    fields.push("schedule_timezone = ?");
    values.push(newVals.scheduleTimezone || null);
  }
  if (newVals.assignee !== undefined) {
    fields.push("assignee = ?");
    values.push(newVals.assignee || null);
  }
  if (newVals.agentBlocked !== undefined) {
    fields.push("agent_blocked = ?");
    values.push(newVals.agentBlocked ? 1 : 0);
  }
  if (newVals.agentStatus !== undefined) {
    fields.push("agent_status = ?");
    values.push(newVals.agentStatus || null);
  }
  if (newVals.runInTarget !== undefined) {
    fields.push("run_in_target = ?");
    values.push(toRunInTargetDbValue(newVals.runInTarget));
  }
  if (newVals.runInLocalPath !== undefined) {
    fields.push("run_in_local_path = ?");
    values.push(newVals.runInLocalPath || null);
  }
  if (newVals.runInBaseBranch !== undefined) {
    fields.push("run_in_base_branch = ?");
    values.push(newVals.runInBaseBranch || null);
  }
  if (newVals.runInWorktreePath !== undefined) {
    fields.push("run_in_worktree_path = ?");
    values.push(newVals.runInWorktreePath || null);
  }
  if (newVals.runInEnvironmentPath !== undefined) {
    fields.push("run_in_environment_path = ?");
    values.push(newVals.runInEnvironmentPath || null);
  }

  if (fields.length > 0) {
    values.push(entry.cardId);
    database
      .prepare(`UPDATE cards SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  }
}

function redoDelete(database: Database.Database, entry: HistoryEntry): void {
  const card = database
    .prepare('SELECT "order" FROM cards WHERE id = ?')
    .get(entry.cardId) as { order: number } | undefined;

  if (!card) return;

  database.prepare("DELETE FROM cards WHERE id = ?").run(entry.cardId);
  database
    .prepare(
      `UPDATE cards SET "order" = "order" - 1 WHERE project_id = ? AND column_id = ? AND "order" > ?`
    )
    .run(entry.projectId, entry.columnId, card.order);
}

function redoMove(database: Database.Database, entry: HistoryEntry): void {
  if (!entry.toColumnId || entry.toOrder === null) return;

  const card = database
    .prepare("SELECT * FROM cards WHERE id = ?")
    .get(entry.cardId) as DbCard | undefined;

  if (!card) return;

  const currentOrder = card.order;
  const currentColumnId = card.column_id;
  const targetColumnId = entry.toColumnId;
  const targetOrder = entry.toOrder;

  if (currentColumnId === targetColumnId) {
    if (targetOrder > currentOrder) {
      database
        .prepare(
          `UPDATE cards SET "order" = "order" - 1
           WHERE project_id = ? AND column_id = ? AND "order" > ? AND "order" <= ?`
        )
        .run(entry.projectId, currentColumnId, currentOrder, targetOrder);
    } else if (targetOrder < currentOrder) {
      database
        .prepare(
          `UPDATE cards SET "order" = "order" + 1
           WHERE project_id = ? AND column_id = ? AND "order" >= ? AND "order" < ?`
        )
        .run(entry.projectId, currentColumnId, targetOrder, currentOrder);
    }
    database
      .prepare('UPDATE cards SET "order" = ? WHERE id = ?')
      .run(targetOrder, entry.cardId);
  } else {
    database
      .prepare(
        `UPDATE cards SET "order" = "order" - 1
         WHERE project_id = ? AND column_id = ? AND "order" > ?`
      )
      .run(entry.projectId, currentColumnId, currentOrder);

    database
      .prepare(
        `UPDATE cards SET "order" = "order" + 1
         WHERE project_id = ? AND column_id = ? AND "order" >= ?`
      )
      .run(entry.projectId, targetColumnId, targetOrder);

    database
      .prepare('UPDATE cards SET column_id = ?, "order" = ? WHERE id = ?')
      .run(targetColumnId, targetOrder, entry.cardId);
  }
}

// === State Reconstruction ===

interface ReconstructedState {
  state: Record<string, unknown>;
  columnId: string;
}

/**
 * Reconstructs the full card state at a given history entry by replaying
 * from the creation snapshot through all non-undone deltas up to the target.
 */
export function reconstructCardStateAtEntry(
  projectId: string,
  cardId: string,
  targetEntryId: number
): ReconstructedState | null {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM history
       WHERE project_id = ? AND card_id = ? AND is_undone = 0 AND undo_of IS NULL
       ORDER BY timestamp ASC, id ASC`
    )
    .all(projectId, cardId) as DbHistoryRow[];

  const entries = rows.map((row) => rowToHistoryEntry(database, row));

  // Find creation entry for the initial snapshot
  const createEntry = entries.find((e) => e.operation === "create");
  if (!createEntry?.cardSnapshot) return null;

  const snapshot = createEntry.cardSnapshot as unknown as Record<string, unknown>;
  const state: Record<string, unknown> = { ...snapshot };
  let columnId = createEntry.columnId;

  // If the target is the create entry itself, return initial state
  if (createEntry.id === targetEntryId) {
    return { state, columnId };
  }

  // Walk forward applying deltas
  for (const entry of entries) {
    if (entry.id === createEntry.id) continue; // skip creation, already applied

    // Delete entries don't change card fields, but they are valid targets
    // (representing "card state just before deletion")
    if (entry.id === targetEntryId) {
      return { state, columnId };
    }
    if (entry.operation === "delete") continue;

    if (entry.operation === "update" && entry.newValues) {
      for (const [key, value] of Object.entries(entry.newValues)) {
        state[key] = value;
      }
    }

    if (entry.operation === "move" && entry.toColumnId) {
      columnId = entry.toColumnId;
    }

    if (entry.id === targetEntryId) {
      return { state, columnId };
    }
  }

  // Target entry not found in the card's history
  return null;
}

// === Revert & Restore ===

/**
 * Reverts a single history entry by creating a new forward history entry
 * that reverses the effect. The revert is itself visible in history and reversible.
 */
export function revertEntry(
  projectId: string,
  historyId: number,
  sessionId?: string
): { success: boolean; error?: string } {
  const database = getDb();
  const entry = getHistoryEntry(historyId);

  if (!entry) return { success: false, error: "History entry not found" };
  if (entry.projectId !== projectId) return { success: false, error: "Entry does not belong to this project" };

  try {
    database.transaction(() => {
      switch (entry.operation) {
        case "update": {
          if (!entry.previousValues) throw new Error("No previous values to revert");
          const card = database.prepare("SELECT * FROM cards WHERE id = ?").get(entry.cardId) as DbCard | undefined;
          if (!card) throw new Error("Card no longer exists");

          // Apply previousValues
          const prev = entry.previousValues as Partial<Card>;
          const fields: string[] = [];
          const values: (string | number | null)[] = [];

          if (prev.title !== undefined) { fields.push("title = ?"); values.push(prev.title); }
          if (prev.description !== undefined) { fields.push("description = ?"); values.push(prev.description); }
          if (entry.previousDescriptionRevisionId !== null) {
            fields.push("description_revision_id = ?");
            values.push(entry.previousDescriptionRevisionId);
          }
          if (prev.priority !== undefined) { fields.push("priority = ?"); values.push(prev.priority); }
          if (prev.estimate !== undefined) { fields.push("estimate = ?"); values.push(prev.estimate || null); }
          if (prev.tags !== undefined) { fields.push("tags = ?"); values.push(JSON.stringify(prev.tags)); }
          if (prev.dueDate !== undefined) {
            fields.push("due_date = ?");
            values.push(toDateOnlyString(prev.dueDate));
          }
          if (prev.scheduledStart !== undefined) {
            fields.push("scheduled_start = ?");
            values.push(toIsoStringOrNull(prev.scheduledStart));
          }
          if (prev.scheduledEnd !== undefined) {
            fields.push("scheduled_end = ?");
            values.push(toIsoStringOrNull(prev.scheduledEnd));
          }
          if (prev.isAllDay !== undefined) {
            fields.push("is_all_day = ?");
            values.push(prev.isAllDay ? 1 : 0);
          }
          if (prev.recurrence !== undefined) {
            fields.push("recurrence_json = ?");
            values.push(prev.recurrence ? JSON.stringify(prev.recurrence) : null);
          }
          if (prev.reminders !== undefined) {
            fields.push("reminders_json = ?");
            values.push(JSON.stringify(prev.reminders));
          }
          if (prev.scheduleTimezone !== undefined) {
            fields.push("schedule_timezone = ?");
            values.push(prev.scheduleTimezone || null);
          }
          if (prev.assignee !== undefined) { fields.push("assignee = ?"); values.push(prev.assignee || null); }
          if (prev.agentBlocked !== undefined) { fields.push("agent_blocked = ?"); values.push(prev.agentBlocked ? 1 : 0); }
          if (prev.agentStatus !== undefined) { fields.push("agent_status = ?"); values.push(prev.agentStatus || null); }
          if (prev.runInTarget !== undefined) { fields.push("run_in_target = ?"); values.push(toRunInTargetDbValue(prev.runInTarget)); }
          if (prev.runInLocalPath !== undefined) { fields.push("run_in_local_path = ?"); values.push(prev.runInLocalPath || null); }
          if (prev.runInBaseBranch !== undefined) { fields.push("run_in_base_branch = ?"); values.push(prev.runInBaseBranch || null); }
          if (prev.runInWorktreePath !== undefined) { fields.push("run_in_worktree_path = ?"); values.push(prev.runInWorktreePath || null); }
          if (prev.runInEnvironmentPath !== undefined) { fields.push("run_in_environment_path = ?"); values.push(prev.runInEnvironmentPath || null); }

          if (fields.length > 0) {
            values.push(entry.cardId);
            database.prepare(`UPDATE cards SET ${fields.join(", ")} WHERE id = ?`).run(...values);
          }

          const storedRevertedPreviousValues = stripDescription(
            (entry.newValues ?? {}) as Record<string, unknown>,
          );
          const storedRevertedNewValues = stripDescription(
            (entry.previousValues ?? {}) as Record<string, unknown>,
          );
          // Record reverse update history
          database.prepare(`
            INSERT INTO history (
              project_id, operation, card_id, column_id, timestamp,
              previous_values, new_values, previous_description_revision_id, new_description_revision_id, session_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectId,
            "update",
            entry.cardId,
            entry.columnId,
            new Date().toISOString(),
            JSON.stringify(storedRevertedPreviousValues),
            JSON.stringify(storedRevertedNewValues),
            entry.newDescriptionRevisionId,
            entry.previousDescriptionRevisionId,
            sessionId || null
          );
          break;
        }

        case "move": {
          if (!entry.fromColumnId) throw new Error("No source column to revert to");
          const card = database.prepare("SELECT * FROM cards WHERE id = ?").get(entry.cardId) as DbCard | undefined;
          if (!card) throw new Error("Card no longer exists");

          const currentOrder = card.order;
          const currentColumnId = card.column_id;
          const targetColumnId = entry.fromColumnId;

          // Append to end of target column
          const maxRow = database
            .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
            .get(projectId, targetColumnId) as { maxOrder: number | null } | undefined;
          const targetOrder = (maxRow?.maxOrder ?? -1) + 1;

          // Remove from current column
          database.prepare(
            `UPDATE cards SET "order" = "order" - 1 WHERE project_id = ? AND column_id = ? AND "order" > ?`
          ).run(projectId, currentColumnId, currentOrder);

          // Move card
          database.prepare('UPDATE cards SET column_id = ?, "order" = ? WHERE id = ?')
            .run(targetColumnId, targetOrder, entry.cardId);

          // Record reverse move history
          database.prepare(`
            INSERT INTO history (project_id, operation, card_id, column_id, timestamp, from_column_id, to_column_id, from_order, to_order, session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectId, "move", entry.cardId, targetColumnId, new Date().toISOString(),
            currentColumnId, targetColumnId, currentOrder, targetOrder,
            sessionId || null
          );
          break;
        }

        case "create": {
          const card = database.prepare("SELECT * FROM cards WHERE id = ?").get(entry.cardId) as DbCard | undefined;
          if (!card) throw new Error("Card no longer exists");

          const currentCard = dbCardToCard(card);
          const cardSnapshot = cardToSnapshot(currentCard);
          const previousValues = stripDescription(currentCard as unknown as Record<string, unknown>);
          const order = card.order;

          database.prepare("DELETE FROM cards WHERE id = ?").run(entry.cardId);
          database.prepare(
            `UPDATE cards SET "order" = "order" - 1 WHERE project_id = ? AND column_id = ? AND "order" > ?`
          ).run(projectId, card.column_id, order);

          // Record delete history
          database.prepare(`
            INSERT INTO history (
              project_id, operation, card_id, column_id, timestamp,
              previous_values, card_snapshot, previous_description_revision_id, snapshot_description_revision_id, session_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectId,
            "delete",
            entry.cardId,
            card.column_id,
            new Date().toISOString(),
            JSON.stringify(previousValues),
            cardSnapshot,
            card.description_revision_id,
            card.description_revision_id,
            sessionId || null
          );
          break;
        }

        case "delete": {
          if (!entry.cardSnapshot) throw new Error("No snapshot to restore from");
          const existing = database.prepare("SELECT id FROM cards WHERE id = ?").get(entry.cardId);
          if (existing) throw new Error("Card already exists — cannot restore deleted card");

          const snapshot = entry.cardSnapshot;
          const maxRow = database
            .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
            .get(projectId, entry.columnId) as { maxOrder: number | null } | undefined;
          const order = (maxRow?.maxOrder ?? -1) + 1;

          const dueDate = snapshot.dueDate;
          const scheduledStart = snapshot.scheduledStart;
          const scheduledEnd = snapshot.scheduledEnd;
          const created = snapshot.created;

          database.prepare(`
            INSERT INTO cards (id, project_id, column_id, title, description, description_revision_id, priority, estimate,
              tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
              assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            snapshot.id, projectId, entry.columnId, snapshot.title, snapshot.description,
            entry.snapshotDescriptionRevisionId,
            snapshot.priority, snapshot.estimate || null, JSON.stringify(snapshot.tags),
            toDateOnlyString(dueDate),
            toIsoStringOrNull(scheduledStart),
            toIsoStringOrNull(scheduledEnd),
            snapshot.isAllDay ? 1 : 0,
            snapshot.recurrence ? JSON.stringify(snapshot.recurrence) : null,
            JSON.stringify(snapshot.reminders ?? []),
            snapshot.scheduleTimezone || null,
            snapshot.assignee || null, snapshot.agentBlocked ? 1 : 0, snapshot.agentStatus || null,
            toRunInTargetDbValue(snapshot.runInTarget),
            snapshot.runInLocalPath || null,
            snapshot.runInBaseBranch || null,
            snapshot.runInWorktreePath || null,
            snapshot.runInEnvironmentPath || null,
            typeof created === "string" ? created : created.toISOString(), order
          );

          // Record create history
          const newCardSnapshot = cardToSnapshot({ ...snapshot, order } as Card);
          const createdNewValues = stripDescription({ ...snapshot, order } as Record<string, unknown>);
          database.prepare(`
            INSERT INTO history (
              project_id, operation, card_id, column_id, timestamp,
              new_values, card_snapshot, new_description_revision_id, snapshot_description_revision_id, session_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectId,
            "create",
            entry.cardId,
            entry.columnId,
            new Date().toISOString(),
            JSON.stringify(createdNewValues),
            newCardSnapshot,
            entry.snapshotDescriptionRevisionId,
            entry.snapshotDescriptionRevisionId,
            sessionId || null
          );
          break;
        }
      }
    })();

    afterRecord(projectId);
    dbNotifier.notifyChange(projectId, "revert", entry.columnId, entry.cardId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Revert failed" };
  }
}

/**
 * Restores a card to the exact state it had at a given history entry
 * by replaying history from creation to that point.
 */
export function restoreToEntry(
  projectId: string,
  cardId: string,
  targetEntryId: number,
  sessionId?: string
): { success: boolean; error?: string } {
  const reconstructed = reconstructCardStateAtEntry(projectId, cardId, targetEntryId);
  if (!reconstructed) {
    return { success: false, error: "Cannot reconstruct state — creation history may have been pruned" };
  }

  const database = getDb();
  const { state, columnId: targetColumnId } = reconstructed;

  try {
    database.transaction(() => {
      const card = database.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as DbCard | undefined;

      if (card) {
        // Card exists — compute diff and apply
        const currentColumnId = card.column_id;
        const fields: string[] = [];
        const values: (string | number | null)[] = [];
        const previousValues: Record<string, unknown> = {};
        const newValues: Record<string, unknown> = {};
        let previousDescriptionRevisionId: number | null = null;
        let newDescriptionRevisionId: number | null = null;
        const targetDescription = typeof state.description === "string" ? state.description : "";

        const fieldMappings: Array<{ key: string; dbCol: string; current: unknown; serialize?: (v: unknown) => string | number | null }> = [
          { key: "title", dbCol: "title", current: card.title },
          { key: "priority", dbCol: "priority", current: card.priority },
          { key: "estimate", dbCol: "estimate", current: card.estimate },
          { key: "tags", dbCol: "tags", current: JSON.parse(card.tags), serialize: (v) => JSON.stringify(v) },
          { key: "dueDate", dbCol: "due_date", current: card.due_date, serialize: (v) => {
            return toDateOnlyString(v);
          }},
          { key: "scheduledStart", dbCol: "scheduled_start", current: card.scheduled_start, serialize: (v) => {
            return toIsoStringOrNull(v);
          }},
          { key: "scheduledEnd", dbCol: "scheduled_end", current: card.scheduled_end, serialize: (v) => {
            return toIsoStringOrNull(v);
          }},
          { key: "isAllDay", dbCol: "is_all_day", current: card.is_all_day === 1, serialize: (v) => v ? 1 : 0 },
          { key: "recurrence", dbCol: "recurrence_json", current: card.recurrence_json ? JSON.parse(card.recurrence_json) : null, serialize: (v) => {
            if (!v) return null;
            return JSON.stringify(v);
          }},
          { key: "reminders", dbCol: "reminders_json", current: card.reminders_json ? JSON.parse(card.reminders_json) : [], serialize: (v) => {
            return JSON.stringify(v ?? []);
          }},
          { key: "scheduleTimezone", dbCol: "schedule_timezone", current: card.schedule_timezone },
          { key: "assignee", dbCol: "assignee", current: card.assignee },
          { key: "agentBlocked", dbCol: "agent_blocked", current: card.agent_blocked === 1, serialize: (v) => v ? 1 : 0 },
          { key: "agentStatus", dbCol: "agent_status", current: card.agent_status },
          {
            key: "runInTarget",
            dbCol: "run_in_target",
            current: card.run_in_target === "new_worktree"
              ? "newWorktree"
              : card.run_in_target === "cloud"
                ? "cloud"
                : "localProject",
            serialize: (v) => toRunInTargetDbValue((v as Card["runInTarget"]) ?? "localProject"),
          },
          { key: "runInLocalPath", dbCol: "run_in_local_path", current: card.run_in_local_path },
          { key: "runInBaseBranch", dbCol: "run_in_base_branch", current: card.run_in_base_branch },
          { key: "runInWorktreePath", dbCol: "run_in_worktree_path", current: card.run_in_worktree_path },
          { key: "runInEnvironmentPath", dbCol: "run_in_environment_path", current: card.run_in_environment_path },
        ];

        const optionalFields = new Set([
          "estimate",
          "dueDate",
          "scheduledStart",
          "scheduledEnd",
          "recurrence",
          "scheduleTimezone",
          "assignee",
          "agentStatus",
          "runInLocalPath",
          "runInBaseBranch",
          "runInWorktreePath",
          "runInEnvironmentPath",
        ]);

        for (const mapping of fieldMappings) {
          let targetVal = state[mapping.key];
          // Optional fields absent from reconstructed state should clear current values
          if (targetVal === undefined) {
            if (optionalFields.has(mapping.key)) {
              targetVal = null;
            } else {
              continue;
            }
          }
          const currentStr = JSON.stringify(mapping.current);
          const targetStr = JSON.stringify(targetVal);
          if (currentStr !== targetStr) {
            previousValues[mapping.key] = mapping.current;
            newValues[mapping.key] = targetVal;
            fields.push(`${mapping.dbCol} = ?`);
            values.push(mapping.serialize ? mapping.serialize(targetVal) : (targetVal as string | number | null) ?? null);
          }
        }

        if (card.description !== targetDescription) {
          previousDescriptionRevisionId = card.description_revision_id;
          newDescriptionRevisionId = card.description_revision_id
            ? descriptionRevisionService.createNextDescriptionRevision(
              database,
              cardId,
              card.description_revision_id,
              targetDescription,
              new Date().toISOString(),
            )
            : descriptionRevisionService.createInitialDescriptionRevision(
              database,
              cardId,
              targetDescription,
              new Date().toISOString(),
            );
          previousValues.description = card.description;
          newValues.description = targetDescription;
          fields.push("description = ?");
          values.push(targetDescription);
          fields.push("description_revision_id = ?");
          values.push(newDescriptionRevisionId);
        }

        // Handle column change
        if (currentColumnId !== targetColumnId) {
          const currentOrder = card.order;
          // Remove from current column
          database.prepare(
            `UPDATE cards SET "order" = "order" - 1 WHERE project_id = ? AND column_id = ? AND "order" > ?`
          ).run(projectId, currentColumnId, currentOrder);

          // Append to target column
          const maxRow = database
            .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
            .get(projectId, targetColumnId) as { maxOrder: number | null } | undefined;
          const targetOrder = (maxRow?.maxOrder ?? -1) + 1;

          database.prepare('UPDATE cards SET column_id = ?, "order" = ? WHERE id = ?')
            .run(targetColumnId, targetOrder, cardId);

          // Record move
          database.prepare(`
            INSERT INTO history (project_id, operation, card_id, column_id, timestamp, from_column_id, to_column_id, from_order, to_order, session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectId, "move", cardId, targetColumnId, new Date().toISOString(),
            currentColumnId, targetColumnId, currentOrder, targetOrder,
            sessionId || null
          );
        }

        // Apply field updates
        if (fields.length > 0) {
          values.push(cardId);
          database.prepare(`UPDATE cards SET ${fields.join(", ")} WHERE id = ?`).run(...values);

          database.prepare(`
            INSERT INTO history (
              project_id, operation, card_id, column_id, timestamp,
              previous_values, new_values, previous_description_revision_id, new_description_revision_id, session_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            projectId,
            "update",
            cardId,
            targetColumnId,
            new Date().toISOString(),
            JSON.stringify(stripDescription(previousValues)),
            JSON.stringify(stripDescription(newValues)),
            previousDescriptionRevisionId,
            newDescriptionRevisionId,
            sessionId || null
          );
        }
      } else {
        // Card was deleted — re-create from reconstructed state
        const maxRow = database
          .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
          .get(projectId, targetColumnId) as { maxOrder: number | null } | undefined;
        const order = (maxRow?.maxOrder ?? -1) + 1;

        const dueDate = state.dueDate;
        const scheduledStart = state.scheduledStart;
        const scheduledEnd = state.scheduledEnd;
        const created = state.created;
        const restoredDescription = typeof state.description === "string" ? state.description : "";
        const restoredDescriptionRevisionId = descriptionRevisionService.createInitialDescriptionRevision(
          database,
          cardId,
          restoredDescription,
          typeof created === "string" ? created : (created as Date).toISOString(),
        );

        database.prepare(`
          INSERT INTO cards (id, project_id, column_id, title, description, description_revision_id, priority, estimate,
            tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
            assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cardId, projectId, targetColumnId,
          state.title as string, restoredDescription, restoredDescriptionRevisionId,
          (state.priority as string) ?? "p2-medium", (state.estimate as string) || null,
          JSON.stringify(state.tags ?? []),
          toDateOnlyString(dueDate),
          toIsoStringOrNull(scheduledStart),
          toIsoStringOrNull(scheduledEnd),
          state.isAllDay ? 1 : 0,
          state.recurrence ? JSON.stringify(state.recurrence) : null,
          JSON.stringify((state.reminders as unknown[]) ?? []),
          (state.scheduleTimezone as string) || null,
          (state.assignee as string) || null,
          state.agentBlocked ? 1 : 0, (state.agentStatus as string) || null,
          toRunInTargetDbValue((state.runInTarget as Card["runInTarget"]) ?? "localProject"),
          (state.runInLocalPath as string) || null,
          (state.runInBaseBranch as string) || null,
          (state.runInWorktreePath as string) || null,
          (state.runInEnvironmentPath as string) || null,
          typeof created === "string" ? created : (created as Date).toISOString(),
          order
        );

        // Record create
        const restoredCard = {
          id: cardId, title: state.title, description: restoredDescription,
          priority: state.priority ?? "p2-medium", estimate: state.estimate || null,
          tags: state.tags ?? [], dueDate: state.dueDate ?? null,
          scheduledStart: parseHistoryDate(state.scheduledStart),
          scheduledEnd: parseHistoryDate(state.scheduledEnd),
          isAllDay: Boolean(state.isAllDay),
          recurrence: state.recurrence ?? null,
          reminders: state.reminders ?? [],
          scheduleTimezone: state.scheduleTimezone ?? null,
          assignee: state.assignee || null, agentBlocked: !!state.agentBlocked,
          agentStatus: state.agentStatus || null, created: state.created,
          runInTarget: (state.runInTarget as Card["runInTarget"]) ?? "localProject",
          runInLocalPath: (state.runInLocalPath as string) || null,
          runInBaseBranch: (state.runInBaseBranch as string) || null,
          runInWorktreePath: (state.runInWorktreePath as string) || null,
          runInEnvironmentPath: (state.runInEnvironmentPath as string) || null,
          order,
        };
        const restoredCardValues = stripDescription(restoredCard as Record<string, unknown>);
        const snap = JSON.stringify(restoredCardValues);
        database.prepare(`
          INSERT INTO history (
            project_id, operation, card_id, column_id, timestamp,
            new_values, card_snapshot, new_description_revision_id, snapshot_description_revision_id, session_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          projectId,
          "create",
          cardId,
          targetColumnId,
          new Date().toISOString(),
          JSON.stringify(restoredCardValues),
          snap,
          restoredDescriptionRevisionId,
          restoredDescriptionRevisionId,
          sessionId || null
        );
      }
    })();

    afterRecord(projectId);
    dbNotifier.notifyChange(projectId, "restore", targetColumnId, cardId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Restore failed" };
  }
}

// === Utility Functions ===

export function canUndo(projectId: string, sessionId?: string): boolean {
  return getUndoTarget(projectId, sessionId) !== null;
}

export function canRedo(projectId: string, sessionId?: string): boolean {
  return getRedoTarget(projectId, sessionId) !== null;
}

export function getUndoRedoState(projectId: string, sessionId?: string): {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
} {
  const undoTarget = getUndoTarget(projectId, sessionId);
  const redoTarget = getRedoTarget(projectId, sessionId);

  return {
    canUndo: undoTarget !== null,
    canRedo: redoTarget !== null,
    undoDescription: undoTarget ? describeOperation(undoTarget) : null,
    redoDescription: redoTarget ? describeOperation(redoTarget) : null,
  };
}

function describeOperation(entry: HistoryEntry): string {
  const groupedDescription = describeGroupedOperation(entry);
  if (groupedDescription) return groupedDescription;

  switch (entry.operation) {
    case "create":
      return `Create card`;
    case "delete":
      return `Delete card`;
    case "move":
      return `Move card`;
    case "update": {
      if (entry.newValues) {
        const keys = Object.keys(entry.newValues);
        if (keys.length === 1) {
          return `Change ${keys[0]}`;
        }
        return `Change ${keys.length} fields`;
      }
      return `Update card`;
    }
    default:
      return `Unknown operation`;
  }
}

function describeGroupedOperation(entry: HistoryEntry): string | null {
  if (!entry.groupId) return null;

  const database = getDb();
  const rows = database.prepare(
    `
      SELECT operation FROM history
      WHERE project_id = ? AND group_id = ? AND undo_of IS NULL AND is_undone = ?
    `,
  ).all(
    entry.projectId,
    entry.groupId,
    entry.isUndone ? 1 : 0,
  ) as Array<{ operation: HistoryOperation }>;

  if (rows.length === 0) return null;

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.operation] += 1;
      return acc;
    },
    { create: 0, update: 0, delete: 0, move: 0 } as Record<HistoryOperation, number>,
  );

  if (counts.create > 0 && counts.update > 0 && counts.delete === 0 && counts.move === 0) {
    if (counts.create === 1) return "Create card from block drop";
    return `Create ${counts.create} cards from block drop`;
  }

  if (rows.length === 1) return null;
  return `Grouped action (${rows.length} changes)`;
}

export function clearRedoStack(projectId: string, sessionId?: string): void {
  const database = getDb();
  const changes = sessionId
    ? database
      .prepare(
        `DELETE FROM history WHERE project_id = ? AND session_id = ? AND is_undone = 1 AND undo_of IS NULL`
      )
      .run(projectId, sessionId).changes
    : database
      .prepare(`DELETE FROM history WHERE project_id = ? AND is_undone = 1 AND undo_of IS NULL`)
      .run(projectId).changes;

  if (changes > 0) {
    descriptionRevisionService.garbageCollectDescriptionRevisions(database);
    database.pragma("incremental_vacuum");
  }
}

export function pruneHistory(projectId: string, retentionCount: number): number {
  if (retentionCount <= 0) return 0;
  const database = getDb();
  const cutoffRow = database
    .prepare(`SELECT id FROM history WHERE project_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`)
    .get(projectId, retentionCount) as { id: number } | undefined;
  if (!cutoffRow) return 0;
  const changes = database
    .prepare(`DELETE FROM history WHERE project_id = ? AND id < ?`)
    .run(projectId, cutoffRow.id).changes;
  if (changes > 0) {
    descriptionRevisionService.garbageCollectDescriptionRevisions(database);
    database.pragma("incremental_vacuum");
  }
  return changes;
}

function afterRecord(projectId: string): void {
  const retention = getHistoryRetention();
  if (retention > 0) pruneHistory(projectId, retention);
}
