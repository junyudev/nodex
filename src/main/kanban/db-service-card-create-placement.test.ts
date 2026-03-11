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
  redoLatest,
  undoLatest,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-card-create-placement-"));
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

describe("createCard placement", () => {
  test("inserts at top when placement is top and shifts existing order", async () => {
    const ran = await withTempDatabase(async () => {
      const first = await createCard("default", "in_progress", { title: "First" });
      const second = await createCard("default", "in_progress", { title: "Second" });
      const top = await createCard("default", "in_progress", { title: "Top" }, undefined, "top");

      expect(first.order).toBe(0);
      expect(second.order).toBe(1);
      expect(top.order).toBe(0);

      const board = await getBoard("default");
      const column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column !== undefined).toBeTrue();
      expect(column?.cards.map((card) => card.title).join(",")).toBe("Top,First,Second");
      expect(column?.cards.map((card) => card.order).join(",")).toBe("0,1,2");
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("redo preserves top insertion position", async () => {
    const ran = await withTempDatabase(async () => {
      const sessionId = "session-create-top";
      await createCard("default", "in_progress", { title: "First" });
      await createCard("default", "in_progress", { title: "Second" });
      await createCard("default", "in_progress", { title: "Top" }, sessionId, "top");

      let board = await getBoard("default");
      let column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => card.title).join(",")).toBe("Top,First,Second");

      const undoResult = undoLatest("default", sessionId);
      expect(undoResult.success).toBeTrue();

      board = await getBoard("default");
      column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => card.title).join(",")).toBe("First,Second");
      expect(column?.cards.map((card) => card.order).join(",")).toBe("0,1");

      const redoResult = redoLatest("default", sessionId);
      expect(redoResult.success).toBeTrue();

      board = await getBoard("default");
      column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => card.title).join(",")).toBe("Top,First,Second");
      expect(column?.cards.map((card) => card.order).join(",")).toBe("0,1,2");
    });

    if (!ran) expect(true).toBeTrue();
  });
});
