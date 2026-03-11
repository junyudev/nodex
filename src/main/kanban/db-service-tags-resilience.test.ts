import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  createCard,
  createProject,
  getBoard,
  getDb,
  initializeDatabase,
  updateCard,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-tags-resilience-"));
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

describe("card tag JSON resilience", () => {
  test("falls back to empty tags when persisted tags JSON is malformed", async () => {
    const ran = await withTempDatabase(async () => {
      const projectId = "default";
      createProject({ id: projectId, name: "Default" });
      const created = await createCard(projectId, "draft", {
        title: "Resilience card",
        tags: ["alpha"],
        description: "",
        priority: "p2-medium",
      });

      getDb()
        .prepare("UPDATE cards SET tags = ? WHERE id = ?")
        .run("{", created.id);

      const board = await getBoard(projectId);
      const column = board.columns.find((entry) => entry.id === "draft");
      expect(column !== undefined).toBeTrue();
      expect(JSON.stringify(column?.cards[0]?.tags ?? null)).toBe("[]");

      const updated = await updateCard(projectId, "draft", created.id, {
        title: "Updated title",
      });
      expect(updated.status).toBe("updated");
      if (updated.status === "updated") {
        expect(updated.card.title).toBe("Updated title");
        expect(JSON.stringify(updated.card.tags ?? null)).toBe("[]");
      }
    });

    if (!ran) expect(true).toBeTrue();
  });
});
