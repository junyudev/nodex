import type { BlockDropImportSourceUpdate } from "@/lib/types";

export interface DragSessionBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: DragSessionBlock[];
}

export interface EditorForExternalBlockDrop {
  document: DragSessionBlock[];
  prosemirrorView?: {
    state: {
      selection: object;
    };
  };
  getSelection?: () => { blocks: Array<{ id: string }> } | undefined;
  getBlock: (id: string) => DragSessionBlock | undefined;
  getParentBlock: (id: string) => DragSessionBlock | undefined;
  removeBlocks: (ids: string[]) => void;
  replaceBlocks: (toRemove: unknown[], replacements: unknown[]) => void;
  transact?: <T>(fn: () => T) => T;
}

export interface ExternalDropAdapter {
  captureBaseline: (
    editor: EditorForExternalBlockDrop,
    container: HTMLElement,
  ) => unknown;
  buildSourceUpdates: (
    editor: EditorForExternalBlockDrop,
    container: HTMLElement,
    baseline: unknown,
  ) => BlockDropImportSourceUpdate[];
  beginOptimisticMutation?: () => () => void;
}

export interface ExternalEditorDragSession {
  id: string;
  editor: EditorForExternalBlockDrop;
  container: HTMLElement;
  adapter: ExternalDropAdapter;
}

let activeSession: ExternalEditorDragSession | null = null;

export function startExternalEditorDragSession(
  editor: EditorForExternalBlockDrop,
  container: HTMLElement,
  adapter: ExternalDropAdapter,
): string {
  const id = crypto.randomUUID();
  activeSession = { id, editor, container, adapter };
  return id;
}

export function getActiveExternalEditorDragSession(): ExternalEditorDragSession | null {
  return activeSession;
}

export function endExternalEditorDragSession(sessionId?: string): void {
  if (!activeSession) return;
  if (sessionId && activeSession.id !== sessionId) return;
  activeSession = null;
}

export function runInEditorTransaction<T>(
  editor: EditorForExternalBlockDrop,
  fn: () => T,
): T {
  if (!editor.transact) return fn();
  return editor.transact(fn);
}

export function snapshotEditorDocument(
  editor: EditorForExternalBlockDrop,
): DragSessionBlock[] {
  if (typeof structuredClone === "function") {
    return structuredClone(editor.document) as DragSessionBlock[];
  }

  return JSON.parse(JSON.stringify(editor.document)) as DragSessionBlock[];
}

export function restoreEditorDocument(
  editor: EditorForExternalBlockDrop,
  snapshot: DragSessionBlock[],
): void {
  editor.replaceBlocks(editor.document, snapshot);
}
