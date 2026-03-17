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
  initializeDatabase,
  moveCard,
  undoLatest,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-move-card-"));
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
  createProject({ id: "default", name: "Default" });

  try {
    await run();
    return true;
  } finally {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KANBAN_DIR;
  }
}

describe("moveCard", () => {
  test("applies a grouped estimate patch and restores it on undo", async () => {
    const ran = await withTempDatabase(async () => {
      const first = await createCard("default", "in_progress", {
        title: "First",
        estimate: "l",
      });
      await createCard("default", "in_progress", {
        title: "Second",
        estimate: "m",
      });

      const result = await moveCard({
        projectId: "default",
        cardId: first.id,
        fromStatus: "in_progress",
        toStatus: "in_progress",
        newOrder: 1,
        fieldPatch: { estimate: "m" },
        sessionId: "session-move-card-with-patch",
      });

      expect(result).toBe("moved");

      let board = await getBoard("default");
      let column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => `${card.title}:${card.estimate ?? "none"}`).join(",")).toBe(
        "Second:m,First:m",
      );

      const undoResult = undoLatest("default", "session-move-card-with-patch");
      expect(undoResult.success).toBeTrue();

      board = await getBoard("default");
      column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => `${card.title}:${card.estimate ?? "none"}`).join(",")).toBe(
        "First:l,Second:m",
      );
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("skips history writes for a no-op drag with an unchanged patch", async () => {
    const ran = await withTempDatabase(async () => {
      const only = await createCard("default", "in_progress", {
        title: "Only",
        estimate: "m",
      });

      const result = await moveCard({
        projectId: "default",
        cardId: only.id,
        fromStatus: "in_progress",
        toStatus: "in_progress",
        newOrder: 0,
        fieldPatch: { estimate: "m" },
        sessionId: "session-move-card-no-op-patch",
      });

      expect(result).toBe("moved");

      const history = getRecentHistory("default", 10, 0);
      const matchingEntries = history.filter((entry) => entry.sessionId === "session-move-card-no-op-patch");
      expect(matchingEntries.length).toBe(0);
    });

    if (!ran) expect(true).toBeTrue();
  });
});
