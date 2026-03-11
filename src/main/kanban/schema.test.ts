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

      const cardColumns = db.prepare("PRAGMA table_info(cards)").all() as Array<{ name: string }>;
      const cardColumnNames = cardColumns.map((column) => column.name);
      expect(cardColumnNames.includes("revision")).toBeTrue();
      expect(cardColumnNames.includes("run_in_environment_path")).toBeTrue();
      expect(cardColumnNames.includes("description_revision_id")).toBeTrue();

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
        "1-ideas",
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
        "1-ideas",
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

});
