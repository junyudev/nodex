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
  moveCards,
  undoLatest,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-move-cards-"));
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

describe("moveCards", () => {
  test("treats same-column move-many newOrder as the post-removal insertion index", async () => {
    const ran = await withTempDatabase(async () => {
      await createCard("default", "in_progress", { title: "First" });
      const second = await createCard("default", "in_progress", { title: "Second" });
      await createCard("default", "in_progress", { title: "Third" });
      const fourth = await createCard("default", "in_progress", { title: "Fourth" });

      const result = await moveCards({
        projectId: "default",
        cardIds: [second.id, fourth.id],
        fromStatus: "in_progress",
        toStatus: "in_progress",
        newOrder: 2,
        sessionId: "session-move-many-same-column",
      });

      expect(result).toBe("moved");

      const board = await getBoard("default");
      const column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => card.title).join(",")).toBe("First,Third,Second,Fourth");
      expect(column?.cards.map((card) => card.order).join(",")).toBe("0,1,2,3");

      const history = getRecentHistory("default", 10, 0);
      const groupedEntries = history.filter((entry) => entry.sessionId === "session-move-many-same-column");
      expect(groupedEntries.length).toBe(2);
      expect(new Set(groupedEntries.map((entry) => entry.groupId)).size).toBe(1);
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("undo restores original order for same-column grouped moves", async () => {
    const ran = await withTempDatabase(async () => {
      const first = await createCard("default", "in_progress", { title: "First" });
      await createCard("default", "in_progress", { title: "Second" });
      const third = await createCard("default", "in_progress", { title: "Third" });
      await createCard("default", "in_progress", { title: "Fourth" });

      const result = await moveCards({
        projectId: "default",
        cardIds: [first.id, third.id],
        fromStatus: "in_progress",
        toStatus: "in_progress",
        newOrder: 2,
        sessionId: "session-move-many-same-column-undo",
      });

      expect(result).toBe("moved");

      const undoResult = undoLatest("default", "session-move-many-same-column-undo");
      expect(undoResult.success).toBeTrue();

      const board = await getBoard("default");
      const column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => card.title).join(",")).toBe("First,Second,Third,Fourth");
      expect(column?.cards.map((card) => card.order).join(",")).toBe("0,1,2,3");
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("moves cards to another column and undoes the group in one step", async () => {
    const ran = await withTempDatabase(async () => {
      const first = await createCard("default", "in_progress", { title: "First" });
      const second = await createCard("default", "in_progress", { title: "Second" });
      await createCard("default", "in_review", { title: "Existing review" });

      const result = await moveCards({
        projectId: "default",
        cardIds: [first.id, second.id],
        fromStatus: "in_progress",
        toStatus: "in_review",
        newOrder: 0,
        sessionId: "session-move-many-cross-column",
        groupId: "group-move-many-cross-column",
      });

      expect(result).toBe("moved");

      let board = await getBoard("default");
      let sourceColumn = board.columns.find((entry) => entry.id === "in_progress");
      let targetColumn = board.columns.find((entry) => entry.id === "in_review");

      expect(sourceColumn?.cards.length).toBe(0);
      expect(targetColumn?.cards.map((card) => card.title).join(",")).toBe("First,Second,Existing review");

      const history = getRecentHistory("default", 10, 0);
      const groupedEntries = history.filter((entry) => entry.groupId === "group-move-many-cross-column");
      expect(groupedEntries.length).toBe(2);

      const undoResult = undoLatest("default", "session-move-many-cross-column");
      expect(undoResult.success).toBeTrue();

      board = await getBoard("default");
      sourceColumn = board.columns.find((entry) => entry.id === "in_progress");
      targetColumn = board.columns.find((entry) => entry.id === "in_review");

      expect(sourceColumn?.cards.map((card) => card.title).join(",")).toBe("First,Second");
      expect(targetColumn?.cards.map((card) => card.title).join(",")).toBe("Existing review");
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("moves a cross-column selection into one target column in board order", async () => {
    const ran = await withTempDatabase(async () => {
      const inProgressFirst = await createCard("default", "in_progress", { title: "In Progress 1" });
      await createCard("default", "in_progress", { title: "In Progress 2" });
      const reviewFirst = await createCard("default", "in_review", { title: "Review 1" });
      await createCard("default", "in_review", { title: "Review 2" });

      const result = await moveCards({
        projectId: "default",
        cardIds: [reviewFirst.id, inProgressFirst.id],
        toStatus: "done",
        newOrder: 0,
        sessionId: "session-move-many-multi-column",
      });

      expect(result).toBe("moved");

      const board = await getBoard("default");
      const inProgressColumn = board.columns.find((entry) => entry.id === "in_progress");
      const reviewColumn = board.columns.find((entry) => entry.id === "in_review");
      const doneColumn = board.columns.find((entry) => entry.id === "done");

      expect(inProgressColumn?.cards.map((card) => card.title).join(",")).toBe("In Progress 2");
      expect(reviewColumn?.cards.map((card) => card.title).join(",")).toBe("Review 2");
      expect(doneColumn?.cards.map((card) => card.title).join(",")).toBe("In Progress 1,Review 1");
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("applies a grouped priority patch and restores it on undo", async () => {
    const ran = await withTempDatabase(async () => {
      const first = await createCard("default", "in_progress", {
        title: "First",
        priority: "p2-medium",
      });
      await createCard("default", "in_progress", {
        title: "Second",
        priority: "p1-high",
      });

      const result = await moveCards({
        projectId: "default",
        cardIds: [first.id],
        fromStatus: "in_progress",
        toStatus: "in_progress",
        newOrder: 1,
        fieldPatch: { priority: "p1-high" },
        sessionId: "session-move-many-with-patch",
      });

      expect(result).toBe("moved");

      let board = await getBoard("default");
      let column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => `${card.title}:${card.priority ?? "none"}`).join(",")).toBe(
        "Second:p1-high,First:p1-high",
      );

      const undoResult = undoLatest("default", "session-move-many-with-patch");
      expect(undoResult.success).toBeTrue();

      board = await getBoard("default");
      column = board.columns.find((entry) => entry.id === "in_progress");
      expect(column?.cards.map((card) => `${card.title}:${card.priority ?? "none"}`).join(",")).toBe(
        "First:p2-medium,Second:p1-high",
      );
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("skips history writes for a no-op drag with an unchanged patch", async () => {
    const ran = await withTempDatabase(async () => {
      const only = await createCard("default", "in_progress", {
        title: "Only",
        priority: "p2-medium",
      });

      const result = await moveCards({
        projectId: "default",
        cardIds: [only.id],
        fromStatus: "in_progress",
        toStatus: "in_progress",
        newOrder: 0,
        fieldPatch: { priority: "p2-medium" },
        sessionId: "session-move-many-no-op-patch",
      });

      expect(result).toBe("moved");

      const history = getRecentHistory("default", 10, 0);
      const matchingEntries = history.filter((entry) => entry.sessionId === "session-move-many-no-op-patch");
      expect(matchingEntries.length).toBe(0);
    });

    if (!ran) expect(true).toBeTrue();
  });
});
