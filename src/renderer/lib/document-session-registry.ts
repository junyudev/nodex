import {
  captureCollaborativeSelection,
  restoreCollaborativeSelection,
  type BlockNoteEditor,
  type BlockSchema,
  type CollaborativeSelectionBookmark,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import type { OwnedDocumentDescriptor } from "../../shared/block-documents";
import type { BlockDocumentSurfaceRuntime } from "./block-document-surface-runtime";
import { contentAccessContextKey } from "../../shared/content-access-context";

interface RetainedBlockNoteEditor {
  readonly _tiptapEditor: {
    destroy: () => void;
  };
}

interface DocumentSurfaceAwarenessState {
  readonly state: Readonly<Record<string, unknown>>;
  readonly sequence: number;
}

interface DocumentSession {
  readonly identity: string;
  readonly descriptor: OwnedDocumentDescriptor;
  readonly runtime: BlockDocumentSurfaceRuntime;
  readonly connectBarrier: Promise<void>;
  references: number;
  awarenessSequence: number;
  readonly awarenessBySurface: Map<string, DocumentSurfaceAwarenessState>;
  closing: boolean;
  closePromise: Promise<void> | null;
}

export interface EditorSurfaceAwarenessLease {
  readonly surfaceId: string;
  publish: (state: Readonly<Record<string, unknown>>) => void;
  release: () => void;
  getRetainedState: () => Readonly<Record<string, unknown>> | null;
}

export const makeEditorSurfaceKey = (projectSessionId: string, tabId: string): string =>
  `${projectSessionId}\u0000${tabId}`;

export const makeDocumentSessionIdentity = (descriptor: OwnedDocumentDescriptor): string =>
  [
    descriptor.storeEpoch,
    descriptor.libraryId,
    contentAccessContextKey(descriptor.accessContext),
    descriptor.documentId,
    descriptor.generation,
    descriptor.schemaKey,
    descriptor.schemaVersion,
    descriptor.sync.kind,
  ].join("\u0000");

const hasSameRuntimeIdentity = (
  left: OwnedDocumentDescriptor,
  right: OwnedDocumentDescriptor,
): boolean => makeDocumentSessionIdentity(left) === makeDocumentSessionIdentity(right);

const persistRuntime = async (runtime: BlockDocumentSurfaceRuntime): Promise<void> => {
  const status = runtime.getStatus();
  if (
    !status.ready ||
    status.reloadRequired ||
    status.phase === "closing" ||
    status.phase === "closed"
  ) {
    return;
  }
  await runtime.persist().then(
    () => undefined,
    () => undefined,
  );
};

const isRuntimeReusable = (runtime: BlockDocumentSurfaceRuntime): boolean => {
  const status = runtime.getStatus();
  return !status.reloadRequired && status.phase !== "closing" && status.phase !== "closed";
};

/**
 * One surface's editor/selection lease over a canonical DocumentSession.
 *
 * The Y.Doc/provider lives in DocumentSessionRegistry's document map, not in
 * the tab key. This is the important boundary: two tab groups can render the
 * same Page without opening two independent local authorities.
 */
export class EditorSurfaceLease {
  readonly key: string;
  readonly descriptor: OwnedDocumentDescriptor;
  readonly runtime: BlockDocumentSurfaceRuntime;
  readonly awarenessLease: EditorSurfaceAwarenessLease;
  readonly transactionOrigin: object;

  private readonly connectBarrier: Promise<void>;
  private readonly releaseRuntime: () => Promise<void>;
  private connectPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private editor: RetainedBlockNoteEditor | null = null;
  private editorKey: string | null = null;
  private selectionBookmark: CollaborativeSelectionBookmark | null = null;
  private readonly retainedResources = new Map<string, { readonly dispose: () => void }>();
  private shouldRestoreEditorFocus = false;
  private nextViewGeneration = 0;
  private activeViewGeneration = 0;
  private disposed = false;

  constructor(input: {
    readonly key: string;
    readonly descriptor: OwnedDocumentDescriptor;
    readonly runtime: BlockDocumentSurfaceRuntime;
    readonly connectBarrier?: Promise<void>;
    readonly releaseRuntime?: () => Promise<void>;
    readonly awarenessLease?: EditorSurfaceAwarenessLease;
  }) {
    this.key = input.key;
    this.descriptor = input.descriptor;
    this.runtime = input.runtime;
    this.transactionOrigin = Object.freeze({ surfaceKey: input.key });
    this.connectBarrier = input.connectBarrier ?? Promise.resolve();
    this.releaseRuntime =
      input.releaseRuntime ?? (() => this.runtime.close().then(() => undefined));
    this.awarenessLease = input.awarenessLease ?? {
      surfaceId: input.key,
      publish: (state) => this.runtime.awareness.setLocalState({ ...state }),
      release: () => this.runtime.clearLocalAwareness(),
      getRetainedState: () => null,
    };
  }

  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Editor surface lease is disposed"));
    }
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connectBarrier.then(() => this.runtime.connect());
    return this.connectPromise;
  }

  claimView(): number {
    if (this.disposed) {
      throw new Error("Cannot claim a disposed editor surface lease");
    }
    this.nextViewGeneration += 1;
    this.activeViewGeneration = this.nextViewGeneration;
    return this.activeViewGeneration;
  }

  releaseView(generation: number, options: { readonly persist?: boolean } = {}): boolean {
    if (generation !== this.activeViewGeneration) return false;
    this.activeViewGeneration = 0;
    if (this.disposed) return true;

    this.awarenessLease.release();
    if (options.persist === false) return true;
    void this.persist();
    return true;
  }

  async persist(): Promise<void> {
    if (this.disposed) return;
    await persistRuntime(this.runtime);
  }

  getOrCreateEditor<Editor extends RetainedBlockNoteEditor>(
    editorKey: string,
    create: () => Editor,
  ): Editor {
    if (this.disposed) {
      throw new Error("Cannot create an editor for a disposed surface lease");
    }
    if (this.editor) {
      if (this.editorKey !== editorKey) {
        throw new Error("Editor identity changed without a new surface lease");
      }
      return this.editor as Editor;
    }

    const editor = create();
    this.editor = editor;
    this.editorKey = editorKey;
    return editor;
  }

  /** Retains surface-local controllers across React view remounts. */
  getOrCreateRetainedResource<Resource extends { dispose(): void }>(
    key: string,
    create: () => Resource,
  ): Resource {
    if (this.disposed) {
      throw new Error("Cannot create a resource for a disposed editor surface lease");
    }
    const existing = this.retainedResources.get(key);
    if (existing) return existing as Resource;

    const resource = create();
    this.retainedResources.set(key, resource);
    return resource;
  }

  captureSelection<
    BSchema extends BlockSchema,
    ISchema extends InlineContentSchema,
    SSchema extends StyleSchema,
  >(editor: BlockNoteEditor<BSchema, ISchema, SSchema>): void {
    if (this.disposed || editor !== this.editor) return;
    this.selectionBookmark = captureCollaborativeSelection(editor);
  }

  setShouldRestoreEditorFocus(value: boolean): void {
    if (this.disposed) return;
    this.shouldRestoreEditorFocus = value;
  }

  restoreSelection<
    BSchema extends BlockSchema,
    ISchema extends InlineContentSchema,
    SSchema extends StyleSchema,
  >(editor: BlockNoteEditor<BSchema, ISchema, SSchema>): boolean {
    if (this.disposed || editor !== this.editor || !this.selectionBookmark) {
      return false;
    }
    const restored = restoreCollaborativeSelection(editor, this.selectionBookmark);
    if (this.shouldRestoreEditorFocus) editor.focus();
    return restored;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.activeViewGeneration = 0;
    this.awarenessLease.release();

    const editor = this.editor;
    this.editor = null;
    this.editorKey = null;
    this.selectionBookmark = null;
    this.shouldRestoreEditorFocus = false;
    const retainedResources = [...this.retainedResources.values()];
    this.retainedResources.clear();
    for (const resource of retainedResources) resource.dispose();
    editor?._tiptapEditor.destroy();

    this.disposePromise = this.connectBarrier
      .catch(() => undefined)
      .then(() => this.releaseRuntime())
      .then(() => undefined);
    return this.disposePromise;
  }
}

export class DocumentSessionRegistry {
  private readonly surfaces = new Map<string, EditorSurfaceLease>();
  private readonly documents = new Map<string, DocumentSession>();
  /** Includes a retiring session if its only draft could not be made durable. */
  private readonly retainedDocuments = new Set<DocumentSession>();

  acquire(input: {
    readonly key: string;
    readonly descriptor: OwnedDocumentDescriptor;
    readonly createRuntime: () => BlockDocumentSurfaceRuntime;
  }): EditorSurfaceLease {
    const existing = this.surfaces.get(input.key);
    if (
      existing &&
      hasSameRuntimeIdentity(existing.descriptor, input.descriptor) &&
      isRuntimeReusable(existing.runtime)
    ) {
      return existing;
    }

    const connectBarrier = existing?.dispose() ?? Promise.resolve();
    const identity = makeDocumentSessionIdentity(input.descriptor);
    const existingDocument = this.documents.get(identity);
    const document =
      existingDocument && !existingDocument.closing && isRuntimeReusable(existingDocument.runtime)
        ? existingDocument
        : this.createDocumentEntry({
            identity,
            descriptor: input.descriptor,
            createRuntime: input.createRuntime,
            connectBarrier: existingDocument?.closePromise ?? connectBarrier,
          });
    document.references += 1;
    const surface = new EditorSurfaceLease({
      key: input.key,
      descriptor: document.descriptor,
      runtime: document.runtime,
      connectBarrier,
      releaseRuntime: () => this.releaseDocument(document),
      awarenessLease: this.createAwarenessLease(document, input.key),
    });
    this.surfaces.set(input.key, surface);
    return surface;
  }

  get(key: string): EditorSurfaceLease | null {
    return this.surfaces.get(key) ?? null;
  }

  dispose(key: string, expected?: EditorSurfaceLease): Promise<void> {
    const surface = this.surfaces.get(key);
    if (!surface || (expected && surface !== expected)) return Promise.resolve();
    this.surfaces.delete(key);
    return surface.dispose();
  }

  async disposeAll(): Promise<void> {
    const surfaces = [...this.surfaces.values()];
    this.surfaces.clear();
    await Promise.all(surfaces.map((surface) => surface.dispose()));
  }

  async persistAll(): Promise<void> {
    await Promise.all([...this.retainedDocuments].map((entry) => persistRuntime(entry.runtime)));
  }

  async disposeProjectSession(projectSessionId: string): Promise<void> {
    const keyPrefix = `${projectSessionId}\u0000`;
    const matches = [...this.surfaces.entries()].filter(([key]) => key.startsWith(keyPrefix));
    for (const [key] of matches) this.surfaces.delete(key);
    await Promise.all(matches.map(([, surface]) => surface.dispose()));
  }

  get size(): number {
    return this.surfaces.size;
  }

  get canonicalDocumentSize(): number {
    return this.documents.size;
  }

  private createDocumentEntry(input: {
    readonly identity: string;
    readonly descriptor: OwnedDocumentDescriptor;
    readonly createRuntime: () => BlockDocumentSurfaceRuntime;
    readonly connectBarrier: Promise<void>;
  }): DocumentSession {
    const entry: DocumentSession = {
      identity: input.identity,
      descriptor: input.descriptor,
      runtime: input.createRuntime(),
      connectBarrier: input.connectBarrier,
      references: 0,
      awarenessSequence: 0,
      awarenessBySurface: new Map(),
      closing: false,
      closePromise: null,
    };
    this.documents.set(input.identity, entry);
    this.retainedDocuments.add(entry);
    return entry;
  }

  private createAwarenessLease(
    entry: DocumentSession,
    surfaceKey: string,
  ): EditorSurfaceAwarenessLease {
    const surfaceId = `surface:${surfaceKey}`;
    let retainedState: Readonly<Record<string, unknown>> | null = null;
    return {
      surfaceId,
      publish: (state) => {
        if (entry.closing) return;
        retainedState = { ...state };
        entry.awarenessSequence += 1;
        entry.awarenessBySurface.set(surfaceId, {
          state: retainedState,
          sequence: entry.awarenessSequence,
        });
        this.publishAggregatedAwareness(entry);
      },
      release: () => {
        if (!entry.awarenessBySurface.delete(surfaceId)) return;
        this.publishAggregatedAwareness(entry);
      },
      getRetainedState: () => retainedState,
    };
  }

  private publishAggregatedAwareness(entry: DocumentSession): void {
    const activeSurfaces = [...entry.awarenessBySurface.entries()];
    if (activeSurfaces.length === 0) {
      entry.runtime.clearLocalAwareness();
      return;
    }

    const [activeSurfaceId, active] = activeSurfaces.reduce((latest, current) =>
      current[1].sequence > latest[1].sequence ? current : latest,
    );
    const nodex =
      typeof active.state.nodex === "object" &&
      active.state.nodex !== null &&
      !Array.isArray(active.state.nodex)
        ? (active.state.nodex as Readonly<Record<string, unknown>>)
        : {};
    entry.runtime.awareness.setLocalState({
      ...active.state,
      nodex: {
        ...nodex,
        activeSurfaceId,
        surfaceIds: activeSurfaces.map(([surfaceId]) => surfaceId).sort(),
      },
    });
  }

  private releaseDocument(entry: DocumentSession): Promise<void> {
    if (entry.references > 0) entry.references -= 1;
    if (entry.references > 0 || entry.closePromise) {
      return entry.closePromise ?? Promise.resolve();
    }

    entry.closing = true;
    const closePromise = entry.connectBarrier
      .catch(() => undefined)
      .then(() => entry.runtime.close())
      .then(() => {
        if (entry.runtime.getStatus().phase !== "closed")
          throw new Error("The document still has an unsaved recovery copy in this window");
      });
    entry.closePromise = closePromise.finally(() => {
      if (entry.runtime.getStatus().phase !== "closed") {
        entry.closing = false;
        entry.closePromise = null;
        return;
      }
      this.retainedDocuments.delete(entry);
      if (this.documents.get(entry.identity) === entry) {
        this.documents.delete(entry.identity);
      }
    });
    return entry.closePromise;
  }
}

export const documentSessionRegistry = new DocumentSessionRegistry();
