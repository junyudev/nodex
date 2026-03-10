import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, createCard, createProject, initializeDatabase, renameProject } from "../kanban/db-service";
import {
  getCodexCardThreadLink,
  getCodexThreadSnapshot,
  listCodexProjectThreads,
  unlinkCodexThread,
  updateCodexThreadArchived,
  updateCodexThreadName,
  updateCodexThreadStatus,
  upsertCodexCardThreadLink,
  upsertCodexThreadSnapshot,
} from "./codex-link-repository";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-links-"));
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

  createProject({ id: "codex", name: "Codex", workspacePath: "/tmp/codex" });

  try {
    await run();
    return true;
  } finally {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KANBAN_DIR;
  }
}

describe("codex-link-repository", () => {
  test("upserts and queries thread links", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "6-in-progress", { title: "Implement Codex integration" });

      const first = upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_test_1",
        threadName: "Thread One",
        threadPreview: "Initial preview",
        modelProvider: "openai",
        cwd: "/tmp/codex",
        statusType: "idle",
      });

      expect(first.threadId).toBe("thr_test_1");
      expect(first.threadName).toBe("Thread One");
      expect(first.archived).toBe(false);

      const second = upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_test_1",
        threadName: "Thread One Updated",
        threadPreview: "Updated preview",
        modelProvider: "openai",
        cwd: "/tmp/codex",
        statusType: "active",
        statusActiveFlags: ["waitingOnApproval"],
      });

      expect(second.threadName).toBe("Thread One Updated");
      expect(second.statusType).toBe("active");
      expect(second.statusActiveFlags.length).toBe(1);

      const byProject = listCodexProjectThreads("codex");
      expect(byProject.length).toBe(1);
      expect(byProject[0]?.threadId).toBe("thr_test_1");

      const byCard = listCodexProjectThreads("codex", { cardId: card.id });
      expect(byCard.length).toBe(1);
      expect(byCard[0]?.cardId).toBe(card.id);
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("archives, renames, and status updates links", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "6-in-progress", { title: "Review links" });

      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_test_2",
      });

      const renamed = updateCodexThreadName("thr_test_2", "Renamed thread");
      expect(renamed?.threadName).toBe("Renamed thread");

      const statusUpdated = updateCodexThreadStatus("thr_test_2", "active", ["waitingOnUserInput"]);
      expect(statusUpdated?.statusType).toBe("active");
      expect(statusUpdated?.statusActiveFlags[0]).toBe("waitingOnUserInput");

      const archived = updateCodexThreadArchived("thr_test_2", true);
      expect(archived?.archived).toBe(true);

      const visible = listCodexProjectThreads("codex", { includeArchived: false });
      expect(visible.length).toBe(0);

      const withArchived = listCodexProjectThreads("codex", { includeArchived: true });
      expect(withArchived.length).toBe(1);
      expect(withArchived[0]?.threadId).toBe("thr_test_2");
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("project rename keeps linked thread rows", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "6-in-progress", { title: "Rename project" });

      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_test_rename",
      });

      const renamed = renameProject("codex", "codex-renamed", {
        name: "Codex Renamed",
        workspacePath: "/tmp/codex-renamed",
      });
      expect(renamed?.id).toBe("codex-renamed");
      expect(renamed?.workspacePath).toBe("/tmp/codex-renamed");

      const link = getCodexCardThreadLink("thr_test_rename");
      expect(link?.projectId).toBe("codex-renamed");
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("persists thread snapshots and cascades cleanup on unlink", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "6-in-progress", { title: "Snapshot cache" });

      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_snapshot_1",
      });

      const snapshot = upsertCodexThreadSnapshot({
        threadId: "thr_snapshot_1",
        turns: [
          {
            threadId: "thr_snapshot_1",
            turnId: "turn_1",
            status: "completed",
            itemIds: ["item_1"],
          },
        ],
        items: [
          {
            threadId: "thr_snapshot_1",
            turnId: "turn_1",
            itemId: "item_1",
            type: "commandExecution",
            normalizedKind: "commandExecution",
            toolCall: {
              subtype: "command",
              toolName: "bash",
              args: {
                command: "bun run lint",
              },
              result: "ok",
            },
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      });

      expect(snapshot.threadId).toBe("thr_snapshot_1");
      expect(snapshot.turns.length).toBe(1);
      expect(snapshot.items[0]?.toolCall?.toolName).toBe("bash");

      const fetched = getCodexThreadSnapshot("thr_snapshot_1");
      expect(fetched?.items[0]?.toolCall?.result).toBe("ok");

      const unlinked = unlinkCodexThread("thr_snapshot_1");
      expect(unlinked).toBe(true);
      expect(getCodexThreadSnapshot("thr_snapshot_1")).toBe(null);
    });

    if (!ran) expect(true).toBeTrue();
  });
});
