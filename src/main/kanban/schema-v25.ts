import Database from "better-sqlite3";
import type { DatabaseMigrationProgress } from "../../shared/app-startup";
import { createUuidV7FromTimestamp } from "../../shared/card-id";
import { type NfmBlock, parseNfm, serializeNfm } from "../../shared/nfm";
import {
  collectReachableRevisionIds,
  createInitialDescriptionRevision,
  createNextDescriptionRevision,
  reconstructDescription,
} from "./description-revision-service";

interface LegacyCardRow {
  id: string;
  project_id: string;
  status: string;
  archived: number;
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

interface LegacyDescriptionRevisionRow {
  id: number;
  card_id: string;
  parent_revision_id: number | null;
  created_at: string;
}

interface LegacyHistoryRow {
  id: number;
  project_id: string;
  operation: string;
  card_id: string;
  status: string;
  archived: number;
  timestamp: string;
  previous_values: string | null;
  new_values: string | null;
  from_status: string | null;
  to_status: string | null;
  from_archived: number | null;
  to_archived: number | null;
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

interface LegacyCodexCardThreadRow {
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

interface LegacyCodexThreadSnapshotRow {
  thread_id: string;
  turns_json: string;
  items_json: string;
  updated_at: number;
}

interface LegacyRecurrenceExceptionRow {
  id: number;
  project_id: string;
  card_id: string;
  occurrence_start: string;
  exception_type: string;
  override_start: string | null;
  override_end: string | null;
  override_reminders_json: string | null;
  created: string;
}

interface LegacyReminderReceiptRow {
  id: number;
  project_id: string;
  card_id: string;
  occurrence_start: string;
  reminder_offset_minutes: number;
  delivered_at: string;
}

interface LegacyReminderSnoozeRow {
  id: number;
  project_id: string;
  card_id: string;
  occurrence_start: string;
  due_at: string;
  created_at: string;
  consumed_at: string | null;
}

interface LegacyCardMeta {
  id: string;
  projectId: string;
  created: string;
  createdMs: number;
}

type ProgressCallback = (progress: DatabaseMigrationProgress) => void;
type ProjectScopedCardIdMap = Map<string, string>;

function createV25Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE cards (
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

    CREATE TABLE description_blocks (
      hash TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE description_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      parent_revision_id INTEGER,
      kind TEXT NOT NULL,
      block_hashes_json TEXT,
      ops_json TEXT,
      created_at TEXT NOT NULL,
      CHECK (kind IN ('snapshot', 'delta'))
    );

    CREATE TABLE codex_card_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
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
    ) WITHOUT ROWID;

    CREATE TABLE codex_thread_snapshots (
      thread_id TEXT PRIMARY KEY REFERENCES codex_card_threads(thread_id) ON DELETE CASCADE,
      turns_json TEXT NOT NULL DEFAULT '[]',
      items_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE history (
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

    CREATE TABLE recurrence_exceptions (
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

    CREATE TABLE reminder_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      occurrence_start TEXT NOT NULL,
      reminder_offset_minutes INTEGER NOT NULL,
      delivered_at TEXT NOT NULL
    );

    CREATE TABLE reminder_snoozes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      occurrence_start TEXT NOT NULL,
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
  `);

  db.exec(`
    CREATE INDEX idx_cards_project_archived_status ON cards(project_id, archived, status);
    CREATE INDEX idx_cards_project_archived_status_order ON cards(project_id, archived, status, "order");
    CREATE INDEX idx_cards_schedule ON cards(project_id, scheduled_start, scheduled_end);

    CREATE INDEX idx_description_revisions_card_created
      ON description_revisions(card_id, created_at, id);

    CREATE INDEX idx_codex_card_threads_project_card_updated
      ON codex_card_threads(project_id, card_id, updated_at DESC);
    CREATE INDEX idx_codex_card_threads_project_updated
      ON codex_card_threads(project_id, updated_at DESC);

    CREATE INDEX idx_history_project ON history(project_id);
    CREATE INDEX idx_history_card ON history(card_id);
    CREATE INDEX idx_history_timestamp ON history(timestamp DESC);
    CREATE INDEX idx_history_session ON history(session_id);
    CREATE INDEX idx_history_group ON history(project_id, group_id);

    CREATE UNIQUE INDEX idx_recurrence_exceptions_unique
      ON recurrence_exceptions(project_id, card_id, occurrence_start);
    CREATE INDEX idx_recurrence_exceptions_lookup
      ON recurrence_exceptions(project_id, card_id, occurrence_start);

    CREATE UNIQUE INDEX idx_reminder_receipts_unique
      ON reminder_receipts(project_id, card_id, occurrence_start, reminder_offset_minutes);
    CREATE INDEX idx_reminder_receipts_lookup
      ON reminder_receipts(project_id, delivered_at DESC);

    CREATE INDEX idx_reminder_snoozes_lookup
      ON reminder_snoozes(project_id, due_at, consumed_at);
  `);
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseCreatedMs(value: string): number {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid legacy card timestamp: ${value}`);
  }
  return timestamp;
}

function reportProgress(
  callback: ProgressCallback | undefined,
  completedUnits: number,
  totalUnits: number,
): void {
  if (!callback) return;
  const ratio = totalUnits <= 0 ? 1 : completedUnits / totalUnits;
  const value = Math.max(1, Math.min(99, Math.round(ratio * 100)));
  callback({ type: "InProgress", value });
}

function buildLegacyCardMetadata(
  cards: LegacyCardRow[],
  historyRows: LegacyHistoryRow[],
): Map<string, LegacyCardMeta> {
  const metadata = new Map<string, LegacyCardMeta>();

  for (const card of cards) {
    metadata.set(card.id, {
      id: card.id,
      projectId: card.project_id,
      created: card.created,
      createdMs: parseCreatedMs(card.created),
    });
  }

  for (const row of historyRows) {
    if (metadata.has(row.card_id)) continue;

    const snapshot = parseJsonRecord(row.card_snapshot);
    const previousValues = parseJsonRecord(row.previous_values);
    const newValues = parseJsonRecord(row.new_values);
    const created = [snapshot?.created, previousValues?.created, newValues?.created, row.timestamp]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (!created) {
      throw new Error(`Could not derive created timestamp for legacy card ${row.card_id}`);
    }

    metadata.set(row.card_id, {
      id: row.card_id,
      projectId: row.project_id,
      created,
      createdMs: parseCreatedMs(created),
    });
  }

  return metadata;
}

function buildCardIdMap(cardMetadata: Map<string, LegacyCardMeta>): Map<string, string> {
  const rows = [...cardMetadata.values()].sort((left, right) => {
    if (left.createdMs !== right.createdMs) return left.createdMs - right.createdMs;
    return left.id.localeCompare(right.id);
  });

  const idMap = new Map<string, string>();
  let currentTimestampMs = Number.NaN;
  let currentSequence = 0;

  for (const row of rows) {
    if (row.createdMs !== currentTimestampMs) {
      currentTimestampMs = row.createdMs;
      currentSequence = 0;
    }

    idMap.set(row.id, createUuidV7FromTimestamp(row.createdMs, currentSequence));
    currentSequence += 1;
  }

  return idMap;
}

function buildProjectScopedCardIdMap(cardMetadata: Map<string, LegacyCardMeta>, cardIdMap: Map<string, string>): ProjectScopedCardIdMap {
  const scopedMap = new Map<string, string>();

  for (const row of cardMetadata.values()) {
    const mappedId = cardIdMap.get(row.id);
    if (!mappedId) {
      throw new Error(`Missing UUID-v7 mapping for legacy card ${row.id}`);
    }

    scopedMap.set(`${row.projectId}\u0000${row.id}`, mappedId);
  }

  return scopedMap;
}

function resolveMappedCardId(
  legacyCardId: string,
  cardIdMap: Map<string, string>,
): string {
  const mapped = cardIdMap.get(legacyCardId);
  if (!mapped) {
    throw new Error(`Missing UUID-v7 mapping for legacy card ${legacyCardId}`);
  }
  return mapped;
}

function findMappedCardId(
  legacyCardId: string,
  projectId: string,
  scopedCardIdMap: ProjectScopedCardIdMap,
): string | undefined {
  return scopedCardIdMap.get(`${projectId}\u0000${legacyCardId}`);
}

function resolveMappedRevisionId(
  legacyRevisionId: number | null,
  revisionIdMap: Map<number, number>,
): number | null {
  if (legacyRevisionId === null) return null;
  const mapped = revisionIdMap.get(legacyRevisionId);
  if (!mapped) {
    throw new Error(`Missing migrated description revision ${legacyRevisionId}`);
  }
  return mapped;
}

function rewriteRecordId(
  value: string | null,
  projectId: string,
  scopedCardIdMap: ProjectScopedCardIdMap,
): string | null {
  if (!value || value.trim().length === 0) return value;

  const parsed = parseJsonRecord(value);
  if (!parsed) return value;
  if (typeof parsed.id !== "string") return value;

  const mappedId = findMappedCardId(parsed.id, projectId, scopedCardIdMap);
  if (!mappedId) return value;

  parsed.id = mappedId;
  return JSON.stringify(parsed);
}

function rewriteBlocks(
  blocks: NfmBlock[],
  hostProjectId: string,
  scopedCardIdMap: ProjectScopedCardIdMap,
): void {
  for (const block of blocks) {
    if (block.type === "cardRef") {
      const mapped = findMappedCardId(block.cardId, block.sourceProjectId, scopedCardIdMap);
      if (mapped) {
        block.cardId = mapped;
      }
    } else if (block.type === "cardToggle") {
      const sourceProjectId = block.sourceProjectId?.trim() || hostProjectId;
      const mapped = findMappedCardId(block.cardId, sourceProjectId, scopedCardIdMap);
      if (mapped) {
        block.cardId = mapped;
      }
    }

    if (block.children.length > 0) {
      rewriteBlocks(block.children, hostProjectId, scopedCardIdMap);
    }
  }
}

function rewriteEmbeddedCardLinks(
  value: string,
  hostProjectId: string,
  scopedCardIdMap: ProjectScopedCardIdMap,
): string {
  try {
    const blocks = parseNfm(value);
    rewriteBlocks(blocks, hostProjectId, scopedCardIdMap);
    return serializeNfm(blocks);
  } catch {
    return value;
  }
}

function dropLegacyTables(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS codex_thread_snapshots");
  db.exec("DROP TABLE IF EXISTS codex_card_threads");
  db.exec("DROP TABLE IF EXISTS reminder_snoozes");
  db.exec("DROP TABLE IF EXISTS reminder_receipts");
  db.exec("DROP TABLE IF EXISTS recurrence_exceptions");
  db.exec("DROP TABLE IF EXISTS history");
  db.exec("DROP TABLE IF EXISTS description_revisions");
  db.exec("DROP TABLE IF EXISTS description_blocks");
  db.exec("DROP TABLE IF EXISTS cards");
  db.exec("DROP TABLE IF EXISTS recurrence_occurrence_log");
}

function validateForeignKeys(db: Database.Database): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
  if (violations.length === 0) return;

  const firstViolation = violations[0];
  throw new Error(`v25 migration foreign key violation: ${JSON.stringify(firstViolation)}`);
}

export function migrateV24ToV25(
  db: Database.Database,
  onMigrationProgress?: ProgressCallback,
): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      const cards = db.prepare(`
        SELECT *
        FROM cards
        ORDER BY created ASC, id ASC
      `).all() as LegacyCardRow[];
      const historyRows = db.prepare(`
        SELECT *
        FROM history
        ORDER BY id ASC
      `).all() as LegacyHistoryRow[];
      const reachableRevisionIds = collectReachableRevisionIds(db);
      const revisions = db.prepare(`
        SELECT id, card_id, parent_revision_id, created_at
        FROM description_revisions
        ORDER BY id ASC
      `).all().filter((row) => reachableRevisionIds.has((row as { id: number }).id)) as LegacyDescriptionRevisionRow[];
      const codexRows = db.prepare(`
        SELECT project_id, card_id, thread_id, thread_name, thread_preview, model_provider, cwd,
               status_type, status_active_flags_json, archived, created_at, updated_at, linked_at
        FROM codex_card_threads
        ORDER BY updated_at DESC, thread_id ASC
      `).all() as LegacyCodexCardThreadRow[];
      const codexSnapshots = db.prepare(`
        SELECT thread_id, turns_json, items_json, updated_at
        FROM codex_thread_snapshots
      `).all() as LegacyCodexThreadSnapshotRow[];
      const recurrenceExceptions = db.prepare(`
        SELECT *
        FROM recurrence_exceptions
        ORDER BY id ASC
      `).all() as LegacyRecurrenceExceptionRow[];
      const reminderReceipts = db.prepare(`
        SELECT *
        FROM reminder_receipts
        ORDER BY id ASC
      `).all() as LegacyReminderReceiptRow[];
      const reminderSnoozes = db.prepare(`
        SELECT *
        FROM reminder_snoozes
        ORDER BY id ASC
      `).all() as LegacyReminderSnoozeRow[];

      const totalUnits = Math.max(
        1,
        cards.length
          + historyRows.length
          + revisions.length * 2
          + codexRows.length
          + codexSnapshots.length
          + recurrenceExceptions.length
          + reminderReceipts.length
          + reminderSnoozes.length
          + 10,
      );
      let completedUnits = 0;
      reportProgress(onMigrationProgress, completedUnits, totalUnits);

      const cardMetadata = buildLegacyCardMetadata(cards, historyRows);
      completedUnits += Math.max(1, cardMetadata.size);
      reportProgress(onMigrationProgress, completedUnits, totalUnits);

      const cardIdMap = buildCardIdMap(cardMetadata);
      const scopedCardIdMap = buildProjectScopedCardIdMap(cardMetadata, cardIdMap);
      const projectIdByCardId = new Map([...cardMetadata.values()].map((row) => [row.id, row.projectId]));

      const rewrittenCardDescriptions = new Map<string, string>();
      for (const card of cards) {
        rewrittenCardDescriptions.set(
          card.id,
          rewriteEmbeddedCardLinks(card.description, card.project_id, scopedCardIdMap),
        );
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      const rewrittenRevisionDescriptions = new Map<number, string>();
      for (const revision of revisions) {
        const hostProjectId = projectIdByCardId.get(revision.card_id);
        if (!hostProjectId) {
          throw new Error(`Missing project metadata for legacy revision card ${revision.card_id}`);
        }
        const description = reconstructDescription(db, revision.id);
        rewrittenRevisionDescriptions.set(
          revision.id,
          rewriteEmbeddedCardLinks(description, hostProjectId, scopedCardIdMap),
        );
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      dropLegacyTables(db);
      createV25Tables(db);
      completedUnits += 5;
      reportProgress(onMigrationProgress, completedUnits, totalUnits);

      const insertCard = db.prepare(`
        INSERT INTO cards (
          id, project_id, status, archived, title, description, description_revision_id, priority, estimate,
          tags, due_date, assignee, agent_blocked, agent_status, run_in_target, run_in_local_path,
          run_in_base_branch, run_in_worktree_path, run_in_environment_path, revision, scheduled_start,
          scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone, created, "order"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const card of cards) {
        insertCard.run(
          resolveMappedCardId(card.id, cardIdMap),
          card.project_id,
          card.status,
          card.archived,
          card.title,
          rewrittenCardDescriptions.get(card.id) ?? card.description,
          null,
          card.priority,
          card.estimate,
          card.tags,
          card.due_date,
          card.assignee,
          card.agent_blocked,
          card.agent_status,
          card.run_in_target,
          card.run_in_local_path,
          card.run_in_base_branch,
          card.run_in_worktree_path,
          card.run_in_environment_path,
          card.revision,
          card.scheduled_start,
          card.scheduled_end,
          card.is_all_day,
          card.recurrence_json,
          card.reminders_json,
          card.schedule_timezone,
          card.created,
          card.order,
        );
      }

      const revisionIdMap = new Map<number, number>();
      for (const revision of revisions) {
        const description = rewrittenRevisionDescriptions.get(revision.id) ?? "";
        const nextRevisionId = revision.parent_revision_id === null
          ? createInitialDescriptionRevision(
            db,
            resolveMappedCardId(revision.card_id, cardIdMap),
            description,
            revision.created_at,
          )
          : createNextDescriptionRevision(
            db,
            resolveMappedCardId(revision.card_id, cardIdMap),
            resolveMappedRevisionId(revision.parent_revision_id, revisionIdMap) ?? 0,
            description,
            revision.created_at,
          );
        revisionIdMap.set(revision.id, nextRevisionId);
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      const updateCardRevision = db.prepare(`
        UPDATE cards
        SET description_revision_id = ?
        WHERE id = ?
      `);
      for (const card of cards) {
        if (card.description_revision_id === null) continue;
        updateCardRevision.run(
          resolveMappedRevisionId(card.description_revision_id, revisionIdMap),
          resolveMappedCardId(card.id, cardIdMap),
        );
      }

      const insertHistory = db.prepare(`
        INSERT INTO history (
          id, project_id, operation, card_id, status, archived, timestamp, previous_values, new_values,
          from_status, to_status, from_archived, to_archived, from_order, to_order, card_snapshot,
          previous_description_revision_id, new_description_revision_id, snapshot_description_revision_id,
          session_id, group_id, is_undone, undo_of
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of historyRows) {
        insertHistory.run(
          row.id,
          row.project_id,
          row.operation,
          resolveMappedCardId(row.card_id, cardIdMap),
          row.status,
          row.archived,
          row.timestamp,
          rewriteRecordId(row.previous_values, row.project_id, scopedCardIdMap),
          rewriteRecordId(row.new_values, row.project_id, scopedCardIdMap),
          row.from_status,
          row.to_status,
          row.from_archived,
          row.to_archived,
          row.from_order,
          row.to_order,
          rewriteRecordId(row.card_snapshot, row.project_id, scopedCardIdMap),
          resolveMappedRevisionId(row.previous_description_revision_id, revisionIdMap),
          resolveMappedRevisionId(row.new_description_revision_id, revisionIdMap),
          resolveMappedRevisionId(row.snapshot_description_revision_id, revisionIdMap),
          row.session_id,
          row.group_id,
          row.is_undone,
          row.undo_of,
        );
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      const insertCodexRow = db.prepare(`
        INSERT INTO codex_card_threads (
          thread_id, project_id, card_id, thread_name, thread_preview, model_provider, cwd,
          status_type, status_active_flags_json, archived, created_at, updated_at, linked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of codexRows) {
        insertCodexRow.run(
          row.thread_id,
          row.project_id,
          resolveMappedCardId(row.card_id, cardIdMap),
          row.thread_name,
          row.thread_preview,
          row.model_provider,
          row.cwd,
          row.status_type,
          row.status_active_flags_json,
          row.archived,
          row.created_at,
          row.updated_at,
          row.linked_at,
        );
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      const insertCodexSnapshot = db.prepare(`
        INSERT INTO codex_thread_snapshots (
          thread_id, turns_json, items_json, updated_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (const row of codexSnapshots) {
        insertCodexSnapshot.run(row.thread_id, row.turns_json, row.items_json, row.updated_at);
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      const insertRecurrenceException = db.prepare(`
        INSERT INTO recurrence_exceptions (
          id, project_id, card_id, occurrence_start, exception_type, override_start, override_end,
          override_reminders_json, created
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of recurrenceExceptions) {
        insertRecurrenceException.run(
          row.id,
          row.project_id,
          resolveMappedCardId(row.card_id, cardIdMap),
          row.occurrence_start,
          row.exception_type,
          row.override_start,
          row.override_end,
          row.override_reminders_json,
          row.created,
        );
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      const insertReminderReceipt = db.prepare(`
        INSERT INTO reminder_receipts (
          id, project_id, card_id, occurrence_start, reminder_offset_minutes, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of reminderReceipts) {
        insertReminderReceipt.run(
          row.id,
          row.project_id,
          resolveMappedCardId(row.card_id, cardIdMap),
          row.occurrence_start,
          row.reminder_offset_minutes,
          row.delivered_at,
        );
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      const insertReminderSnooze = db.prepare(`
        INSERT INTO reminder_snoozes (
          id, project_id, card_id, occurrence_start, due_at, created_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of reminderSnoozes) {
        insertReminderSnooze.run(
          row.id,
          row.project_id,
          resolveMappedCardId(row.card_id, cardIdMap),
          row.occurrence_start,
          row.due_at,
          row.created_at,
          row.consumed_at,
        );
        completedUnits += 1;
        reportProgress(onMigrationProgress, completedUnits, totalUnits);
      }

      validateForeignKeys(db);
      completedUnits = totalUnits;
      reportProgress(onMigrationProgress, completedUnits, totalUnits);
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
