import { autoUpdater, type AppUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";
import type { AppUpdateSettings, AppUpdateStatus } from "../shared/types";

type StatusListener = (status: AppUpdateStatus) => void;

interface LoggerLike {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

type UpdaterLike = Pick<
  AppUpdater,
  "checkForUpdates" | "quitAndInstall"
> & {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

interface AppUpdateServiceOptions {
  currentVersion: string;
  isPackaged: boolean;
  logger: LoggerLike;
  platform: NodeJS.Platform;
  createUpdater?: () => UpdaterLike;
}

function normalizeReleaseNotes(releaseNotes: UpdateInfo["releaseNotes"] | UpdateDownloadedEvent["releaseNotes"]): string | null {
  if (typeof releaseNotes === "string") {
    const normalized = releaseNotes.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(releaseNotes) || releaseNotes.length === 0) {
    return null;
  }

  const latestNote = releaseNotes[0]?.note?.trim();
  return latestNote && latestNote.length > 0 ? latestNote : null;
}

function roundProgressPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

export class AppUpdateService {
  private readonly currentVersion: string;
  private readonly isPackaged: boolean;
  private readonly logger: LoggerLike;
  private readonly platform: NodeJS.Platform;
  private readonly createUpdater: () => UpdaterLike;
  private readonly listeners = new Set<StatusListener>();

  private updater: UpdaterLike | null = null;
  private initialized = false;
  private automaticCheckStarted = false;
  private status: AppUpdateStatus;

  constructor(options: AppUpdateServiceOptions) {
    this.currentVersion = options.currentVersion;
    this.isPackaged = options.isPackaged;
    this.logger = options.logger;
    this.platform = options.platform;
    this.createUpdater = options.createUpdater ?? (() => autoUpdater as unknown as UpdaterLike);
    this.status = this.buildInitialStatus();
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): AppUpdateStatus {
    return this.status;
  }

  initialize(): AppUpdateStatus {
    if (this.initialized) {
      return this.status;
    }

    this.initialized = true;

    if (!this.isSupportedRuntime()) {
      this.status = this.buildInitialStatus();
      return this.status;
    }

    const updater = this.createUpdater();
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    this.updater = updater;
    this.bindUpdaterEvents(updater);

    this.setStatus({
      status: "idle",
      supported: true,
      currentVersion: this.currentVersion,
      availableVersion: null,
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      checkedAt: null,
      message: null,
    });

    this.logger.info("App updater initialized", {
      currentVersion: this.currentVersion,
      platform: this.platform,
    });

    return this.status;
  }

  maybeStartAutomaticChecks(settings: AppUpdateSettings): void {
    this.initialize();

    if (!this.status.supported) {
      return;
    }

    if (!settings.automaticChecksEnabled || this.automaticCheckStarted) {
      return;
    }

    this.automaticCheckStarted = true;
    void this.checkForUpdates("startup");
  }

  async checkForUpdates(reason: "startup" | "manual" = "manual"): Promise<AppUpdateStatus> {
    this.initialize();

    if (!this.status.supported || !this.updater) {
      return this.status;
    }

    if (this.status.status === "checking" || this.status.status === "downloading") {
      return this.status;
    }

    this.logger.info("Checking for app updates", {
      currentVersion: this.currentVersion,
      reason,
    });

    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.logger.error("App update check failed", {
        error,
        reason,
      });
      this.setStatus({
        ...this.status,
        status: "error",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return this.status;
  }

  installUpdateAndRestart(): boolean {
    this.initialize();

    if (!this.updater || this.status.status !== "downloaded") {
      return false;
    }

    this.logger.info("Installing downloaded app update", {
      version: this.status.availableVersion,
    });
    this.updater.quitAndInstall(false, true);
    return true;
  }

  private bindUpdaterEvents(updater: UpdaterLike): void {
    updater.on("checking-for-update", () => {
      this.setStatus({
        ...this.status,
        status: "checking",
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        message: "Checking for updates…",
      });
    });

    updater.on("update-available", (info) => {
      const updateInfo = info as UpdateInfo;
      this.logger.info("App update available", {
        currentVersion: this.currentVersion,
        version: updateInfo.version,
      });
      this.setStatus({
        ...this.status,
        status: "available",
        availableVersion: updateInfo.version ?? null,
        releaseName: updateInfo.releaseName ?? null,
        releaseDate: updateInfo.releaseDate ?? null,
        releaseNotes: normalizeReleaseNotes(updateInfo.releaseNotes),
        checkedAt: new Date().toISOString(),
        message: "Update found. Downloading in the background…",
      });
    });

    updater.on("update-not-available", (info) => {
      const updateInfo = info as UpdateInfo;
      this.logger.info("App is already up to date", {
        currentVersion: this.currentVersion,
        version: updateInfo.version ?? this.currentVersion,
      });
      this.setStatus({
        ...this.status,
        status: "upToDate",
        availableVersion: null,
        releaseName: updateInfo.releaseName ?? null,
        releaseDate: updateInfo.releaseDate ?? null,
        releaseNotes: normalizeReleaseNotes(updateInfo.releaseNotes),
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        checkedAt: new Date().toISOString(),
        message: "You’re up to date.",
      });
    });

    updater.on("download-progress", (progress) => {
      const progressInfo = progress as ProgressInfo;
      this.setStatus({
        ...this.status,
        status: "downloading",
        progressPercent: roundProgressPercent(progressInfo.percent),
        transferredBytes: progressInfo.transferred,
        totalBytes: progressInfo.total,
        message: "Downloading update…",
      });
    });

    updater.on("update-downloaded", (info) => {
      const downloadedInfo = info as UpdateDownloadedEvent;
      this.logger.info("App update downloaded", {
        currentVersion: this.currentVersion,
        version: downloadedInfo.version,
      });
      this.setStatus({
        ...this.status,
        status: "downloaded",
        availableVersion: downloadedInfo.version ?? this.status.availableVersion,
        releaseName: downloadedInfo.releaseName ?? null,
        releaseDate: downloadedInfo.releaseDate ?? null,
        releaseNotes: normalizeReleaseNotes(downloadedInfo.releaseNotes),
        progressPercent: 100,
        transferredBytes: downloadedInfo.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
        totalBytes: downloadedInfo.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
        checkedAt: new Date().toISOString(),
        message: "Update ready. Restart Nodex to install it.",
      });
    });

    updater.on("error", (error) => {
      const resolvedError = error as Error;
      this.logger.error("App updater emitted an error", { error: resolvedError });
      this.setStatus({
        ...this.status,
        status: "error",
        checkedAt: new Date().toISOString(),
        message: resolvedError.message,
      });
    });
  }

  private buildInitialStatus(): AppUpdateStatus {
    const supported = this.isSupportedRuntime();

    return {
      status: supported ? "idle" : "unsupported",
      supported,
      currentVersion: this.currentVersion,
      availableVersion: null,
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      checkedAt: null,
      message: supported ? null : "App updates are only available in packaged macOS builds.",
    };
  }

  private isSupportedRuntime(): boolean {
    return this.isPackaged && this.platform === "darwin";
  }

  private setStatus(nextStatus: AppUpdateStatus): void {
    this.status = nextStatus;
    for (const listener of this.listeners) {
      listener(this.status);
    }
  }
}
