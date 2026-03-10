import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_BACKUP_ENV = {
  autoEnabled: process.env.KANBAN_BACKUP_AUTO_ENABLED,
  intervalHours: process.env.KANBAN_BACKUP_INTERVAL_HOURS,
  retention: process.env.KANBAN_BACKUP_RETENTION,
};

async function importConfigModule() {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return import(`./config.ts?test=${token}`);
}

function clearBackupEnv(): void {
  delete process.env.KANBAN_BACKUP_AUTO_ENABLED;
  delete process.env.KANBAN_BACKUP_INTERVAL_HOURS;
  delete process.env.KANBAN_BACKUP_RETENTION;
}

function restoreProcessState(): void {
  process.chdir(ORIGINAL_CWD);

  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }

  if (ORIGINAL_BACKUP_ENV.autoEnabled === undefined) {
    delete process.env.KANBAN_BACKUP_AUTO_ENABLED;
  } else {
    process.env.KANBAN_BACKUP_AUTO_ENABLED = ORIGINAL_BACKUP_ENV.autoEnabled;
  }
  if (ORIGINAL_BACKUP_ENV.intervalHours === undefined) {
    delete process.env.KANBAN_BACKUP_INTERVAL_HOURS;
  } else {
    process.env.KANBAN_BACKUP_INTERVAL_HOURS = ORIGINAL_BACKUP_ENV.intervalHours;
  }
  if (ORIGINAL_BACKUP_ENV.retention === undefined) {
    delete process.env.KANBAN_BACKUP_RETENTION;
  } else {
    process.env.KANBAN_BACKUP_RETENTION = ORIGINAL_BACKUP_ENV.retention;
  }
}

async function withTempConfigFixture(
  run: (fixture: { tempHome: string }) => Promise<void>,
): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-config-test-"));
  const workspace = path.join(tempHome, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  process.chdir(workspace);
  process.env.HOME = tempHome;
  clearBackupEnv();

  try {
    await run({ tempHome });
  } finally {
    restoreProcessState();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

describe("backup settings config", () => {
  test("persists updated backup settings to user config", async () => {
    await withTempConfigFixture(async ({ tempHome }) => {
      const config = await importConfigModule();
      const updated = config.updateBackupSettings({
        autoEnabled: true,
        intervalHours: 4,
        retentionCount: 12,
      });

      expect(updated.autoEnabled).toBeTrue();
      expect(updated.intervalHours).toBe(4);
      expect(updated.retentionCount).toBe(12);
      expect(updated.envOverrides.autoEnabled).toBeFalse();
      expect(updated.envOverrides.intervalHours).toBeFalse();
      expect(updated.envOverrides.retentionCount).toBeFalse();

      const configPath = path.join(tempHome, ".nodex", "config.toml");
      const written = fs.readFileSync(configPath, "utf8");
      expect(written.includes("backup_auto_enabled = true")).toBeTrue();
      expect(written.includes("backup_interval_hours = 4")).toBeTrue();
      expect(written.includes("backup_retention = 12")).toBeTrue();

      const reloaded = await importConfigModule();
      const persisted = reloaded.getBackupSettings();
      expect(persisted.autoEnabled).toBeTrue();
      expect(persisted.intervalHours).toBe(4);
      expect(persisted.retentionCount).toBe(12);
    });
  });

  test("reports environment overrides while still persisting user values", async () => {
    await withTempConfigFixture(async ({ tempHome }) => {
      process.env.KANBAN_BACKUP_AUTO_ENABLED = "false";
      process.env.KANBAN_BACKUP_INTERVAL_HOURS = "24";
      process.env.KANBAN_BACKUP_RETENTION = "2";

      const config = await importConfigModule();
      const updated = config.updateBackupSettings({
        autoEnabled: true,
        intervalHours: 6,
        retentionCount: 10,
      });

      expect(updated.autoEnabled).toBeFalse();
      expect(updated.intervalHours).toBe(24);
      expect(updated.retentionCount).toBe(2);
      expect(updated.envOverrides.autoEnabled).toBeTrue();
      expect(updated.envOverrides.intervalHours).toBeTrue();
      expect(updated.envOverrides.retentionCount).toBeTrue();

      const configPath = path.join(tempHome, ".nodex", "config.toml");
      const written = fs.readFileSync(configPath, "utf8");
      expect(written.includes("backup_auto_enabled = true")).toBeTrue();
      expect(written.includes("backup_interval_hours = 6")).toBeTrue();
      expect(written.includes("backup_retention = 10")).toBeTrue();
    });
  });
});

describe("thread notification settings config", () => {
  test("defaults to enabled and persists updates to user config", async () => {
    await withTempConfigFixture(async ({ tempHome }) => {
      const config = await importConfigModule();

      expect(config.getThreadNotificationSettings().threadCompletionEnabled).toBeTrue();

      const updated = config.updateThreadNotificationSettings({
        threadCompletionEnabled: false,
      });

      expect(updated.threadCompletionEnabled).toBeFalse();
      expect(config.getThreadCompletionNotificationsEnabled()).toBeFalse();

      const configPath = path.join(tempHome, ".nodex", "config.toml");
      const written = fs.readFileSync(configPath, "utf8");
      expect(written.includes("thread_completion_notifications_enabled = false")).toBeTrue();

      const reloaded = await importConfigModule();
      expect(reloaded.getThreadNotificationSettings().threadCompletionEnabled).toBeFalse();
    });
  });

  test("reads thread notification settings from user config even when project config exists", async () => {
    await withTempConfigFixture(async ({ tempHome }) => {
      const projectConfigDir = path.join(tempHome, "workspace", ".nodex");
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, "config.toml"),
        ["[server]", "thread_completion_notifications_enabled = true", ""].join("\n"),
        "utf8",
      );

      const config = await importConfigModule();
      const updated = config.updateThreadNotificationSettings({
        threadCompletionEnabled: false,
      });

      expect(updated.threadCompletionEnabled).toBeFalse();

      const reloaded = await importConfigModule();
      expect(reloaded.getThreadNotificationSettings().threadCompletionEnabled).toBeFalse();
    });
  });
});
