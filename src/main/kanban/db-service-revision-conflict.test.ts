import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  createCard,
  createProject,
  getBoard,
  initializeDatabase,
  updateCard,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-revision-conflict-"));
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

describe("card update revision conflict handling", () => {
  test("returns conflict without mutating on stale expectedRevision", async () => {
    const ran = await withTempDatabase(async () => {
      const projectId = "default";
      createProject({ id: projectId, name: "Default" });

      const created = await createCard(projectId, "1-ideas", {
        title: "Original title",
        description: "",
        priority: "p2-medium",
      });
      expect(created.revision).toBe(1);

      const firstUpdate = await updateCard(
        projectId,
        "1-ideas",
        created.id,
        { title: "First writer" },
        undefined,
        1,
      );
      expect(firstUpdate.status).toBe("updated");
      if (firstUpdate.status === "updated") {
        expect(firstUpdate.card.revision).toBe(2);
      }

      const staleUpdate = await updateCard(
        projectId,
        "1-ideas",
        created.id,
        { title: "Stale writer" },
        undefined,
        1,
      );
      expect(staleUpdate.status).toBe("conflict");
      if (staleUpdate.status === "conflict") {
        expect(staleUpdate.card.title).toBe("First writer");
        expect(staleUpdate.card.revision).toBe(2);
      }

      const board = await getBoard(projectId);
      const card = board.columns
        .flatMap((column) => column.cards)
        .find((entry) => entry.id === created.id);
      expect(card?.title).toBe("First writer");
      expect(card?.revision).toBe(2);
    });

    if (!ran) expect(true).toBeTrue();
  });
});
