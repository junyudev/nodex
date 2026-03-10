import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  ARCHIVE_COLUMN_ID,
  ARCHIVE_COLUMN_NAME,
  type BlockDropImportInput,
  type BlockDropImportResult,
  type Board,
  type CalendarOccurrence,
  type CardDropMoveToEditorInput,
  type CardDropMoveToEditorResult,
  type Card,
  type CardCreatePlacement,
  type CardCreateInput,
  type CardInput,
  type CardUpdateResult,
  type CardOccurrenceActionInput,
  type CardOccurrenceUpdateInput,
  type Column,
  type MoveCardInput,
  type MoveCardToProjectInput,
  type MoveCardToProjectResult,
  type MoveCardsInput,
  type Project,
  type ProjectInput,
  type RecurrenceConfig,
  type ReminderConfig,
} from "../../shared/types";
import {
  normalizeProjectIcon,
  normalizeProjectIconUpdate,
} from "../../shared/project-icon";
import { getDatabasePath, getKanbanDir } from "./config";
import { dbNotifier } from "./db-notifier";
import { ensureDatabase, COLUMNS, type EnsureDatabaseOptions } from "./schema";
import * as historyService from "./history-service";
import { assertValidCardInput } from "./card-input-validation";
import {
  expandCardOccurrences,
  nextOccurrenceAfter,
  shiftUntilDateByDays,
  type RecurrenceException,
} from "./recurrence-service";
import * as fs from "fs";

interface DbCard {
  id: string;
  project_id: string;
  column_id: string;
  title: string;
  description: string;
  priority: string;
  estimate: string | null;
  tags: string;
  due_date: string | null;
  assignee: string | null;
  agent_blocked: number;
  agent_status: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  is_all_day: number;
  recurrence_json: string | null;
  reminders_json: string;
  schedule_timezone: string | null;
  run_in_target: string;
  run_in_local_path: string | null;
  run_in_base_branch: string | null;
  run_in_worktree_path: string | null;
  run_in_environment_path: string | null;
  revision: number;
  created: string;
  order: number;
}

interface DbRecurrenceException {
  id: number;
  project_id: string;
  card_id: string;
  occurrence_start: string;
  exception_type: "skip" | "override_time";
  override_start: string | null;
  override_end: string | null;
  override_reminders_json: string | null;
  created: string;
}

interface DbProject {
  id: string;
  name: string;
  description: string;
  icon: string;
  workspace_path: string | null;
  created: string;
}

// Module-level singleton (Electron main process is a single long-lived process)
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = getDatabasePath();
    const dir = getKanbanDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
  }
  return db;
}

export function closeDatabase(): void {
  if (!db) return;
  db.close();
  db = null;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function normalizeClientId(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 128) {
    throw new Error("clientId exceeds 128 characters");
  }
  if (/\s/.test(normalized)) {
    throw new Error("clientId cannot contain whitespace");
  }
  return normalized;
}

function assertCardIdAvailable(database: Database.Database, id: string): void {
  const existing = database.prepare("SELECT 1 FROM cards WHERE id = ?").get(id);
  if (existing) {
    throw new Error(`Card id already exists: ${id}`);
  }
}

/** Resolve columnId from the database when not provided by the caller. */
function resolveColumnId(
  database: Database.Database,
  projectId: string,
  cardId: string,
  columnId?: string,
): string | null {
  if (columnId) return columnId;
  const row = database
    .prepare("SELECT column_id FROM cards WHERE id = ? AND project_id = ?")
    .get(cardId, projectId) as { column_id: string } | undefined;
  return row?.column_id ?? null;
}

function rowToCard(row: DbCard): Card {
  const runInTarget = parseRunInTarget(row.run_in_target);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority as Card["priority"],
    estimate: row.estimate as Card["estimate"] | undefined,
    tags: parseTags(row.tags),
    dueDate: row.due_date ? new Date(row.due_date) : undefined,
    scheduledStart: row.scheduled_start ? new Date(row.scheduled_start) : undefined,
    scheduledEnd: row.scheduled_end ? new Date(row.scheduled_end) : undefined,
    isAllDay: row.is_all_day === 1,
    recurrence: parseRecurrence(row.recurrence_json),
    reminders: parseReminders(row.reminders_json),
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

function parseRunInTarget(value: string | null | undefined): Card["runInTarget"] {
  if (value === "local_project") return "localProject";
  if (value === "new_worktree") return "newWorktree";
  if (value === "cloud") return "cloud";
  return "localProject";
}

function toRunInTargetDbValue(value: CardInput["runInTarget"]): string {
  if (value === "newWorktree") return "new_worktree";
  if (value === "cloud") return "cloud";
  return "local_project";
}

function parseRecurrence(value: string | null): RecurrenceConfig | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as RecurrenceConfig;
  } catch {
    return undefined;
  }
}

function parseReminders(value: string): ReminderConfig[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ReminderConfig => (
      typeof item === "object"
      && item !== null
      && typeof (item as { offsetMinutes?: unknown }).offsetMinutes === "number"
    ));
  } catch {
    return [];
  }
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    return [];
  }
}

function rowToProject(row: DbProject): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: normalizeProjectIcon(row.icon),
    workspacePath: row.workspace_path || undefined,
    created: new Date(row.created),
  };
}

interface CardUpdateMutation {
  fields: string[];
  values: (string | number | null)[];
  previousValues: Partial<Card>;
  newValues: Partial<Card>;
}

function buildCardUpdateMutation(
  existing: DbCard,
  updates: Partial<CardInput>,
): CardUpdateMutation {
  const previousValues: Partial<Card> = {};
  const newValues: Partial<Card> = {};
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.title !== undefined) {
    fields.push("title = ?");
    values.push(updates.title);
    previousValues.title = existing.title;
    newValues.title = updates.title;
  }
  if (updates.description !== undefined) {
    fields.push("description = ?");
    values.push(updates.description);
    previousValues.description = existing.description;
    newValues.description = updates.description;
  }
  if (updates.priority !== undefined) {
    fields.push("priority = ?");
    values.push(updates.priority);
    previousValues.priority = existing.priority as Card["priority"];
    newValues.priority = updates.priority;
  }
  if (updates.estimate !== undefined) {
    fields.push("estimate = ?");
    values.push(updates.estimate || null);
    previousValues.estimate = existing.estimate as Card["estimate"] | undefined;
    newValues.estimate = updates.estimate ?? undefined;
  }
  if (updates.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(updates.tags));
    previousValues.tags = parseTags(existing.tags);
    newValues.tags = updates.tags;
  }
  if (updates.dueDate !== undefined) {
    fields.push("due_date = ?");
    values.push(updates.dueDate?.toISOString().split("T")[0] || null);
    previousValues.dueDate = existing.due_date ? new Date(existing.due_date) : undefined;
    newValues.dueDate = updates.dueDate ?? undefined;
  }
  if (updates.scheduledStart !== undefined) {
    fields.push("scheduled_start = ?");
    values.push(updates.scheduledStart?.toISOString() ?? null);
    previousValues.scheduledStart = existing.scheduled_start ? new Date(existing.scheduled_start) : undefined;
    newValues.scheduledStart = updates.scheduledStart ?? undefined;
  }
  if (updates.scheduledEnd !== undefined) {
    fields.push("scheduled_end = ?");
    values.push(updates.scheduledEnd?.toISOString() ?? null);
    previousValues.scheduledEnd = existing.scheduled_end ? new Date(existing.scheduled_end) : undefined;
    newValues.scheduledEnd = updates.scheduledEnd ?? undefined;
  }
  if (updates.isAllDay !== undefined) {
    fields.push("is_all_day = ?");
    values.push(updates.isAllDay ? 1 : 0);
    previousValues.isAllDay = existing.is_all_day === 1;
    newValues.isAllDay = Boolean(updates.isAllDay);
  }
  if (updates.recurrence !== undefined) {
    fields.push("recurrence_json = ?");
    values.push(updates.recurrence ? JSON.stringify(updates.recurrence) : null);
    previousValues.recurrence = parseRecurrence(existing.recurrence_json);
    newValues.recurrence = updates.recurrence ?? undefined;
  }
  if (updates.reminders !== undefined) {
    fields.push("reminders_json = ?");
    values.push(JSON.stringify(updates.reminders));
    previousValues.reminders = parseReminders(existing.reminders_json);
    newValues.reminders = updates.reminders;
  }
  if (updates.scheduleTimezone !== undefined) {
    fields.push("schedule_timezone = ?");
    values.push(updates.scheduleTimezone?.trim() || null);
    previousValues.scheduleTimezone = existing.schedule_timezone || undefined;
    newValues.scheduleTimezone = updates.scheduleTimezone?.trim() || undefined;
  }
  if (updates.assignee !== undefined) {
    fields.push("assignee = ?");
    values.push(updates.assignee || null);
    previousValues.assignee = existing.assignee || undefined;
    newValues.assignee = updates.assignee;
  }
  if (updates.agentBlocked !== undefined) {
    fields.push("agent_blocked = ?");
    values.push(updates.agentBlocked ? 1 : 0);
    previousValues.agentBlocked = existing.agent_blocked === 1;
    newValues.agentBlocked = updates.agentBlocked;
  }
  if (updates.agentStatus !== undefined) {
    fields.push("agent_status = ?");
    values.push(updates.agentStatus || null);
    previousValues.agentStatus = existing.agent_status || undefined;
    newValues.agentStatus = updates.agentStatus;
  }
  if (updates.runInTarget !== undefined) {
    fields.push("run_in_target = ?");
    values.push(toRunInTargetDbValue(updates.runInTarget));
    previousValues.runInTarget = parseRunInTarget(existing.run_in_target);
    newValues.runInTarget = updates.runInTarget;
  }
  if (updates.runInLocalPath !== undefined) {
    fields.push("run_in_local_path = ?");
    values.push(updates.runInLocalPath?.trim() || null);
    previousValues.runInLocalPath = existing.run_in_local_path || undefined;
    newValues.runInLocalPath = updates.runInLocalPath?.trim() || undefined;
  }
  if (updates.runInBaseBranch !== undefined) {
    fields.push("run_in_base_branch = ?");
    values.push(updates.runInBaseBranch?.trim() || null);
    previousValues.runInBaseBranch = existing.run_in_base_branch || undefined;
    newValues.runInBaseBranch = updates.runInBaseBranch?.trim() || undefined;
  }
  if (updates.runInWorktreePath !== undefined) {
    fields.push("run_in_worktree_path = ?");
    values.push(updates.runInWorktreePath?.trim() || null);
    previousValues.runInWorktreePath = existing.run_in_worktree_path || undefined;
    newValues.runInWorktreePath = updates.runInWorktreePath?.trim() || undefined;
  }
  if (updates.runInEnvironmentPath !== undefined) {
    fields.push("run_in_environment_path = ?");
    values.push(updates.runInEnvironmentPath?.trim() || null);
    previousValues.runInEnvironmentPath = existing.run_in_environment_path || undefined;
    newValues.runInEnvironmentPath = updates.runInEnvironmentPath?.trim() || undefined;
  }

  return { fields, values, previousValues, newValues };
}

// === Project CRUD ===

export function listProjects(): Project[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT * FROM projects ORDER BY created ASC")
    .all() as DbProject[];
  return rows.map(rowToProject);
}

export function getProject(projectId: string): Project | null {
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as DbProject | undefined;
  return row ? rowToProject(row) : null;
}

export function createProject(input: ProjectInput): Project {
  const database = getDb();
  const now = new Date();
  const icon = normalizeProjectIcon(input.icon);
  const workspacePath = input.workspacePath?.trim() || null;

  database.prepare(
    "INSERT INTO projects (id, name, description, icon, workspace_path, created) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(input.id, input.name, input.description || "", icon, workspacePath, now.toISOString());

  return {
    id: input.id,
    name: input.name,
    description: input.description || "",
    icon,
    workspacePath: workspacePath || undefined,
    created: now,
  };
}

export function deleteProject(projectId: string): boolean {
  const database = getDb();
  const result = database
    .prepare("DELETE FROM projects WHERE id = ?")
    .run(projectId);
  return result.changes > 0;
}

export function renameProject(
  oldId: string,
  newId: string,
  updates?: { name?: string; description?: string; icon?: string; workspacePath?: string | null }
): Project | null {
  const database = getDb();
  const existing = database
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(oldId) as DbProject | undefined;
  if (!existing) return null;

  if (oldId !== newId) {
    const conflict = database
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get(newId);
    if (conflict) throw new Error(`Project "${newId}" already exists`);
  }

  // Disable FK checks so we can update the PK + FK references atomically
  database.pragma("foreign_keys = OFF");
  try {
    const txn = database.transaction(() => {
      if (oldId !== newId) {
        database.prepare("UPDATE projects SET id = ? WHERE id = ?").run(newId, oldId);
        database.prepare("UPDATE cards SET project_id = ? WHERE project_id = ?").run(newId, oldId);
        database.prepare("UPDATE history SET project_id = ? WHERE project_id = ?").run(newId, oldId);
        database.prepare("UPDATE canvas SET project_id = ? WHERE project_id = ?").run(newId, oldId);
        database.prepare("UPDATE recurrence_exceptions SET project_id = ? WHERE project_id = ?").run(newId, oldId);
        database.prepare("UPDATE reminder_receipts SET project_id = ? WHERE project_id = ?").run(newId, oldId);
        database.prepare("UPDATE reminder_snoozes SET project_id = ? WHERE project_id = ?").run(newId, oldId);
        database.prepare("UPDATE codex_card_threads SET project_id = ? WHERE project_id = ?").run(newId, oldId);
      }
      if (updates?.name !== undefined) {
        database.prepare("UPDATE projects SET name = ? WHERE id = ?").run(updates.name, newId);
      }
      if (updates?.description !== undefined) {
        database.prepare("UPDATE projects SET description = ? WHERE id = ?").run(updates.description, newId);
      }
      if (updates?.workspacePath !== undefined) {
        const workspacePath = updates.workspacePath?.trim() || null;
        database.prepare("UPDATE projects SET workspace_path = ? WHERE id = ?").run(workspacePath, newId);
      }
      const normalizedIcon = normalizeProjectIconUpdate(updates?.icon);
      if (normalizedIcon !== undefined) {
        database.prepare("UPDATE projects SET icon = ? WHERE id = ?").run(normalizedIcon, newId);
      }
    });
    txn();
  } finally {
    database.pragma("foreign_keys = ON");
  }

  return getProject(newId);
}

// === Card CRUD ===

export async function readColumn(projectId: string, columnId: string): Promise<Column> {
  const columnMeta = COLUMNS.find((c) => c.id === columnId);
  if (!columnMeta) throw new Error(`Unknown column: ${columnId}`);

  const stmt = getDb().prepare(
    'SELECT * FROM cards WHERE project_id = ? AND column_id = ? ORDER BY "order" ASC'
  );
  const rows = stmt.all(projectId, columnId) as DbCard[];

  return {
    id: columnId,
    name: columnMeta.name,
    cards: rows.map(rowToCard),
  };
}

export async function getBoard(projectId: string): Promise<Board> {
  const columns = await Promise.all(COLUMNS.map((c) => readColumn(projectId, c.id)));
  return { columns };
}

export async function createCard(
  projectId: string,
  columnId: string,
  input: CardCreateInput,
  sessionId?: string,
  placement: CardCreatePlacement = "bottom",
): Promise<Card> {
  assertValidCardInput(input, "create");

  const database = getDb();
  const requestedId = normalizeClientId(input.clientId);
  const id = requestedId ?? generateId();
  const now = new Date();
  const nowIso = now.toISOString();

  const card = database.transaction(() => {
    if (requestedId) {
      assertCardIdAvailable(database, requestedId);
    }

    const order = (() => {
      if (placement === "top") {
        database
          .prepare(
            `UPDATE cards SET "order" = "order" + 1
             WHERE project_id = ? AND column_id = ?`,
          )
          .run(projectId, columnId);
        return 0;
      }

      const maxOrderRow = database
        .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
        .get(projectId, columnId) as { maxOrder: number | null } | undefined;
      return (maxOrderRow?.maxOrder ?? -1) + 1;
    })();

    database.prepare(`
      INSERT INTO cards (
        id, project_id, column_id, title, description, priority, estimate,
        tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
        assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      columnId,
      input.title,
      input.description || "",
      input.priority || "p2-medium",
      input.estimate || null,
      JSON.stringify(input.tags || []),
      input.dueDate?.toISOString().split("T")[0] || null,
      input.scheduledStart?.toISOString() ?? null,
      input.scheduledEnd?.toISOString() ?? null,
      input.isAllDay ? 1 : 0,
      input.recurrence ? JSON.stringify(input.recurrence) : null,
      JSON.stringify(input.reminders ?? []),
      input.scheduleTimezone?.trim() || null,
      input.assignee || null,
      input.agentBlocked ? 1 : 0,
      input.agentStatus || null,
      toRunInTargetDbValue(input.runInTarget),
      input.runInLocalPath?.trim() || null,
      input.runInBaseBranch?.trim() || null,
      input.runInWorktreePath?.trim() || null,
      input.runInEnvironmentPath?.trim() || null,
      nowIso,
      order
    );

    const result: Card = {
      id,
      title: input.title,
      description: input.description || "",
      priority: input.priority || "p2-medium",
      estimate: input.estimate ?? undefined,
      tags: input.tags || [],
      dueDate: input.dueDate ?? undefined,
      scheduledStart: input.scheduledStart ?? undefined,
      scheduledEnd: input.scheduledEnd ?? undefined,
      isAllDay: Boolean(input.isAllDay),
      recurrence: input.recurrence ?? undefined,
      reminders: input.reminders ?? [],
      scheduleTimezone: input.scheduleTimezone ?? undefined,
      assignee: input.assignee,
      agentBlocked: input.agentBlocked ?? false,
      agentStatus: input.agentStatus,
      runInTarget: input.runInTarget ?? "localProject",
      runInLocalPath: input.runInLocalPath?.trim() || undefined,
      runInBaseBranch: input.runInBaseBranch?.trim() || undefined,
      runInWorktreePath: input.runInWorktreePath?.trim() || undefined,
      runInEnvironmentPath: input.runInEnvironmentPath?.trim() || undefined,
      revision: 1,
      created: now,
      order,
    };

    historyService.clearRedoStack(projectId, sessionId);
    historyService.recordCreate(result, projectId, columnId, sessionId);

    return result;
  })();

  dbNotifier.notifyChange(projectId, "create", columnId, id);

  return card;
}

export async function updateCard(
  projectId: string,
  columnId: string | undefined,
  cardId: string,
  updates: Partial<CardInput>,
  sessionId?: string,
  expectedRevision?: number,
): Promise<CardUpdateResult> {
  assertValidCardInput(updates, "update");
  const database = getDb();

  const result = database.transaction(() => {
    const resolvedColumnId = resolveColumnId(database, projectId, cardId, columnId);
    if (!resolvedColumnId) {
      return { status: "not_found" } as const;
    }

    const existing = database
      .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
      .get(cardId, projectId, resolvedColumnId) as DbCard | undefined;

    if (!existing) {
      return { status: "not_found" } as const;
    }

    if (
      Number.isInteger(expectedRevision)
      && typeof expectedRevision === "number"
      && expectedRevision !== existing.revision
    ) {
      return {
        status: "conflict",
        card: rowToCard(existing),
        columnId: resolvedColumnId,
      } as const;
    }

    const {
      fields,
      values,
      previousValues,
      newValues,
    } = buildCardUpdateMutation(existing, updates);

    let didMutate = false;
    if (fields.length > 0) {
      didMutate = true;
      values.push(cardId);
      database.prepare(
        `UPDATE cards SET ${fields.join(", ")}, revision = revision + 1 WHERE id = ?`
      ).run(...values);

      historyService.clearRedoStack(projectId, sessionId);
      historyService.recordUpdate(cardId, projectId, resolvedColumnId, previousValues, newValues, sessionId);
    }

    const updated = database
      .prepare("SELECT * FROM cards WHERE id = ?")
      .get(cardId) as DbCard;

    return {
      status: "updated",
      card: rowToCard(updated),
      columnId: resolvedColumnId,
      didMutate,
    } as const;
  })();

  if (result.status !== "updated") {
    return result;
  }

  if (result.didMutate) {
    dbNotifier.notifyChange(projectId, "update", result.columnId, cardId);
  }

  return {
    status: "updated",
    card: result.card,
    columnId: result.columnId,
  };
}

export async function deleteCard(
  projectId: string,
  columnId: string | undefined,
  cardId: string,
  sessionId?: string
): Promise<boolean> {
  const database = getDb();

  const result = database.transaction(() => {
    const resolvedColumnId = resolveColumnId(database, projectId, cardId, columnId);
    if (!resolvedColumnId) return null;

    const cardRow = database
      .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
      .get(cardId, projectId, resolvedColumnId) as DbCard | undefined;

    if (!cardRow) return null;

    const card = rowToCard(cardRow);

    database.prepare("DELETE FROM cards WHERE id = ?").run(cardId);

    database
      .prepare(
        `UPDATE cards SET "order" = "order" - 1 WHERE project_id = ? AND column_id = ? AND "order" > ?`
      )
      .run(projectId, resolvedColumnId, cardRow.order);

    historyService.clearRedoStack(projectId, sessionId);
    historyService.recordDelete(card, projectId, resolvedColumnId, sessionId);

    return resolvedColumnId;
  })();

  if (!result) return false;

  dbNotifier.notifyChange(projectId, "delete", result, cardId);
  return true;
}

export interface MoveCardInputWithSession extends MoveCardInput {
  projectId: string;
  sessionId?: string;
}

export interface MoveCardsInputWithSession extends MoveCardsInput {
  projectId: string;
  sessionId?: string;
}

export interface MoveCardToProjectInputWithSession extends MoveCardToProjectInput {
  sessionId?: string;
}

function clampOrderIndex(value: number, max: number): number {
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

const columnOrderIndex = new Map(
  COLUMNS.map((column, index) => [column.id, index]),
);

function compareCardsByBoardPosition(left: DbCard, right: DbCard): number {
  const leftIndex = columnOrderIndex.get(left.column_id) ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = columnOrderIndex.get(right.column_id) ?? Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  if (left.order !== right.order) return left.order - right.order;
  return left.id.localeCompare(right.id);
}

function listOrderedColumnCards(
  database: Database.Database,
  projectId: string,
  columnId: string,
): DbCard[] {
  return database
    .prepare(
      `SELECT * FROM cards
       WHERE project_id = ? AND column_id = ?
       ORDER BY "order" ASC`,
    )
    .all(projectId, columnId) as DbCard[];
}

function rewriteColumnOrdering(
  database: Database.Database,
  cards: readonly DbCard[],
  columnId: string,
): void {
  const updateCardPosition = database.prepare(
    'UPDATE cards SET column_id = ?, "order" = ? WHERE id = ?',
  );

  cards.forEach((card, index) => {
    if (card.column_id === columnId && card.order === index) return;
    updateCardPosition.run(columnId, index, card.id);
  });
}

function readCardRowsByIds(
  database: Database.Database,
  projectId: string,
  cardIds: readonly string[],
): DbCard[] {
  if (cardIds.length === 0) return [];

  const placeholders = cardIds.map(() => "?").join(", ");
  return database
    .prepare(
      `SELECT * FROM cards
       WHERE project_id = ? AND id IN (${placeholders})`,
    )
    .all(projectId, ...cardIds) as DbCard[];
}

export async function moveCard(input: MoveCardInputWithSession): Promise<"moved" | "not_found" | "wrong_column"> {
  const database = getDb();

  const result = database.transaction(() => {
    // Resolve fromColumnId — either explicitly provided (atomic claim) or auto-resolved
    let fromColumnId: string;
    let card: DbCard | undefined;

    if (input.fromColumnId) {
      // Atomic claim: assert card is still in the expected column
      card = database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
        .get(input.cardId, input.projectId, input.fromColumnId) as DbCard | undefined;

      if (!card) {
        // Distinguish: card doesn't exist vs card moved to different column
        const exists = database
          .prepare("SELECT 1 FROM cards WHERE id = ? AND project_id = ?")
          .get(input.cardId, input.projectId);
        return exists ? "wrong_column" : "not_found";
      }

      fromColumnId = input.fromColumnId;
    } else {
      // Auto-resolve column
      const resolved = resolveColumnId(database, input.projectId, input.cardId);
      if (!resolved) return "not_found";
      fromColumnId = resolved;

      card = database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
        .get(input.cardId, input.projectId, fromColumnId) as DbCard | undefined;

      if (!card) return "not_found";
    }

    const currentOrder = card.order;

    // Resolve newOrder: undefined means append to end of target column
    const newOrder = input.newOrder ?? (() => {
      const row = database
        .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
        .get(input.projectId, input.toColumnId) as { maxOrder: number | null } | undefined;
      const max = row?.maxOrder ?? -1;
      // If moving within the same column, the card itself is counted in MAX — end position is max (not max+1)
      if (fromColumnId === input.toColumnId) return max;
      return max + 1;
    })();

    if (fromColumnId === input.toColumnId) {
      if (newOrder > currentOrder) {
        database
          .prepare(
            `UPDATE cards SET "order" = "order" - 1
             WHERE project_id = ? AND column_id = ? AND "order" > ? AND "order" <= ?`
          )
          .run(input.projectId, fromColumnId, currentOrder, newOrder);
      } else if (newOrder < currentOrder) {
        database
          .prepare(
            `UPDATE cards SET "order" = "order" + 1
             WHERE project_id = ? AND column_id = ? AND "order" >= ? AND "order" < ?`
          )
          .run(input.projectId, fromColumnId, newOrder, currentOrder);
      }
      database
        .prepare('UPDATE cards SET "order" = ? WHERE id = ?')
        .run(newOrder, input.cardId);
    } else {
      database
        .prepare(
          `UPDATE cards SET "order" = "order" - 1
           WHERE project_id = ? AND column_id = ? AND "order" > ?`
        )
        .run(input.projectId, fromColumnId, currentOrder);

      database
        .prepare(
          `UPDATE cards SET "order" = "order" + 1
           WHERE project_id = ? AND column_id = ? AND "order" >= ?`
        )
        .run(input.projectId, input.toColumnId, newOrder);

      database
        .prepare('UPDATE cards SET column_id = ?, "order" = ? WHERE id = ?')
        .run(input.toColumnId, newOrder, input.cardId);
    }

    historyService.clearRedoStack(input.projectId, input.sessionId);
    historyService.recordMove(
      input.cardId,
      input.projectId,
      fromColumnId,
      input.toColumnId,
      currentOrder,
      newOrder,
      input.sessionId
    );

    return { movedFromColumnId: fromColumnId };
  })();

  // Error results are strings
  if (typeof result === "string") return result;

  dbNotifier.notifyChange(input.projectId, "move", input.toColumnId, input.cardId);
  if (result.movedFromColumnId !== input.toColumnId) {
    dbNotifier.notifyChange(input.projectId, "move", result.movedFromColumnId, input.cardId);
  }

  return "moved";
}

export async function moveCards(
  input: MoveCardsInputWithSession,
): Promise<"moved" | "not_found" | "wrong_column"> {
  if (!Array.isArray(input.cardIds) || input.cardIds.length === 0) {
    throw new Error("cardIds must be a non-empty array");
  }

  const uniqueCardIds = Array.from(new Set(input.cardIds));
  if (uniqueCardIds.length !== input.cardIds.length) {
    throw new Error("cardIds must be unique");
  }

  const database = getDb();

  const result = database.transaction(() => {
    let selectedCards: DbCard[];

    if (input.fromColumnId) {
      const sourceCards = listOrderedColumnCards(database, input.projectId, input.fromColumnId);
      const sourceCardIdSet = new Set(sourceCards.map((card) => card.id));
      const missingCardId = uniqueCardIds.find((cardId) => !sourceCardIdSet.has(cardId));

      if (missingCardId) {
        const exists = database
          .prepare("SELECT 1 FROM cards WHERE id = ? AND project_id = ?")
          .get(missingCardId, input.projectId);
        return exists ? "wrong_column" : "not_found";
      }

      const selectedCardIdSet = new Set(uniqueCardIds);
      selectedCards = sourceCards.filter((card) => selectedCardIdSet.has(card.id));
    } else {
      const rows = readCardRowsByIds(database, input.projectId, uniqueCardIds);
      if (rows.length !== uniqueCardIds.length) {
        return "not_found";
      }
      selectedCards = [...rows].sort(compareCardsByBoardPosition);
    }

    if (selectedCards.length === 0) {
      return "not_found";
    }

    const selectedCardIdSet = new Set(selectedCards.map((card) => card.id));
    const cardsByColumn = new Map<string, DbCard[]>();

    for (const columnId of new Set([input.toColumnId, ...selectedCards.map((card) => card.column_id)])) {
      cardsByColumn.set(
        columnId,
        listOrderedColumnCards(database, input.projectId, columnId),
      );
    }

    const targetCards = cardsByColumn.get(input.toColumnId) ?? [];
    const remainingTargetCards = targetCards.filter((card) => !selectedCardIdSet.has(card.id));
    const requestedOrder = input.newOrder ?? targetCards.length;
    const selectedTargetCardsBeforeRequested = targetCards.filter((card) =>
      selectedCardIdSet.has(card.id) && card.order < requestedOrder
    ).length;
    const insertIndex = clampOrderIndex(
      requestedOrder - selectedTargetCardsBeforeRequested,
      remainingTargetCards.length,
    );

    const groupId = input.groupId ?? randomUUID();

    const reorderedTargetCards = [...remainingTargetCards];
    reorderedTargetCards.splice(insertIndex, 0, ...selectedCards);
    const movedCards = selectedCards.map((card) => ({
      id: card.id,
      fromColumnId: card.column_id,
      fromOrder: card.order,
      toOrder: reorderedTargetCards.findIndex((candidate) => candidate.id === card.id),
    }));
    const hasAnyChange = movedCards.some((card) =>
      card.fromColumnId !== input.toColumnId || card.fromOrder !== card.toOrder
    );

    if (!hasAnyChange) {
      return {
        movedCards: [] as typeof movedCards,
      };
    }

    for (const [columnId, columnCards] of cardsByColumn) {
      if (columnId === input.toColumnId) continue;
      rewriteColumnOrdering(
        database,
        columnCards.filter((card) => !selectedCardIdSet.has(card.id)),
        columnId,
      );
    }
    rewriteColumnOrdering(database, reorderedTargetCards, input.toColumnId);

    historyService.clearRedoStack(input.projectId, input.sessionId);
    [...movedCards].reverse().forEach((card) => {
      historyService.recordMove(
        card.id,
        input.projectId,
        card.fromColumnId,
        input.toColumnId,
        card.fromOrder,
        card.toOrder,
        input.sessionId,
        groupId,
      );
    });

    return {
      movedCards,
    };
  })();

  if (typeof result === "string") return result;

  result.movedCards.forEach((card) => {
    dbNotifier.notifyChange(input.projectId, "move", input.toColumnId, card.id);
    if (card.fromColumnId !== input.toColumnId) {
      dbNotifier.notifyChange(input.projectId, "move", card.fromColumnId, card.id);
    }
  });

  return "moved";
}

export async function moveCardToProject(
  input: MoveCardToProjectInputWithSession,
): Promise<MoveCardToProjectResult | "not_found" | "wrong_column" | "target_project_not_found"> {
  if (input.sourceProjectId === input.targetProjectId) {
    throw new Error("Target project must be different from source project");
  }

  const database = getDb();
  const result = database.transaction(() => {
    const targetProject = database
      .prepare("SELECT 1 FROM projects WHERE id = ?")
      .get(input.targetProjectId);
    if (!targetProject) return "target_project_not_found";

    let sourceCard: DbCard | undefined;
    let sourceColumnId: string;

    if (input.sourceColumnId) {
      sourceCard = database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
        .get(input.cardId, input.sourceProjectId, input.sourceColumnId) as DbCard | undefined;

      if (!sourceCard) {
        const exists = database
          .prepare("SELECT 1 FROM cards WHERE id = ? AND project_id = ?")
          .get(input.cardId, input.sourceProjectId);
        return exists ? "wrong_column" : "not_found";
      }

      sourceColumnId = input.sourceColumnId;
    } else {
      const resolvedColumnId = resolveColumnId(database, input.sourceProjectId, input.cardId);
      if (!resolvedColumnId) return "not_found";

      sourceCard = database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
        .get(input.cardId, input.sourceProjectId, resolvedColumnId) as DbCard | undefined;
      if (!sourceCard) return "not_found";

      sourceColumnId = resolvedColumnId;
    }

    const targetColumnId = input.targetColumnId ?? sourceColumnId;
    const isKnownTargetColumn =
      targetColumnId === ARCHIVE_COLUMN_ID
      || COLUMNS.some((column) => column.id === targetColumnId);
    if (!isKnownTargetColumn) {
      throw new Error(`Unknown column: ${targetColumnId}`);
    }

    const maxOrderRow = database
      .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
      .get(input.targetProjectId, targetColumnId) as { maxOrder: number | null } | undefined;
    const targetOrder = (maxOrderRow?.maxOrder ?? -1) + 1;

    database
      .prepare(
        `UPDATE cards
         SET project_id = ?, column_id = ?, "order" = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        input.targetProjectId,
        targetColumnId,
        targetOrder,
        input.cardId,
        input.sourceProjectId,
      );

    database
      .prepare(
        `UPDATE cards SET "order" = "order" - 1
         WHERE project_id = ? AND column_id = ? AND "order" > ?`,
      )
      .run(input.sourceProjectId, sourceColumnId, sourceCard.order);

    [
      "recurrence_exceptions",
      "reminder_receipts",
      "reminder_snoozes",
      "codex_card_threads",
    ].forEach((tableName) => {
      database
        .prepare(`UPDATE ${tableName} SET project_id = ? WHERE project_id = ? AND card_id = ?`)
        .run(input.targetProjectId, input.sourceProjectId, input.cardId);
    });

    return {
      cardId: input.cardId,
      sourceProjectId: input.sourceProjectId,
      sourceColumnId,
      targetProjectId: input.targetProjectId,
      targetColumnId,
    };
  })();

  if (typeof result === "string") return result;

  dbNotifier.notifyChange(result.sourceProjectId, "delete", result.sourceColumnId, result.cardId);
  dbNotifier.notifyChange(result.targetProjectId, "create", result.targetColumnId, result.cardId);

  return result;
}

interface AppliedSourceUpdate {
  projectId: string;
  columnId: string;
  cardId: string;
}

export async function importBlockDropAsCards(
  projectId: string,
  input: BlockDropImportInput,
  sessionId?: string,
): Promise<BlockDropImportResult> {
  if (!Array.isArray(input.cards)) {
    throw new Error("cards must be an array");
  }

  if (!Array.isArray(input.sourceUpdates)) {
    throw new Error("sourceUpdates must be an array");
  }
  if (input.cards.length === 0 && input.sourceUpdates.length === 0) {
    throw new Error("At least one card or source update is required");
  }

  if (!Number.isInteger(input.insertIndex ?? 0) || (input.insertIndex ?? 0) < 0) {
    throw new Error("insertIndex must be a non-negative integer");
  }

  const targetColumn = COLUMNS.find((column) => column.id === input.targetColumnId);
  if (!targetColumn) {
    throw new Error(`Unknown column: ${input.targetColumnId}`);
  }

  for (const card of input.cards) {
    assertValidCardInput(card, "create");
  }
  for (const sourceUpdate of input.sourceUpdates) {
    assertValidCardInput(sourceUpdate.updates, "update");
  }

  const database = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const groupId = input.groupId || randomUUID();
  const touchedProjects = new Set<string>([
    projectId,
    ...input.sourceUpdates.map((update) => update.projectId),
  ]);

  const appliedSourceUpdates: AppliedSourceUpdate[] = [];
  const createdCards: Card[] = [];

  database.transaction(() => {
    for (const touchedProjectId of touchedProjects) {
      historyService.clearRedoStack(touchedProjectId, sessionId);
    }

    for (const sourceUpdate of input.sourceUpdates) {
      const resolvedColumnId = resolveColumnId(
        database,
        sourceUpdate.projectId,
        sourceUpdate.cardId,
        sourceUpdate.columnId,
      );
      if (!resolvedColumnId) {
        throw new Error(`Card not found: ${sourceUpdate.cardId}`);
      }

      const existing = database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
        .get(
          sourceUpdate.cardId,
          sourceUpdate.projectId,
          resolvedColumnId,
        ) as DbCard | undefined;

      if (!existing) {
        throw new Error(`Card not found: ${sourceUpdate.cardId}`);
      }

      const mutation = buildCardUpdateMutation(existing, sourceUpdate.updates);
      if (mutation.fields.length === 0) continue;

      mutation.values.push(sourceUpdate.cardId);
      database
        .prepare(`UPDATE cards SET ${mutation.fields.join(", ")} WHERE id = ?`)
        .run(...mutation.values);

      historyService.recordUpdate(
        sourceUpdate.cardId,
        sourceUpdate.projectId,
        resolvedColumnId,
        mutation.previousValues,
        mutation.newValues,
        sessionId,
        groupId,
      );

      appliedSourceUpdates.push({
        projectId: sourceUpdate.projectId,
        columnId: resolvedColumnId,
        cardId: sourceUpdate.cardId,
      });
    }

    const maxOrderRow = database
      .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
      .get(projectId, input.targetColumnId) as { maxOrder: number | null } | undefined;
    const maxOrder = maxOrderRow?.maxOrder ?? -1;
    const insertIndex = Math.min(input.insertIndex ?? maxOrder + 1, maxOrder + 1);

    database
      .prepare(
        `UPDATE cards SET "order" = "order" + ?
         WHERE project_id = ? AND column_id = ? AND "order" >= ?`
      )
      .run(input.cards.length, projectId, input.targetColumnId, insertIndex);

    for (const [offset, cardInput] of input.cards.entries()) {
      const requestedId = normalizeClientId(cardInput.clientId);
      const id = requestedId ?? generateId();
      if (requestedId) {
        assertCardIdAvailable(database, requestedId);
      }
      const order = insertIndex + offset;

      database.prepare(`
        INSERT INTO cards (
          id, project_id, column_id, title, description, priority, estimate,
          tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
          assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        projectId,
        input.targetColumnId,
        cardInput.title,
        cardInput.description || "",
        cardInput.priority || "p2-medium",
        cardInput.estimate || null,
        JSON.stringify(cardInput.tags || []),
        cardInput.dueDate?.toISOString().split("T")[0] || null,
        cardInput.scheduledStart?.toISOString() ?? null,
        cardInput.scheduledEnd?.toISOString() ?? null,
        cardInput.isAllDay ? 1 : 0,
        cardInput.recurrence ? JSON.stringify(cardInput.recurrence) : null,
        JSON.stringify(cardInput.reminders ?? []),
        cardInput.scheduleTimezone?.trim() || null,
        cardInput.assignee || null,
        cardInput.agentBlocked ? 1 : 0,
        cardInput.agentStatus || null,
        toRunInTargetDbValue(cardInput.runInTarget),
        cardInput.runInLocalPath?.trim() || null,
        cardInput.runInBaseBranch?.trim() || null,
        cardInput.runInWorktreePath?.trim() || null,
        cardInput.runInEnvironmentPath?.trim() || null,
        nowIso,
        order,
      );

      const createdCard: Card = {
        id,
        title: cardInput.title,
        description: cardInput.description || "",
        priority: cardInput.priority || "p2-medium",
        estimate: cardInput.estimate ?? undefined,
        tags: cardInput.tags || [],
        dueDate: cardInput.dueDate ?? undefined,
        scheduledStart: cardInput.scheduledStart ?? undefined,
        scheduledEnd: cardInput.scheduledEnd ?? undefined,
        isAllDay: Boolean(cardInput.isAllDay),
        recurrence: cardInput.recurrence ?? undefined,
        reminders: cardInput.reminders ?? [],
        scheduleTimezone: cardInput.scheduleTimezone ?? undefined,
        assignee: cardInput.assignee,
        agentBlocked: cardInput.agentBlocked ?? false,
        agentStatus: cardInput.agentStatus,
        runInTarget: cardInput.runInTarget ?? "localProject",
        runInLocalPath: cardInput.runInLocalPath?.trim() || undefined,
        runInBaseBranch: cardInput.runInBaseBranch?.trim() || undefined,
        runInWorktreePath: cardInput.runInWorktreePath?.trim() || undefined,
        runInEnvironmentPath: cardInput.runInEnvironmentPath?.trim() || undefined,
        revision: 1,
        created: now,
        order,
      };

      historyService.recordCreate(
        createdCard,
        projectId,
        input.targetColumnId,
        sessionId,
        groupId,
      );

      createdCards.push(createdCard);
    }
  })();

  for (const update of appliedSourceUpdates) {
    dbNotifier.notifyChange(update.projectId, "update", update.columnId, update.cardId);
  }
  for (const card of createdCards) {
    dbNotifier.notifyChange(projectId, "create", input.targetColumnId, card.id);
  }

  return {
    cards: createdCards,
    groupId,
  };
}

interface AppliedTargetDescriptionUpdate {
  columnId: string;
  cardId: string;
}

export async function moveCardDropToEditor(
  projectId: string,
  input: CardDropMoveToEditorInput,
  sessionId?: string,
): Promise<CardDropMoveToEditorResult> {
  const sourceProjectId = typeof input.sourceProjectId === "string"
    && input.sourceProjectId.length > 0
    ? input.sourceProjectId
    : projectId;

  if (typeof input.sourceCardId !== "string" || input.sourceCardId.length === 0) {
    throw new Error("sourceCardId is required");
  }

  const sourceCards = Array.isArray(input.sourceCards) && input.sourceCards.length > 0
    ? input.sourceCards
    : [{ cardId: input.sourceCardId, columnId: input.sourceColumnId }];
  const uniqueSourceCardIds = Array.from(new Set(sourceCards.map((source) => source.cardId)));
  if (uniqueSourceCardIds.length !== sourceCards.length) {
    throw new Error("source cards must be unique");
  }

  if (!Array.isArray(input.targetUpdates) || input.targetUpdates.length === 0) {
    throw new Error("At least one target update is required");
  }

  for (const targetUpdate of input.targetUpdates) {
    if (targetUpdate.projectId !== projectId) {
      throw new Error("Cross-project drops are not supported");
    }
    if (sourceProjectId === projectId && uniqueSourceCardIds.includes(targetUpdate.cardId)) {
      throw new Error("Cannot drop a card into itself");
    }
    assertValidCardInput(targetUpdate.updates, "update");
  }

  const database = getDb();
  const groupId = input.groupId || randomUUID();
  const appliedTargetUpdates: AppliedTargetDescriptionUpdate[] = [];
  let sourceColumnId = "";

  database.transaction(() => {
    const sourceRows = [...sourceCards.map((source) => {
      const resolvedSourceColumnId = resolveColumnId(
        database,
        sourceProjectId,
        source.cardId,
        source.columnId,
      );
      if (!resolvedSourceColumnId) {
        throw new Error(`Card not found: ${source.cardId}`);
      }
      if (source.columnId && source.columnId !== resolvedSourceColumnId) {
        throw new Error("Card is no longer in the expected column");
      }

      const sourceRow = database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
        .get(
          source.cardId,
          sourceProjectId,
          resolvedSourceColumnId,
        ) as DbCard | undefined;
      if (!sourceRow) {
        throw new Error(`Card not found: ${source.cardId}`);
      }

      return sourceRow;
    })].sort(compareCardsByBoardPosition);

    historyService.clearRedoStack(projectId, sessionId);
    if (sourceProjectId !== projectId) {
      historyService.clearRedoStack(sourceProjectId, sessionId);
    }

    for (const targetUpdate of input.targetUpdates) {
      const resolvedTargetColumnId = resolveColumnId(
        database,
        projectId,
        targetUpdate.cardId,
        targetUpdate.columnId,
      );
      if (!resolvedTargetColumnId) {
        throw new Error(`Card not found: ${targetUpdate.cardId}`);
      }

      const existingTarget = database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
        .get(
          targetUpdate.cardId,
          projectId,
          resolvedTargetColumnId,
        ) as DbCard | undefined;
      if (!existingTarget) {
        throw new Error(`Card not found: ${targetUpdate.cardId}`);
      }

      const mutation = buildCardUpdateMutation(existingTarget, targetUpdate.updates);
      if (mutation.fields.length === 0) continue;

      mutation.values.push(targetUpdate.cardId);
      database
        .prepare(`UPDATE cards SET ${mutation.fields.join(", ")} WHERE id = ?`)
        .run(...mutation.values);

      historyService.recordUpdate(
        targetUpdate.cardId,
        projectId,
        resolvedTargetColumnId,
        mutation.previousValues,
        mutation.newValues,
        sessionId,
        groupId,
      );

      appliedTargetUpdates.push({
        columnId: resolvedTargetColumnId,
        cardId: targetUpdate.cardId,
      });
    }

    sourceColumnId = sourceRows[0]?.column_id ?? "";

    const deleteCardStmt = database.prepare("DELETE FROM cards WHERE id = ? AND project_id = ?");
    const collapseOrderStmt = database.prepare(
      `UPDATE cards SET "order" = "order" - 1
       WHERE project_id = ? AND column_id = ? AND "order" > ?`,
    );
    const sourceRowsByColumn = new Map<string, DbCard[]>();
    sourceRows.forEach((row: DbCard) => {
      const rows = sourceRowsByColumn.get(row.column_id) ?? [];
      rows.push(row);
      sourceRowsByColumn.set(row.column_id, rows);
    });

    for (const rows of sourceRowsByColumn.values()) {
      [...rows]
        .sort((left: DbCard, right: DbCard) => right.order - left.order)
        .forEach((row: DbCard) => {
          deleteCardStmt.run(row.id, sourceProjectId);
          collapseOrderStmt.run(sourceProjectId, row.column_id, row.order);
        });
    }

    [...sourceRows].reverse().forEach((row: DbCard) => {
      historyService.recordDelete(
        rowToCard(row),
        sourceProjectId,
        row.column_id,
        sessionId,
        groupId,
      );
    });
  })();

  for (const targetUpdate of appliedTargetUpdates) {
    dbNotifier.notifyChange(projectId, "update", targetUpdate.columnId, targetUpdate.cardId);
  }
  sourceCards.forEach((source) => {
    dbNotifier.notifyChange(
      sourceProjectId,
      "delete",
      source.columnId ?? sourceColumnId,
      source.cardId,
    );
  });

  return {
    sourceCardId: input.sourceCardId,
    sourceColumnId,
    sourceCardIds: sourceCards.map((source) => source.cardId),
    updatedCardIds: [...new Set(appliedTargetUpdates.map((update) => update.cardId))],
    groupId,
  };
}

export async function getCard(
  projectId: string,
  cardId: string,
  columnId?: string,
): Promise<{ card: Card; columnId: string } | null> {
  const database = getDb();
  const row = columnId
    ? database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
        .get(cardId, projectId, columnId) as DbCard | undefined
    : database
        .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ?")
        .get(cardId, projectId) as DbCard | undefined;

  return row ? { card: rowToCard(row), columnId: row.column_id } : null;
}

export function findCardLocationById(
  cardId: string,
): { projectId: string; columnId: string } | null {
  const database = getDb();
  const row = database
    .prepare("SELECT project_id, column_id FROM cards WHERE id = ?")
    .get(cardId) as { project_id: string; column_id: string } | undefined;

  if (!row) {
    return null;
  }

  return {
    projectId: row.project_id,
    columnId: row.column_id,
  };
}

/** Sync card lookup (better-sqlite3 is synchronous). */
export function getCardSync(
  projectId: string,
  cardId: string,
): { title: string } | null {
  const database = getDb();
  const row = database
    .prepare("SELECT title FROM cards WHERE id = ? AND project_id = ?")
    .get(cardId, projectId) as { title: string } | undefined;
  return row ?? null;
}

function resolveColumnName(columnId: string): string {
  if (columnId === ARCHIVE_COLUMN_ID) return ARCHIVE_COLUMN_NAME;
  return COLUMNS.find((column) => column.id === columnId)?.name ?? columnId;
}

function dateKeyInTimezone(date: Date, timezone?: string): string {
  const resolved = timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolved,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function dateKeyDayDelta(fromDateKey: string, toDateKey: string): number {
  const [fromYear, fromMonth, fromDay] = fromDateKey.split("-").map(Number);
  const [toYear, toMonth, toDay] = toDateKey.split("-").map(Number);
  const fromUtc = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const toUtc = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.floor((toUtc - fromUtc) / (24 * 60 * 60 * 1000));
}

function shiftRecurringUntilDateWithDraggedDate(
  recurrence: RecurrenceConfig | undefined,
  occurrenceStart: Date,
  nextStart: Date | undefined,
  timezone?: string,
): RecurrenceConfig | undefined {
  if (!recurrence || !nextStart) return undefined;
  if (recurrence.endCondition?.type !== "untilDate") return undefined;

  const fromDateKey = dateKeyInTimezone(occurrenceStart, timezone);
  const toDateKey = dateKeyInTimezone(nextStart, timezone);
  const dayDelta = dateKeyDayDelta(fromDateKey, toDateKey);
  if (dayDelta === 0) return undefined;

  return {
    ...recurrence,
    endCondition: {
      type: "untilDate",
      untilDate: shiftUntilDateByDays(recurrence.endCondition.untilDate, dayDelta),
    },
  };
}

function queryRecurrenceExceptions(
  database: Database.Database,
  projectId: string,
  cardId: string,
): RecurrenceException[] {
  const rows = database.prepare(`
    SELECT * FROM recurrence_exceptions
    WHERE project_id = ? AND card_id = ?
  `).all(projectId, cardId) as DbRecurrenceException[];

  return rows.map((row) => ({
    occurrenceStart: new Date(row.occurrence_start),
    exceptionType: row.exception_type,
    overrideStart: row.override_start ? new Date(row.override_start) : undefined,
    overrideEnd: row.override_end ? new Date(row.override_end) : undefined,
    overrideReminders: row.override_reminders_json
      ? parseReminders(row.override_reminders_json)
      : undefined,
  }));
}

function upsertSkipRecurrenceException(
  database: Database.Database,
  projectId: string,
  cardId: string,
  occurrenceStart: Date,
  nowIso: string,
): void {
  database.prepare(`
    INSERT INTO recurrence_exceptions (
      project_id, card_id, occurrence_start, exception_type, created
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, card_id, occurrence_start)
    DO UPDATE SET
      exception_type = excluded.exception_type,
      override_start = NULL,
      override_end = NULL,
      override_reminders_json = NULL
  `).run(
    projectId,
    cardId,
    occurrenceStart.toISOString(),
    "skip",
    nowIso,
  );
}

function normalizeSearchTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function cardSearchText(card: Card): string {
  return [
    card.title,
    card.description,
    card.priority,
    card.estimate ?? "",
    card.assignee ?? "",
    card.agentStatus ?? "",
    card.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

export async function listCalendarOccurrences(
  projectId: string,
  windowStart: Date,
  windowEnd: Date,
  searchQuery?: string,
): Promise<CalendarOccurrence[]> {
  const database = getDb();
  const rows = database.prepare(`
    SELECT * FROM cards
    WHERE project_id = ?
      AND scheduled_start IS NOT NULL
      AND scheduled_end IS NOT NULL
  `).all(projectId) as DbCard[];

  const tokens = normalizeSearchTokens(searchQuery ?? "");
  const occurrences: CalendarOccurrence[] = [];

  for (const row of rows) {
    const card = rowToCard(row);
    if (tokens.length > 0) {
      const searchText = cardSearchText(card);
      if (!tokens.every((token) => searchText.includes(token))) continue;
    }

    const exceptions = queryRecurrenceExceptions(database, projectId, card.id);
    const expanded = expandCardOccurrences(card, windowStart, windowEnd, {
      exceptions,
    });
    const thisAndFutureEquivalentToAllThresholdTs = card.scheduledStart?.getTime() ?? null;

    for (const occurrence of expanded) {
      const thisAndFutureEquivalentToAll = Boolean(card.recurrence) &&
        thisAndFutureEquivalentToAllThresholdTs !== null &&
        occurrence.occurrenceStart.getTime() <= thisAndFutureEquivalentToAllThresholdTs;
      occurrences.push({
        ...card,
        id: `${card.id}:${occurrence.occurrenceStart.toISOString()}`,
        cardId: card.id,
        columnId: row.column_id,
        columnName: resolveColumnName(row.column_id),
        occurrenceStart: occurrence.occurrenceStart,
        occurrenceEnd: occurrence.occurrenceEnd,
        scheduledStart: occurrence.occurrenceStart,
        scheduledEnd: occurrence.occurrenceEnd,
        reminders: occurrence.reminders,
        isRecurring: Boolean(card.recurrence),
        thisAndFutureEquivalentToAll,
      });
    }
  }

  return occurrences.sort(
    (left, right) => left.occurrenceStart.getTime() - right.occurrenceStart.getTime(),
  );
}


async function updateCardScheduleForNextOccurrence(
  projectId: string,
  columnId: string,
  card: Card,
  occurrenceStart: Date,
  sessionId?: string,
): Promise<void> {
  if (!card.scheduledStart || !card.scheduledEnd) return;
  const shouldAdvance = occurrenceStart.getTime() <= card.scheduledStart.getTime();

  if (!card.recurrence) {
    if (!shouldAdvance) return;
    await updateCard(projectId, columnId, card.id, {
      scheduledStart: null,
      scheduledEnd: null,
    }, sessionId);
    return;
  }

  if (!shouldAdvance) return;

  const database = getDb();
  const exceptions = queryRecurrenceExceptions(database, projectId, card.id);
  const next = nextOccurrenceAfter(card, occurrenceStart, { exceptions });

  if (!next) {
    await updateCard(projectId, columnId, card.id, {
      scheduledStart: null,
      scheduledEnd: null,
    }, sessionId);
    return;
  }

  await updateCard(projectId, columnId, card.id, {
    scheduledStart: next.occurrenceStart,
    scheduledEnd: next.occurrenceEnd,
  }, sessionId);
}

export async function completeCardOccurrence(
  projectId: string,
  input: CardOccurrenceActionInput,
  sessionId?: string,
): Promise<{ success: boolean; error?: string }> {
  const target = await getCard(projectId, input.cardId);
  if (!target) return { success: false, error: "Card not found" };
  if (!target.card.scheduledStart || !target.card.scheduledEnd) {
    return { success: false, error: "Card is not scheduled" };
  }

  const durationMs = Math.max(
    60_000,
    target.card.scheduledEnd.getTime() - target.card.scheduledStart.getTime(),
  );
  const occurrenceStart = input.occurrenceStart;
  const occurrenceEnd = new Date(occurrenceStart.getTime() + durationMs);
  const shouldAdvance = occurrenceStart.getTime() <= target.card.scheduledStart.getTime();
  const database = getDb();
  const groupId = resolveGroupId();
  const now = new Date();
  const nowIso = now.toISOString();
  const archiveCardId = generateId();

  database.transaction(() => {
    const maxArchiveOrderRow = database
      .prepare('SELECT MAX("order") as maxOrder FROM cards WHERE project_id = ? AND column_id = ?')
      .get(projectId, ARCHIVE_COLUMN_ID) as { maxOrder: number | null } | undefined;
    const archiveOrder = (maxArchiveOrderRow?.maxOrder ?? -1) + 1;

    database.prepare(`
      INSERT INTO cards (
        id, project_id, column_id, title, description, priority, estimate,
        tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
        assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      archiveCardId,
      projectId,
      ARCHIVE_COLUMN_ID,
      target.card.title,
      target.card.description,
      target.card.priority,
      target.card.estimate ?? null,
      JSON.stringify(target.card.tags),
      target.card.dueDate?.toISOString().split("T")[0] ?? null,
      occurrenceStart.toISOString(),
      occurrenceEnd.toISOString(),
      target.card.isAllDay ? 1 : 0,
      null,
      "[]",
      target.card.scheduleTimezone?.trim() || null,
      target.card.assignee ?? null,
      target.card.agentBlocked ? 1 : 0,
      target.card.agentStatus ?? null,
      toRunInTargetDbValue(target.card.runInTarget),
      target.card.runInLocalPath?.trim() || null,
      target.card.runInBaseBranch?.trim() || null,
      target.card.runInWorktreePath?.trim() || null,
      target.card.runInEnvironmentPath?.trim() || null,
      nowIso,
      archiveOrder,
    );

    historyService.clearRedoStack(projectId, sessionId);
    historyService.recordCreate(
      {
        ...target.card,
        id: archiveCardId,
        recurrence: undefined,
        reminders: [],
        isAllDay: target.card.isAllDay,
        scheduledStart: occurrenceStart,
        scheduledEnd: occurrenceEnd,
        created: now,
        order: archiveOrder,
      },
      projectId,
      ARCHIVE_COLUMN_ID,
      sessionId,
      groupId,
    );

    if (target.card.recurrence && !shouldAdvance) {
      upsertSkipRecurrenceException(
        database,
        projectId,
        input.cardId,
        occurrenceStart,
        nowIso,
      );
    }

    const isOneTime = !target.card.recurrence;
    if (!isOneTime && !shouldAdvance) return;

    let nextScheduledStart: Date | null = null;
    let nextScheduledEnd: Date | null = null;

    if (!isOneTime) {
      const exceptions = queryRecurrenceExceptions(database, projectId, target.card.id);
      const next = nextOccurrenceAfter(target.card, occurrenceStart, { exceptions });
      nextScheduledStart = next?.occurrenceStart ?? null;
      nextScheduledEnd = next?.occurrenceEnd ?? null;
    }

    const prevStartIso = target.card.scheduledStart?.toISOString() ?? null;
    const prevEndIso = target.card.scheduledEnd?.toISOString() ?? null;
    const nextStartIso = nextScheduledStart?.toISOString() ?? null;
    const nextEndIso = nextScheduledEnd?.toISOString() ?? null;

    if (prevStartIso === nextStartIso && prevEndIso === nextEndIso) return;

    database.prepare(`
      UPDATE cards
      SET scheduled_start = ?, scheduled_end = ?
      WHERE id = ? AND project_id = ?
    `).run(
      nextStartIso,
      nextEndIso,
      target.card.id,
      projectId,
    );

    historyService.recordUpdate(
      target.card.id,
      projectId,
      target.columnId,
      {
        scheduledStart: target.card.scheduledStart,
        scheduledEnd: target.card.scheduledEnd,
      },
      {
        scheduledStart: nextScheduledStart ?? undefined,
        scheduledEnd: nextScheduledEnd ?? undefined,
      },
      sessionId,
      groupId,
    );
  })();

  dbNotifier.notifyChange(projectId, "update", target.columnId, input.cardId);
  dbNotifier.notifyChange(projectId, "create", ARCHIVE_COLUMN_ID, archiveCardId);
  return { success: true };
}

export async function skipCardOccurrence(
  projectId: string,
  input: CardOccurrenceActionInput,
  sessionId?: string,
): Promise<{ success: boolean; error?: string }> {
  const target = await getCard(projectId, input.cardId);
  if (!target) return { success: false, error: "Card not found" };
  if (!target.card.scheduledStart || !target.card.scheduledEnd) {
    return { success: false, error: "Card is not scheduled" };
  }

  const occurrenceStart = input.occurrenceStart;
  const database = getDb();
  const nowIso = new Date().toISOString();

  database.transaction(() => {
    if (target.card.recurrence) {
      upsertSkipRecurrenceException(
        database,
        projectId,
        input.cardId,
        occurrenceStart,
        nowIso,
      );
    }
  })();

  await updateCardScheduleForNextOccurrence(
    projectId,
    target.columnId,
    target.card,
    occurrenceStart,
    sessionId,
  );

  dbNotifier.notifyChange(projectId, "update", target.columnId, input.cardId);
  return { success: true };
}

function resolveGroupId(): string {
  return randomUUID();
}

function normalizeOccurrenceTiming(
  card: Card,
  occurrenceStart: Date,
  updates: CardOccurrenceUpdateInput["updates"],
): { start: Date; end: Date } {
  const baseStart = updates.scheduledStart ?? occurrenceStart;
  const baseDurationMs = card.scheduledStart && card.scheduledEnd
    ? Math.max(60_000, card.scheduledEnd.getTime() - card.scheduledStart.getTime())
    : 15 * 60_000;
  const baseEnd = updates.scheduledEnd ?? new Date(baseStart.getTime() + baseDurationMs);
  if (baseEnd > baseStart) {
    return { start: baseStart, end: baseEnd };
  }
  return {
    start: baseStart,
    end: new Date(baseStart.getTime() + baseDurationMs),
  };
}

export async function updateCardOccurrence(
  projectId: string,
  input: CardOccurrenceUpdateInput,
  sessionId?: string,
): Promise<{ success: boolean; error?: string }> {
  const target = await getCard(projectId, input.cardId);
  if (!target) return { success: false, error: "Card not found" };
  const card = target.card;
  const dragShiftRecurrence = shiftRecurringUntilDateWithDraggedDate(
    card.recurrence,
    input.occurrenceStart,
    input.updates.scheduledStart,
    input.updates.scheduleTimezone ?? card.scheduleTimezone,
  );

  if (input.scope === "all") {
    const result = await updateCard(projectId, target.columnId, input.cardId, {
      scheduledStart: input.updates.scheduledStart,
      scheduledEnd: input.updates.scheduledEnd,
      isAllDay: input.updates.isAllDay,
      recurrence: input.updates.recurrence === undefined
        ? dragShiftRecurrence
        : input.updates.recurrence,
      reminders: input.updates.reminders,
      scheduleTimezone:
        input.updates.scheduleTimezone === undefined ? undefined : input.updates.scheduleTimezone,
    }, sessionId);
    return result.status === "updated"
      ? { success: true }
      : { success: false, error: "Failed to update card" };
  }

  if (input.scope === "this") {
    if (!card.recurrence) {
      const result = await updateCard(projectId, target.columnId, input.cardId, {
        scheduledStart: input.updates.scheduledStart,
        scheduledEnd: input.updates.scheduledEnd,
        isAllDay: input.updates.isAllDay,
        reminders: input.updates.reminders,
        scheduleTimezone:
          input.updates.scheduleTimezone === undefined ? undefined : input.updates.scheduleTimezone,
      }, sessionId);
      return result.status === "updated"
        ? { success: true }
        : { success: false, error: "Failed to update card" };
    }

    const database = getDb();
    const existing = database
      .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
      .get(input.cardId, projectId, target.columnId) as DbCard | undefined;
    if (!existing) return { success: false, error: "Card no longer exists" };

    const timing = normalizeOccurrenceTiming(card, input.occurrenceStart, input.updates);
    const detachedCardId = generateId();
    const nowIso = new Date().toISOString();
    const detachedReminders = input.updates.reminders ?? card.reminders;
    const detachedTimezone = input.updates.scheduleTimezone === undefined
      ? card.scheduleTimezone
      : (input.updates.scheduleTimezone ?? undefined);

    database.transaction(() => {
      database.prepare(
        `UPDATE cards SET "order" = "order" + 1
         WHERE project_id = ? AND column_id = ? AND "order" > ?`
      ).run(projectId, target.columnId, existing.order);

      database.prepare(`
        INSERT INTO cards (
          id, project_id, column_id, title, description, priority, estimate,
          tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
          assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        detachedCardId,
        projectId,
        target.columnId,
        card.title,
        card.description,
        card.priority,
        card.estimate ?? null,
        JSON.stringify(card.tags),
        card.dueDate?.toISOString().split("T")[0] ?? null,
        timing.start.toISOString(),
        timing.end.toISOString(),
        (input.updates.isAllDay ?? card.isAllDay) ? 1 : 0,
        null,
        JSON.stringify(detachedReminders),
        detachedTimezone ?? null,
        card.assignee ?? null,
        card.agentBlocked ? 1 : 0,
        card.agentStatus ?? null,
        toRunInTargetDbValue(card.runInTarget),
        card.runInLocalPath?.trim() || null,
        card.runInBaseBranch?.trim() || null,
        card.runInWorktreePath?.trim() || null,
        card.runInEnvironmentPath?.trim() || null,
        nowIso,
        existing.order + 1,
      );

      upsertSkipRecurrenceException(
        database,
        projectId,
        input.cardId,
        input.occurrenceStart,
        nowIso,
      );
    })();

    dbNotifier.notifyChange(projectId, "update", target.columnId, input.cardId);
    dbNotifier.notifyChange(projectId, "create", target.columnId, detachedCardId);
    return { success: true };
  }

  if (!card.recurrence) {
    const result = await updateCard(projectId, target.columnId, input.cardId, {
      scheduledStart: input.updates.scheduledStart,
      scheduledEnd: input.updates.scheduledEnd,
      isAllDay: input.updates.isAllDay,
      reminders: input.updates.reminders,
      scheduleTimezone:
        input.updates.scheduleTimezone === undefined ? undefined : input.updates.scheduleTimezone,
    }, sessionId);
    return result.status === "updated"
      ? { success: true }
      : { success: false, error: "Failed to update card" };
  }

  // this-and-future: split the series into a new card from occurrence start onward
  const database = getDb();
  const existing = database
    .prepare("SELECT * FROM cards WHERE id = ? AND project_id = ? AND column_id = ?")
    .get(input.cardId, projectId, target.columnId) as DbCard | undefined;
  if (!existing) return { success: false, error: "Card no longer exists" };

  const oldCard = rowToCard(existing);
  const oldRecurrence = oldCard.recurrence;
  if (!oldRecurrence) {
    return { success: false, error: "Card is not recurring" };
  }

  const oldScheduledStart = oldCard.scheduledStart;
  const isEquivalentToAll = oldScheduledStart !== undefined &&
    input.occurrenceStart.getTime() <= oldScheduledStart.getTime();
  if (isEquivalentToAll) {
    const result = await updateCard(projectId, target.columnId, input.cardId, {
      scheduledStart: input.updates.scheduledStart,
      scheduledEnd: input.updates.scheduledEnd,
      isAllDay: input.updates.isAllDay,
      recurrence: input.updates.recurrence === undefined
        ? dragShiftRecurrence
        : input.updates.recurrence,
      reminders: input.updates.reminders,
      scheduleTimezone:
        input.updates.scheduleTimezone === undefined ? undefined : input.updates.scheduleTimezone,
    }, sessionId);
    return result.status === "updated"
      ? { success: true }
      : { success: false, error: "Failed to update card" };
  }

  const timezone = oldCard.scheduleTimezone ?? input.updates.scheduleTimezone ?? undefined;
  const occurrenceDateKey = dateKeyInTimezone(input.occurrenceStart, timezone);
  const endedRecurrence: RecurrenceConfig = {
    ...oldRecurrence,
    endCondition: {
      type: "untilDate",
      untilDate: shiftUntilDateByDays(occurrenceDateKey, -1),
    },
  };

  const splitTiming = normalizeOccurrenceTiming(oldCard, input.occurrenceStart, input.updates);
  const nextCardId = generateId();
  const groupId = resolveGroupId();
  const nextReminders = input.updates.reminders ?? oldCard.reminders;
  const nextTimezone = input.updates.scheduleTimezone === undefined
    ? oldCard.scheduleTimezone
    : (input.updates.scheduleTimezone ?? undefined);
  const shiftedFutureRecurrence = shiftRecurringUntilDateWithDraggedDate(
    oldRecurrence,
    input.occurrenceStart,
    splitTiming.start,
    nextTimezone,
  );
  const nextRecurrence = input.updates.recurrence === undefined
    ? (shiftedFutureRecurrence ?? oldRecurrence)
    : (input.updates.recurrence ?? undefined);

  database.transaction(() => {
    database.prepare(`
      UPDATE cards
      SET recurrence_json = ?
      WHERE id = ? AND project_id = ?
    `).run(
      JSON.stringify(endedRecurrence),
      input.cardId,
      projectId,
    );

    historyService.clearRedoStack(projectId, sessionId);
    historyService.recordUpdate(
      input.cardId,
      projectId,
      target.columnId,
      {
        recurrence: oldCard.recurrence,
      },
      {
        recurrence: endedRecurrence,
      },
      sessionId,
      groupId,
    );

    database.prepare(
      `UPDATE cards SET "order" = "order" + 1
       WHERE project_id = ? AND column_id = ? AND "order" > ?`
    ).run(projectId, target.columnId, existing.order);

    database.prepare(`
      INSERT INTO cards (
        id, project_id, column_id, title, description, priority, estimate,
        tags, due_date, scheduled_start, scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone,
        assignee, agent_blocked, agent_status, run_in_target, run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path, created, "order"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nextCardId,
      projectId,
      target.columnId,
      oldCard.title,
      oldCard.description,
      oldCard.priority,
      oldCard.estimate ?? null,
      JSON.stringify(oldCard.tags),
      oldCard.dueDate?.toISOString().split("T")[0] ?? null,
      splitTiming.start.toISOString(),
      splitTiming.end.toISOString(),
      (input.updates.isAllDay ?? oldCard.isAllDay) ? 1 : 0,
      nextRecurrence ? JSON.stringify(nextRecurrence) : null,
      JSON.stringify(nextReminders),
      nextTimezone ?? null,
      oldCard.assignee ?? null,
      oldCard.agentBlocked ? 1 : 0,
      oldCard.agentStatus ?? null,
      toRunInTargetDbValue(oldCard.runInTarget),
      oldCard.runInLocalPath?.trim() || null,
      oldCard.runInBaseBranch?.trim() || null,
      oldCard.runInWorktreePath?.trim() || null,
      oldCard.runInEnvironmentPath?.trim() || null,
      new Date().toISOString(),
      existing.order + 1,
    );

    const createdCard: Card = {
      ...oldCard,
      id: nextCardId,
      scheduledStart: splitTiming.start,
      scheduledEnd: splitTiming.end,
      isAllDay: input.updates.isAllDay ?? oldCard.isAllDay,
      recurrence: nextRecurrence,
      reminders: nextReminders,
      scheduleTimezone: nextTimezone,
      created: new Date(),
      order: existing.order + 1,
    };

    historyService.recordCreate(
      createdCard,
      projectId,
      target.columnId,
      sessionId,
      groupId,
    );
  })();

  dbNotifier.notifyChange(projectId, "update", target.columnId, input.cardId);
  dbNotifier.notifyChange(projectId, "create", target.columnId, nextCardId);
  return { success: true };
}

export async function initializeDatabase(options?: EnsureDatabaseOptions): Promise<void> {
  ensureDatabase(options);
}

// Schema introspection for agents
export interface TableSchema {
  name: string;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    defaultValue: string | null;
    primaryKey: boolean;
  }[];
}

export interface SchemaResult {
  tables: TableSchema[];
}

export function getSchema(): SchemaResult {
  const database = getDb();

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as { name: string }[];

  const result: TableSchema[] = tables.map((table) => {
    const columns = database.prepare(`PRAGMA table_info("${table.name}")`).all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];

    return {
      name: table.name,
      columns: columns.map((col) => ({
        name: col.name,
        type: col.type,
        nullable: col.notnull === 0,
        defaultValue: col.dflt_value,
        primaryKey: col.pk === 1,
      })),
    };
  });

  return { tables: result };
}

// Read-only SQL query for agents
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
}

export const MAX_READ_ONLY_QUERY_ROWS = 5_000;

export function executeReadOnlyQuery(
  sql: string,
  params: (string | number | null)[] = []
): QueryResult {
  const database = getDb();
  const stmt = database.prepare(sql);

  if (!stmt.readonly) {
    throw new Error("Only read-only queries are allowed");
  }

  const rows: Record<string, unknown>[] = [];
  for (const row of stmt.iterate(...params) as Iterable<Record<string, unknown>>) {
    rows.push(row);
    if (rows.length > MAX_READ_ONLY_QUERY_ROWS) {
      throw new Error(`Query returned more than ${MAX_READ_ONLY_QUERY_ROWS} rows`);
    }
  }
  const columns = stmt.columns().map((col) => col.name);

  return { rows, rowCount: rows.length, columns };
}

// Re-export history service functions for convenience
export {
  getUndoTarget,
  getRedoTarget,
  executeUndo,
  executeRedo,
  getCardHistory,
  getRecentHistory,
  getUndoRedoState,
  canUndo,
  canRedo,
  revertEntry,
  restoreToEntry,
} from "./history-service";

/** Atomic undo: target selection + execution in a single synchronous call. */
export function undoLatest(
  projectId: string,
  sessionId?: string,
): { success: boolean; entry?: { operation: string; cardId: string }; error?: string; canUndo: boolean; canRedo: boolean; undoDescription: string | null; redoDescription: string | null } {
  const target = historyService.getUndoTarget(projectId, sessionId);
  if (!target) {
    const state = historyService.getUndoRedoState(projectId, sessionId);
    return { success: false, error: "Nothing to undo", ...state };
  }
  const result = historyService.executeUndoWithGrouping(target.id);
  const state = historyService.getUndoRedoState(projectId, sessionId);
  return {
    success: result.success,
    entry: result.entry ? { operation: result.entry.operation, cardId: result.entry.cardId } : undefined,
    error: result.error,
    ...state,
  };
}

/** Atomic redo: target selection + execution in a single synchronous call. */
export function redoLatest(
  projectId: string,
  sessionId?: string,
): { success: boolean; entry?: { operation: string; cardId: string }; error?: string; canUndo: boolean; canRedo: boolean; undoDescription: string | null; redoDescription: string | null } {
  const target = historyService.getRedoTarget(projectId, sessionId);
  if (!target) {
    const state = historyService.getUndoRedoState(projectId, sessionId);
    return { success: false, error: "Nothing to redo", ...state };
  }
  const result = historyService.executeRedoWithGrouping(target.id);
  const state = historyService.getUndoRedoState(projectId, sessionId);
  return {
    success: result.success,
    entry: result.entry ? { operation: result.entry.operation, cardId: result.entry.cardId } : undefined,
    error: result.error,
    ...state,
  };
}

export { COLUMNS };
