import {
  getBlockInfo,
  getBlockInfoAtNearest,
  getNodeById,
  type BlockNoteEditor,
} from "@blocknote/core";
import { TextSelection } from "@tiptap/pm/state";
import type { NfmFileEditorSource } from "@/components/board/editor/nfm-editor-source";
import {
  materializePageDocument,
  populateBlockDocumentBodyFromBlockTree,
  type BlockTreeNode,
} from "../../../shared/block-documents/block-document-codec";
import { createPageDocument } from "../../../shared/block-documents/page-document";
import { writeMarkdown, type MarkdownBlock } from "../../../shared/nodex-markdown";
import {
  applySkillBodyEdit,
  parseSkillSource,
  type SkillSource,
} from "../../../shared/skill-document";
import { createUuidV7 } from "../../../shared/uuid-v7";

export interface SkillEditorCandidate {
  readonly baseText: string;
  readonly text: string;
}

export type SkillEditorDraft =
  | { readonly kind: "clean" }
  | { readonly kind: "pending" }
  | { readonly kind: "candidate"; readonly candidate: SkillEditorCandidate }
  | { readonly kind: "refused"; readonly reason: string };

export interface SkillEditorSnapshot {
  readonly source: SkillSource;
  readonly editorSource: NfmFileEditorSource | null;
  readonly draft: SkillEditorDraft;
}

export interface SkillEditorSession {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SkillEditorSnapshot;
  /** Validate a pending edit synchronously, for example before leaving Rich mode. */
  readonly flush: () => SkillEditorDraft;
  /** Adopt the exact candidate confirmed written to disk. Later keystrokes stay in the draft. */
  readonly acceptSaved: (candidate: SkillEditorCandidate) => boolean;
  /** Advance a confirmed frontmatter-only write while preserving body edits made during it. */
  readonly acceptFrontmatter: (text: string) => void;
  /** Replace the draft from disk only when it is clean. A refused or pending edit is retained. */
  readonly reseed: (text: string) => boolean;
  readonly dispose: () => void;
}

type MountedEditor = BlockNoteEditor<any, any, any>;
interface SelectionPoint {
  readonly id: string;
  readonly offset: number;
}
interface EditorSelection {
  readonly anchor: SelectionPoint;
  readonly head: SelectionPoint;
  readonly focused: boolean;
}

function captureSelection(editor: MountedEditor | null): EditorSelection | null {
  const view = editor?.prosemirrorView;
  if (!view) return null;
  const { selection } = view.state;
  function point(position: number): SelectionPoint | null {
    const info = getBlockInfoAtNearest(view!.state, position);
    if (!info.isBlockContainer || typeof info.bnBlock.node.attrs.id !== "string") return null;
    return { id: info.bnBlock.node.attrs.id, offset: position - info.blockContent.beforePos - 1 };
  }
  const anchor = point(selection.anchor);
  const head = point(selection.head);
  return anchor && head ? { anchor, head, focused: view.hasFocus() } : null;
}

function restoreSelection(editor: MountedEditor, selection: EditorSelection): void {
  const view = editor.prosemirrorView;
  if (!view) return;
  function position(point: SelectionPoint): number | undefined {
    const location = getNodeById(point.id, view!.state.doc);
    if (!location) return;
    const info = getBlockInfo(location);
    if (!info.isBlockContainer) return;
    return (
      info.blockContent.beforePos +
      1 +
      Math.max(0, Math.min(point.offset, info.blockContent.node.content.size))
    );
  }
  const anchor = position(selection.anchor);
  const head = position(selection.head);
  if (anchor !== undefined && head !== undefined) {
    const doc = view.state.doc;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head))),
    );
  }
  if (selection.focused) view.focus();
}

function flatten<T extends MarkdownBlock>(blocks: readonly T[]): T[] {
  return blocks.flatMap((block) => [block, ...flatten((block.children ?? []) as readonly T[])]);
}

function matchCleanIds(source: SkillSource): (block: MarkdownBlock) => string {
  const ids = new Map<string, string[]>();
  const key = (block: MarkdownBlock) => writeMarkdown([{ ...block, id: undefined, children: [] }]);
  for (const block of flatten(source.blocks)) {
    const signature = key(block);
    const matching = ids.get(signature) ?? [];
    matching.push(block.id);
    ids.set(signature, matching);
  }
  return (block) => ids.get(key(block))?.shift() ?? createUuidV7();
}

/** Owns a disposable, detached Yjs draft. The caller owns disk revisions and writes. */
export function createSkillEditorSession(
  text: string,
  { debounceMs = 200 }: { readonly debounceMs?: number } = {},
): SkillEditorSession {
  const id = "skill-draft:" + createUuidV7();
  const listeners = new Set<() => void>();
  const savedSources = new WeakMap<
    SkillEditorCandidate,
    {
      readonly base: SkillSource;
      readonly ids: readonly string[];
    }
  >();
  let mounted: MountedEditor | null = null;
  let bookmark: EditorSelection | null = null;
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let envelope: ReturnType<typeof createPageDocument> | null = null;

  function publish(next: SkillEditorSnapshot): void {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function onEdit(): void {
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    if (snapshot.draft.kind !== "pending") publish({ ...snapshot, draft: { kind: "pending" } });
  }

  function createSource(source: SkillSource): NfmFileEditorSource | null {
    if (!source.rich.editable) return null;
    const draft = createPageDocument({ documentId: id, initializeBody: false });
    try {
      // The converter emits portable BlockNote JSON with IDs on every node.
      populateBlockDocumentBodyFromBlockTree(draft.body, source.blocks as readonly BlockTreeNode[]);
    } catch (error) {
      draft.document.destroy();
      throw error;
    }
    envelope = draft;
    draft.body.observeDeep(onEdit);
    return {
      kind: "markdown-file",
      documentId: id,
      clientSessionId: id,
      storeEpoch: "skill-draft",
      generation: generation++,
      fragment: draft.body,
      user: { name: "You", color: "#0285ff" },
      onMount(editor) {
        if (envelope !== draft || disposed) return () => undefined;
        mounted = editor;
        if (bookmark) restoreSelection(editor, bookmark);
        bookmark = null;
        return () => {
          if (mounted !== editor) return;
          bookmark = captureSelection(editor);
          mounted = null;
        };
      },
    };
  }

  function validate(): SkillEditorDraft {
    if (!envelope) return { kind: "clean" };
    try {
      const { source } = snapshot;
      const { blockTree } = materializePageDocument(envelope.document);
      const result = applySkillBodyEdit(source, blockTree);
      if (!result.ok) return { kind: "refused", reason: result.reason };
      if (result.text === source.text) return { kind: "clean" };
      const candidate = { baseText: source.text, text: result.text };
      savedSources.set(candidate, {
        base: source,
        ids: flatten(blockTree).map((block) => block.id),
      });
      return { kind: "candidate", candidate };
    } catch (error) {
      return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function flush(): SkillEditorDraft {
    clearTimeout(timer);
    if (disposed || snapshot.draft.kind !== "pending") return snapshot.draft;
    const draft = validate();
    publish({ ...snapshot, draft });
    return draft;
  }

  function destroyEnvelope(previous: typeof envelope): void {
    previous?.body.unobserveDeep(onEdit);
    previous?.document.destroy();
  }

  const initial = parseSkillSource(text);
  let snapshot: SkillEditorSnapshot = {
    source: initial,
    editorSource: createSource(initial),
    draft: { kind: "clean" },
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush,
    acceptSaved(candidate) {
      const saved = savedSources.get(candidate);
      if (disposed || !saved || saved.base !== snapshot.source) return false;
      clearTimeout(timer);
      let index = 0;
      const source = parseSkillSource(candidate.text, () => saved.ids[index++] ?? createUuidV7());
      // Keep the mounted fragment and its history. Only the disk baseline advances.
      snapshot = { ...snapshot, source };
      publish({ ...snapshot, draft: validate() });
      return true;
    },
    acceptFrontmatter(text) {
      clearTimeout(timer);
      const source = parseSkillSource(text, matchCleanIds(snapshot.source));
      snapshot = { ...snapshot, source };
      publish({ ...snapshot, draft: validate() });
    },
    reseed(nextText) {
      if (disposed || flush().kind !== "clean") return false;
      if (snapshot.source.text === nextText) return true;
      const source = parseSkillSource(nextText, matchCleanIds(snapshot.source));
      if (
        source.rich.editable &&
        snapshot.source.rich.editable &&
        source.text.slice(source.bodyStart) ===
          snapshot.source.text.slice(snapshot.source.bodyStart)
      ) {
        publish({ ...snapshot, source });
        return true;
      }
      const previous = envelope;
      if (mounted) bookmark = captureSelection(mounted);
      mounted = null;
      const editorSource = createSource(source);
      if (!editorSource) envelope = null;
      destroyEnvelope(previous);
      publish({ source, editorSource, draft: { kind: "clean" } });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      destroyEnvelope(envelope);
      envelope = null;
      listeners.clear();
      mounted = null;
      bookmark = null;
    },
  };
}
