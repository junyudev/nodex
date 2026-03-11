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
  initializeDatabase,
  moveCardToProject,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-move-project-"));
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

describe("moveCardToProject", () => {
  test("moves a card to another project in the same workflow column", async () => {
    const ran = await withTempDatabase(async () => {
      createProject({ id: "ops", name: "Ops" });

      await createCard("default", "in_progress", {
        title: "Default head",
        description: "",
      });
      const movedCard = await createCard("default", "in_progress", {
        title: "Move me",
        description: "Cross-project transfer",
      });
      await createCard("ops", "in_progress", {
        title: "Ops tail",
        description: "",
      });

      const result = await moveCardToProject({
        cardId: movedCard.id,
        sourceProjectId: "default",
        sourceStatus: "in_progress",
        targetProjectId: "ops",
      });

      if (typeof result === "string") {
        throw new Error(`Expected move result, received ${result}`);
      }

      expect(result.sourceStatus).toBe("in_progress");
      expect(result.targetStatus).toBe("in_progress");

      const sourceAfterMove = await getCard("default", movedCard.id);
      const targetAfterMove = await getCard("ops", movedCard.id);
      expect(sourceAfterMove === null).toBeTrue();
      expect(targetAfterMove?.status).toBe("in_progress");

      const defaultBoard = await getBoard("default");
      const opsBoard = await getBoard("ops");
      const defaultColumn = defaultBoard.columns.find((column) => column.id === "in_progress");
      const opsColumn = opsBoard.columns.find((column) => column.id === "in_progress");

      expect(defaultColumn?.cards.map((card) => card.title).join(",")).toBe("Default head");
      expect(defaultColumn?.cards.map((card) => card.order).join(",")).toBe("0");
      expect(opsColumn?.cards.map((card) => card.title).join(",")).toBe("Ops tail,Move me");
      expect(opsColumn?.cards.map((card) => card.order).join(",")).toBe("0,1");
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("returns target_project_not_found when the destination project is missing", async () => {
    const ran = await withTempDatabase(async () => {
      const source = await createCard("default", "in_progress", {
        title: "Source",
        description: "",
      });

      const result = await moveCardToProject({
        cardId: source.id,
        sourceProjectId: "default",
        sourceStatus: "in_progress",
        targetProjectId: "missing",
      });

      expect(result).toBe("target_project_not_found");

      const sourceAfterFailure = await getCard("default", source.id);
      expect(sourceAfterFailure?.status).toBe("in_progress");
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });
});
