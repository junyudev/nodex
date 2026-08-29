import { getBlockInfo, getNodeById, type BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "@tiptap/pm/state";

import type { ContentAccessContext } from "../../../../shared/content-access-context";
import type { NodexClipboardEnvelopeV1 } from "../../../../shared/clipboard-paste";
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
import { applyLibraryModule, writeStructuralClipboard } from "../../../lib/api";
import { NfmHistoryLane, resolveNfmUndoManager } from "./nfm-editor-history";
import { planBackspaceAcrossAtomicBlocks } from "./atomic-block-backspace";
import { getNfmBlockSelectionIds } from "./nfm-block-selection";
import {
  nfmStructuralClipboardCoordinator,
  type NfmStructuralClipboardCoordinator,
} from "./nfm-structural-clipboard-coordinator";

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
};

type NfmStructuralPasteIntent =
  | {
      readonly kind: "replace";
      readonly rootBlockIds: readonly string[];
    }
  | {
      readonly kind: "insert";
      readonly parentBlockId: string | null;
      readonly beforeBlockId: string | null;
    };

export interface NfmStructuralEditingSessionOptions {
  readonly editor: BlockNoteEditor<any, any, any>;
  readonly historyLane?: NfmHistoryLane | null;
  readonly apply?: typeof applyLibraryModule;
  readonly writeClipboard?: typeof writeStructuralClipboard;
  readonly clipboardCoordinator?: NfmStructuralClipboardCoordinator;
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
  readonly onError?: (message: string) => void;
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

/**
 * One retained editor surface's structural input owner. React provides stable
 * runtime dependencies; this session owns command ordering, history and focus.
 */
export class NfmStructuralEditingSession {
  private readonly editor: StructuralEditor;
  private readonly apply: typeof applyLibraryModule;
  private readonly writeClipboard: typeof writeStructuralClipboard;
  private readonly history: NfmHistoryLane;
  private readonly clipboardCoordinator: NfmStructuralClipboardCoordinator;
  private readonly ownsHistory: boolean;
  private readonly detachHistory: () => void;
  private disposed = false;
  private currentOperation: Promise<void> = Promise.resolve();
  private historyReplayFocusChanged = false;
  private operationFocusChanged = false;
  private backwardMergePending = false;
  private runtime: NfmStructuralEditingRuntime | null;

  constructor(options: NfmStructuralEditingSessionOptions) {
    this.editor = options.editor as StructuralEditor;
    this.apply = options.apply ?? applyLibraryModule;
    this.writeClipboard = options.writeClipboard ?? writeStructuralClipboard;
    this.clipboardCoordinator = options.clipboardCoordinator ?? nfmStructuralClipboardCoordinator;
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

  handleCopy(presentation: NfmStructuralClipboardPresentation): string | null {
    return this.captureClipboard("copy", presentation);
  }

  handleCut(presentation: NfmStructuralClipboardPresentation): string | null {
    return this.captureClipboard("cut", presentation);
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

  handlePendingPaste(pendingEnvelope: Promise<NodexClipboardEnvelopeV1 | null>): boolean {
    if (this.disposed) return false;
    const intent = this.capturePasteIntent();
    if (!intent) return false;
    return this.start(async () => {
      const envelope = await pendingEnvelope;
      if (!envelope) throw new Error("The structural clipboard could not be prepared.");
      if (this.boundRuntime.libraryId && envelope.libraryId !== this.boundRuntime.libraryId) {
        throw new Error("Structural clipboard content belongs to another Library.");
      }
      if (envelope.storeEpoch !== this.boundRuntime.source.storeEpoch) {
        throw new Error("Structural clipboard content belongs to another Store generation.");
      }
      await this.pasteEnvelope(envelope, intent);
    });
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
    this.detachHistory();
    if (this.ownsHistory) this.history.dispose();
  }

  private captureClipboard(
    actionHint: "copy" | "cut",
    presentation: NfmStructuralClipboardPresentation,
  ): string | null {
    if (this.disposed) return null;
    this.clipboardCoordinator.supersedePending();
    const roots = structuralRoots(this.editor);
    if (!hasTypedOwnerBlock(roots)) return null;
    const writeClaim = createUuidV7();
    const pendingCapture = this.clipboardCoordinator.beginCapture({
      libraryId: this.boundRuntime.libraryId,
      storeEpoch: this.boundRuntime.source.storeEpoch,
      writeClaim,
      presentation,
    });
    const started = this.start(async () => {
      let envelope: NodexClipboardEnvelopeV1 | null = null;
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
        envelope = {
          version: 1,
          profileId: capturedResult.value.profileId,
          libraryId: capturedResult.value.libraryId,
          storeEpoch: clipboard.storeEpoch,
          bundleId: clipboard.bundleId,
          capability: clipboard.capability,
          manifestHash: clipboard.manifestHash,
          actionHint,
        };
        const written = await this.writeClipboard({
          envelope,
          writeClaim,
          html: presentation.html,
          text: presentation.text,
        });
        if (!written.ok) {
          if (written.failure === "superseded") return;
          envelope = null;
          throw new Error(
            written.failure === "readback_mismatch"
              ? "The system clipboard could not verify the copied structure."
              : "The system clipboard could not be written.",
          );
        }
        if (actionHint === "copy") return;

        const deleteSelection = await this.prepareSelection(roots);
        const deleted = applyResult(
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
        this.recordStructuralResult(deleted);
        await this.restoreSelection(deleted);
      } finally {
        pendingCapture.complete(envelope);
      }
    });
    if (started) return writeClaim;
    pendingCapture.complete(null);
    return null;
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
      parentBlockId: parent?.id ?? null,
      beforeBlockId: cursor.nextBlock?.id ?? null,
    };
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
