import type { SkillDocument, SkillSaveResult } from "../../../shared/skill-inventory";
import {
  parseSkillSource,
  setSkillFrontmatter,
  type SkillFrontmatterPatch,
} from "../../../shared/skill-document";
import {
  createSkillEditorSession,
  type SkillEditorCandidate,
  type SkillEditorSession,
} from "./skill-editor-session";

export type SkillFileMode = "rich" | "source";

export type SkillFileSaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "unsaved" }
  | { readonly kind: "saving" }
  /** The rich editor cannot write this edit without disturbing text it did not touch. */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly message: string };

export interface SkillFileSnapshot {
  /** The file as last read from or written to disk. */
  readonly document: SkillDocument;
  readonly session: SkillEditorSession;
  readonly mode: SkillFileMode;
  /** The Source editor's text. */
  readonly sourceText: string;
  /** Bumps whenever the Source editor must take `sourceText` as a new document. */
  readonly sourceVersion: number;
  readonly save: SkillFileSaveState;
  /** The file changed on disk while this page held unsaved edits. */
  readonly conflict: SkillDocument | null;
}

export interface SkillFileController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SkillFileSnapshot;
  /** Hands the controller what the file watcher last read. */
  readonly observeDisk: (document: SkillDocument) => void;
  readonly setMode: (mode: SkillFileMode) => Promise<void>;
  readonly setSourceText: (text: string) => void;
  readonly patchFrontmatter: (
    patch: SkillFrontmatterPatch,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /** Keeps this page's text over the disk version, or drops it for what is on disk. */
  readonly resolveConflict: (keep: "mine" | "disk") => Promise<void>;
  /** Writes everything pending; resolves true when the page matches the disk. */
  readonly flush: () => Promise<boolean>;
  readonly dispose: () => void;
}

const SOURCE_SAVE_DELAY_MS = 600;

/**
 * One open SKILL.md: the rich editor session, the Source text, and the single queue that writes
 * either back to disk against the revision they were read at. The file on disk stays the truth;
 * a clean page follows it, and a page with edits keeps them and reports the conflict.
 */
export function createSkillFileController(
  initial: SkillDocument,
  write: (input: {
    readonly baseRevision: string;
    readonly markdown: string;
  }) => Promise<SkillSaveResult>,
): SkillFileController {
  const listeners = new Set<() => void>();
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let sourceTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceDirty = false;
  let saving = 0;
  let observed: SkillDocument = initial;
  let unsubscribeSession: () => void = () => undefined;

  let snapshot: SkillFileSnapshot = {
    document: initial,
    session: createSkillEditorSession(initial.markdown),
    mode: parseSkillSource(initial.markdown).rich.editable ? "rich" : "source",
    sourceText: initial.markdown,
    sourceVersion: 0,
    save: { kind: "saved" },
    conflict: null,
  };

  function publish(next: Partial<SkillFileSnapshot>): void {
    if (disposed) return;
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }

  function watchSession(session: SkillEditorSession): void {
    unsubscribeSession();
    unsubscribeSession = session.subscribe(() => {
      if (snapshot.session !== session || snapshot.mode !== "rich") return;
      const { draft } = session.getSnapshot();
      if (draft.kind === "pending") publish({ save: { kind: "unsaved" } });
      else if (draft.kind === "refused")
        publish({ save: { kind: "refused", reason: draft.reason } });
      else if (draft.kind === "candidate") void saveCandidate(draft.candidate);
      else if (saving === 0 && snapshot.save.kind !== "failed")
        publish({ save: { kind: "saved" } });
    });
  }

  function replaceSession(text: string): SkillEditorSession {
    const previous = snapshot.session;
    const session = createSkillEditorSession(text);
    watchSession(session);
    // The mounted editor still holds the old fragment until it renders the new session.
    setTimeout(() => previous.dispose(), 1000);
    return session;
  }

  function hasLocalEdits(): boolean {
    if (snapshot.mode === "source") return sourceDirty;
    return snapshot.session.getSnapshot().draft.kind !== "clean";
  }

  /** Takes a disk version as the page's content. */
  function adopt(document: SkillDocument, forceSession = false): void {
    sourceDirty = false;
    clearTimeout(sourceTimer);
    const reseeded = !forceSession && snapshot.session.reseed(document.markdown);
    const session = reseeded ? snapshot.session : replaceSession(document.markdown);
    publish({
      document,
      session,
      mode: session.getSnapshot().source.rich.editable ? snapshot.mode : "source",
      sourceText: document.markdown,
      sourceVersion: snapshot.sourceVersion + 1,
      save: { kind: "saved" },
      conflict: null,
    });
  }

  function enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }

  /** Writes `markdown` over the revision this page was read at. */
  async function writeText(markdown: string, onSaved: (document: SkillDocument) => void) {
    if (disposed || snapshot.conflict) return false;
    const baseRevision = snapshot.document.revision;
    const observationAtStart = observed;
    saving += 1;
    publish({ save: { kind: "saving" } });
    let result: SkillSaveResult;
    try {
      result = await write({ baseRevision, markdown });
    } catch (error) {
      result = {
        status: "failed",
        code: "io",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      saving -= 1;
    }
    if (disposed) return false;
    if (result.status === "conflict") {
      publish({ conflict: result.document, save: { kind: "unsaved" } });
      return false;
    }
    if (result.status === "failed") {
      publish({ save: { kind: "failed", message: result.message } });
      return false;
    }
    const duringWrite = observed;
    observed = result.value;
    publish({ document: result.value });
    onSaved(result.value);
    if (saving === 0 && !hasLocalEdits()) publish({ save: { kind: "saved" } });
    // A disk change that arrived mid-write was set aside; look at it now.
    if (
      duringWrite !== observationAtStart &&
      duringWrite.revision !== baseRevision &&
      duringWrite.revision !== result.value.revision
    ) {
      queueMicrotask(() => {
        if (observed === result.value) observeDisk(duringWrite);
      });
    }
    return true;
  }

  function saveCandidate(candidate: SkillEditorCandidate): Promise<boolean> {
    return enqueue(async () => {
      const { session } = snapshot;
      const current = session.getSnapshot().draft;
      // A newer keystroke replaced this candidate; its own save is already queued.
      if (current.kind !== "candidate" || current.candidate !== candidate) return false;
      return writeText(candidate.text, (document) => {
        session.acceptSaved(candidate);
        publish({ sourceText: document.markdown, sourceVersion: snapshot.sourceVersion + 1 });
      });
    });
  }

  function saveSource(): Promise<boolean> {
    clearTimeout(sourceTimer);
    return enqueue(async () => {
      if (!sourceDirty) return true;
      const text = snapshot.sourceText;
      return writeText(text, (document) => {
        snapshot.session.reseed(document.markdown);
        if (snapshot.sourceText === text) sourceDirty = false;
        else scheduleSourceSave();
      });
    });
  }

  function scheduleSourceSave(): void {
    clearTimeout(sourceTimer);
    sourceTimer = setTimeout(() => void saveSource(), SOURCE_SAVE_DELAY_MS);
  }

  async function flush(): Promise<boolean> {
    if (snapshot.mode === "source") {
      await saveSource();
    } else {
      const draft = snapshot.session.flush();
      if (draft.kind === "candidate") await saveCandidate(draft.candidate);
    }
    await queue;
    return !hasLocalEdits() && snapshot.conflict === null;
  }

  function observeDisk(document: SkillDocument): void {
    if (disposed) return;
    observed = document;
    if (document.revision === snapshot.document.revision) {
      if (document !== snapshot.document) publish({ document });
      return;
    }
    if (saving > 0) return;
    if (hasLocalEdits()) publish({ conflict: document });
    else adopt(document);
  }

  watchSession(snapshot.session);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    observeDisk,
    flush,
    async setMode(mode) {
      if (mode === snapshot.mode) return;
      if (!(await flush()) || disposed) return;
      if (mode === "source") {
        publish({
          mode,
          sourceText: snapshot.document.markdown,
          sourceVersion: snapshot.sourceVersion + 1,
        });
        return;
      }
      if (!snapshot.session.getSnapshot().source.rich.editable) return;
      publish({ mode });
    },
    setSourceText(text) {
      if (
        disposed ||
        !snapshot.document.writable ||
        snapshot.conflict ||
        text === snapshot.sourceText
      )
        return;
      sourceDirty = true;
      publish({ sourceText: text, save: { kind: "unsaved" } });
      scheduleSourceSave();
    },
    async patchFrontmatter(patch) {
      if (!(await flush())) {
        return { ok: false, reason: "Save or resolve the page's other edits first." };
      }
      return enqueue(async () => {
        const edit = setSkillFrontmatter(parseSkillSource(snapshot.document.markdown), patch);
        if (!edit.ok) return edit;
        if (edit.text === snapshot.document.markdown) return { ok: true } as const;
        const saved = await writeText(edit.text, (document) => {
          snapshot.session.acceptFrontmatter(document.markdown);
          publish({ sourceText: document.markdown, sourceVersion: snapshot.sourceVersion + 1 });
        });
        return saved
          ? ({ ok: true } as const)
          : { ok: false, reason: "The skill could not be saved." };
      });
    },
    async resolveConflict(keep) {
      const disk = snapshot.conflict;
      if (!disk) {
        if (keep === "disk" && snapshot.save.kind === "refused") adopt(snapshot.document, true);
        return;
      }
      if (keep === "disk") {
        adopt(disk, true);
        return;
      }
      // Rebase onto the disk revision, then write this page's whole text over it.
      const draft = snapshot.mode === "rich" ? snapshot.session.flush() : null;
      publish({ document: { ...snapshot.document, revision: disk.revision }, conflict: null });
      if (draft?.kind === "candidate") await saveCandidate(draft.candidate);
      else if (snapshot.mode === "source") await saveSource();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(sourceTimer);
      unsubscribeSession();
      snapshot.session.dispose();
      listeners.clear();
    },
  };
}
