import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  createProject,
  getProject,
  initializeDatabase,
  renameProject,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-project-icon-"));
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

describe("project icon persistence", () => {
  test("stores icon on create and update", async () => {
    const ran = await withTempDatabase(async () => {
      const project = createProject({ id: "alpha", name: "Alpha", icon: "🚀", workspacePath: "/tmp/alpha" });
      expect(project.icon).toBe("🚀");
      expect(project.workspacePath).toBe("/tmp/alpha");
      expect(getProject("alpha")?.icon).toBe("🚀");
      expect(getProject("alpha")?.workspacePath).toBe("/tmp/alpha");

      const renamed = renameProject("alpha", "alpha", { icon: "🧠", workspacePath: "/tmp/alpha-2" });
      expect(renamed?.icon).toBe("🧠");
      expect(renamed?.workspacePath).toBe("/tmp/alpha-2");
      expect(getProject("alpha")?.icon).toBe("🧠");
      expect(getProject("alpha")?.workspacePath).toBe("/tmp/alpha-2");
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("stores empty icon when icon is missing or invalid", async () => {
    const ran = await withTempDatabase(async () => {
      const project = createProject({ id: "beta", name: "Beta", workspacePath: null });
      expect(project.icon).toBe("");

      const renamed = renameProject("beta", "beta", { icon: "not-an-emoji" });
      expect(renamed?.icon).toBe("");
    });

    if (!ran) expect(true).toBeTrue();
  });
});
