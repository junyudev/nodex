import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getDatabasePath } from "./config";
import type { DatabaseMigrationProgress } from "../../shared/app-startup";
import { CARD_STATUS_COLUMNS } from "../../shared/card-status";

export const COLUMNS = CARD_STATUS_COLUMNS;

export const CURRENT_SCHEMA_VERSION = 26;

const RESETTABLE_TABLES = [
  "canvas",
  "reminder_snoozes",
  "reminder_receipts",
  "recurrence_exceptions",
  "history",
  "codex_thread_snapshots",
  "codex_card_threads",
  "description_revisions",
  "description_blocks",
  "cards",
  "projects",
  // Kept here so a versionless local file can still be reset safely.
  "recurrence_occurrence_log",
];

export interface EnsureDatabaseOptions {
  onMigrationProgress?: (progress: DatabaseMigrationProgress) => void;
}

export function getSchemaMigrationTargets(currentVersion: number): number[] | null {
  return currentVersion === CURRENT_SCHEMA_VERSION ? [] : null;
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

function resetDatabaseToLatestSchema(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const tableName of RESETTABLE_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    }
    db.pragma("auto_vacuum = INCREMENTAL");
    createLatestSchema(db);
    setUserVersion(db, CURRENT_SCHEMA_VERSION);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function seedDefaultProjectIfMissing(db: Database.Database): void {
  const projectCount = db.prepare("SELECT COUNT(*) as count FROM projects").get() as {
    count: number;
  };
  if (projectCount.count > 0) return;

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
    } else if (getSchemaMigrationTargets(currentVersion) === null) {
      throw new Error(
        `Unsupported Nodex database schema version ${currentVersion}. Expected ${CURRENT_SCHEMA_VERSION}. Delete or recreate the local database if you want a fresh start.`,
      );
    }

    seedDefaultProjectIfMissing(db);
  } finally {
    db.close();
  }
}
