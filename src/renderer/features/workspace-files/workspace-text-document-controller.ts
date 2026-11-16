import { getIntl } from "@/lib/i18n";
import type { WorkspaceFileWriteResult } from "@/lib/types";
import type { WorkspaceFilesDraftState } from "./workspace-file-types";

export const WORKSPACE_EDIT_STABILIZATION_MS = 550;
export const WORKSPACE_AUTOSAVE_DELAY_MS = 3_000;

export type WorkspaceTextDocumentStatus = "clean" | "dirty" | "saving" | "conflict" | "error";

export interface WorkspaceTextDocumentSnapshot {
  readonly path: string;
  readonly content: string;
  readonly baseMtimeMs: number | null;
  readonly diskContent: string | null;
  readonly diskMtimeMs: number | null;
  readonly documentVersion: number;
  readonly status: WorkspaceTextDocumentStatus;
  readonly message: string | null;
}

interface WorkspaceTextDiskVersion {
  readonly content: string;
  readonly mtimeMs: number | null;
}

interface WorkspaceTextDocumentControllerDependencies {
  readonly write: (
    path: string,
    content: string,
    expectedMtimeMs: number | null,
  ) => Promise<WorkspaceFileWriteResult>;
  readonly readDisk: (path: string) => Promise<WorkspaceTextDiskVersion>;
  readonly persistDraft: (draft: WorkspaceFilesDraftState) => void;
  readonly clearDraft: () => void;
  readonly now?: () => Date;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface LoadWorkspaceTextDocumentInput extends WorkspaceTextDiskVersion {
  readonly path: string;
  readonly draft?: WorkspaceFilesDraftState;
}

type WorkspaceTextDocumentListener = () => void;

export class WorkspaceTextDocumentController {
  readonly #dependencies: WorkspaceTextDocumentControllerDependencies;
  readonly #listeners = new Set<WorkspaceTextDocumentListener>();
  #snapshot: WorkspaceTextDocumentSnapshot;
  #draftTimer: ReturnType<typeof setTimeout> | null = null;
  #autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  #savePromise: Promise<boolean> | null = null;
  #disposed = false;

  constructor(
    input: LoadWorkspaceTextDocumentInput,
    dependencies: WorkspaceTextDocumentControllerDependencies,
  ) {
    this.#dependencies = dependencies;
    const draft = input.draft?.path === input.path ? input.draft : undefined;
    const hasRecoverableDraft = draft !== undefined && draft.content !== input.content;
    const draftConflictsWithDisk = hasRecoverableDraft && draft.baseMtimeMs !== input.mtimeMs;
    this.#snapshot = {
      path: input.path,
      content: hasRecoverableDraft ? draft.content : input.content,
      baseMtimeMs: draft?.baseMtimeMs ?? input.mtimeMs,
      diskContent: draftConflictsWithDisk ? input.content : null,
      diskMtimeMs: draftConflictsWithDisk ? input.mtimeMs : null,
      documentVersion: 0,
      status: draftConflictsWithDisk ? "conflict" : hasRecoverableDraft ? "dirty" : "clean",
      message: null,
    };
    if (hasRecoverableDraft && !draftConflictsWithDisk) {
      this.#scheduleAutosave();
    }
  }

  getSnapshot = (): WorkspaceTextDocumentSnapshot => this.#snapshot;

  subscribe = (listener: WorkspaceTextDocumentListener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  edit(content: string): void {
    if (this.#disposed || this.#snapshot.status === "conflict") return;
    if (content === this.#snapshot.content) return;
    this.#setSnapshot({
      ...this.#snapshot,
      content,
      status: "dirty",
      message: null,
    });
    this.#scheduleDraftPersistence();
    this.#scheduleAutosave();
  }

  async flush(): Promise<boolean> {
    this.#clearScheduledAutosave();
    this.#clearScheduledDraftPersistence();
    while (this.#snapshot.status !== "clean") {
      if (this.#snapshot.status === "conflict") return false;
      const saved = this.#savePromise ? await this.#savePromise : await this.#save();
      if (!saved) return false;
      this.#clearScheduledAutosave();
      this.#clearScheduledDraftPersistence();
    }
    return true;
  }

  async notifyExternalChange(): Promise<void> {
    if (this.#disposed) return;
    if (this.#savePromise) await this.#savePromise;
    if (this.#disposed) return;
    const disk = await this.#dependencies.readDisk(this.#snapshot.path);
    if (this.#disposed || disk.mtimeMs === this.#snapshot.baseMtimeMs) return;
    if (this.#snapshot.status === "clean") {
      this.#clearScheduledDraftPersistence();
      this.#dependencies.clearDraft();
      this.#setSnapshot({
        ...this.#snapshot,
        content: disk.content,
        baseMtimeMs: disk.mtimeMs,
        diskContent: null,
        diskMtimeMs: null,
        documentVersion: this.#snapshot.documentVersion + 1,
        message: null,
      });
      return;
    }
    this.#clearScheduledDraftPersistence();
    this.#clearScheduledAutosave();
    this.#setSnapshot({
      ...this.#snapshot,
      diskContent: disk.content,
      diskMtimeMs: disk.mtimeMs,
      status: "conflict",
      message: null,
    });
    this.#persistDraft();
  }

  useDiskVersion(): void {
    if (this.#snapshot.status !== "conflict" || this.#snapshot.diskContent === null) {
      return;
    }
    this.#clearScheduledDraftPersistence();
    this.#clearScheduledAutosave();
    this.#dependencies.clearDraft();
    this.#setSnapshot({
      ...this.#snapshot,
      content: this.#snapshot.diskContent,
      baseMtimeMs: this.#snapshot.diskMtimeMs,
      diskContent: null,
      diskMtimeMs: null,
      documentVersion: this.#snapshot.documentVersion + 1,
      status: "clean",
      message: null,
    });
  }

  keepLocalChanges(): void {
    if (this.#snapshot.status !== "conflict") return;
    this.#setSnapshot({
      ...this.#snapshot,
      baseMtimeMs: this.#snapshot.diskMtimeMs,
      diskContent: null,
      diskMtimeMs: null,
      documentVersion: this.#snapshot.documentVersion + 1,
      status: "dirty",
      message: null,
    });
    this.#persistDraft();
    void this.flush();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearScheduledDraftPersistence();
    this.#clearScheduledAutosave();
    this.#listeners.clear();
  }

  #setSnapshot(snapshot: WorkspaceTextDocumentSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #scheduleDraftPersistence(): void {
    this.#clearScheduledDraftPersistence();
    const setTimer = this.#dependencies.setTimer ?? setTimeout;
    this.#draftTimer = setTimer(() => {
      this.#draftTimer = null;
      this.#persistDraft();
    }, WORKSPACE_EDIT_STABILIZATION_MS);
  }

  #persistDraft(): void {
    this.#dependencies.persistDraft({
      path: this.#snapshot.path,
      content: this.#snapshot.content,
      baseMtimeMs: this.#snapshot.baseMtimeMs,
      updatedAt: (this.#dependencies.now ?? (() => new Date()))().toISOString(),
    });
  }

  #scheduleAutosave(): void {
    this.#clearScheduledAutosave();
    const setTimer = this.#dependencies.setTimer ?? setTimeout;
    this.#autosaveTimer = setTimer(() => {
      this.#autosaveTimer = null;
      void this.#save();
    }, WORKSPACE_AUTOSAVE_DELAY_MS);
  }

  #clearScheduledDraftPersistence(): void {
    if (this.#draftTimer === null) return;
    (this.#dependencies.clearTimer ?? clearTimeout)(this.#draftTimer);
    this.#draftTimer = null;
  }

  #clearScheduledAutosave(): void {
    if (this.#autosaveTimer === null) return;
    (this.#dependencies.clearTimer ?? clearTimeout)(this.#autosaveTimer);
    this.#autosaveTimer = null;
  }

  #save(): Promise<boolean> {
    if (this.#savePromise) return this.#savePromise;
    if (this.#snapshot.status === "conflict") return Promise.resolve(false);
    const savedContent = this.#snapshot.content;
    const expectedMtimeMs = this.#snapshot.baseMtimeMs;
    this.#setSnapshot({
      ...this.#snapshot,
      status: "saving",
      message: null,
    });
    this.#savePromise = this.#dependencies
      .write(this.#snapshot.path, savedContent, expectedMtimeMs)
      .then(async (result) => {
        if (result.outcome === "conflict") {
          const disk = await this.#dependencies.readDisk(this.#snapshot.path);
          this.#setSnapshot({
            ...this.#snapshot,
            diskContent: disk.content,
            diskMtimeMs: disk.mtimeMs,
            status: "conflict",
            message: null,
          });
          this.#persistDraft();
          return false;
        }

        const changedDuringSave = this.#snapshot.content !== savedContent;
        this.#setSnapshot({
          ...this.#snapshot,
          baseMtimeMs: result.mtimeMs,
          status: changedDuringSave ? "dirty" : "clean",
          message: null,
        });
        if (changedDuringSave) {
          this.#persistDraft();
          this.#scheduleAutosave();
        } else {
          this.#clearScheduledDraftPersistence();
          this.#dependencies.clearDraft();
        }
        return true;
      })
      .catch((error: unknown) => {
        this.#setSnapshot({
          ...this.#snapshot,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : getIntl().formatMessage({
                  id: "workspaceFiles.workspaceTextDocumentController.saveFailed",
                  defaultMessage: "Unable to save file.",
                }),
        });
        this.#persistDraft();
        return false;
      })
      .finally(() => {
        this.#savePromise = null;
      });
    return this.#savePromise;
  }
}

class WorkspaceTextDocumentRegistry {
  readonly #controllers = new Map<string, WorkspaceTextDocumentController>();

  register(key: string, controller: WorkspaceTextDocumentController): () => void {
    this.#controllers.set(key, controller);
    return () => {
      if (this.#controllers.get(key) === controller) {
        this.#controllers.delete(key);
      }
    };
  }

  async flush(key: string): Promise<boolean> {
    const controller = this.#controllers.get(key);
    return controller ? await controller.flush() : true;
  }

  async flushAll(): Promise<boolean> {
    const outcomes = await Promise.all(
      [...this.#controllers.values()].map(async (controller) => await controller.flush()),
    );
    return outcomes.every(Boolean);
  }
}

export const workspaceTextDocumentRegistry = new WorkspaceTextDocumentRegistry();
