import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  createCard,
  createProject,
  getBoard,
  getCard,
  getRecentHistory,
  initializeDatabase,
  moveCardDropToEditor,
  redoLatest,
  undoLatest,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-card-drop-"));
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

describe("moveCardDropToEditor", () => {
  test("updates target description and deletes source card in one grouped undo step", async () => {
    const ran = await withTempDatabase(async () => {
      const source = await createCard("default", "in_progress", {
        title: "Source card",
        description: "Source description",
      });
      const target = await createCard("default", "in_progress", {
        title: "Target card",
        description: "Before drop",
      });

      const moveResult = await moveCardDropToEditor(
        "default",
        {
          sourceCardId: source.id,
          sourceStatus: "in_progress",
          groupId: "group-drop-1",
          targetUpdates: [
            {
              projectId: "default",
              status: "in_progress",
              cardId: target.id,
              updates: { description: "After drop" },
            },
          ],
        },
        "session-1",
      );

      expect(moveResult.groupId).toBe("group-drop-1");
      expect(moveResult.sourceCardId).toBe(source.id);
      expect(moveResult.sourceCardIds.join(",")).toBe(source.id);

      const sourceAfterMove = await getCard("default", source.id);
      const targetAfterMove = await getCard("default", target.id);

      expect(sourceAfterMove === null).toBeTrue();
      expect(targetAfterMove?.description).toBe("After drop");

      const historyAfterMove = getRecentHistory("default", 10, 0);
      const groupedEntries = historyAfterMove.filter((entry) => entry.groupId === "group-drop-1");
      expect(groupedEntries.length).toBe(2);

      const undoResult = undoLatest("default", "session-1");
      expect(undoResult.success).toBeTrue();

      const sourceAfterUndo = await getCard("default", source.id);
      const targetAfterUndo = await getCard("default", target.id);
      expect(sourceAfterUndo?.status).toBe("in_progress");
      expect(targetAfterUndo?.description).toBe("Before drop");

      const redoResult = redoLatest("default", "session-1");
      expect(redoResult.success).toBeTrue();

      const sourceAfterRedo = await getCard("default", source.id);
      const targetAfterRedo = await getCard("default", target.id);
      expect(sourceAfterRedo === null).toBeTrue();
      expect(targetAfterRedo?.description).toBe("After drop");
    });
    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("validation failure keeps source card unchanged", async () => {
    const ran = await withTempDatabase(async () => {
      const source = await createCard("default", "in_progress", {
        title: "Source card",
        description: "Source description",
      });

      let errorMessage = "";
      try {
        await moveCardDropToEditor("default", {
          sourceCardId: source.id,
          sourceStatus: "in_progress",
          targetUpdates: [
            {
              projectId: "default",
              status: "in_progress",
              cardId: source.id,
              updates: { description: "Invalid" },
            },
          ],
        });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      expect(errorMessage).toBe("Cannot drop a card into itself");

      const sourceAfterError = await getCard("default", source.id);
      expect(sourceAfterError?.description).toBe("Source description");
    });
    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("supports moving source card from another project into target editor updates", async () => {
    const ran = await withTempDatabase(async () => {
      createProject({ id: "other", name: "Other" });

      const source = await createCard("other", "in_progress", {
        title: "Cross-project source",
        description: "From other project",
      });
      const target = await createCard("default", "in_progress", {
        title: "Default target",
        description: "Before cross-project drop",
      });

      const moveResult = await moveCardDropToEditor(
        "default",
        {
          sourceProjectId: "other",
          sourceCardId: source.id,
          sourceStatus: "in_progress",
          groupId: "group-drop-cross-project",
          targetUpdates: [
            {
              projectId: "default",
              status: "in_progress",
              cardId: target.id,
              updates: { description: "After cross-project drop" },
            },
          ],
        },
        "session-1",
      );

      expect(moveResult.groupId).toBe("group-drop-cross-project");
      expect(moveResult.sourceCardIds.join(",")).toBe(source.id);
      const sourceAfterMove = await getCard("other", source.id);
      const targetAfterMove = await getCard("default", target.id);
      expect(sourceAfterMove === null).toBeTrue();
      expect(targetAfterMove?.description).toBe("After cross-project drop");
    });
    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("supports deleting multiple source cards in one grouped editor drop", async () => {
    const ran = await withTempDatabase(async () => {
      const sourceOne = await createCard("default", "in_progress", {
        title: "Source one",
        description: "One",
      });
      const sourceTwo = await createCard("default", "in_review", {
        title: "Source two",
        description: "Two",
      });
      const target = await createCard("default", "in_progress", {
        title: "Target card",
        description: "Before",
      });

      const moveResult = await moveCardDropToEditor(
        "default",
        {
          sourceCardId: sourceOne.id,
          sourceStatus: "in_progress",
          sourceCards: [
            {
              cardId: sourceOne.id,
              status: "in_progress",
            },
            {
              cardId: sourceTwo.id,
              status: "in_review",
            },
          ],
          groupId: "group-drop-many",
          targetUpdates: [
            {
              projectId: "default",
              status: "in_progress",
              cardId: target.id,
              updates: { description: "After" },
            },
          ],
        },
        "session-1",
      );

      expect(moveResult.groupId).toBe("group-drop-many");
      expect(moveResult.sourceCardIds.join(",")).toBe(`${sourceOne.id},${sourceTwo.id}`);

      const firstAfterMove = await getCard("default", sourceOne.id);
      const secondAfterMove = await getCard("default", sourceTwo.id);
      const targetAfterMove = await getCard("default", target.id);

      expect(firstAfterMove === null).toBeTrue();
      expect(secondAfterMove === null).toBeTrue();
      expect(targetAfterMove?.description).toBe("After");

      const historyAfterMove = getRecentHistory("default", 10, 0);
      const groupedEntries = historyAfterMove.filter((entry) => entry.groupId === "group-drop-many");
      expect(groupedEntries.length).toBe(3);
    });
    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("undo restores same-column multi-card editor drops in original order", async () => {
    const ran = await withTempDatabase(async () => {
      const sourceOne = await createCard("default", "in_progress", {
        title: "Source one",
        description: "One",
      });
      const target = await createCard("default", "in_progress", {
        title: "Target card",
        description: "Before",
      });
      const sourceTwo = await createCard("default", "in_progress", {
        title: "Source two",
        description: "Two",
      });
      await createCard("default", "in_progress", {
        title: "Tail",
        description: "Tail",
      });

      const moveResult = await moveCardDropToEditor(
        "default",
        {
          sourceCardId: sourceOne.id,
          sourceStatus: "in_progress",
          sourceCards: [
            {
              cardId: sourceOne.id,
              status: "in_progress",
            },
            {
              cardId: sourceTwo.id,
              status: "in_progress",
            },
          ],
          groupId: "group-drop-same-column-many",
          targetUpdates: [
            {
              projectId: "default",
              status: "in_progress",
              cardId: target.id,
              updates: { description: "After" },
            },
          ],
        },
        "session-same-column-many",
      );

      expect(moveResult.groupId).toBe("group-drop-same-column-many");

      const undoResult = undoLatest("default", "session-same-column-many");
      expect(undoResult.success).toBeTrue();

      const board = await getBoard("default");
      const column = board.columns.find((entry) => entry.id === "in_progress");
      const targetAfterUndo = await getCard("default", target.id);

      expect(column?.cards.map((card) => card.title).join(",")).toBe(
        "Source one,Target card,Source two,Tail",
      );
      expect(column?.cards.map((card) => card.order).join(",")).toBe("0,1,2,3");
      expect(targetAfterUndo?.description).toBe("Before");
    });
    if (!ran) {
      expect(true).toBeTrue();
    }
  });
});
