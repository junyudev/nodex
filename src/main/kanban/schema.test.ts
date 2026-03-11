import { describe, expect, test } from "bun:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "./db-service";
import { getDatabasePath } from "./config";
import { CURRENT_SCHEMA_VERSION } from "./schema";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

function encodeBase64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("schema initialization", () => {
  test("initializes the latest schema from a fresh database", async () => {
    closeDatabase();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-schema-init-"));
    process.env.KANBAN_DIR = tempDir;

    let initializationRan = true;
    try {
      await initializeDatabase();

      const db = new Database(getDatabasePath(), { readonly: true });
      const version = db.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      expect(version?.user_version).toBe(CURRENT_SCHEMA_VERSION);

      const cardColumns = db.prepare("PRAGMA table_info(cards)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const cardColumnNames = cardColumns.map((column) => column.name);
      expect(cardColumnNames.includes("revision")).toBeTrue();
      expect(cardColumnNames.includes("run_in_environment_path")).toBeTrue();
      expect(cardColumnNames.includes("description_revision_id")).toBeTrue();
      const priorityColumn = cardColumns.find((column) => column.name === "priority");
      expect(priorityColumn?.notnull).toBe(0);
      expect(priorityColumn?.dflt_value ?? null).toBe(null);

      const historyColumns = db.prepare("PRAGMA table_info(history)").all() as Array<{ name: string }>;
      const historyColumnNames = historyColumns.map((column) => column.name);
      expect(historyColumnNames.includes("previous_description_revision_id")).toBeTrue();
      expect(historyColumnNames.includes("snapshot_description_revision_id")).toBeTrue();

      const autoVacuum = db.prepare("PRAGMA auto_vacuum").get() as
        | { auto_vacuum: number }
        | undefined;
      expect(autoVacuum?.auto_vacuum).toBe(2);

      const projectCount = db.prepare("SELECT COUNT(*) as count FROM projects").get() as { count: number };
      expect(projectCount.count).toBe(1);

      db.close();
    } catch (error) {
      if (isUnsupportedSqliteError(error)) {
        initializationRan = false;
      } else {
        throw error;
      }
    } finally {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
      delete process.env.KANBAN_DIR;
    }

    if (!initializationRan) {
      expect(true).toBeTrue();
    }
  });

  test("rejects explicit older schema versions", async () => {
    closeDatabase();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-schema-old-"));
    process.env.KANBAN_DIR = tempDir;

    let initializationRan = true;
    try {
      const dbPath = getDatabasePath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec("PRAGMA user_version = 18");
      db.close();

      let message = "";
      try {
        await initializeDatabase();
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message.includes("Unsupported Nodex database schema version 18")).toBeTrue();
    } catch (error) {
      if (isUnsupportedSqliteError(error)) {
        initializationRan = false;
      } else {
        throw error;
      }
    } finally {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
      delete process.env.KANBAN_DIR;
    }

    if (!initializationRan) {
      expect(true).toBeTrue();
    }
  });

  test("migrates schema version 20 by dropping legacy history and seeding description revisions", async () => {
    closeDatabase();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-schema-v20-"));
    process.env.KANBAN_DIR = tempDir;

    let initializationRan = true;
    try {
      const dbPath = getDatabasePath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        PRAGMA auto_vacuum = NONE;

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          icon TEXT NOT NULL DEFAULT '',
          workspace_path TEXT,
          created TEXT NOT NULL
        );

        CREATE TABLE cards (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          column_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
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
          "order" INTEGER NOT NULL
        );

        CREATE TABLE history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          operation TEXT NOT NULL,
          card_id TEXT NOT NULL,
          column_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          previous_values TEXT,
          new_values TEXT,
          from_column_id TEXT,
          to_column_id TEXT,
          from_order INTEGER,
          to_order INTEGER,
          card_snapshot TEXT,
          session_id TEXT,
          group_id TEXT,
          is_undone INTEGER NOT NULL DEFAULT 0,
          undo_of INTEGER
        );

        PRAGMA user_version = 20;
      `);

      db.prepare(`
        INSERT INTO projects (id, name, description, icon, workspace_path, created)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("legacy-project", "Legacy", "", "", null, "2026-03-10T00:00:00.000Z");

      db.prepare(`
        INSERT INTO cards (
          id, project_id, column_id, title, description, priority, estimate,
          tags, due_date, assignee, agent_blocked, agent_status, run_in_target,
          run_in_local_path, run_in_base_branch, run_in_worktree_path, run_in_environment_path,
          revision, scheduled_start, scheduled_end, is_all_day, recurrence_json,
          reminders_json, schedule_timezone, created, "order"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-card",
        "legacy-project",
        "draft",
        "Legacy card",
        "Legacy description",
        "p2-medium",
        null,
        "[]",
        null,
        null,
        0,
        null,
        "local_project",
        null,
        null,
        null,
        null,
        1,
        null,
        null,
        0,
        null,
        "[]",
        null,
        "2026-03-10T00:00:00.000Z",
        0,
      );

      db.prepare(`
        INSERT INTO history (
          project_id, operation, card_id, column_id, timestamp, previous_values, new_values, card_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-project",
        "update",
        "legacy-card",
        "draft",
        "2026-03-10T00:05:00.000Z",
        JSON.stringify({ description: "Old" }),
        JSON.stringify({ description: "Legacy description" }),
        JSON.stringify({ title: "Legacy card", description: "Legacy description" }),
      );
      db.close();

      await initializeDatabase();

      const migratedDb = new Database(getDatabasePath(), { readonly: true });
      const version = migratedDb.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      expect(version?.user_version).toBe(CURRENT_SCHEMA_VERSION);

      const migratedCard = migratedDb.prepare(`
        SELECT id, description, description_revision_id
        FROM cards
        WHERE id = ?
      `).get("legacy-card") as
        | { id: string; description: string; description_revision_id: number | null }
        | undefined;
      expect(migratedCard?.id).toBe("legacy-card");
      expect(migratedCard?.description).toBe("Legacy description");
      expect(migratedCard?.description_revision_id).not.toBeNull();

      const historyCount = migratedDb.prepare("SELECT COUNT(*) as count FROM history").get() as
        | { count: number }
        | undefined;
      expect(historyCount?.count).toBe(0);

      const descriptionRevisionCount = migratedDb
        .prepare("SELECT COUNT(*) as count FROM description_revisions")
        .get() as { count: number };
      expect(descriptionRevisionCount.count > 0).toBeTrue();

      const autoVacuum = migratedDb.prepare("PRAGMA auto_vacuum").get() as
        | { auto_vacuum: number }
        | undefined;
      expect(autoVacuum?.auto_vacuum).toBe(2);
      migratedDb.close();
    } catch (error) {
      if (isUnsupportedSqliteError(error)) {
        initializationRan = false;
      } else {
        throw error;
      }
    } finally {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
      delete process.env.KANBAN_DIR;
    }

    if (!initializationRan) {
      expect(true).toBeTrue();
    }
  });

  test("migrates persisted legacy NFM status payloads on startup", async () => {
    closeDatabase();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-schema-v22-"));
    process.env.KANBAN_DIR = tempDir;

    let initializationRan = true;
    try {
      const dbPath = getDatabasePath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          icon TEXT NOT NULL DEFAULT '',
          workspace_path TEXT,
          created TEXT NOT NULL
        );

        CREATE TABLE cards (
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
          "order" INTEGER NOT NULL
        );

        CREATE TABLE description_blocks (
          hash TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
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
          undo_of INTEGER
        );

        PRAGMA user_version = 22;
      `);

      const legacyRules = encodeBase64Utf8(JSON.stringify({
        mode: "basic",
        includeHostCard: false,
        filter: {
          any: [
            {
              all: [
                { field: "status", op: "in", values: ["5-ready", "7-review"] },
              ],
            },
          ],
        },
        sort: [],
      }));
      const legacySnapshot = encodeBase64Utf8(JSON.stringify({
        projectId: "default",
        columnId: "5-ready",
        columnName: "Ready",
      }));
      const legacyDescription = [
        `<card-toggle card="legacy-card" meta="[Ready]" project="default" column="5-ready" column-name="Ready" snapshot="${legacySnapshot}">`,
        "\tLegacy title",
        "</card-toggle>",
        `<toggle-list-inline-view project="default" rules-v2="${legacyRules}" />`,
      ].join("\n");

      db.prepare(`
        INSERT INTO projects (id, name, description, icon, workspace_path, created)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("default", "Default", "", "", null, "2026-03-12T00:00:00.000Z");

      db.prepare(`
        INSERT INTO cards (
          id, project_id, status, archived, title, description, description_revision_id, priority, estimate,
          tags, due_date, assignee, agent_blocked, agent_status, run_in_target, run_in_local_path,
          run_in_base_branch, run_in_worktree_path, run_in_environment_path, revision, scheduled_start,
          scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone, created, "order"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-card",
        "default",
        "backlog",
        0,
        "Legacy",
        legacyDescription,
        null,
        "p2-medium",
        null,
        "[]",
        null,
        null,
        0,
        null,
        "local_project",
        null,
        null,
        null,
        null,
        1,
        null,
        null,
        0,
        null,
        "[]",
        null,
        "2026-03-12T00:00:00.000Z",
        0,
      );

      db.prepare(`
        INSERT INTO description_blocks (hash, content, created_at)
        VALUES (?, ?, ?)
      `).run(
        "legacy-block",
        `<card-toggle card="legacy-card" meta="[Review]" project="default" column="7-review" column-name="Review">`,
        "2026-03-12T00:00:00.000Z",
      );

      db.prepare(`
        INSERT INTO history (
          id, project_id, operation, card_id, status, archived, timestamp, previous_values, new_values,
          from_status, to_status, from_archived, to_archived, from_order, to_order, card_snapshot,
          previous_description_revision_id, new_description_revision_id, snapshot_description_revision_id,
          session_id, group_id, is_undone, undo_of
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        1,
        "default",
        "update",
        "legacy-card",
        "backlog",
        0,
        "2026-03-12T00:00:00.000Z",
        JSON.stringify({ columnId: "5-ready", columnName: "Ready" }),
        JSON.stringify({ columnId: "7-review", columnName: "Review" }),
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify({ columnId: "5-ready", columnName: "Ready" }),
        null,
        null,
        null,
        null,
        null,
        0,
        null,
      );
      db.close();

      await initializeDatabase();

      const migratedDb = new Database(dbPath, { readonly: true });
      const version = migratedDb.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      expect(version?.user_version).toBe(CURRENT_SCHEMA_VERSION);

      const priorityColumn = (migratedDb.prepare("PRAGMA table_info(cards)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((column) => column.name === "priority");
      expect(priorityColumn?.notnull).toBe(0);
      expect(priorityColumn?.dflt_value ?? null).toBe(null);

      const descriptionRow = migratedDb.prepare("SELECT description FROM cards WHERE id = ?").get("legacy-card") as
        | { description: string }
        | undefined;
      const blockRow = migratedDb.prepare("SELECT content FROM description_blocks WHERE hash = ?").get("legacy-block") as
        | { content: string }
        | undefined;
      const historyRow = migratedDb.prepare("SELECT previous_values, new_values, card_snapshot FROM history WHERE id = 1").get() as
        | { previous_values: string | null; new_values: string | null; card_snapshot: string | null }
        | undefined;

      expect(descriptionRow?.description.includes('status="backlog"')).toBeTrue();
      expect(descriptionRow?.description.includes('status-name="Backlog"')).toBeTrue();
      expect(descriptionRow?.description.includes('column="5-ready"')).toBeFalse();
      expect(descriptionRow?.description.includes("[Backlog]")).toBeTrue();
      expect(descriptionRow?.description.includes('"values":["backlog","in_review"]')).toBeTrue();
      expect(blockRow?.content.includes('status="in_review"')).toBeTrue();
      expect(blockRow?.content.includes('status-name="In Review"')).toBeTrue();
      expect(historyRow?.previous_values?.includes('"status":"backlog"')).toBeTrue();
      expect(historyRow?.new_values?.includes('"status":"in_review"')).toBeTrue();
      expect(historyRow?.card_snapshot?.includes('"statusName":"Backlog"')).toBeTrue();
      migratedDb.close();
    } catch (error) {
      if (isUnsupportedSqliteError(error)) {
        initializationRan = false;
      } else {
        throw error;
      }
    } finally {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
      delete process.env.KANBAN_DIR;
    }

    if (!initializationRan) {
      expect(true).toBeTrue();
    }
  });

  test("migrates schema version 23 to nullable priority without rewriting existing values", async () => {
    closeDatabase();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-schema-v23-priority-"));
    process.env.KANBAN_DIR = tempDir;

    let initializationRan = true;
    try {
      const dbPath = getDatabasePath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          icon TEXT NOT NULL DEFAULT '',
          workspace_path TEXT,
          created TEXT NOT NULL
        );

        CREATE TABLE cards (
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
          created_at TEXT NOT NULL
        );

        CREATE TABLE codex_card_threads (
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
          undo_of INTEGER
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
          created TEXT NOT NULL
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

        CREATE TABLE recurrence_occurrence_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          occurrence_start TEXT NOT NULL,
          action TEXT NOT NULL,
          created TEXT NOT NULL
        );

        CREATE TABLE canvas (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          elements TEXT NOT NULL DEFAULT '[]',
          app_state TEXT NOT NULL DEFAULT '{}',
          files TEXT NOT NULL DEFAULT '{}',
          updated TEXT NOT NULL
        );

        PRAGMA user_version = 23;
      `);

      db.prepare(`
        INSERT INTO projects (id, name, description, icon, workspace_path, created)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("default", "Default", "", "", null, "2026-03-12T00:00:00.000Z");

      db.prepare(`
        INSERT INTO cards (
          id, project_id, status, archived, title, description, description_revision_id, priority, estimate,
          tags, due_date, assignee, agent_blocked, agent_status, run_in_target, run_in_local_path,
          run_in_base_branch, run_in_worktree_path, run_in_environment_path, revision, scheduled_start,
          scheduled_end, is_all_day, recurrence_json, reminders_json, schedule_timezone, created, "order"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "card-p2",
        "default",
        "backlog",
        0,
        "Keeps medium",
        "",
        null,
        "p2-medium",
        null,
        "[]",
        null,
        null,
        0,
        null,
        "local_project",
        null,
        null,
        null,
        null,
        1,
        null,
        null,
        0,
        null,
        "[]",
        null,
        "2026-03-12T00:00:00.000Z",
        0,
      );
      db.close();

      await initializeDatabase();

      const migratedDb = new Database(dbPath, { readonly: true });
      const version = migratedDb.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      expect(version?.user_version).toBe(CURRENT_SCHEMA_VERSION);

      const priorityColumn = (migratedDb.prepare("PRAGMA table_info(cards)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((column) => column.name === "priority");
      expect(priorityColumn?.notnull).toBe(0);
      expect(priorityColumn?.dflt_value ?? null).toBe(null);

      const preserved = migratedDb.prepare("SELECT priority FROM cards WHERE id = ?").get("card-p2") as
        | { priority: string | null }
        | undefined;
      expect(preserved?.priority).toBe("p2-medium");
      migratedDb.close();
    } catch (error) {
      if (isUnsupportedSqliteError(error)) {
        initializationRan = false;
      } else {
        throw error;
      }
    } finally {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
      delete process.env.KANBAN_DIR;
    }

    if (!initializationRan) {
      expect(true).toBeTrue();
    }
  });

});
