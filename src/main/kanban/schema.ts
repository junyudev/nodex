import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getDatabasePath } from "./config";
import type { DatabaseMigrationProgress } from "../../shared/app-startup";
import { seedCardDescriptionRevisions } from "./description-revision-service";
import {
  CARD_STATUS_COLUMNS,
  CARD_STATUS_LABELS,
  CARD_STATUS_ORDER,
  mapLegacyColumnIdToCardState,
  type CardStatus,
} from "../../shared/card-status";
import { escapeXmlAttr, getXmlAttr } from "../../shared/nfm/xml-attributes";

export const COLUMNS = CARD_STATUS_COLUMNS;

export const CURRENT_SCHEMA_VERSION = 24;

const RESETTABLE_TABLES = [
  "canvas",
  "reminder_snoozes",
  "reminder_receipts",
  "recurrence_exceptions",
  "history",
  "codex_thread_snapshots",
  "codex_card_threads",
  "cards",
  "projects",
  "recurrence_occurrence_log",
];

export interface EnsureDatabaseOptions {
  onMigrationProgress?: (progress: DatabaseMigrationProgress) => void;
}

function getUserVersion(db: Database.Database): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

function setUserVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`);
}

function createLatestSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      workspace_path TEXT,
      created TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      description_revision_id INTEGER,
      priority TEXT,
      estimate TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      due_date TEXT,
      assignee TEXT,
      agent_blocked INTEGER NOT NULL DEFAULT 0,
      agent_status TEXT,
      run_in_target TEXT NOT NULL DEFAULT 'local_project',
      run_in_local_path TEXT,
      run_in_base_branch TEXT,
      run_in_worktree_path TEXT,
      run_in_environment_path TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      scheduled_start TEXT,
      scheduled_end TEXT,
      is_all_day INTEGER NOT NULL DEFAULT 0,
      recurrence_json TEXT,
      reminders_json TEXT NOT NULL DEFAULT '[]',
      schedule_timezone TEXT,
      created TEXT NOT NULL,
      "order" INTEGER NOT NULL,
      CHECK (status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done')),
      CHECK (priority IS NULL OR priority IN ('p0-critical', 'p1-high', 'p2-medium', 'p3-low', 'p4-later')),
      CHECK (estimate IS NULL OR estimate IN ('xs', 's', 'm', 'l', 'xl'))
    );

    CREATE INDEX IF NOT EXISTS idx_cards_project_archived_status ON cards(project_id, archived, status);
    CREATE INDEX IF NOT EXISTS idx_cards_project_archived_status_order ON cards(project_id, archived, status, "order");
    CREATE INDEX IF NOT EXISTS idx_cards_schedule ON cards(project_id, scheduled_start, scheduled_end);

    CREATE TABLE IF NOT EXISTS description_blocks (
      hash TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS description_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      parent_revision_id INTEGER,
      kind TEXT NOT NULL,
      block_hashes_json TEXT,
      ops_json TEXT,
      created_at TEXT NOT NULL,
      CHECK (kind IN ('snapshot', 'delta'))
    );

    CREATE INDEX IF NOT EXISTS idx_description_revisions_card_created
      ON description_revisions(card_id, created_at, id);

    CREATE TABLE IF NOT EXISTS codex_card_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL UNIQUE,
      thread_name TEXT,
      thread_preview TEXT NOT NULL DEFAULT '',
      model_provider TEXT NOT NULL DEFAULT '',
      cwd TEXT,
      status_type TEXT NOT NULL DEFAULT 'notLoaded',
      status_active_flags_json TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      linked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_codex_card_threads_project_card_updated
      ON codex_card_threads(project_id, card_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_codex_card_threads_project_updated
      ON codex_card_threads(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS codex_thread_snapshots (
      thread_id TEXT PRIMARY KEY REFERENCES codex_card_threads(thread_id) ON DELETE CASCADE,
      turns_json TEXT NOT NULL DEFAULT '[]',
      items_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      card_id TEXT NOT NULL,
      status TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      previous_values TEXT,
      new_values TEXT,
      from_status TEXT,
      to_status TEXT,
      from_archived INTEGER,
      to_archived INTEGER,
      from_order INTEGER,
      to_order INTEGER,
      card_snapshot TEXT,
      previous_description_revision_id INTEGER,
      new_description_revision_id INTEGER,
      snapshot_description_revision_id INTEGER,
      session_id TEXT,
      group_id TEXT,
      is_undone INTEGER NOT NULL DEFAULT 0,
      undo_of INTEGER,
      CHECK (operation IN ('create', 'update', 'delete', 'move')),
      CHECK (status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done')),
      CHECK (from_status IS NULL OR from_status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done')),
      CHECK (to_status IS NULL OR to_status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done'))
    );

    CREATE INDEX IF NOT EXISTS idx_history_project ON history(project_id);
    CREATE INDEX IF NOT EXISTS idx_history_card ON history(card_id);
    CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_history_session ON history(session_id);
    CREATE INDEX IF NOT EXISTS idx_history_group ON history(project_id, group_id);

    CREATE TABLE IF NOT EXISTS recurrence_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      occurrence_start TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      override_start TEXT,
      override_end TEXT,
      override_reminders_json TEXT,
      created TEXT NOT NULL,
      CHECK (exception_type IN ('skip', 'override_time'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_recurrence_exceptions_unique
      ON recurrence_exceptions(project_id, card_id, occurrence_start);
    CREATE INDEX IF NOT EXISTS idx_recurrence_exceptions_lookup
      ON recurrence_exceptions(project_id, card_id, occurrence_start);

    CREATE TABLE IF NOT EXISTS reminder_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      occurrence_start TEXT NOT NULL,
      reminder_offset_minutes INTEGER NOT NULL,
      delivered_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_receipts_unique
      ON reminder_receipts(project_id, card_id, occurrence_start, reminder_offset_minutes);
    CREATE INDEX IF NOT EXISTS idx_reminder_receipts_lookup
      ON reminder_receipts(project_id, delivered_at DESC);

    CREATE TABLE IF NOT EXISTS reminder_snoozes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      occurrence_start TEXT NOT NULL,
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reminder_snoozes_lookup
      ON reminder_snoozes(project_id, due_at, consumed_at);

    CREATE TABLE IF NOT EXISTS canvas (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      elements TEXT NOT NULL DEFAULT '[]',
      app_state TEXT NOT NULL DEFAULT '{}',
      files TEXT NOT NULL DEFAULT '{}',
      updated TEXT NOT NULL
    );
  `);
}

interface LegacyCardRow {
  id: string;
  project_id: string;
  column_id: string;
  title: string;
  description: string;
  description_revision_id: number | null;
  priority: string | null;
  estimate: string | null;
  tags: string;
  due_date: string | null;
  assignee: string | null;
  agent_blocked: number;
  agent_status: string | null;
  run_in_target: string;
  run_in_local_path: string | null;
  run_in_base_branch: string | null;
  run_in_worktree_path: string | null;
  run_in_environment_path: string | null;
  revision: number;
  scheduled_start: string | null;
  scheduled_end: string | null;
  is_all_day: number;
  recurrence_json: string | null;
  reminders_json: string;
  schedule_timezone: string | null;
  created: string;
  order: number;
}

interface LegacyHistoryRow {
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

const legacyColumnOrderIndex = new Map(
  [
    "1-ideas",
    "2-analyzing",
    "3-backlog",
    "4-planning",
    "5-ready",
    "6-in-progress",
    "7-review",
    "8-done",
    "n-archive",
  ].map((columnId, index) => [columnId, index]),
);

function createCardsV22Table(db: Database.Database): void {
  db.exec(`
    CREATE TABLE cards_v22 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      description_revision_id INTEGER,
      priority TEXT NOT NULL DEFAULT 'p2-medium',
      estimate TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      due_date TEXT,
      assignee TEXT,
      agent_blocked INTEGER NOT NULL DEFAULT 0,
      agent_status TEXT,
      run_in_target TEXT NOT NULL DEFAULT 'local_project',
      run_in_local_path TEXT,
      run_in_base_branch TEXT,
      run_in_worktree_path TEXT,
      run_in_environment_path TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      scheduled_start TEXT,
      scheduled_end TEXT,
      is_all_day INTEGER NOT NULL DEFAULT 0,
      recurrence_json TEXT,
      reminders_json TEXT NOT NULL DEFAULT '[]',
      schedule_timezone TEXT,
      created TEXT NOT NULL,
      "order" INTEGER NOT NULL,
      CHECK (status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done')),
      CHECK (priority IN ('p0-critical', 'p1-high', 'p2-medium', 'p3-low', 'p4-later')),
      CHECK (estimate IS NULL OR estimate IN ('xs', 's', 'm', 'l', 'xl'))
    );
  `);
}

function createHistoryV22Table(db: Database.Database): void {
  db.exec(`
    CREATE TABLE history_v22 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      card_id TEXT NOT NULL,
      status TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      previous_values TEXT,
      new_values TEXT,
      from_status TEXT,
      to_status TEXT,
      from_archived INTEGER,
      to_archived INTEGER,
      from_order INTEGER,
      to_order INTEGER,
      card_snapshot TEXT,
      previous_description_revision_id INTEGER,
      new_description_revision_id INTEGER,
      snapshot_description_revision_id INTEGER,
      session_id TEXT,
      group_id TEXT,
      is_undone INTEGER NOT NULL DEFAULT 0,
      undo_of INTEGER,
      CHECK (operation IN ('create', 'update', 'delete', 'move')),
      CHECK (status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done')),
      CHECK (from_status IS NULL OR from_status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done')),
      CHECK (to_status IS NULL OR to_status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done'))
    );
  `);
}

function migrateLegacyCardsToCanonicalState(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT *
    FROM cards
    ORDER BY project_id ASC, created ASC, "order" ASC, id ASC
  `).all() as LegacyCardRow[];

  const orderBuckets = new Map<string, number>();
  const insertCard = db.prepare(`
    INSERT INTO cards_v22 (
      id, project_id, status, archived, title, description, description_revision_id, priority, estimate,
      tags, due_date, assignee, agent_blocked, agent_status, run_in_target, run_in_local_path,
      run_in_base_branch, run_in_worktree_path, run_in_environment_path, revision, scheduled_start,
      scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone, created, "order"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sortedRows = [...rows].sort((left, right) => {
    if (left.project_id !== right.project_id) return left.project_id.localeCompare(right.project_id);
    const leftState = mapLegacyColumnIdToCardState(left.column_id);
    const rightState = mapLegacyColumnIdToCardState(right.column_id);
    const leftArchived = leftState?.archived ? 1 : 0;
    const rightArchived = rightState?.archived ? 1 : 0;
    if (leftArchived !== rightArchived) return leftArchived - rightArchived;
    const leftStatus = leftState?.status ?? CARD_STATUS_ORDER[0];
    const rightStatus = rightState?.status ?? CARD_STATUS_ORDER[0];
    const statusCompare = CARD_STATUS_ORDER.indexOf(leftStatus) - CARD_STATUS_ORDER.indexOf(rightStatus);
    if (statusCompare !== 0) return statusCompare;
    const leftColumnOrder = legacyColumnOrderIndex.get(left.column_id) ?? Number.MAX_SAFE_INTEGER;
    const rightColumnOrder = legacyColumnOrderIndex.get(right.column_id) ?? Number.MAX_SAFE_INTEGER;
    if (leftColumnOrder !== rightColumnOrder) return leftColumnOrder - rightColumnOrder;
    if (left.order !== right.order) return left.order - right.order;
    return left.id.localeCompare(right.id);
  });

  for (const row of sortedRows) {
    const state = mapLegacyColumnIdToCardState(row.column_id);
    if (!state) {
      throw new Error(`Unknown legacy card column during migration: ${row.column_id}`);
    }
    const bucketKey = `${row.project_id}:${state.archived ? 1 : 0}:${state.status}`;
    const nextOrder = orderBuckets.get(bucketKey) ?? 0;
    orderBuckets.set(bucketKey, nextOrder + 1);

    insertCard.run(
      row.id,
      row.project_id,
      state.status,
      state.archived ? 1 : 0,
      row.title,
      row.description,
      row.description_revision_id,
      row.priority,
      row.estimate,
      row.tags,
      row.due_date,
      row.assignee,
      row.agent_blocked,
      row.agent_status,
      row.run_in_target,
      row.run_in_local_path,
      row.run_in_base_branch,
      row.run_in_worktree_path,
      row.run_in_environment_path,
      row.revision,
      row.scheduled_start,
      row.scheduled_end,
      row.is_all_day,
      row.recurrence_json,
      row.reminders_json,
      row.schedule_timezone,
      row.created,
      nextOrder,
    );
  }
}

function migrateLegacyHistoryToCanonicalState(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT *
    FROM history
    ORDER BY id ASC
  `).all() as LegacyHistoryRow[];

  const insertHistory = db.prepare(`
    INSERT INTO history_v22 (
      id, project_id, operation, card_id, status, archived, timestamp, previous_values, new_values,
      from_status, to_status, from_archived, to_archived, from_order, to_order, card_snapshot,
      previous_description_revision_id, new_description_revision_id, snapshot_description_revision_id,
      session_id, group_id, is_undone, undo_of
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    const currentState = mapLegacyColumnIdToCardState(row.column_id);
    if (!currentState) {
      throw new Error(`Unknown legacy history column during migration: ${row.column_id}`);
    }
    const fromState = row.from_column_id ? mapLegacyColumnIdToCardState(row.from_column_id) : null;
    const toState = row.to_column_id ? mapLegacyColumnIdToCardState(row.to_column_id) : null;
    if (row.from_column_id && !fromState) {
      throw new Error(`Unknown legacy history source column during migration: ${row.from_column_id}`);
    }
    if (row.to_column_id && !toState) {
      throw new Error(`Unknown legacy history target column during migration: ${row.to_column_id}`);
    }

    insertHistory.run(
      row.id,
      row.project_id,
      row.operation,
      row.card_id,
      currentState.status,
      currentState.archived ? 1 : 0,
      row.timestamp,
      row.previous_values,
      row.new_values,
      fromState?.status ?? null,
      toState?.status ?? null,
      fromState ? (fromState.archived ? 1 : 0) : null,
      toState ? (toState.archived ? 1 : 0) : null,
      row.from_order,
      row.to_order,
      row.card_snapshot,
      row.previous_description_revision_id,
      row.new_description_revision_id,
      row.snapshot_description_revision_id,
      row.session_id,
      row.group_id,
      row.is_undone,
      row.undo_of,
    );
  }
}

function migrateV21ToV22(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    createCardsV22Table(db);
    createHistoryV22Table(db);
    migrateLegacyCardsToCanonicalState(db);
    migrateLegacyHistoryToCanonicalState(db);

    db.exec("DROP TABLE history");
    db.exec("DROP TABLE cards");
    db.exec("ALTER TABLE cards_v22 RENAME TO cards");
    db.exec("ALTER TABLE history_v22 RENAME TO history");
    createLatestSchema(db);
    setUserVersion(db, 22);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const CARD_STATUS_SET = new Set<CardStatus>(CARD_STATUS_ORDER);

function normalizeCardStatusValue(value: string | null | undefined): CardStatus | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (CARD_STATUS_SET.has(trimmed as CardStatus)) {
    return trimmed as CardStatus;
  }

  const legacyState = mapLegacyColumnIdToCardState(trimmed);
  if (legacyState) return legacyState.status;

  switch (trimmed.toLowerCase()) {
    case "draft":
      return "draft";
    case "backlog":
      return "backlog";
    case "in progress":
    case "in-progress":
    case "in_progress":
      return "in_progress";
    case "in review":
    case "in-review":
    case "in_review":
    case "review":
      return "in_review";
    case "done":
      return "done";
    case "ideas":
    case "analyzing":
    case "planning":
      return "draft";
    case "ready":
      return "backlog";
    default:
      return null;
  }
}

function normalizeStatusLabel(value: string | null | undefined): string | null {
  const normalizedStatus = normalizeCardStatusValue(value);
  if (!normalizedStatus) return null;
  return CARD_STATUS_LABELS[normalizedStatus];
}

function decodeBase64Utf8(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function encodeBase64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function migrateLegacyJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => migrateLegacyJsonValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const migrated: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    migrated[key] = migrateLegacyJsonValue(entry);
  }

  const remapStatusField = (legacyKey: string, nextKey: string) => {
    const currentValue = migrated[nextKey];
    const legacyValue = migrated[legacyKey];
    const normalized = normalizeCardStatusValue(
      typeof currentValue === "string" ? currentValue : typeof legacyValue === "string" ? legacyValue : undefined,
    );
    if (normalized) {
      migrated[nextKey] = normalized;
    }
    delete migrated[legacyKey];
  };

  const remapStatusLabelField = (legacyKey: string, nextKey: string, statusKey: string) => {
    const currentValue = migrated[nextKey];
    const legacyValue = migrated[legacyKey];
    const fromStatus = typeof migrated[statusKey] === "string"
      ? CARD_STATUS_LABELS[migrated[statusKey] as CardStatus]
      : null;
    const normalized = fromStatus ?? normalizeStatusLabel(
      typeof currentValue === "string" ? currentValue : typeof legacyValue === "string" ? legacyValue : undefined,
    );
    if (normalized) {
      migrated[nextKey] = normalized;
    }
    delete migrated[legacyKey];
  };

  remapStatusField("columnId", "status");
  remapStatusField("fromColumnId", "fromStatus");
  remapStatusField("toColumnId", "toStatus");
  remapStatusField("sourceColumnId", "sourceStatus");
  remapStatusField("targetColumnId", "targetStatus");
  remapStatusLabelField("columnName", "statusName", "status");
  remapStatusLabelField("sourceColumnName", "sourceStatusName", "sourceStatus");
  remapStatusLabelField("targetColumnName", "targetStatusName", "targetStatus");

  if (migrated.field === "status" && Array.isArray(migrated.values)) {
    migrated.values = migrated.values.map((entry) => (
      typeof entry === "string" ? (normalizeCardStatusValue(entry) ?? entry) : entry
    ));
  }

  if (Array.isArray(migrated.statuses)) {
    migrated.statuses = migrated.statuses.map((entry) => (
      typeof entry === "string" ? (normalizeCardStatusValue(entry) ?? entry) : entry
    ));
  }

  return migrated;
}

function migrateLegacyJsonText(value: string | null): string | null {
  if (!value || value.trim().length === 0) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(migrateLegacyJsonValue(parsed));
  } catch {
    return value;
  }
}

function migrateLegacyMeta(value: string): string {
  return value.replace(/\[([^\]]+)\]/g, (_match, token) => {
    const normalized = normalizeStatusLabel(token);
    return normalized ? `[${normalized}]` : `[${token}]`;
  });
}

function migrateLegacySnapshot(value: string | undefined): string | undefined {
  if (!value) return value;
  const decoded = decodeBase64Utf8(value);
  if (!decoded) return value;
  const migrated = migrateLegacyJsonText(decoded);
  return migrated ? encodeBase64Utf8(migrated) : value;
}

function migrateLegacyCardToggleTag(attrs: string): string {
  const cardId = getXmlAttr(attrs, "card") ?? "";
  const meta = migrateLegacyMeta(getXmlAttr(attrs, "meta") ?? "");
  const snapshot = migrateLegacySnapshot(getXmlAttr(attrs, "snapshot"));
  const sourceProjectId = getXmlAttr(attrs, "project");
  const sourceStatus = normalizeCardStatusValue(
    getXmlAttr(attrs, "status") ?? getXmlAttr(attrs, "column"),
  );
  const sourceStatusName = sourceStatus
    ? CARD_STATUS_LABELS[sourceStatus]
    : normalizeStatusLabel(getXmlAttr(attrs, "status-name") ?? getXmlAttr(attrs, "column-name"));

  const nextAttrs = [
    `card="${escapeXmlAttr(cardId)}"`,
    `meta="${escapeXmlAttr(meta)}"`,
  ];
  if (snapshot) nextAttrs.push(`snapshot="${escapeXmlAttr(snapshot)}"`);
  if (sourceProjectId) nextAttrs.push(`project="${escapeXmlAttr(sourceProjectId)}"`);
  if (sourceStatus) nextAttrs.push(`status="${escapeXmlAttr(sourceStatus)}"`);
  if (sourceStatusName) nextAttrs.push(`status-name="${escapeXmlAttr(sourceStatusName)}"`);
  return `<card-toggle ${nextAttrs.join(" ")}>`;
}

function migrateLegacyToggleListInlineViewTag(attrs: string): string {
  const sourceProjectId = getXmlAttr(attrs, "project") ?? "";
  const rulesV2 = getXmlAttr(attrs, "rules-v2");
  const propertyOrder = getXmlAttr(attrs, "property-order");
  const hiddenProperties = getXmlAttr(attrs, "hidden-properties");
  const showEmptyEstimate = getXmlAttr(attrs, "show-empty-estimate");

  const nextAttrs = [`project="${escapeXmlAttr(sourceProjectId)}"`];
  if (rulesV2) {
    const decoded = decodeBase64Utf8(rulesV2);
    const migrated = decoded ? migrateLegacyJsonText(decoded) : null;
    const encoded = migrated ? encodeBase64Utf8(migrated) : rulesV2;
    nextAttrs.push(`rules-v2="${escapeXmlAttr(encoded)}"`);
  }
  if (propertyOrder) nextAttrs.push(`property-order="${escapeXmlAttr(propertyOrder)}"`);
  if (hiddenProperties) nextAttrs.push(`hidden-properties="${escapeXmlAttr(hiddenProperties)}"`);
  if (showEmptyEstimate) nextAttrs.push(`show-empty-estimate="${escapeXmlAttr(showEmptyEstimate)}"`);
  return `<toggle-list-inline-view ${nextAttrs.join(" ")} />`;
}

function migrateLegacyNfmText(value: string): string {
  let next = value.replace(/<card-toggle(?:\s+([^>]*))?\s*>/g, (_match, attrs = "") => (
    migrateLegacyCardToggleTag(attrs)
  ));
  next = next.replace(/<toggle-list-inline-view(?:\s+([^>]*))?\s*\/>/g, (_match, attrs = "") => (
    migrateLegacyToggleListInlineViewTag(attrs)
  ));
  return next;
}

function migrateV22ToV23(db: Database.Database): void {
  const updateCardDescription = db.prepare("UPDATE cards SET description = ? WHERE id = ?");
  const cardRows = db.prepare("SELECT id, description FROM cards").all() as Array<{ id: string; description: string }>;
  for (const row of cardRows) {
    const migrated = migrateLegacyNfmText(row.description);
    if (migrated !== row.description) {
      updateCardDescription.run(migrated, row.id);
    }
  }

  const updateDescriptionBlock = db.prepare("UPDATE description_blocks SET content = ? WHERE hash = ?");
  const blockRows = db.prepare("SELECT hash, content FROM description_blocks").all() as Array<{ hash: string; content: string }>;
  for (const row of blockRows) {
    const migrated = migrateLegacyNfmText(row.content);
    if (migrated !== row.content) {
      updateDescriptionBlock.run(migrated, row.hash);
    }
  }

  const updateHistory = db.prepare(`
    UPDATE history
    SET previous_values = ?, new_values = ?, card_snapshot = ?
    WHERE id = ?
  `);
  const historyRows = db.prepare(`
    SELECT id, previous_values, new_values, card_snapshot
    FROM history
  `).all() as Array<{
    id: number;
    previous_values: string | null;
    new_values: string | null;
    card_snapshot: string | null;
  }>;
  for (const row of historyRows) {
    const previousValues = migrateLegacyJsonText(row.previous_values);
    const newValues = migrateLegacyJsonText(row.new_values);
    const cardSnapshot = migrateLegacyJsonText(row.card_snapshot);
    if (
      previousValues !== row.previous_values
      || newValues !== row.new_values
      || cardSnapshot !== row.card_snapshot
    ) {
      updateHistory.run(previousValues, newValues, cardSnapshot, row.id);
    }
  }

  setUserVersion(db, 23);
}

function createCardsV24Table(db: Database.Database): void {
  db.exec(`
    CREATE TABLE cards_v24 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      description_revision_id INTEGER,
      priority TEXT,
      estimate TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      due_date TEXT,
      assignee TEXT,
      agent_blocked INTEGER NOT NULL DEFAULT 0,
      agent_status TEXT,
      run_in_target TEXT NOT NULL DEFAULT 'local_project',
      run_in_local_path TEXT,
      run_in_base_branch TEXT,
      run_in_worktree_path TEXT,
      run_in_environment_path TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      scheduled_start TEXT,
      scheduled_end TEXT,
      is_all_day INTEGER NOT NULL DEFAULT 0,
      recurrence_json TEXT,
      reminders_json TEXT NOT NULL DEFAULT '[]',
      schedule_timezone TEXT,
      created TEXT NOT NULL,
      "order" INTEGER NOT NULL,
      CHECK (status IN ('draft', 'backlog', 'in_progress', 'in_review', 'done')),
      CHECK (priority IS NULL OR priority IN ('p0-critical', 'p1-high', 'p2-medium', 'p3-low', 'p4-later')),
      CHECK (estimate IS NULL OR estimate IN ('xs', 's', 'm', 'l', 'xl'))
    );
  `);
}

function migrateV23ToV24(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    createCardsV24Table(db);
    db.exec(`
      INSERT INTO cards_v24 (
        id, project_id, status, archived, title, description, description_revision_id, priority, estimate,
        tags, due_date, assignee, agent_blocked, agent_status, run_in_target, run_in_local_path,
        run_in_base_branch, run_in_worktree_path, run_in_environment_path, revision, scheduled_start,
        scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone, created, "order"
      )
      SELECT
        id, project_id, status, archived, title, description, description_revision_id, priority, estimate,
        tags, due_date, assignee, agent_blocked, agent_status, run_in_target, run_in_local_path,
        run_in_base_branch, run_in_worktree_path, run_in_environment_path, revision, scheduled_start,
        scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone, created, "order"
      FROM cards
    `);
    db.exec("DROP TABLE cards");
    db.exec("ALTER TABLE cards_v24 RENAME TO cards");
    createLatestSchema(db);
    setUserVersion(db, CURRENT_SCHEMA_VERSION);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function resetDatabaseToLatestSchema(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const tableName of RESETTABLE_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    }
    db.exec("DROP TABLE IF EXISTS description_revisions");
    db.exec("DROP TABLE IF EXISTS description_blocks");
    db.pragma("auto_vacuum = INCREMENTAL");
    createLatestSchema(db);
    setUserVersion(db, CURRENT_SCHEMA_VERSION);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateV20ToV21(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    const cardColumns = db.prepare("PRAGMA table_info(cards)").all() as Array<{ name: string }>;
    if (!cardColumns.some((column) => column.name === "description_revision_id")) {
      db.exec("ALTER TABLE cards ADD COLUMN description_revision_id INTEGER");
    }

    db.exec("DROP TABLE IF EXISTS description_revisions");
    db.exec("DROP TABLE IF EXISTS description_blocks");
    db.exec("DROP TABLE IF EXISTS history");
    createLatestSchema(db);
    seedCardDescriptionRevisions(db);
    db.pragma("auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
    setUserVersion(db, CURRENT_SCHEMA_VERSION);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function seedDefaultProjectIfMissing(db: Database.Database): void {
  const projectCount = db.prepare("SELECT COUNT(*) as count FROM projects").get() as {
    count: number;
  };

  if (projectCount.count > 0) {
    return;
  }

  db.prepare(
    "INSERT INTO projects (id, name, description, icon, created) VALUES (?, ?, ?, ?, ?)",
  ).run("default", "Default", "", "", new Date().toISOString());
}

export function ensureDatabase(options: EnsureDatabaseOptions = {}): void {
  void options;
  const dbPath = getDatabasePath();
  const dir = path.dirname(dbPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    const currentVersion = getUserVersion(db);

    if (currentVersion === 0) {
      resetDatabaseToLatestSchema(db);
    } else if (currentVersion === 20) {
      migrateV20ToV21(db);
    } else if (currentVersion === 21) {
      migrateV21ToV22(db);
      migrateV22ToV23(db);
      migrateV23ToV24(db);
    } else if (currentVersion === 22) {
      migrateV22ToV23(db);
      migrateV23ToV24(db);
    } else if (currentVersion === 23) {
      migrateV23ToV24(db);
    } else if (currentVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported Nodex database schema version ${currentVersion}. Expected ${CURRENT_SCHEMA_VERSION}. Delete or recreate the local database if you want a fresh start.`,
      );
    }

    seedDefaultProjectIfMissing(db);
  } finally {
    db.close();
  }
}
