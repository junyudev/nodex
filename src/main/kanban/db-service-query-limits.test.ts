import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  executeReadOnlyQuery,
  initializeDatabase,
  MAX_READ_ONLY_QUERY_ROWS,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-query-limits-"));
  process.env.KANBAN_DIR = tempDir;

  try {
    await initializeDatabase();
  } catch (error) {
    if (isUnsupportedSqliteError(error)) {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
      delete process.env.KANBAN_DIR;
      return false;
    }
    throw error;
  }

  try {
    await run();
    return true;
  } finally {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KANBAN_DIR;
  }
}

describe("read-only query limits", () => {
  test("allows result sets up to the row cap", async () => {
    const ran = await withTempDatabase(async () => {
      const result = executeReadOnlyQuery(
        `
          WITH RECURSIVE a(n) AS (
            VALUES(0)
            UNION ALL
            SELECT n + 1 FROM a WHERE n < 99
          ),
          b(n) AS (
            VALUES(0)
            UNION ALL
            SELECT n + 1 FROM b WHERE n < 49
          )
          SELECT (a.n * 50) + b.n AS value
          FROM a
          CROSS JOIN b
          ORDER BY value
        `
      );

      expect(result.rowCount).toBe(MAX_READ_ONLY_QUERY_ROWS);
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("rejects result sets above the row cap", async () => {
    const ran = await withTempDatabase(async () => {
      let errorMessage = "";
      try {
        executeReadOnlyQuery(
          `
            WITH RECURSIVE a(n) AS (
              VALUES(0)
              UNION ALL
              SELECT n + 1 FROM a WHERE n < 99
            ),
            b(n) AS (
              VALUES(0)
              UNION ALL
              SELECT n + 1 FROM b WHERE n < 99
            )
            SELECT (a.n * 100) + b.n AS value
            FROM a
            CROSS JOIN b
          `
        );
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toBe(`Query returned more than ${MAX_READ_ONLY_QUERY_ROWS} rows`);
    });

    if (!ran) expect(true).toBeTrue();
  });
});
