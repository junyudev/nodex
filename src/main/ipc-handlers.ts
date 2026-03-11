import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { inspectClipboardPasteItems } from "./clipboard-paste-inspector";
import * as dbService from "./kanban/db-service";
import * as backupService from "./kanban/backup-service";
import * as canvasService from "./kanban/canvas-service";
import * as ptyManager from "./pty-manager";
import {
  getBackupSettings,
  getThreadNotificationSettings,
  updateBackupSettings,
  updateThreadNotificationSettings,
} from "./kanban/config";
import { resolveAssetPath } from "./kanban/asset-service";
import { parseAssetSource } from "../shared/assets";
import { codexService } from "./codex/codex-service";
import { openFileLinkTarget } from "./file-link-opener";
import type { WorkbenchResumeSnapshot } from "../shared/workbench-resume";
import {
  checkoutGitBranch,
  createAndCheckoutGitBranch,
  readGitBranchState,
  watchGitBranch,
} from "./git-branch-service";

function registerHandle(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  // Make registration idempotent so hot-reloads cannot leave partial channel maps.
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}

interface RegisterIpcHandlersOptions {
  onCreateWindow?: () => void;
  onConsumeWorkbenchResume?: (webContentsId: number) => WorkbenchResumeSnapshot | null;
  onSaveWorkbenchResume?: (webContentsId: number, snapshot: WorkbenchResumeSnapshot) => boolean;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions = {}): void {
  const gitBranchWatches = new Map<number, { cwd: string; dispose: () => void }>();
  const gitBranchWatchCleanupBound = new Set<number>();

  const stopGitBranchWatch = (webContentsId: number) => {
    const activeWatch = gitBranchWatches.get(webContentsId);
    if (!activeWatch) return;
    activeWatch.dispose();
    gitBranchWatches.delete(webContentsId);
  };

  codexService.on("event", (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send("codex:event", event);
    }
  });

  // Projects
  registerHandle("projects:list", () => dbService.listProjects());

  registerHandle("projects:get", (_, projectId: string) =>
    dbService.getProject(projectId)
  );

  registerHandle("projects:create", (_, input) =>
    dbService.createProject(input)
  );

  registerHandle("projects:rename", (_, oldId: string, newId: string, updates?) =>
    dbService.renameProject(oldId, newId, updates)
  );

  registerHandle("projects:delete", (_, projectId: string) =>
    dbService.deleteProject(projectId)
  );

  // Board
  registerHandle("board:get", (_, projectId: string) =>
    dbService.getBoard(projectId)
  );

  // Cards
  registerHandle("card:create", (_, projectId, columnId, input, sessionId?, placement?) =>
    dbService.createCard(projectId, columnId, input, sessionId, placement)
  );

  registerHandle("card:update", async (_, projectId, columnId, cardId, updates, sessionId?, expectedRevision?) => {
    return dbService.updateCard(
      projectId,
      columnId || undefined,
      cardId,
      updates,
      sessionId,
      expectedRevision,
    );
  });

  registerHandle("card:get", (_, projectId: string, cardId: string, columnId?: string) =>
    dbService.getCard(projectId, cardId, columnId)
  );

  registerHandle("card:delete", (_, projectId, columnId, cardId, sessionId?) =>
    dbService.deleteCard(projectId, columnId || undefined, cardId, sessionId)
  );

  registerHandle("card:move", async (_, input) => {
    const result = await dbService.moveCard(input);
    return result === "moved";
  });

  registerHandle("card:move-many", async (_, input) => {
    const result = await dbService.moveCards(input);
    return result === "moved";
  });

  registerHandle("card:move-to-project", async (_, input) => {
    const result = await dbService.moveCardToProject(input);
    if (result === "wrong_column") throw new Error("Card is no longer in the expected column");
    if (result === "not_found") throw new Error("Card not found");
    if (result === "target_project_not_found") throw new Error("Target project not found");
    return result;
  });

  registerHandle("card:import-block-drop", (_, projectId: string, input, sessionId?: string) =>
    dbService.importBlockDropAsCards(projectId, input, sessionId)
  );

  registerHandle("card:move-drop-to-editor", (_, projectId: string, input, sessionId?: string) =>
    dbService.moveCardDropToEditor(projectId, input, sessionId)
  );

  registerHandle("calendar:occurrences", (_, projectId: string, windowStart: Date, windowEnd: Date, searchQuery?: string) =>
    dbService.listCalendarOccurrences(projectId, windowStart, windowEnd, searchQuery).then((occurrences) => ({ occurrences }))
  );

  registerHandle("card:occurrence:complete", (_, projectId: string, input, sessionId?: string) =>
    dbService.completeCardOccurrence(projectId, input, sessionId)
  );

  registerHandle("card:occurrence:skip", (_, projectId: string, input, sessionId?: string) =>
    dbService.skipCardOccurrence(projectId, input, sessionId)
  );

  registerHandle("card:occurrence:update", (_, projectId: string, input, sessionId?: string) =>
    dbService.updateCardOccurrence(projectId, input, sessionId)
  );

  // History
  registerHandle("history:recent", (_, projectId: string, sessionId?: string) => {
    const entries = dbService.getRecentHistory(projectId);
    const state = dbService.getUndoRedoState(projectId, sessionId);
    return { ...state, entries };
  });

  registerHandle("history:card", (_, projectId: string, cardId: string) => {
    const entries = dbService.getCardHistoryPanelEntries(projectId, cardId);
    return { entries };
  });

  registerHandle("history:undo", (_, projectId: string, sessionId?: string) =>
    dbService.undoLatest(projectId, sessionId)
  );

  registerHandle("history:redo", (_, projectId: string, sessionId?: string) =>
    dbService.redoLatest(projectId, sessionId)
  );

  registerHandle("history:revert", (_, projectId: string, historyId: number, sessionId?: string) =>
    dbService.revertEntry(projectId, historyId, sessionId)
  );

  registerHandle("history:restore", (_, projectId: string, cardId: string, historyId: number, sessionId?: string) =>
    dbService.restoreToEntry(projectId, cardId, historyId, sessionId)
  );

  // Database introspection
  registerHandle("db:schema", (_event, projectId: string) => {
    void projectId;
    return dbService.getSchema();
  });

  registerHandle("db:query", (_, projectId: string, sql: string, params?: unknown[]) => {
    void projectId;
    return dbService.executeReadOnlyQuery(sql, params as (string | number | null)[] | undefined);
  });

  // Backups
  registerHandle("backup:list", () => backupService.listBackups());

  registerHandle("backup:create", (_, input) =>
    backupService.createBackup({ trigger: "manual", label: input?.label })
  );

  registerHandle("backup:restore", (_, input) =>
    backupService.restoreBackup(input)
  );

  registerHandle("settings:backup:get", () => getBackupSettings());

  registerHandle("settings:backup:update", (_, input) => {
    const settings = updateBackupSettings(input);
    backupService.configureAutoBackupScheduler({
      enabled: settings.autoEnabled,
      intervalHours: settings.intervalHours,
      retentionCount: settings.retentionCount,
    });
    return settings;
  });

  registerHandle("settings:thread-notifications:get", () => getThreadNotificationSettings());

  registerHandle("settings:thread-notifications:update", (_, input) =>
    updateThreadNotificationSettings(input)
  );

  registerHandle("shell:open-file-link", (_, target, openerId) =>
    openFileLinkTarget(target, openerId)
  );

  // Canvas
  registerHandle("canvas:get", (_, projectId: string) =>
    canvasService.getCanvas(projectId)
  );

  registerHandle("canvas:save", (_, projectId: string, data) =>
    canvasService.saveCanvas(projectId, data)
  );

  registerHandle("window:show-emoji-panel", () => {
    if (process.platform !== "darwin") return false;
    app.showEmojiPanel();
    return true;
  });

  registerHandle("window:new", () => {
    if (!options.onCreateWindow) return false;
    options.onCreateWindow();
    return true;
  });

  registerHandle("workbench:resume:consume", (event) => {
    if (!options.onConsumeWorkbenchResume) return null;
    return options.onConsumeWorkbenchResume(event.sender.id);
  });

  registerHandle("workbench:resume:save", (event, snapshot: WorkbenchResumeSnapshot) => {
    if (!options.onSaveWorkbenchResume) return false;
    return options.onSaveWorkbenchResume(event.sender.id, snapshot);
  });

  registerHandle("git:branch:state", (_, cwd: string) => {
    return readGitBranchState(cwd);
  });

  registerHandle("git:branch:checkout", (_, input: { cwd: string; branch: string }) => {
    return checkoutGitBranch(input);
  });

  registerHandle("git:branch:create", (_, input: { cwd: string; branch: string }) => {
    return createAndCheckoutGitBranch(input);
  });

  registerHandle("git:branch:watch:start", async (event, cwd: string) => {
    const sender = event.sender;
    const webContentsId = sender.id;
    const normalizedCwd = typeof cwd === "string" ? cwd.trim() : "";

    if (!normalizedCwd) {
      stopGitBranchWatch(webContentsId);
      return;
    }

    const existingWatch = gitBranchWatches.get(webContentsId);
    if (existingWatch?.cwd === normalizedCwd) {
      return;
    }

    stopGitBranchWatch(webContentsId);

    if (!gitBranchWatchCleanupBound.has(webContentsId)) {
      gitBranchWatchCleanupBound.add(webContentsId);
      sender.once("destroyed", () => {
        stopGitBranchWatch(webContentsId);
        gitBranchWatchCleanupBound.delete(webContentsId);
      });
    }

    const dispose = await watchGitBranch(normalizedCwd, () => {
      if (sender.isDestroyed()) {
        stopGitBranchWatch(webContentsId);
        return;
      }
      sender.send("git:branch:changed", { cwd: normalizedCwd });
    });

    if (sender.isDestroyed()) {
      dispose();
      stopGitBranchWatch(webContentsId);
      return;
    }

    gitBranchWatches.set(webContentsId, {
      cwd: normalizedCwd,
      dispose,
    });
  });

  registerHandle("git:branch:watch:stop", (event) => {
    stopGitBranchWatch(event.sender.id);
  });

  // Assets
  registerHandle("asset:resolve-path", (_, source: string) => {
    if (typeof source !== "string") return null;

    const parsed = parseAssetSource(source);
    if (!parsed) return null;

    try {
      return resolveAssetPath(parsed.fileName);
    } catch {
      return null;
    }
  });

  registerHandle("clipboard:inspect-paste", () =>
    inspectClipboardPasteItems()
  );

  // Terminal
  registerHandle(
    "pty:spawn",
    (event, sessionId: string, opts: { cols: number; rows: number; cwd?: string }) => {
      const sender = event.sender;
      return ptyManager.spawn(
        sessionId,
        opts,
        (data) => { if (!sender.isDestroyed()) sender.send("pty:data", { sessionId, data }); },
        (exitCode) => { if (!sender.isDestroyed()) sender.send("pty:exit", { sessionId, exitCode }); },
      );
    },
  );

  registerHandle("pty:write", (_, sessionId: string, data: string) => {
    ptyManager.write(sessionId, data);
  });

  registerHandle("pty:resize", (_, sessionId: string, cols: number, rows: number) => {
    ptyManager.resize(sessionId, cols, rows);
  });

  registerHandle("pty:kill", (_, sessionId: string) => {
    ptyManager.kill(sessionId);
  });

  registerHandle("pty:pick-cwd", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Codex
  registerHandle("codex:connection:status", () => codexService.getConnectionState());

  registerHandle("codex:account:read", () => codexService.readAccountSnapshot());

  registerHandle("codex:account:login:start", (_, input) => codexService.startAccountLogin(input));

  registerHandle("codex:account:login:cancel", (_, loginId: string) =>
    codexService.cancelAccountLogin(loginId)
  );

  registerHandle("codex:account:logout", () => codexService.logoutAccount());

  registerHandle("codex:threads:list", (_, projectId: string, opts?: { cardId?: string; includeArchived?: boolean }) =>
    codexService.listProjectThreads(projectId, opts)
  );

  registerHandle("codex:model:list", () =>
    codexService.listModels()
  );

  registerHandle("codex:collaboration-mode:list", () =>
    codexService.listCollaborationModes()
  );

  registerHandle(
    "codex:thread:start-for-card",
    (
      _,
      input: {
        projectId: string;
        cardId: string;
        prompt: string;
        threadName?: string;
        model?: string;
        permissionMode?: "sandbox" | "full-access" | "custom";
        reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
        collaborationMode?: "default" | "plan";
        worktreeStartMode?: "autoBranch" | "detachedHead";
        worktreeBranchPrefix?: string;
      },
    ) =>
      codexService.startThreadForCard(input),
  );

  registerHandle("worktrees:list", () =>
    codexService.listManagedWorktrees()
  );

  registerHandle("worktrees:environments:list", (_, projectId: string) =>
    codexService.listWorktreeEnvironments(projectId)
  );

  registerHandle("worktrees:delete", (_, threadId: string) =>
    codexService.deleteManagedWorktree(threadId)
  );

  registerHandle("codex:thread:read", (_, threadId: string, includeTurns?: boolean) =>
    codexService.readThread(threadId, includeTurns ?? true)
  );

  registerHandle("codex:thread:resume", (_, threadId: string) =>
    codexService.resumeThread(threadId)
  );

  registerHandle("codex:thread:name:set", (_, threadId: string, name: string) =>
    codexService.setThreadName(threadId, name)
  );

  registerHandle("codex:thread:archive", (_, threadId: string) =>
    codexService.archiveThread(threadId)
  );

  registerHandle("codex:thread:unarchive", (_, threadId: string) =>
    codexService.unarchiveThread(threadId)
  );

  registerHandle(
    "codex:turn:start",
    (
      _,
      threadId: string,
      prompt: string,
      opts?: {
        model?: string;
        reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
        permissionMode?: "sandbox" | "full-access" | "custom";
        collaborationMode?: "default" | "plan";
      },
    ) =>
      codexService.startTurn(threadId, prompt, opts),
  );

  registerHandle(
    "codex:turn:steer",
    (_,
      threadId: string,
      expectedTurnId: string,
      prompt: string,
      optimisticItemId?: string,
    ) =>
      codexService.steerTurn(threadId, expectedTurnId, prompt, optimisticItemId),
  );

  registerHandle("codex:turn:interrupt", (_, threadId: string, turnId?: string) =>
    codexService.interruptTurn(threadId, turnId)
  );

  registerHandle("codex:approval:respond", (_, requestId: string, decision) =>
    codexService.respondToApproval(requestId, decision)
  );

  registerHandle("codex:user-input:respond", (_, requestId: string, answers) =>
    codexService.respondToUserInput(requestId, answers)
  );

  registerHandle("codex:permission:mode:set", (_, projectId: string, mode: "sandbox" | "full-access" | "custom") => {
    codexService.setProjectPermissionMode(projectId, mode);
  });

  registerHandle("codex:permission:mode:get", (_, projectId: string) => {
    return codexService.getProjectPermissionMode(projectId);
  });

  registerHandle("codex:permission:custom-description:get", (_, projectId: string) => {
    return codexService.getCustomPermissionModeDescription(projectId);
  });
}
