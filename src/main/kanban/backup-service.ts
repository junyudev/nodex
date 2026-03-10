import * as fs from "fs";
import * as path from "path";
import type {
  BackupRecord,
  BackupTrigger,
  CreateBackupInput,
  RestoreBackupInput,
  RestoreBackupResult,
} from "../../shared/types";
import { dbNotifier } from "./db-notifier";
import { getDatabasePath, getKanbanDir } from "./config";
import { closeDatabase, getDb, listProjects } from "./db-service";
import { getLogger } from "../logging/logger";

const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_DB_FILE_NAME = "kanban.db";
const BACKUP_MANIFEST_FILE_NAME = "manifest.json";
const BACKUP_ASSETS_DIR_NAME = "assets";
const SAFE_BACKUP_ID_REGEX = /^[A-Za-z0-9-]+$/;

interface BackupManifest {
  version: number;
  id: string;
  createdAt: string;
  trigger: BackupTrigger;
  label: string | null;
  includesAssets: boolean;
  dbBytes: number;
  assetsBytes: number;
  totalBytes: number;
}

interface AutoBackupSchedulerOptions {
  enabled: boolean;
  intervalHours: number;
  retentionCount: number;
}

export class BackupNotFoundError extends Error {
  constructor(backupId: string) {
    super(`Backup not found: ${backupId}`);
    this.name = "BackupNotFoundError";
  }
}

export class InvalidBackupIdError extends Error {
  constructor(backupId: string) {
    super(`Invalid backup id: ${backupId}`);
    this.name = "InvalidBackupIdError";
  }
}

let backupOperationQueue = Promise.resolve();
let stopRunningAutoBackupScheduler: (() => void) | null = null;
const logger = getLogger({ subsystem: "backup" });

function enqueueBackupOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = backupOperationQueue.then(operation, operation);
  backupOperationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function getBackupsRootPath(): string {
  return path.join(getKanbanDir(), "backups");
}

function getAssetsRootPath(): string {
  return path.join(getKanbanDir(), "assets");
}

function assertSafeBackupId(backupId: string): void {
  if (!SAFE_BACKUP_ID_REGEX.test(backupId)) {
    throw new InvalidBackupIdError(backupId);
  }
}

function getBackupPath(backupId: string): string {
  assertSafeBackupId(backupId);
  return path.join(getBackupsRootPath(), backupId);
}

function getRollbackPath(): string {
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return path.join(getBackupsRootPath(), `.rollback-${Date.now()}-${randomSuffix}`);
}

function getBackupId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${randomSuffix}`;
}

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function removePathIfExists(targetPath: string): void {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function movePathIfExists(sourcePath: string, destinationPath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  fs.renameSync(sourcePath, destinationPath);
}

function copyPathIfExists(sourcePath: string, destinationPath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
}

function getDirectorySize(directoryPath: string): number {
  if (!fs.existsSync(directoryPath)) return 0;
  if (!fs.statSync(directoryPath).isDirectory()) return 0;

  let totalSize = 0;
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += getDirectorySize(entryPath);
      continue;
    }
    if (!entry.isFile()) continue;
    totalSize += fs.statSync(entryPath).size;
  }

  return totalSize;
}

function toBackupRecord(manifest: BackupManifest): BackupRecord {
  return {
    version: manifest.version,
    id: manifest.id,
    createdAt: manifest.createdAt,
    trigger: manifest.trigger,
    label: manifest.label,
    includesAssets: manifest.includesAssets,
    dbBytes: manifest.dbBytes,
    assetsBytes: manifest.assetsBytes,
    totalBytes: manifest.totalBytes,
  };
}

function readManifest(backupDirectoryPath: string): BackupManifest {
  const manifestPath = path.join(backupDirectoryPath, BACKUP_MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup manifest is missing in ${backupDirectoryPath}`);
  }

  const rawValue = fs.readFileSync(manifestPath, "utf8");
  const parsedValue = JSON.parse(rawValue) as Partial<BackupManifest>;
  if (!parsedValue.id || !parsedValue.createdAt || !parsedValue.trigger) {
    throw new Error(`Backup manifest is invalid in ${backupDirectoryPath}`);
  }
  assertSafeBackupId(parsedValue.id);

  return {
    version: parsedValue.version ?? BACKUP_SCHEMA_VERSION,
    id: parsedValue.id,
    createdAt: parsedValue.createdAt,
    trigger: parsedValue.trigger,
    label: parsedValue.label ?? null,
    includesAssets: parsedValue.includesAssets ?? false,
    dbBytes: parsedValue.dbBytes ?? 0,
    assetsBytes: parsedValue.assetsBytes ?? 0,
    totalBytes: parsedValue.totalBytes ?? 0,
  };
}

function notifyAllProjects(): void {
  const projects = listProjects();
  if (projects.length === 0) {
    dbNotifier.notifyChange("default", "update", "1-ideas");
    return;
  }

  for (const project of projects) {
    dbNotifier.notifyChange(project.id, "update", "1-ideas");
  }
}

async function createBackupInternal(input: CreateBackupInput): Promise<BackupRecord> {
  const trigger = input.trigger ?? "manual";
  const label = input.label?.trim() || null;

  ensureDirectory(getBackupsRootPath());

  const backupId = getBackupId();
  const backupDirectoryPath = getBackupPath(backupId);
  const tempDirectoryPath = `${backupDirectoryPath}.tmp`;
  const backupDatabasePath = path.join(tempDirectoryPath, BACKUP_DB_FILE_NAME);
  const backupAssetsPath = path.join(tempDirectoryPath, BACKUP_ASSETS_DIR_NAME);
  const sourceAssetsPath = getAssetsRootPath();

  ensureDirectory(tempDirectoryPath);

  try {
    await getDb().backup(backupDatabasePath);
    copyPathIfExists(sourceAssetsPath, backupAssetsPath);

    const dbBytes = fs.statSync(backupDatabasePath).size;
    const assetsBytes = getDirectorySize(backupAssetsPath);
    const manifest: BackupManifest = {
      version: BACKUP_SCHEMA_VERSION,
      id: backupId,
      createdAt: new Date().toISOString(),
      trigger,
      label,
      includesAssets: fs.existsSync(backupAssetsPath),
      dbBytes,
      assetsBytes,
      totalBytes: dbBytes + assetsBytes,
    };

    fs.writeFileSync(
      path.join(tempDirectoryPath, BACKUP_MANIFEST_FILE_NAME),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    fs.renameSync(tempDirectoryPath, backupDirectoryPath);
    logger.info("Created backup", {
      backupId,
      trigger,
      hasLabel: Boolean(label),
      dbBytes,
      assetsBytes,
      totalBytes: manifest.totalBytes,
    });
    return toBackupRecord(manifest);
  } catch (error) {
    removePathIfExists(tempDirectoryPath);
    logger.error("Backup creation failed", {
      backupId,
      trigger,
      error,
    });
    throw error;
  }
}

function restoreRollbackSnapshot(rollbackDirectoryPath: string): void {
  const databasePath = getDatabasePath();
  const databaseWalPath = `${databasePath}-wal`;
  const databaseShmPath = `${databasePath}-shm`;
  const assetsPath = getAssetsRootPath();

  removePathIfExists(databasePath);
  removePathIfExists(databaseWalPath);
  removePathIfExists(databaseShmPath);
  removePathIfExists(assetsPath);

  movePathIfExists(path.join(rollbackDirectoryPath, "kanban.db"), databasePath);
  movePathIfExists(path.join(rollbackDirectoryPath, "kanban.db-wal"), databaseWalPath);
  movePathIfExists(path.join(rollbackDirectoryPath, "kanban.db-shm"), databaseShmPath);
  movePathIfExists(path.join(rollbackDirectoryPath, BACKUP_ASSETS_DIR_NAME), assetsPath);
}

async function restoreBackupInternal(input: RestoreBackupInput): Promise<RestoreBackupResult> {
  if (!input.confirm) {
    throw new Error("Restore requires explicit confirm=true");
  }

  logger.warn("Starting backup restore", {
    backupId: input.backupId,
    createSafetyBackup: input.createSafetyBackup !== false,
  });

  const backupDirectoryPath = getBackupPath(input.backupId);
  if (!fs.existsSync(backupDirectoryPath)) {
    throw new BackupNotFoundError(input.backupId);
  }

  const backupDatabasePath = path.join(backupDirectoryPath, BACKUP_DB_FILE_NAME);
  if (!fs.existsSync(backupDatabasePath)) {
    throw new Error(`Backup database file is missing for ${input.backupId}`);
  }

  const backupAssetsPath = path.join(backupDirectoryPath, BACKUP_ASSETS_DIR_NAME);
  const rollbackDirectoryPath = getRollbackPath();
  const databasePath = getDatabasePath();
  const databaseWalPath = `${databasePath}-wal`;
  const databaseShmPath = `${databasePath}-shm`;
  const assetsPath = getAssetsRootPath();
  const createSafetyBackup = input.createSafetyBackup !== false;

  let safetyBackupId: string | undefined;
  let rollbackPrepared = false;

  ensureDirectory(getBackupsRootPath());
  ensureDirectory(rollbackDirectoryPath);

  if (createSafetyBackup) {
    const safetyBackup = await createBackupInternal({
      trigger: "pre-restore",
      label: `Auto safety backup before restoring ${input.backupId}`,
    });
    safetyBackupId = safetyBackup.id;
  }

  try {
    closeDatabase();
    rollbackPrepared = true;

    movePathIfExists(databasePath, path.join(rollbackDirectoryPath, "kanban.db"));
    movePathIfExists(databaseWalPath, path.join(rollbackDirectoryPath, "kanban.db-wal"));
    movePathIfExists(databaseShmPath, path.join(rollbackDirectoryPath, "kanban.db-shm"));
    movePathIfExists(assetsPath, path.join(rollbackDirectoryPath, BACKUP_ASSETS_DIR_NAME));

    fs.copyFileSync(backupDatabasePath, databasePath);
    copyPathIfExists(backupAssetsPath, assetsPath);

    const validationRow = getDb()
      .prepare("SELECT COUNT(*) as count FROM projects")
      .get() as { count: number } | undefined;
    if (!validationRow || typeof validationRow.count !== "number") {
      throw new Error("Restore validation failed");
    }
  } catch (error) {
    if (rollbackPrepared) {
      closeDatabase();
      restoreRollbackSnapshot(rollbackDirectoryPath);
      getDb();
    }
    logger.error("Backup restore failed", {
      backupId: input.backupId,
      rollbackPrepared,
      error,
    });
    throw error;
  } finally {
    removePathIfExists(rollbackDirectoryPath);
  }

  notifyAllProjects();

  logger.warn("Backup restore completed", {
    backupId: input.backupId,
    safetyBackupId,
  });

  return {
    success: true,
    restoredBackupId: input.backupId,
    safetyBackupId,
  };
}

export async function createBackup(input: CreateBackupInput = {}): Promise<BackupRecord> {
  logger.info("Queueing backup creation", {
    trigger: input.trigger ?? "manual",
    hasLabel: Boolean(input.label?.trim()),
  });
  return enqueueBackupOperation(() => createBackupInternal(input));
}

export async function listBackups(): Promise<BackupRecord[]> {
  const backupsRootPath = getBackupsRootPath();
  if (!fs.existsSync(backupsRootPath)) return [];

  const entries = fs.readdirSync(backupsRootPath, { withFileTypes: true });
  const backups: BackupRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const backupDirectoryPath = path.join(backupsRootPath, entry.name);
    try {
      backups.push(toBackupRecord(readManifest(backupDirectoryPath)));
    } catch (error) {
      logger.warn("Skipping invalid backup entry", {
        backupId: entry.name,
        error,
      });
    }
  }

  backups.sort((left, right) => {
    if (left.createdAt === right.createdAt) return right.id.localeCompare(left.id);
    return right.createdAt.localeCompare(left.createdAt);
  });

  return backups;
}

export async function restoreBackup(input: RestoreBackupInput): Promise<RestoreBackupResult> {
  logger.warn("Queueing backup restore", {
    backupId: input.backupId,
    createSafetyBackup: input.createSafetyBackup !== false,
  });
  return enqueueBackupOperation(() => restoreBackupInternal(input));
}

export async function pruneAutoBackups(retentionCount: number): Promise<{ removed: string[] }> {
  return enqueueBackupOperation(async () => {
    const normalizedRetention = Math.max(0, retentionCount);
    const backups = await listBackups();
    const autoBackups = backups.filter((backup) => backup.trigger === "auto");
    const backupsToRemove = autoBackups.slice(normalizedRetention);
    const removed: string[] = [];

    for (const backup of backupsToRemove) {
      const backupPath = getBackupPath(backup.id);
      removePathIfExists(backupPath);
      removed.push(backup.id);
    }

    return { removed };
  });
}

export function startAutoBackupScheduler(options: AutoBackupSchedulerOptions): () => void {
  if (!options.enabled) {
    return () => undefined;
  }

  const intervalHours = Math.max(1, options.intervalHours);
  const intervalMilliseconds = intervalHours * 60 * 60 * 1000;
  const retentionCount = Math.max(0, options.retentionCount);

  const handleRun = async () => {
    try {
      await createBackup({ trigger: "auto" });
      await pruneAutoBackups(retentionCount);
    } catch (error) {
      logger.error("Auto backup run failed", { error, retentionCount, intervalHours });
    }
  };

  const timer = setInterval(() => {
    void handleRun();
  }, intervalMilliseconds);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

export function configureAutoBackupScheduler(options: AutoBackupSchedulerOptions): void {
  if (stopRunningAutoBackupScheduler) {
    stopRunningAutoBackupScheduler();
    stopRunningAutoBackupScheduler = null;
  }
  logger.info("Configuring auto backup scheduler", options);
  stopRunningAutoBackupScheduler = startAutoBackupScheduler(options);
}

export function stopAutoBackupScheduler(): void {
  if (!stopRunningAutoBackupScheduler) return;
  stopRunningAutoBackupScheduler();
  stopRunningAutoBackupScheduler = null;
  logger.info("Stopped auto backup scheduler");
}
