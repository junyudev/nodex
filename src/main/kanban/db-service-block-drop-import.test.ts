import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  createCard,
  createProject,
  getCard,
  getRecentHistory,
  importBlockDropAsCards,
  initializeDatabase,
  redoLatest,
  undoLatest,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-block-drop-import-"));
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

describe("importBlockDropAsCards", () => {
  test("supports grouped source updates even when no new cards are created", async () => {
    const ran = await withTempDatabase(async () => {
      const source = await createCard("default", "6-in-progress", {
        title: "Source card",
        description: "Source before",
      });
      const target = await createCard("default", "6-in-progress", {
        title: "Target card",
        description: "Target before",
      });

      const result = await importBlockDropAsCards(
        "default",
        {
          targetColumnId: "6-in-progress",
          cards: [],
          sourceUpdates: [
            {
              projectId: "default",
              columnId: "6-in-progress",
              cardId: source.id,
              updates: { description: "Source after" },
            },
            {
              projectId: "default",
              columnId: "6-in-progress",
              cardId: target.id,
              updates: { description: "Target after" },
            },
          ],
          groupId: "group-send-blocks",
        },
        "session-1",
      );

      expect(result.cards.length).toBe(0);
      expect(result.groupId).toBe("group-send-blocks");

      const sourceAfter = await getCard("default", source.id, "6-in-progress");
      const targetAfter = await getCard("default", target.id, "6-in-progress");
      expect(sourceAfter?.card.description).toBe("Source after");
      expect(targetAfter?.card.description).toBe("Target after");

      const groupedEntries = getRecentHistory("default", 20, 0)
        .filter((entry) => entry.groupId === "group-send-blocks");
      expect(groupedEntries.length).toBe(2);

      const undoResult = undoLatest("default", "session-1");
      expect(undoResult.success).toBeTrue();
      const sourceAfterUndo = await getCard("default", source.id, "6-in-progress");
      const targetAfterUndo = await getCard("default", target.id, "6-in-progress");
      expect(sourceAfterUndo?.card.description).toBe("Source before");
      expect(targetAfterUndo?.card.description).toBe("Target before");

      const redoResult = redoLatest("default", "session-1");
      expect(redoResult.success).toBeTrue();
      const sourceAfterRedo = await getCard("default", source.id, "6-in-progress");
      const targetAfterRedo = await getCard("default", target.id, "6-in-progress");
      expect(sourceAfterRedo?.card.description).toBe("Source after");
      expect(targetAfterRedo?.card.description).toBe("Target after");
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });
});
