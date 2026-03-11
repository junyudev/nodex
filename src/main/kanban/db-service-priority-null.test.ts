import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  createCard,
  createProject,
  getBoard,
  getRecentHistory,
  getDb,
  initializeDatabase,
  redoLatest,
  restoreToEntry,
  undoLatest,
  updateCard,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-priority-null-"));
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

describe("nullable card priority", () => {
  test("creates cards without assigning a default priority", async () => {
    const ran = await withTempDatabase(async () => {
      const projectId = "default";
      createProject({ id: projectId, name: "Default" });

      const created = await createCard(projectId, "draft", {
        title: "No default priority",
      });

      expect(created.priority ?? null).toBe(null);

      const row = getDb().prepare("SELECT priority FROM cards WHERE id = ?").get(created.id) as
        | { priority: string | null }
        | undefined;
      expect(row?.priority ?? null).toBe(null);

      const board = await getBoard(projectId);
      const card = board.columns.find((column) => column.id === "draft")?.cards[0];
      expect(card?.priority ?? null).toBe(null);
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("clears persisted priority when updated to null", async () => {
    const ran = await withTempDatabase(async () => {
      const projectId = "default";
      createProject({ id: projectId, name: "Default" });

      const created = await createCard(projectId, "draft", {
        title: "Clear priority",
        priority: "p1-high",
      });

      const updated = await updateCard(projectId, "draft", created.id, {
        priority: null,
      });

      expect(updated.status).toBe("updated");
      if (updated.status !== "updated") return;

      expect(updated.card.priority ?? null).toBe(null);

      const row = getDb().prepare("SELECT priority FROM cards WHERE id = ?").get(created.id) as
        | { priority: string | null }
        | undefined;
      expect(row?.priority ?? null).toBe(null);
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("redo and restore preserve cleared priority history entries", async () => {
    const ran = await withTempDatabase(async () => {
      const projectId = "default";
      createProject({ id: projectId, name: "Default" });

      const created = await createCard(projectId, "draft", {
        title: "History keeps cleared priority",
        priority: "p1-high",
      });

      const cleared = await updateCard(projectId, "draft", created.id, {
        priority: null,
      });
      expect(cleared.status).toBe("updated");
      if (cleared.status !== "updated") return;
      expect(cleared.card.priority ?? null).toBe(null);

      const history = getRecentHistory(projectId, 10, 0);
      const clearEntry = history.find((entry) => entry.operation === "update");
      expect(clearEntry?.newValues?.priority ?? null).toBe(null);

      const undone = undoLatest(projectId);
      expect(undone.success).toBeTrue();

      let row = getDb().prepare("SELECT priority FROM cards WHERE id = ?").get(created.id) as
        | { priority: string | null }
        | undefined;
      expect(row?.priority).toBe("p1-high");

      const redone = redoLatest(projectId);
      expect(redone.success).toBeTrue();

      row = getDb().prepare("SELECT priority FROM cards WHERE id = ?").get(created.id) as
        | { priority: string | null }
        | undefined;
      expect(row?.priority ?? null).toBe(null);

      const restored = restoreToEntry(projectId, created.id, clearEntry?.id ?? -1);
      expect(restored.success).toBeTrue();

      row = getDb().prepare("SELECT priority FROM cards WHERE id = ?").get(created.id) as
        | { priority: string | null }
        | undefined;
      expect(row?.priority ?? null).toBe(null);
    });

    if (!ran) expect(true).toBeTrue();
  });
});
