import { getBlockInfo, getNodeById, type BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "@tiptap/pm/state";

import type { ContentAccessContext } from "../../../../shared/content-access-context";
import type {
  NodexClipboardEnvelopeV1,
  NodexStructuralClipboardDescriptorV1,
  StructuralClipboardResolution,
} from "../../../../shared/clipboard-paste";
import type {
  LibraryModuleApplyResult,
  LibraryPageFileOwnershipMove,
  LibraryStructuralClipboardToken,
  LibraryStructuralEditResult,
  LibraryStructuralHistoryToken,
  LibraryStructuralReplacementBlock,
  LibraryStructuralTurnIntoTarget,
} from "../../../../shared/library-module";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { hasTypedOwnerBlock, type TypedOwnerBlockLike } from "../../../lib/typed-owner-blocks";
import type { BlockDocumentStructuralMutationParticipant } from "../../../lib/block-document-mutation-registry";
import {
  applyLibraryModule,
  awaitStructuralClipboard,
  beginStructuralClipboard,
  publishStructuralClipboard,
  settleStructuralClipboard,
} from "../../../lib/api";
import { NfmHistoryLane, resolveNfmUndoManager } from "./nfm-editor-history";
import { planBackspaceAcrossAtomicBlocks } from "./atomic-block-backspace";
import { getNfmBlockSelectionIds } from "./nfm-block-selection";
import { setNfmClipboardPastePending } from "./nfm-clipboard-paste-pending-extension";

export const NFM_CLIPBOARD_PASTE_PENDING_DELAY_MS = 150;

export interface NfmStructuralClipboardPresentation {
  readonly html: string;
  readonly text: string;
}

export interface NfmStructuralDocumentTarget {
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly parentBlockId?: string | null;
  readonly beforeBlockId?: string | null;
}

export interface NfmStructuralReplacementBlockLike extends TypedOwnerBlockLike {
  readonly id: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
  readonly children?: readonly NfmStructuralReplacementBlockLike[];
}

type StructuralEditorBlock = NfmStructuralReplacementBlockLike;

interface StructuralCursorPosition {
  readonly block: StructuralEditorBlock;
  readonly nextBlock?: StructuralEditorBlock;
}

type StructuralEditor = BlockNoteEditor & {
  readonly document: readonly StructuralEditorBlock[];
  getSelection: () => { readonly blocks?: readonly StructuralEditorBlock[] } | undefined;
  getTextCursorPosition: () => StructuralCursorPosition;
  getParentBlock: (blockId: string) => StructuralEditorBlock | undefined;
  insertBlocks: (
    blocks: readonly unknown[],
    referenceBlockId: string,
    placement: "before" | "after",
  ) => readonly StructuralEditorBlock[];
  replaceBlocks: (
    blockIds: readonly string[],
    blocks: readonly unknown[],
  ) => readonly StructuralEditorBlock[];
};

type NfmStructuralPasteIntent =
  | {
      readonly kind: "replace";
      readonly rootBlockIds: readonly string[];
    }
  | {
      readonly kind: "insert";
      readonly anchorBlockId: string;
      readonly parentBlockId: string | null;
      readonly beforeBlockId: string | null;
    };

export interface NfmStructuralEditingSessionOptions {
  readonly editor: BlockNoteEditor<any, any, any>;
  readonly historyLane?: NfmHistoryLane | null;
  readonly apply?: typeof applyLibraryModule;
  readonly beginClipboard?: typeof beginStructuralClipboard;
  readonly publishClipboard?: typeof publishStructuralClipboard;
  readonly settleClipboard?: typeof settleStructuralClipboard;
  readonly awaitClipboard?: typeof awaitStructuralClipboard;
  readonly runtime?: NfmStructuralEditingRuntime;
}

export interface NfmStructuralEditingRuntime {
  readonly accessContext: ContentAccessContext;
  readonly libraryId?: string;
  readonly source: {
    readonly documentId: string;
    readonly storeEpoch: string;
    readonly generation: number;
  };
  readonly participant: BlockDocumentStructuralMutationParticipant;
  readonly getContainer: () => HTMLElement | null;
  readonly resolveClipboardText?: (portableText: string) => Promise<string>;
  readonly onError?: (message: string) => void;
  readonly onClipboardFallback?: (message: string) => void;
  readonly onFileOwnershipMoves?: (moves: readonly LibraryPageFileOwnershipMove[]) => void;
}

const topLevelRoots = (
  editor: StructuralEditor,
  candidates: readonly StructuralEditorBlock[],
): readonly StructuralEditorBlock[] => {
  const selectedIds = new Set(candidates.map((block) => block.id));
  return candidates.filter((block) => {
    let parent = editor.getParentBlock(block.id);
    let depth = 0;
    while (parent && depth < 1_000) {
      if (selectedIds.has(parent.id)) return false;
      parent = editor.getParentBlock(parent.id);
      depth += 1;
    }
    return true;
  });
};

const selectedStructuralRoots = (editor: StructuralEditor): readonly StructuralEditorBlock[] => {
  const view = editor.prosemirrorView;
  if (!view) return [];

  const blockSelectionIds = getNfmBlockSelectionIds(view.state.selection);
  const blockSelection = blockSelectionIds
    .map((blockId) => editor.getBlock(blockId) as StructuralEditorBlock | undefined)
    .filter((block): block is StructuralEditorBlock => Boolean(block));
  const publicSelection = editor.getSelection()?.blocks;
  const candidates = blockSelection.length ? blockSelection : (publicSelection ?? []);
  return topLevelRoots(editor, candidates);
};

const structuralRoots = (editor: StructuralEditor): readonly StructuralEditorBlock[] => {
  if (!editor.prosemirrorView) return [];

  const selected = selectedStructuralRoots(editor);
  return selected.length ? selected : topLevelRoots(editor, [editor.getTextCursorPosition().block]);
};

const applyResult = (result: LibraryModuleApplyResult): LibraryStructuralEditResult => {
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.structuralEdit) return result.value.structuralEdit;
  throw new Error("Core omitted the structural edit receipt.");
};

const clipboardTokenFromEnvelope = (
  envelope: NodexClipboardEnvelopeV1,
): LibraryStructuralClipboardToken => ({
  bundleId: envelope.bundleId,
  capability: envelope.capability,
  manifestHash: envelope.manifestHash,
  storeEpoch: envelope.storeEpoch,
});

const nextAnimationFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

const portableJson = (value: unknown): unknown => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Pasted Block content is not portable JSON.");
  return JSON.parse(encoded) as unknown;
};

const toReplacementBlock = (block: StructuralEditorBlock): LibraryStructuralReplacementBlock => ({
  blockType: block.type,
  props: portableJson(block.props ?? {}) as Readonly<Record<string, unknown>>,
  content: block.content === undefined ? null : portableJson(block.content),
  children: (block.children ?? []).map(toReplacementBlock),
});

const textReplacementBlock = (text: string): LibraryStructuralReplacementBlock => ({
  blockType: "paragraph",
  props: {},
  content:
    text.length === 0
      ? []
      : [
          {
            type: "text",
            text,
            styles: {},
          },
        ],
  children: [],
});

const isPageFileLocator = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("nodex://files/");

const fallbackTextContent = (text: string): readonly unknown[] =>
  text.length > 0 ? [{ type: "text", text, styles: {} }] : [];

const sanitizePortableInlineContent = (content: unknown): unknown => {
  if (Array.isArray(content)) return content.map(sanitizePortableInlineContent);
  if (!content || typeof content !== "object") return content;
  const record = content as Readonly<Record<string, unknown>>;
  const props =
    record.props && typeof record.props === "object"
      ? (record.props as Readonly<Record<string, unknown>>)
      : null;
  if (record.type === "attachment" && props && isPageFileLocator(props.source)) {
    const name = typeof props.name === "string" && props.name.trim() ? props.name.trim() : "File";
    return { type: "text", text: name, styles: {} };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, sanitizePortableInlineContent(value)]),
  );
};

/** Removes private File locators before a portable fallback crosses Page authority. */
const sanitizePortableFallbackBlock = (block: StructuralEditorBlock): StructuralEditorBlock => {
  const props = block.props ?? {};
  const imageLocator = isPageFileLocator(props.url) || isPageFileLocator(props.source);
  if (block.type === "image" && imageLocator) {
    const label =
      (typeof props.name === "string" && props.name.trim()) ||
      (typeof props.caption === "string" && props.caption.trim()) ||
      (typeof props.alt === "string" && props.alt.trim()) ||
      "Image";
    return {
      id: block.id,
      type: "paragraph",
      props: {},
      content: fallbackTextContent(label),
      children: (block.children ?? []).map(sanitizePortableFallbackBlock),
    };
  }
  return {
    ...block,
    props: portableJson(props) as Readonly<Record<string, unknown>>,
    content: sanitizePortableInlineContent(portableJson(block.content ?? [])),
    children: (block.children ?? []).map(sanitizePortableFallbackBlock),
  };
};

const withoutPortableBlockIdentity = (
  block: StructuralEditorBlock,
): Readonly<Record<string, unknown>> => ({
  type: block.type,
  props: block.props ?? {},
  content: block.content ?? [],
  children: (block.children ?? []).map(withoutPortableBlockIdentity),
});

/**
 * One retained editor surface's structural input owner. React provides stable
 * runtime dependencies; this session owns command ordering, history and focus.
 */
export class NfmStructuralEditingSession {
  private readonly editor: StructuralEditor;
  private readonly apply: typeof applyLibraryModule;
  private readonly beginClipboard: typeof beginStructuralClipboard;
  private readonly publishClipboard: typeof publishStructuralClipboard;
  private readonly settleClipboard: typeof settleStructuralClipboard;
  private readonly awaitClipboard: typeof awaitStructuralClipboard;
  private readonly history: NfmHistoryLane;
  private readonly ownsHistory: boolean;
  private readonly detachHistory: () => void;
  private disposed = false;
  private currentOperation: Promise<void> = Promise.resolve();
  private historyReplayFocusChanged = false;
  private operationFocusChanged = false;
  private backwardMergePending = false;
  private preparedPasteIntent: {
    readonly token: symbol;
    readonly intent: NfmStructuralPasteIntent;
  } | null = null;
  private runtime: NfmStructuralEditingRuntime | null;

  constructor(options: NfmStructuralEditingSessionOptions) {
    this.editor = options.editor as StructuralEditor;
    this.apply = options.apply ?? applyLibraryModule;
    this.beginClipboard = options.beginClipboard ?? beginStructuralClipboard;
    this.publishClipboard = options.publishClipboard ?? publishStructuralClipboard;
    this.settleClipboard = options.settleClipboard ?? settleStructuralClipboard;
    this.awaitClipboard = options.awaitClipboard ?? awaitStructuralClipboard;
    this.runtime = options.runtime ?? null;
    const undoManager = resolveNfmUndoManager(options.editor);
    this.history = options.historyLane ?? new NfmHistoryLane({ undoManager });
    this.ownsHistory = this.history !== options.historyLane;
    this.detachHistory = this.history.attach({
      reverseStructural: async (token) => await this.reverseStructural(token),
      releaseStructural: async (tokens) => await this.releaseStructuralHistory(tokens),
      onStructuralReversed: async (result) => {
        this.notifyFileOwnershipMoves(result);
        if (this.historyReplayFocusChanged) return;
        await this.restoreSelection(result);
        this.restoreFocusIfUnclaimed();
      },
      onError: (error) =>
        this.runtime?.onError?.(
          error instanceof Error ? error.message : "History replay could not be completed.",
        ),
    });
  }

  /** Rebinds live Document authority without replacing the surface command queue. */
  rebind(runtime: NfmStructuralEditingRuntime): void {
    if (this.disposed) return;
    if (
      this.runtime &&
      (this.runtime.source.documentId !== runtime.source.documentId ||
        this.runtime.source.storeEpoch !== runtime.source.storeEpoch ||
        this.runtime.source.generation !== runtime.source.generation)
    ) {
      throw new Error("A structural editing session cannot change its Document authority.");
    }
    this.runtime = runtime;
  }

  private get boundRuntime(): NfmStructuralEditingRuntime {
    if (this.runtime) return this.runtime;
    throw new Error("The editor surface is not ready for structural editing.");
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.disposed) return false;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && event.key.toLowerCase() === "z") {
      return event.shiftKey ? this.history.requestRedo() : this.history.requestUndo();
    }
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing ||
      (event.key !== "Backspace" && event.key !== "Delete")
    ) {
      return false;
    }
    if (event.key === "Backspace") {
      const plan = planBackspaceAcrossAtomicBlocks(this.editor);
      if (plan?.kind === "protect_boundary") return true;
      if (plan?.kind === "merge") return this.mergeBlockBackward(plan);
    }
    const roots = structuralRoots(this.editor);
    if (!hasTypedOwnerBlock(roots)) return false;
    return this.deleteRoots(roots, event.key === "Backspace" ? "backward" : "forward");
  }

  deleteBlocks(rootBlockIds: readonly string[], direction: "backward" | "forward"): boolean {
    const roots = rootBlockIds
      .map((blockId) => this.editor.getBlock(blockId) as StructuralEditorBlock | undefined)
      .filter((block): block is StructuralEditorBlock => Boolean(block));
    if (!hasTypedOwnerBlock(roots)) return false;
    return this.deleteRoots(roots, direction);
  }

  duplicateBlocks(rootBlockIds: readonly string[]): boolean {
    const roots = rootBlockIds
      .map((blockId) => this.editor.getBlock(blockId) as StructuralEditorBlock | undefined)
      .filter((block): block is StructuralEditorBlock => Boolean(block));
    if (!hasTypedOwnerBlock(roots) || this.disposed) return false;
    this.start(async () => {
      const { selection, target } = await this.prepareDuplicateCommand(roots);
      const result = applyResult(
        await this.apply(this.boundRuntime.accessContext, {
          operationId: createUuidV7(),
          storeEpoch: this.boundRuntime.source.storeEpoch,
          operation: {
            kind: "apply_structural_edit",
            command: { kind: "duplicate_selection", selection, target },
          },
        }),
      );
      this.recordStructuralResult(result);
      await this.restoreSelection(result, result.resultRootBlockIds.at(-1));
    });
    return true;
  }

  turnBlocksInto(
    rootBlockIds: readonly string[],
    expandedBlockIds: readonly string[],
    target: LibraryStructuralTurnIntoTarget,
  ): boolean {
    const roots = rootBlockIds
      .map((blockId) => this.editor.getBlock(blockId) as StructuralEditorBlock | undefined)
      .filter((block): block is StructuralEditorBlock => Boolean(block));
    const expandedBlocks = expandedBlockIds
      .map((blockId) => this.editor.getBlock(blockId) as StructuralEditorBlock | undefined)
      .filter((block): block is StructuralEditorBlock => Boolean(block));
    if (
      !hasTypedOwnerBlock(expandedBlocks) ||
      this.disposed ||
      roots.length === 0 ||
      roots.length !== rootBlockIds.length ||
      expandedBlocks.length !== expandedBlockIds.length
    ) {
      return false;
    }
    this.start(async () => {
      const selection = await this.prepareSelection(roots);
      const result = applyResult(
        await this.apply(this.boundRuntime.accessContext, {
          operationId: createUuidV7(),
          storeEpoch: this.boundRuntime.source.storeEpoch,
          operation: {
            kind: "apply_structural_edit",
            command: { kind: "turn_selection_into", selection, target },
          },
        }),
      );
      this.recordStructuralResult(result);
      await this.restoreSelection(result, result.resultRootBlockIds.at(-1));
    });
    return true;
  }

  moveBlocksToDocument(
    rootBlockIds: readonly string[],
    target: NfmStructuralDocumentTarget,
  ): boolean {
    const roots = rootBlockIds
      .map((blockId) => this.editor.getBlock(blockId) as StructuralEditorBlock | undefined)
      .filter((block): block is StructuralEditorBlock => Boolean(block));
    if (!hasTypedOwnerBlock(roots) || this.disposed) return false;
    this.start(async () => {
      if (target.storeEpoch !== this.boundRuntime.source.storeEpoch) {
        throw new Error("The target belongs to another Store generation.");
      }
      const selection = await this.prepareSelection(roots);
      const result = applyResult(
        await this.apply(this.boundRuntime.accessContext, {
          operationId: createUuidV7(),
          storeEpoch: this.boundRuntime.source.storeEpoch,
          operation: {
            kind: "apply_structural_edit",
            command: {
              kind: "move_selection",
              selection,
              target: {
                targetDocumentId: target.documentId,
                parentBlockId: target.parentBlockId ?? null,
                beforeBlockId: target.beforeBlockId ?? null,
                targetHead: {
                  documentId: target.documentId,
                  generation: target.generation,
                  expectedHeadSeq: target.headSeq,
                },
              },
            },
          },
        }),
      );
      this.recordStructuralResult(result);
      await this.restoreSelection(result);
    });
    return true;
  }

  adoptStructuralResult(result: LibraryStructuralEditResult, preferredBlockId?: string): void {
    if (this.disposed) return;
    this.recordStructuralResult(result);
    this.start(async () => {
      await this.restoreSelection(result, preferredBlockId ?? result.resultRootBlockIds.at(-1));
    });
  }

  handleClipboard(
    action: "copy" | "cut",
    rootBlockIds: readonly string[],
    presentation: NfmStructuralClipboardPresentation,
    writeClaim: string,
  ): boolean {
    return this.captureClipboard(action, rootBlockIds, presentation, writeClaim);
  }

  handlePaste(envelope: NodexClipboardEnvelopeV1): boolean {
    if (this.disposed) return false;
    if (this.boundRuntime.libraryId && envelope.libraryId !== this.boundRuntime.libraryId) {
      return false;
    }
    if (envelope.storeEpoch !== this.boundRuntime.source.storeEpoch) return false;
    const intent = this.capturePasteIntent();
    if (!intent) return false;
    return this.start(async () => await this.pasteEnvelope(envelope, intent));
  }

  handleStructuralClaimPaste(
    descriptor: NodexStructuralClipboardDescriptorV1,
    portableBlocks: readonly StructuralEditorBlock[],
  ): boolean {
    if (this.disposed) return false;
    const intent = this.consumePreparedPasteIntent() ?? this.capturePasteIntent();
    if (!intent) return false;
    const frozenPortableBlocks = portableBlocks.map(sanitizePortableFallbackBlock);
    return this.start(async () => {
      const releasePending = this.schedulePendingPasteIndicator(intent);
      try {
        const resolution: StructuralClipboardResolution =
          descriptor.phase === "ready"
            ? { kind: "ready", envelope: descriptor.envelope, disposition: "structural" }
            : await this.awaitClipboard({ writeClaim: descriptor.writeClaim });
        if (resolution.kind === "portable_fallback") {
          await this.pastePortableBlocks(frozenPortableBlocks, intent);
          this.boundRuntime.onClipboardFallback?.(
            descriptor.actionHint === "cut"
              ? "Pasted a copy because the move could not be completed."
              : "Pasted portable content because structural clipboard data was unavailable.",
          );
          return;
        }
        if (!this.envelopeMatchesRuntime(resolution.envelope)) {
          await this.pastePortableBlocks(frozenPortableBlocks, intent);
          return;
        }
        await this.pasteEnvelope(resolution.envelope, intent);
        if (resolution.disposition === "copy_fallback") {
          this.boundRuntime.onClipboardFallback?.(
            "Pasted a copy because the move could not be completed.",
          );
        }
      } finally {
        releasePending();
      }
    });
  }

  /** Freezes a context-menu target before its asynchronous native clipboard read. */
  prepareNextStructuralPaste(): () => void {
    const intent = this.capturePasteIntent();
    if (!intent) return () => undefined;
    const token = Symbol("structural-paste-intent");
    this.preparedPasteIntent = { token, intent };
    return () => {
      if (this.preparedPasteIntent?.token === token) this.preparedPasteIntent = null;
    };
  }

  handleBlockPaste(blocks: readonly StructuralEditorBlock[]): boolean {
    if (this.disposed || blocks.length === 0) return false;
    const roots = selectedStructuralRoots(this.editor);
    if (!hasTypedOwnerBlock(roots)) return false;
    return this.replaceRoots(roots, blocks.map(toReplacementBlock));
  }

  hasTypedOwnerSelection(): boolean {
    if (this.disposed) return false;
    return hasTypedOwnerBlock(selectedStructuralRoots(this.editor));
  }

  handleBeforeInput(event: InputEvent): boolean {
    if (this.disposed || event.isComposing) return false;
    const roots = selectedStructuralRoots(this.editor);
    if (!hasTypedOwnerBlock(roots)) return false;
    if (event.inputType === "insertParagraph") {
      return this.replaceRoots(roots, [textReplacementBlock("")]);
    }
    if (event.inputType !== "insertText" && event.inputType !== "insertReplacementText") {
      return false;
    }
    if (event.data === null) return false;
    return this.replaceRoots(roots, [textReplacementBlock(event.data)]);
  }

  stopCapturing(): void {
    this.history.stopCapturing();
  }

  whenIdle(): Promise<void> {
    return this.currentOperation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.preparedPasteIntent = null;
    this.detachHistory();
    if (this.ownsHistory) this.history.dispose();
  }

  private captureClipboard(
    actionHint: "copy" | "cut",
    rootBlockIds: readonly string[],
    presentation: NfmStructuralClipboardPresentation,
    writeClaim: string,
  ): boolean {
    if (this.disposed) return false;
    const roots = rootBlockIds
      .map((blockId) => this.editor.getBlock(blockId) as StructuralEditorBlock | undefined)
      .filter((block): block is StructuralEditorBlock => Boolean(block));
    if (roots.length === 0 || roots.length !== rootBlockIds.length) return false;
    const begin = this.beginClipboard({
      writeClaim,
      actionHint,
      libraryId: this.boundRuntime.libraryId,
      storeEpoch: this.boundRuntime.source.storeEpoch,
    });
    const started = this.start(async () => {
      const begun = await begin;
      if (!begun.ok) {
        throw new Error("The structural clipboard session could not be started.");
      }

      let published = false;
      try {
        const selection = await this.prepareSelection(roots);
        const capturedResult = await this.apply(this.boundRuntime.accessContext, {
          operationId: createUuidV7(),
          storeEpoch: this.boundRuntime.source.storeEpoch,
          operation: {
            kind: "apply_structural_edit",
            command: { kind: "capture_clipboard", selection },
          },
        });
        const captured = applyResult(capturedResult);
        const clipboard = captured.clipboard;
        if (!clipboard || !capturedResult.ok) {
          throw new Error("Core omitted the structural clipboard capability.");
        }
        const envelope: NodexClipboardEnvelopeV1 = {
          version: 1,
          profileId: capturedResult.value.profileId,
          libraryId: capturedResult.value.libraryId,
          storeEpoch: clipboard.storeEpoch,
          bundleId: clipboard.bundleId,
          capability: clipboard.capability,
          manifestHash: clipboard.manifestHash,
          actionHint,
        };
        const text = this.boundRuntime.resolveClipboardText
          ? await this.boundRuntime.resolveClipboardText(presentation.text)
          : presentation.text;
        const written = await this.publishClipboard({
          envelope,
          writeClaim,
          html: presentation.html,
          text,
        });
        if (!written.ok) {
          if (written.failure === "superseded") return;
          throw new Error(
            written.failure === "readback_mismatch"
              ? "The system clipboard could not verify the copied structure."
              : "The system clipboard could not be written.",
          );
        }
        published = true;
        if (actionHint === "copy") return;

        let deleted: LibraryStructuralEditResult;
        try {
          const deleteSelection = await this.prepareSelection(roots);
          deleted = applyResult(
            await this.apply(this.boundRuntime.accessContext, {
              operationId: createUuidV7(),
              storeEpoch: this.boundRuntime.source.storeEpoch,
              operation: {
                kind: "apply_structural_edit",
                command: {
                  kind: "delete_selection",
                  selection: deleteSelection,
                  reason: { kind: "cut", bundle: clipboard },
                  direction: "backward",
                },
              },
            }),
          );
        } catch (error) {
          await this.settleClipboard({ writeClaim, outcome: "source_preserved" });
          throw error;
        }
        await this.settleClipboard({ writeClaim, outcome: "cut_committed" });
        this.recordStructuralResult(deleted);
        await this.restoreSelection(deleted);
      } catch (error) {
        if (!published) {
          await this.settleClipboard({
            writeClaim,
            outcome: "failed",
            reason: "capture_failed",
          });
        }
        throw error;
      }
    });
    if (!started) {
      void begin
        .then((result) => {
          if (!result.ok) return;
          return this.settleClipboard({
            writeClaim,
            outcome: "failed",
            reason: "capture_failed",
          });
        })
        .catch(() => undefined);
    }
    return started;
  }

  private async reverseStructural(token: LibraryStructuralHistoryToken) {
    const container = this.boundRuntime.getContainer();
    const document = container?.ownerDocument;
    let userMovedFocus = false;
    this.historyReplayFocusChanged = false;
    const markInteraction = (): void => {
      userMovedFocus = true;
    };
    document?.addEventListener("pointerdown", markInteraction, true);
    document?.addEventListener("keydown", markInteraction, true);
    try {
      const head = await this.boundRuntime.participant.prepareAndFence();
      this.assertSourceHead(head);
      return {
        structuralEdit: applyResult(
          await this.apply(this.boundRuntime.accessContext, {
            operationId: createUuidV7(),
            storeEpoch: this.boundRuntime.source.storeEpoch,
            operation: { kind: "reverse_structural_edit", token },
          }),
        ),
      };
    } finally {
      document?.removeEventListener("pointerdown", markInteraction, true);
      document?.removeEventListener("keydown", markInteraction, true);
      this.historyReplayFocusChanged = userMovedFocus;
    }
  }

  private async releaseStructuralHistory(
    tokens: readonly LibraryStructuralHistoryToken[],
  ): Promise<void> {
    if (tokens.length === 0) return;
    const result = await this.apply(this.boundRuntime.accessContext, {
      operationId: createUuidV7(),
      storeEpoch: this.boundRuntime.source.storeEpoch,
      operation: {
        kind: "apply_structural_edit",
        command: { kind: "release_history", tokens },
      },
    });
    if (!result.ok) throw new Error(result.error.message);
  }

  private deleteRoots(
    roots: readonly StructuralEditorBlock[],
    direction: "backward" | "forward",
  ): boolean {
    if (this.disposed) return false;
    this.start(async () => {
      const selection = await this.prepareSelection(roots);
      const result = applyResult(
        await this.apply(this.boundRuntime.accessContext, {
          operationId: createUuidV7(),
          storeEpoch: this.boundRuntime.source.storeEpoch,
          operation: {
            kind: "apply_structural_edit",
            command: {
              kind: "delete_selection",
              selection,
              reason: { kind: "delete" },
              direction,
            },
          },
        }),
      );
      this.recordStructuralResult(result);
      await this.restoreSelection(result);
    });
    return true;
  }

  private mergeBlockBackward(plan: {
    readonly sourceBlockId: string;
    readonly targetBlockId: string;
  }): boolean {
    if (this.disposed || this.backwardMergePending) return true;
    const source = this.editor.getBlock(plan.sourceBlockId) as StructuralEditorBlock | undefined;
    const joinOffset = this.inlineContentSize(plan.targetBlockId);
    if (!source || joinOffset === null) return false;

    this.backwardMergePending = true;
    this.start(async () => {
      try {
        const selection = await this.prepareSelection([source]);
        const result = applyResult(
          await this.apply(this.boundRuntime.accessContext, {
            operationId: createUuidV7(),
            storeEpoch: this.boundRuntime.source.storeEpoch,
            operation: {
              kind: "apply_structural_edit",
              command: {
                kind: "merge_block_backward",
                selection,
                targetBlockId: plan.targetBlockId,
              },
            },
          }),
        );
        this.recordStructuralResult(result);
        await this.restoreBackwardMergeSelection(plan, joinOffset, result);
      } finally {
        this.backwardMergePending = false;
      }
    });
    return true;
  }

  private inlineContentSize(blockId: string): number | null {
    const view = this.editor.prosemirrorView;
    if (!view) return null;
    const position = getNodeById(blockId, view.state.doc);
    if (!position) return null;
    const info = getBlockInfo(position);
    if (!info.isBlockContainer) return null;
    return info.blockContent.node.content.size;
  }

  private async restoreBackwardMergeSelection(
    plan: { readonly sourceBlockId: string; readonly targetBlockId: string },
    joinOffset: number,
    result: LibraryStructuralEditResult,
  ): Promise<void> {
    if (this.operationFocusChanged || this.historyReplayFocusChanged) return;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (this.operationFocusChanged || this.historyReplayFocusChanged) return;
      const view = this.editor.prosemirrorView;
      if (view && !this.editor.getBlock(plan.sourceBlockId)) {
        const position = getNodeById(plan.targetBlockId, view.state.doc);
        if (position) {
          const info = getBlockInfo(position);
          if (info.isBlockContainer) {
            const offset = Math.min(joinOffset, info.blockContent.node.content.size);
            const cursor = info.blockContent.beforePos + 1 + offset;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor)));
            return;
          }
        }
      }
      await nextAnimationFrame();
    }
    await this.restoreSelection(result, plan.targetBlockId);
  }

  private recordStructuralResult(result: LibraryStructuralEditResult): void {
    this.history.recordStructural(result);
    this.notifyFileOwnershipMoves(result);
  }

  private notifyFileOwnershipMoves(result: LibraryStructuralEditResult): void {
    if (result.fileOwnershipMoves.length === 0) return;
    this.runtime?.onFileOwnershipMoves?.(result.fileOwnershipMoves);
  }

  private start(operation: () => Promise<void>): boolean {
    if (this.disposed) return false;
    const run = async (): Promise<void> => {
      const container = this.boundRuntime.getContainer();
      const document = container?.ownerDocument;
      let userMovedFocus = false;
      this.operationFocusChanged = false;
      this.historyReplayFocusChanged = false;
      const markInteraction = (): void => {
        userMovedFocus = true;
        this.operationFocusChanged = true;
      };
      document?.addEventListener("pointerdown", markInteraction, true);
      document?.addEventListener("keydown", markInteraction, true);
      try {
        await operation();
      } catch (error: unknown) {
        this.boundRuntime.onError?.(
          error instanceof Error ? error.message : "The structural edit could not be completed.",
        );
      } finally {
        document?.removeEventListener("pointerdown", markInteraction, true);
        document?.removeEventListener("keydown", markInteraction, true);
        if (!userMovedFocus) this.restoreFocusIfUnclaimed();
      }
    };
    this.currentOperation = this.currentOperation.then(run);
    return true;
  }

  private async pasteEnvelope(
    envelope: NodexClipboardEnvelopeV1,
    intent: NfmStructuralPasteIntent,
  ): Promise<void> {
    const head = await this.boundRuntime.participant.prepareAndFence();
    this.assertSourceHead(head);
    const command =
      intent.kind === "replace"
        ? {
            kind: "replace_selection" as const,
            selection: {
              sourceDocumentId: this.boundRuntime.source.documentId,
              rootBlockIds: intent.rootBlockIds,
              sourceHead: {
                documentId: head.documentId,
                generation: head.generation,
                expectedHeadSeq: head.expectedHeadSeq,
              },
            },
            replacement: {
              kind: "clipboard" as const,
              bundle: clipboardTokenFromEnvelope(envelope),
            },
          }
        : {
            kind: "paste_clipboard" as const,
            bundle: clipboardTokenFromEnvelope(envelope),
            target: {
              targetDocumentId: this.boundRuntime.source.documentId,
              parentBlockId: intent.parentBlockId,
              beforeBlockId: intent.beforeBlockId,
              targetHead: {
                documentId: head.documentId,
                generation: head.generation,
                expectedHeadSeq: head.expectedHeadSeq,
              },
            },
          };
    const result = applyResult(
      await this.apply(this.boundRuntime.accessContext, {
        operationId: createUuidV7(),
        storeEpoch: this.boundRuntime.source.storeEpoch,
        operation: {
          kind: "apply_structural_edit",
          command,
        },
      }),
    );
    this.recordStructuralResult(result);
    await this.restoreSelection(result, result.resultRootBlockIds.at(-1));
  }

  private envelopeMatchesRuntime(envelope: NodexClipboardEnvelopeV1): boolean {
    return (
      (!this.boundRuntime.libraryId || envelope.libraryId === this.boundRuntime.libraryId) &&
      envelope.storeEpoch === this.boundRuntime.source.storeEpoch
    );
  }

  private async pastePortableBlocks(
    blocks: readonly StructuralEditorBlock[],
    intent: NfmStructuralPasteIntent,
  ): Promise<void> {
    if (blocks.length === 0) {
      throw new Error("The clipboard no longer contains a portable representation.");
    }
    const portableBlocks = blocks.map(withoutPortableBlockIdentity);
    if (intent.kind === "replace") {
      if (intent.rootBlockIds.some((blockId) => !this.editor.getBlock(blockId))) {
        throw new Error("The paste target changed before the clipboard was ready.");
      }
      this.editor.replaceBlocks(intent.rootBlockIds, portableBlocks);
      return;
    }
    if (intent.beforeBlockId && this.editor.getBlock(intent.beforeBlockId)) {
      this.editor.insertBlocks(portableBlocks, intent.beforeBlockId, "before");
      return;
    }
    if (this.editor.getBlock(intent.anchorBlockId)) {
      this.editor.insertBlocks(portableBlocks, intent.anchorBlockId, "after");
      return;
    }
    throw new Error("The paste target changed before the clipboard was ready.");
  }

  private schedulePendingPasteIndicator(intent: NfmStructuralPasteIntent): () => void {
    const blockId =
      intent.kind === "replace"
        ? intent.rootBlockIds[0]
        : (intent.beforeBlockId ?? intent.anchorBlockId);
    if (!blockId || typeof this.editor.transact !== "function") return () => undefined;
    let visible = false;
    const timer = globalThis.setTimeout(() => {
      if (this.disposed || !this.editor.getBlock(blockId)) return;
      visible = true;
      setNfmClipboardPastePending(this.editor, blockId, true);
    }, NFM_CLIPBOARD_PASTE_PENDING_DELAY_MS);
    return () => {
      globalThis.clearTimeout(timer);
      if (!visible) return;
      setNfmClipboardPastePending(this.editor, blockId, false);
    };
  }

  private async prepareSelection(roots: readonly StructuralEditorBlock[]) {
    const head = await this.boundRuntime.participant.prepareAndFence();
    this.assertSourceHead(head);
    return this.selectionFromHead(roots, head);
  }

  private selectionFromHead(
    roots: readonly StructuralEditorBlock[],
    head: {
      readonly documentId: string;
      readonly generation: number;
      readonly expectedHeadSeq: number;
    },
  ) {
    return {
      sourceDocumentId: this.boundRuntime.source.documentId,
      rootBlockIds: roots.map((block) => block.id),
      sourceHead: {
        documentId: head.documentId,
        generation: head.generation,
        expectedHeadSeq: head.expectedHeadSeq,
      },
    };
  }

  private capturePasteIntent(): NfmStructuralPasteIntent | null {
    if (!this.editor.prosemirrorView) return null;

    const selected = selectedStructuralRoots(this.editor);
    if (selected.length) {
      return {
        kind: "replace",
        rootBlockIds: selected.map((block) => block.id),
      };
    }
    const cursor = this.editor.getTextCursorPosition();
    const anchor = cursor.block;
    if (!anchor) throw new Error("The paste target is no longer available.");
    const parent = this.editor.getParentBlock(anchor.id);
    return {
      kind: "insert",
      anchorBlockId: anchor.id,
      parentBlockId: parent?.id ?? null,
      beforeBlockId: cursor.nextBlock?.id ?? null,
    };
  }

  private consumePreparedPasteIntent(): NfmStructuralPasteIntent | null {
    const prepared = this.preparedPasteIntent;
    this.preparedPasteIntent = null;
    return prepared?.intent ?? null;
  }

  private replaceRoots(
    roots: readonly StructuralEditorBlock[],
    blocks: readonly LibraryStructuralReplacementBlock[],
  ): boolean {
    if (this.disposed || roots.length === 0 || blocks.length === 0) return false;
    this.start(async () => {
      const selection = await this.prepareSelection(roots);
      const result = applyResult(
        await this.apply(this.boundRuntime.accessContext, {
          operationId: createUuidV7(),
          storeEpoch: this.boundRuntime.source.storeEpoch,
          operation: {
            kind: "apply_structural_edit",
            command: {
              kind: "replace_selection",
              selection,
              replacement: { kind: "blocks", blocks },
            },
          },
        }),
      );
      this.recordStructuralResult(result);
      await this.restoreSelection(result, result.resultRootBlockIds.at(-1));
    });
    return true;
  }

  private async prepareDuplicateCommand(roots: readonly StructuralEditorBlock[]) {
    const lastRoot = roots.at(-1);
    if (!lastRoot) throw new Error("The duplicate target is no longer available.");
    const parent = this.editor.getParentBlock(lastRoot.id);
    const siblings = parent?.children ?? this.editor.document;
    const rootIndex = siblings.findIndex((block) => block.id === lastRoot.id);
    if (rootIndex < 0) throw new Error("The duplicate target is no longer available.");
    const head = await this.boundRuntime.participant.prepareAndFence();
    this.assertSourceHead(head);
    return {
      selection: this.selectionFromHead(roots, head),
      target: {
        targetDocumentId: this.boundRuntime.source.documentId,
        parentBlockId: parent?.id ?? null,
        beforeBlockId: siblings[rootIndex + 1]?.id ?? null,
        targetHead: {
          documentId: head.documentId,
          generation: head.generation,
          expectedHeadSeq: head.expectedHeadSeq,
        },
      },
    };
  }

  private assertSourceHead(head: {
    readonly documentId: string;
    readonly storeEpoch: string;
    readonly generation: number;
  }): void {
    if (
      head.storeEpoch === this.boundRuntime.source.storeEpoch &&
      head.documentId === this.boundRuntime.source.documentId &&
      head.generation === this.boundRuntime.source.generation
    ) {
      return;
    }
    throw new Error("The editor changed before the structural operation could be fenced.");
  }

  private async restoreSelection(
    result: LibraryStructuralEditResult,
    preferredBlockId?: string,
  ): Promise<void> {
    if (this.operationFocusChanged || this.historyReplayFocusChanged) return;
    const candidates = [
      preferredBlockId,
      result.resume?.blockId,
      result.resume?.fallbackBeforeBlockId,
      result.resume?.fallbackAfterBlockId,
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const blockId of candidates) {
        if (!this.editor.getBlock(blockId)) continue;
        this.editor.setTextCursorPosition(
          blockId,
          blockId === result.resume?.blockId ? result.resume.edge : "end",
        );
        return;
      }
      await nextAnimationFrame();
    }
  }

  private restoreFocusIfUnclaimed(): void {
    const container = this.boundRuntime.getContainer();
    if (!container?.isConnected) return;
    const { activeElement, body, documentElement } = container.ownerDocument;
    if (activeElement && activeElement !== body && activeElement !== documentElement) return;
    try {
      this.editor.focus();
    } catch {
      // The retained editor may have been destroyed while the command was pending.
    }
  }
}

/**
 * Stable structural command entrypoint for one retained BlockNote editor.
 *
 * BlockNote installs clipboard and ProseMirror callbacks when the editor is
 * created, while Page Stage can detach and remount its React view around that
 * same editor. This controller gives those callbacks an editor-lifetime owner
 * and only swaps the live view runtime as views come and go.
 */
export class NfmStructuralEditingController {
  private editor: BlockNoteEditor<any, any, any> | null = null;
  private session: NfmStructuralEditingSession | null = null;
  private activeSession: NfmStructuralEditingSession | null = null;
  private disposed = false;

  get current(): NfmStructuralEditingSession | null {
    return this.activeSession;
  }

  attachEditor(editor: BlockNoteEditor<any, any, any>): NfmStructuralEditingSession {
    if (this.disposed) {
      throw new Error("Cannot attach an editor to a disposed structural editing controller.");
    }
    if (this.editor && this.editor !== editor) {
      throw new Error("A structural editing controller cannot change its editor.");
    }
    if (this.session) return this.session;

    this.editor = editor;
    this.session = new NfmStructuralEditingSession({ editor });
    return this.session;
  }

  activate(session: NfmStructuralEditingSession, runtime: NfmStructuralEditingRuntime): void {
    if (this.disposed || session !== this.session) return;
    session.rebind(runtime);
    this.activeSession = session;
  }

  deactivate(session: NfmStructuralEditingSession): void {
    if (this.activeSession !== session) return;
    this.activeSession = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeSession = null;
    this.session?.dispose();
    this.session = null;
    this.editor = null;
  }
}
