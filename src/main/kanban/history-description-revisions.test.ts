import { describe, expect, test } from "bun:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  createCard,
  createProject,
  getBoard,
  getCardHistory,
  getCardHistoryPanelEntries,
  getRecentHistory,
  initializeDatabase,
  redoLatest,
  restoreToEntry,
  undoLatest,
  updateCard,
} from "./db-service";
import { getDatabasePath } from "./config";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-history-description-"));
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

async function findCardDescription(projectId: string, cardId: string): Promise<string | null> {
  const board = await getBoard(projectId);
  const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === cardId);
  return card?.description ?? null;
}

describe("history description revisions", () => {
  test("hydrates descriptions back into history while keeping raw payloads compact", async () => {
    const ran = await withTempDatabase(async () => {
      const projectId = "history-description-project";
      createProject({ id: projectId, name: "History descriptions" });

      const initialDescription = "# Heading\n\nOriginal body";
      const updatedDescription = "# Heading\n\nUpdated body\n\nThird block";
      const created = await createCard(projectId, "1-ideas", {
        title: "Revision card",
        description: initialDescription,
      });

      const updated = await updateCard(projectId, "1-ideas", created.id, {
        description: updatedDescription,
      });
      expect(updated.status).toBe("updated");

      const history = getCardHistory(projectId, created.id);
      expect(history.length).toBe(2);
      expect(history[0]?.operation).toBe("update");
      expect(String(history[0]?.previousValues?.description)).toBe(initialDescription);
      expect(String(history[0]?.newValues?.description)).toBe(updatedDescription);
      expect(history[1]?.operation).toBe("create");
      expect(history[1]?.cardSnapshot?.description).toBe(initialDescription);

      const database = new Database(getDatabasePath(), { readonly: true });
      const rows = database.prepare(`
        SELECT
          previous_values,
          new_values,
          card_snapshot,
          previous_description_revision_id,
          new_description_revision_id,
          snapshot_description_revision_id
        FROM history
        WHERE project_id = ? AND card_id = ?
        ORDER BY id DESC
      `).all(projectId, created.id) as Array<{
        previous_values: string | null;
        new_values: string | null;
        card_snapshot: string | null;
        previous_description_revision_id: number | null;
        new_description_revision_id: number | null;
        snapshot_description_revision_id: number | null;
      }>;

      const updateRow = rows[0];
      const createRow = rows[1];
      const updatePreviousValues = JSON.parse(updateRow?.previous_values ?? "{}") as Record<string, unknown>;
      const updateNewValues = JSON.parse(updateRow?.new_values ?? "{}") as Record<string, unknown>;
      const createSnapshot = JSON.parse(createRow?.card_snapshot ?? "{}") as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(updatePreviousValues, "description")).toBeFalse();
      expect(Object.prototype.hasOwnProperty.call(updateNewValues, "description")).toBeFalse();
      expect(Object.prototype.hasOwnProperty.call(createSnapshot, "description")).toBeFalse();
      expect(updateRow?.previous_description_revision_id).not.toBeNull();
      expect(updateRow?.new_description_revision_id).not.toBeNull();
      expect(createRow?.snapshot_description_revision_id).not.toBeNull();

      const cardRow = database.prepare(`
        SELECT description_revision_id
        FROM cards
        WHERE id = ?
      `).get(created.id) as { description_revision_id: number | null } | undefined;
      expect(cardRow?.description_revision_id).not.toBeNull();
      database.close();
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("builds panel entries with block-level description deltas instead of hydrated full texts", async () => {
    const ran = await withTempDatabase(async () => {
      const projectId = "history-panel-project";
      createProject({ id: projectId, name: "History panel" });

      const created = await createCard(projectId, "1-ideas", {
        title: "Panel card",
        description: "# Heading\n\nAlpha",
      });

      const updated = await updateCard(projectId, "1-ideas", created.id, {
        description: "# Heading\n\nBeta\n\nGamma",
        tags: ["delta"],
      });
      expect(updated.status).toBe("updated");

      const entries = getCardHistoryPanelEntries(projectId, created.id);
      expect(entries.length).toBe(2);
      expect(entries[0]?.operation).toBe("update");
      expect(entries[0]?.descriptionChange?.beforeBlockCount).toBe(2);
      expect(entries[0]?.descriptionChange?.afterBlockCount).toBe(3);
      expect(entries[0]?.descriptionChange?.beforeFullText).toBe("# Heading\n\nAlpha");
      expect(entries[0]?.descriptionChange?.afterFullText).toBe("# Heading\n\nBeta\n\nGamma");
      expect(entries[0]?.descriptionChange?.blocks.length).toBe(2);
      expect(entries[0]?.descriptionChange?.blocks[0]?.changeType).toBe("replaced");
      expect(entries[0]?.descriptionChange?.blocks[0]?.beforePreview).toBe("Alpha");
      expect(entries[0]?.descriptionChange?.blocks[0]?.afterPreview).toBe("Beta");
      expect(entries[0]?.fieldChanges.length).toBe(1);
      expect(entries[0]?.fieldChanges[0]?.field).toBe("tags");
      expect(entries[1]?.snapshot?.description?.blockCount).toBe(2);
      expect(entries[1]?.snapshot?.description?.blocks[1]?.preview).toBe("Alpha");
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("undo redo and restore operate on description revisions", async () => {
    const ran = await withTempDatabase(async () => {
      const projectId = "history-restore-project";
      createProject({ id: projectId, name: "History restore" });

      const created = await createCard(projectId, "1-ideas", {
        title: "Restorable card",
        description: "Original description",
      });

      const updated = await updateCard(projectId, "1-ideas", created.id, {
        description: "Updated description",
      });
      expect(updated.status).toBe("updated");

      const historyBeforeRestore = getRecentHistory(projectId, 10, 0);
      const createEntry = historyBeforeRestore.find((entry) => entry.operation === "create");
      expect(createEntry?.id !== undefined).toBeTrue();

      const undone = undoLatest(projectId);
      expect(undone.success).toBeTrue();
      expect(await findCardDescription(projectId, created.id)).toBe("Original description");

      const redone = redoLatest(projectId);
      expect(redone.success).toBeTrue();
      expect(await findCardDescription(projectId, created.id)).toBe("Updated description");

      const restored = restoreToEntry(projectId, created.id, createEntry?.id ?? -1);
      expect(restored.success).toBeTrue();
      expect(await findCardDescription(projectId, created.id)).toBe("Original description");

      const database = new Database(getDatabasePath(), { readonly: true });
      const cardRow = database.prepare(`
        SELECT description_revision_id
        FROM cards
        WHERE id = ?
      `).get(created.id) as { description_revision_id: number | null } | undefined;
      expect(cardRow?.description_revision_id).not.toBeNull();
      database.close();
    });

    if (!ran) expect(true).toBeTrue();
  });
});
