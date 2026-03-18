import {
  Menu,
  Notification,
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  powerMonitor,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { join, resolve } from "path";
import type {
  AppInitializationStep,
  DatabaseMigrationProgress,
} from "../shared/app-startup";
import type { AppUpdateStatus, CodexTurnSummary } from "../shared/types";
import { registerIpcHandlers } from "./ipc-handlers";
import { startHttpServer } from "./http-server";
import { findCardLocationById, initializeDatabase } from "./kanban/db-service";
import { dbNotifier } from "./kanban/db-notifier";
import {
  configureAutoBackupScheduler,
  stopAutoBackupScheduler,
} from "./kanban/backup-service";
import { getAssetsPathPrefix } from "./kanban/asset-service";
import { runReminderTick, snoozeReminder, startReminderScheduler } from "./kanban/reminder-service";
import * as ptyManager from "./pty-manager";
import {
  getAppUpdateSettings,
  getBackupSettings,
  getKanbanDir,
  getThreadNotificationSettings,
  getPort,
} from "./kanban/config";
import { codexService } from "./codex/codex-service";
import { getCodexCardThreadLink } from "./codex/codex-link-repository";
import { resolveThreadCompletionNotificationContent } from "./codex/thread-completion-notification";
import { configureInstanceScopePaths } from "./instance-scope";
import { parseCardDeepLink } from "../shared/card-deeplink";
import { WorkbenchResumeState } from "./workbench-resume-state";
import { getLogger, shutdownBackendLogger } from "./logging/logger";
import { AppUpdateService } from "./app-update-service";
// macOS uses the packaged bundle icon from the app resources.
// We only keep a PNG around for development Dock icon parity and non-macOS window icons.
const appIconPath = app.isPackaged
  ? join(process.resourcesPath, "icon.png")
  : join(__dirname, "../../resources/icon.png");
const appDockIcon = nativeImage.createFromPath(appIconPath);

const openWindows = new Map<number, BrowserWindow>();
let lastFocusedWindowId: number | null = null;
let serverUrlForWindows: string | null = null;
let stopReminderScheduler: (() => void) | null = null;
let databaseReady = false;
let pendingCardDeepLinkCardId: string | null = null;
let pendingCardDeepLinkTarget: { projectId: string; cardId: string } | null = null;
const pendingCloseResolvers = new Map<number, () => void>();
const allowImmediateWindowClose = new Set<number>();
const WINDOW_CLOSE_FLUSH_TIMEOUT_MS = 1500;
let workbenchResumeState: WorkbenchResumeState | null = null;
let appInitializationStep: AppInitializationStep = { phase: "app_waiting" };
let latestDatabaseMigrationProgress: DatabaseMigrationProgress | null = null;
let appInitializationPromise: Promise<void> = Promise.resolve();
let appUpdateService: AppUpdateService | null = null;
const logger = getLogger({ subsystem: "app" });

function resolveUnsupportedAppUpdateStatus(): AppUpdateStatus {
  return {
    status: "unsupported",
    supported: false,
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    checkedAt: null,
    message: "App updates are only available in packaged macOS builds.",
  };
}

function getLastFocusedWindow(): BrowserWindow | null {
  if (lastFocusedWindowId !== null) {
    const remembered = openWindows.get(lastFocusedWindowId);
    if (remembered && !remembered.isDestroyed()) return remembered;
  }

  for (const window of openWindows.values()) {
    if (window.isDestroyed()) continue;
    return window;
  }

  return null;
}

function focusLastWindow(): void {
  const existingWindow = getLastFocusedWindow();
  if (existingWindow) {
    if (existingWindow.isMinimized()) existingWindow.restore();
    existingWindow.show();
    existingWindow.focus();
    return;
  }

  if (!serverUrlForWindows) return;
  const createdWindow = createWindow(serverUrlForWindows, { restoreEligible: true });
  createdWindow.show();
  createdWindow.focus();
}

function openNewWindow(): BrowserWindow | null {
  if (!serverUrlForWindows) return null;
  const window = createWindow(serverUrlForWindows, { restoreEligible: false });
  window.show();
  window.focus();
  return window;
}

function configureMacWindowMenus(): void {
  if (process.platform !== "darwin") return;

  const dockMenuTemplate: MenuItemConstructorOptions[] = [
    {
      label: "New Window",
      accelerator: "Command+N",
      click: () => {
        openNewWindow();
      },
    },
  ];
  app.dock?.setMenu(Menu.buildFromTemplate(dockMenuTemplate));

  const appMenuTemplate: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        {
          label: "Check for Updates…",
          click: () => {
            void appUpdateService?.checkForUpdates("manual");
          },
        },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "Command+N",
          click: () => {
            openNewWindow();
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate));
}

function broadcastToWindows(channel: string, payload: unknown): void {
  for (const window of openWindows.values()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

function setAppInitializationStep(step: AppInitializationStep): void {
  appInitializationStep = step;
  broadcastToWindows("app:init-step", step);
}

function broadcastAppUpdateStatus(status: AppUpdateStatus): void {
  broadcastToWindows("app:update-status", status);
}

function maybeStartAutomaticAppUpdateChecks(): void {
  if (!appUpdateService) {
    return;
  }

  if (appInitializationStep.phase !== "done" || openWindows.size === 0) {
    return;
  }

  appUpdateService.maybeStartAutomaticChecks(getAppUpdateSettings());
}

function publishDatabaseMigrationProgress(progress: DatabaseMigrationProgress): void {
  latestDatabaseMigrationProgress = progress;
  broadcastToWindows("db:migration-progress", progress);
}

function registerInitializationIpcHandlers(): void {
  ipcMain.removeHandler("app:await-initialization");
  ipcMain.handle("app:await-initialization", (event) => {
    event.sender.send("app:init-step", appInitializationStep);
    if (latestDatabaseMigrationProgress) {
      event.sender.send("db:migration-progress", latestDatabaseMigrationProgress);
    }
    return appInitializationPromise;
  });
}

function sendReminderOpenEvent(payload: {
  projectId: string;
  cardId: string;
  occurrenceStart: string;
}): void {
  const targetWindow = getLastFocusedWindow();
  if (!targetWindow || targetWindow.isDestroyed()) return;
  targetWindow.webContents.send("reminder:open", payload);
}

function flushPendingCardDeepLink(): void {
  if (!pendingCardDeepLinkTarget) {
    return;
  }

  const targetWindow = getLastFocusedWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (targetWindow.webContents.isLoadingMainFrame()) {
    return;
  }

  targetWindow.webContents.send("deeplink:open-card", pendingCardDeepLinkTarget);
  pendingCardDeepLinkTarget = null;
}

function resolvePendingCardDeepLink(): void {
  if (!databaseReady) {
    return;
  }

  if (!pendingCardDeepLinkCardId) {
    flushPendingCardDeepLink();
    return;
  }

  const cardId = pendingCardDeepLinkCardId;
  const location = findCardLocationById(cardId);
  pendingCardDeepLinkCardId = null;
  if (!location) {
    return;
  }

  pendingCardDeepLinkTarget = {
    projectId: location.projectId,
    cardId,
  };

  flushPendingCardDeepLink();
}

function queueCardDeepLink(cardId: string): void {
  pendingCardDeepLinkCardId = cardId;

  if (!databaseReady) {
    return;
  }

  focusLastWindow();
  resolvePendingCardDeepLink();
}

function handleIncomingDeepLink(value: string): boolean {
  const target = parseCardDeepLink(value);
  if (!target) {
    return false;
  }

  queueCardDeepLink(target.cardId);
  return true;
}

function extractDeepLinkFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    const target = parseCardDeepLink(arg);
    if (!target) {
      continue;
    }

    queueCardDeepLink(target.cardId);
    return arg;
  }

  return null;
}

function registerDeepLinkProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("nodex", process.execPath, [resolve(process.argv[1])]);
    return;
  }

  app.setAsDefaultProtocolClient("nodex");
}

function showThreadCompletionNotification(turn: CodexTurnSummary): void {
  if (!Notification.isSupported()) return;
  if (!getThreadNotificationSettings().threadCompletionEnabled) return;

  const content = resolveThreadCompletionNotificationContent({
    thread: getCodexCardThreadLink(turn.threadId),
    detail: codexService.serializeThreadDetail(turn.threadId),
    turn,
  });
  if (!content) return;

  const notification = new Notification(content);
  notification.on("click", () => {
    focusLastWindow();
  });
  notification.show();
}

function createWindow(
  serverUrl: string,
  options: { restoreEligible: boolean },
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    ...(process.platform === "darwin" ? {} : { icon: appIconPath }),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === "darwin"
      ? {
          vibrancy: "menu" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      additionalArguments: [
        `--nodex-server-url=${serverUrl}`,
        `--nodex-asset-path-prefix=${encodeURIComponent(getAssetsPathPrefix())}`,
      ],
    },
  });

  // Open external links in the system browser
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // In dev mode, load the vite dev server URL
  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  const webContentsId = window.webContents.id;
  openWindows.set(webContentsId, window);
  lastFocusedWindowId = webContentsId;
  if (options.restoreEligible) {
    workbenchResumeState?.markWindowEligible(webContentsId);
  }

  const closeHandler = (event: Electron.Event) => {
    if (allowImmediateWindowClose.has(webContentsId)) {
      allowImmediateWindowClose.delete(webContentsId);
      return;
    }

    if (pendingCloseResolvers.has(webContentsId)) {
      event.preventDefault();
      return;
    }

    event.preventDefault();

    const finishClose = () => {
      pendingCloseResolvers.delete(webContentsId);
      allowImmediateWindowClose.add(webContentsId);
      if (window.isDestroyed()) return;
      window.close();
    };

    const timeout = setTimeout(finishClose, WINDOW_CLOSE_FLUSH_TIMEOUT_MS);
    pendingCloseResolvers.set(webContentsId, () => {
      clearTimeout(timeout);
      finishClose();
    });

    try {
      window.webContents.send("app:flush-before-close", webContentsId);
    } catch {
      finishClose();
    }
  };

  window.on("close", closeHandler);
  window.on("focus", () => {
    lastFocusedWindowId = webContentsId;
  });
  window.webContents.on("did-finish-load", () => {
    const appUpdateStatus = appUpdateService?.getStatus();
    if (appUpdateStatus) {
      window.webContents.send("app:update-status", appUpdateStatus);
    }
    flushPendingCardDeepLink();
    maybeStartAutomaticAppUpdateChecks();
  });
  window.on("closed", () => {
    workbenchResumeState?.clearWindowEligibility(webContentsId);
    pendingCloseResolvers.delete(webContentsId);
    allowImmediateWindowClose.delete(webContentsId);
    openWindows.delete(webContentsId);
    if (lastFocusedWindowId === webContentsId) {
      lastFocusedWindowId = null;
    }
  });

  return window;
}

async function initializeDesktopApp(serverPort: number): Promise<void> {
  await initializeDatabase({
    onMigrationProgress: (progress) => {
      setAppInitializationStep({ phase: "sqlite_waiting" });
      publishDatabaseMigrationProgress(progress);
    },
  });
  databaseReady = true;
  resolvePendingCardDeepLink();

  startHttpServer(serverPort);

  const backupSettings = getBackupSettings();
  configureAutoBackupScheduler({
    enabled: backupSettings.autoEnabled,
    intervalHours: backupSettings.intervalHours,
    retentionCount: backupSettings.retentionCount,
  });

  stopReminderScheduler = startReminderScheduler({
    onReminder: (payload) => {
      if (!Notification.isSupported()) return;

      const notification = new Notification({
        title: payload.title,
        body: payload.body,
        actions: [
          { type: "button", text: "Snooze 10m" },
          { type: "button", text: "Snooze 1h" },
        ],
      });

      notification.on("click", () => {
        focusLastWindow();
        sendReminderOpenEvent({
          projectId: payload.projectId,
          cardId: payload.cardId,
          occurrenceStart: payload.occurrenceStart,
        });
      });

      notification.on("action", (_, index) => {
        const minutes = index === 0 ? 10 : 60;
        void snoozeReminder(
          payload.projectId,
          payload.cardId,
          payload.occurrenceStart,
          minutes,
        );
      });

      notification.show();
    },
  });

  powerMonitor.on("resume", () => {
    void runReminderTick((payload) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: payload.title,
        body: payload.body,
      });
      notification.on("click", () => {
        focusLastWindow();
        sendReminderOpenEvent({
          projectId: payload.projectId,
          cardId: payload.cardId,
          occurrenceStart: payload.occurrenceStart,
        });
      });
      notification.show();
    });
  });

  codexService.on("event", (event) => {
    if (event.type !== "turn") return;
    if (event.turn.status === "inProgress") return;
    showThreadCompletionNotification(event.turn);
  });

  dbNotifier.on("board-changed", (event) => {
    broadcastToWindows("board-changed", event);
  });

  app.on("activate", () => {
    const currentServerUrl = serverUrlForWindows;
    if (!currentServerUrl) return;
    if (openWindows.size === 0) {
      createWindow(currentServerUrl, { restoreEligible: true });
      return;
    }
    focusLastWindow();
  });

  setAppInitializationStep({ phase: "done" });
  maybeStartAutomaticAppUpdateChecks();
}

configureInstanceScopePaths(app, getKanbanDir());

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const handledDeepLink = Boolean(extractDeepLinkFromArgv(argv));
    if (handledDeepLink) {
      return;
    }
    if (openNewWindow()) return;
    focusLastWindow();
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleIncomingDeepLink(url);
});

if (hasSingleInstanceLock) {
  extractDeepLinkFromArgv(process.argv);
  app.whenReady()
    .then(async () => {
      logger.info("Nodex main process starting", {
        packaged: app.isPackaged,
        platform: process.platform,
        pid: process.pid,
        kanbanDir: getKanbanDir(),
      });
      registerDeepLinkProtocol();
      // Packaged macOS builds use the bundle icon; dev still needs an explicit Dock icon override.
      if (process.platform === "darwin" && !app.isPackaged && !appDockIcon.isEmpty()) {
        app.dock?.setIcon(appDockIcon);
      }
      workbenchResumeState = new WorkbenchResumeState(app.getPath("userData"));
      appUpdateService = new AppUpdateService({
        currentVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        logger,
        platform: process.platform,
      });
      appUpdateService.onStatusChange((status) => {
        broadcastAppUpdateStatus(status);
      });
      appUpdateService.initialize();

      const serverPort = getPort();
      const serverUrl = `http://127.0.0.1:${serverPort}`;
      serverUrlForWindows = serverUrl;
      configureMacWindowMenus();
      registerInitializationIpcHandlers();
      registerIpcHandlers({
        onCreateWindow: () => {
          openNewWindow();
        },
        onConsumeWorkbenchResume: (webContentsId) =>
          workbenchResumeState?.consumeSnapshotForWindow(webContentsId) ?? null,
        onSaveWorkbenchResume: (webContentsId, snapshot) =>
          workbenchResumeState?.saveSnapshotForWindow(
            webContentsId,
            lastFocusedWindowId,
            openWindows.size,
            snapshot,
          ) ?? false,
        onGetAppUpdateStatus: () =>
          appUpdateService?.getStatus() ?? resolveUnsupportedAppUpdateStatus(),
        onCheckForAppUpdate: async () =>
          await (appUpdateService?.checkForUpdates("manual")
            ?? Promise.resolve(resolveUnsupportedAppUpdateStatus())),
        onInstallAppUpdate: () => appUpdateService?.installUpdateAndRestart() ?? false,
        onAppUpdateSettingsChanged: () => {
          maybeStartAutomaticAppUpdateChecks();
        },
      });

      ipcMain.removeHandler("app:flush-before-close:done");
      ipcMain.handle("app:flush-before-close:done", (_, webContentsId: number) => {
        const resolve = pendingCloseResolvers.get(webContentsId);
        if (!resolve) return;
        resolve();
      });

      appInitializationPromise = initializeDesktopApp(serverPort);
      createWindow(serverUrl, { restoreEligible: true });
      await appInitializationPromise;
    })
    .catch((error: unknown) => {
      logger.error("Nodex failed to start", { error });
      app.quit();
    });
}

app.on("before-quit", () => {
  logger.info("Nodex before-quit");
  ptyManager.killAll();
  void codexService.shutdown();
  void shutdownBackendLogger();
});

app.on("window-all-closed", () => {
  logger.info("All windows closed");
  stopAutoBackupScheduler();
  if (stopReminderScheduler) {
    stopReminderScheduler();
    stopReminderScheduler = null;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception in main process", { error });
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection in main process", { reason });
});
