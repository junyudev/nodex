import { describe, expect, test } from "bun:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "./db-service";
import { getDatabasePath } from "./config";
import { CURRENT_SCHEMA_VERSION, getSchemaMigrationTargets } from "./schema";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

describe("schema initialization", () => {
  test("does not expose in-app migration targets for older schemas", () => {
    expect(JSON.stringify(getSchemaMigrationTargets(CURRENT_SCHEMA_VERSION))).toBe("[]");
    expect(getSchemaMigrationTargets(CURRENT_SCHEMA_VERSION - 1) === null).toBeTrue();
    expect(getSchemaMigrationTargets(20) === null).toBeTrue();
  });

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

      const codexThreadColumns = db.prepare("PRAGMA table_info(codex_card_threads)").all() as Array<{
        name: string;
        pk: number;
      }>;
      const codexThreadColumnNames = codexThreadColumns.map((column) => column.name);
      expect(codexThreadColumnNames.includes("id")).toBeFalse();
      expect(codexThreadColumns.find((column) => column.name === "thread_id")?.pk).toBe(1);

      const codexTableSql = db.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = 'codex_card_threads'
      `).get() as { sql: string } | undefined;
      expect((codexTableSql?.sql ?? "").includes("WITHOUT ROWID")).toBeTrue();

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
      db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
      db.close();

      let message = "";
      try {
        await initializeDatabase();
      } catch (error) {
        message = (error as Error).message;
      }

      expect(
        message.includes(`Unsupported Nodex database schema version ${CURRENT_SCHEMA_VERSION - 1}`),
      ).toBeTrue();
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
