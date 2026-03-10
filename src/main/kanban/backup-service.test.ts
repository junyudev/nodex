import { describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-backup-unit-"));
const liveDbPath = path.join(fixtureRoot, "kanban.db");
const liveAssetsPath = path.join(fixtureRoot, "assets");

const state = {
  projects: [{ id: "default" }],
  notifications: [] as Array<[string, string, string]>,
};

mock.module("./config", () => ({
  getKanbanDir: () => fixtureRoot,
  getDatabasePath: () => liveDbPath,
}));

mock.module("./db-notifier", () => ({
  dbNotifier: {
    notifyChange: (projectId: string, changeType: string, columnId: string) => {
      state.notifications.push([projectId, changeType, columnId]);
    },
  },
}));

mock.module("./db-service", () => ({
  closeDatabase: () => undefined,
  listProjects: () => state.projects,
  getDb: () => ({
    backup: async (destinationPath: string) => {
      fs.copyFileSync(liveDbPath, destinationPath);
      return { totalPages: 1, remainingPages: 0 };
    },
    prepare: () => ({
      get: () => {
        if (!fs.existsSync(liveDbPath)) {
          throw new Error("missing database");
        }
        const content = fs.readFileSync(liveDbPath, "utf8");
        if (content.startsWith("invalid")) {
          throw new Error("invalid database");
        }
        return { count: 1 };
      },
    }),
  }),
}));

const backupService = await import("./backup-service");

function resetState(): void {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(liveDbPath, "live-db", "utf8");
  state.notifications = [];
}

function writeAsset(fileName: string, content: string): void {
  fs.mkdirSync(liveAssetsPath, { recursive: true });
  fs.writeFileSync(path.join(liveAssetsPath, fileName), content, "utf8");
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("backup service", () => {
  test("creates backup containing db and assets", async () => {
    resetState();
    writeAsset("a.txt", "asset-a");

    const backup = await backupService.createBackup({
      trigger: "manual",
      label: "first",
    });

    expect(backup.trigger).toBe("manual");
    expect(backup.includesAssets).toBeTrue();
    expect(backup.dbBytes > 0).toBeTrue();
    expect(backup.totalBytes >= backup.dbBytes).toBeTrue();

    const backupDir = path.join(fixtureRoot, "backups", backup.id);
    expect(fs.existsSync(path.join(backupDir, "manifest.json"))).toBeTrue();
    expect(fs.existsSync(path.join(backupDir, "kanban.db"))).toBeTrue();
    expect(fs.existsSync(path.join(backupDir, "assets", "a.txt"))).toBeTrue();
  });

  test("lists backups newest first", async () => {
    resetState();

    const first = await backupService.createBackup({ trigger: "manual", label: "first" });
    await sleep(5);
    const second = await backupService.createBackup({ trigger: "manual", label: "second" });

    const backups = await backupService.listBackups();
    expect(backups.length).toBe(2);
    expect(backups[0].id).toBe(second.id);
    expect(backups[1].id).toBe(first.id);
  });

  test("restore requires explicit confirm", async () => {
    resetState();
    const backup = await backupService.createBackup({ trigger: "manual" });

    let message = "";
    try {
      await backupService.restoreBackup({
        backupId: backup.id,
        confirm: false,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message.includes("confirm=true")).toBeTrue();
  });

  test("restore creates pre-restore safety backup by default", async () => {
    resetState();
    const target = await backupService.createBackup({ trigger: "manual", label: "target" });
    fs.writeFileSync(liveDbPath, "live-db-updated", "utf8");

    const result = await backupService.restoreBackup({
      backupId: target.id,
      confirm: true,
    });

    expect(result.success).toBeTrue();
    expect(result.restoredBackupId).toBe(target.id);
    expect(Boolean(result.safetyBackupId)).toBeTrue();
    expect(state.notifications.length > 0).toBeTrue();

    const allBackups = await backupService.listBackups();
    const safety = allBackups.find((item) => item.id === result.safetyBackupId);
    expect(Boolean(safety)).toBeTrue();
    expect(safety?.trigger).toBe("pre-restore");
  });

  test("prunes only auto backups beyond retention", async () => {
    resetState();

    await backupService.createBackup({ trigger: "manual", label: "manual" });
    await backupService.createBackup({ trigger: "pre-restore", label: "safety" });
    for (let index = 0; index < 4; index += 1) {
      await sleep(2);
      await backupService.createBackup({ trigger: "auto", label: `auto-${index}` });
    }

    const pruneResult = await backupService.pruneAutoBackups(2);
    expect(pruneResult.removed.length).toBe(2);

    const backups = await backupService.listBackups();
    expect(backups.filter((item) => item.trigger === "auto").length).toBe(2);
    expect(backups.filter((item) => item.trigger === "manual").length).toBe(1);
    expect(backups.filter((item) => item.trigger === "pre-restore").length).toBe(1);
  });

  test("restore rolls back when validation fails", async () => {
    resetState();
    fs.writeFileSync(liveDbPath, "baseline-live-db", "utf8");
    const backup = await backupService.createBackup({ trigger: "manual", label: "baseline" });

    const backupDbPath = path.join(fixtureRoot, "backups", backup.id, "kanban.db");
    fs.writeFileSync(backupDbPath, "invalid-backup-db", "utf8");

    let failed = false;
    try {
      await backupService.restoreBackup({
        backupId: backup.id,
        confirm: true,
        createSafetyBackup: false,
      });
    } catch {
      failed = true;
    }

    expect(failed).toBeTrue();
    expect(fs.readFileSync(liveDbPath, "utf8")).toBe("baseline-live-db");
  });

  test("restore rejects unsafe backup ids", async () => {
    resetState();

    let message = "";
    try {
      await backupService.restoreBackup({
        backupId: "../outside",
        confirm: true,
        createSafetyBackup: false,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message.includes("Invalid backup id")).toBeTrue();
  });
});
