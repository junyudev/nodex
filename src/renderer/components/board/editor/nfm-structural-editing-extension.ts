import { getBlockInfo, getNodeById, type BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "@tiptap/pm/state";

import {
  abandonPromotion,
  abandonStructuralHistory,
  promotionRetentionResources,
  releaseStructuralHistory,
} from "../../../lib/surface-history/structural-resources";
import {
  contentAccessContextKey,
  type ContentAccessContext,
} from "../../../../shared/content-access-context";
import { canRetryNfmHistory } from "./nfm-history-command";
import type {
  NodexClipboardEnvelopeV1,
  NodexStructuralClipboardDescriptorV1,
  StructuralClipboardResolution,
} from "../../../../shared/clipboard-paste";
import type {
  LibraryApplyOperation,
  LibraryModuleApplyResult,
  LibraryStructuralClipboardToken,
  LibraryStructuralEditResult,
  LibraryStructuralHistoryToken,
  LibraryStructuralReplacementBlock,
  LibraryStructuralTurnIntoTarget,
} from "../../../../shared/library-module";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { hasTypedOwnerBlock, type TypedOwnerBlockLike } from "../../../lib/typed-owner-blocks";
import {
  resolveBlockDocumentStructuralMutationParticipantByDocumentId,
  type BlockDocumentStructuralMutationParticipant,
} from "../../../lib/block-document-mutation-registry";
import {
  applyLibraryModule,
  readLibraryModule,
  awaitStructuralClipboard,
  beginStructuralClipboard,
  publishStructuralClipboard,
  settleStructuralClipboard,
  transferBlocks,
} from "../../../lib/api";
import {
  prepareNfmBlockPromotion,
  type NfmBlockMoveRequest,
} from "../../../lib/nfm-block-move-runtime";
import type { SurfaceHistorySelectionPair, YUndoExtension } from "@blocknote/core/yjs";
import { NfmHistoryLane } from "./nfm-editor-history";
import type { SurfaceHistoryControls } from "../../../lib/surface-history/controls";
import type { SurfaceHistoryDirection } from "../../../../shared/surface-history";
import {
  acquireContentInteractionHistory,
  contentInteractionHistoryScopeKey,
  type ContentInteractionHistoryScope,
} from "../../../lib/content-interaction-history";
import type {
  HistoryCommandHandle,
  HistoryCommandOutcome,
  HistoryPreparation,
  InteractionHistory,
} from "../../../lib/surface-history/owner";
import type {
  NfmHistoryCommand,
  NfmHistoryRequest,
  NfmLibraryHistoryRequest,
  NfmHistoryReceipt,
  NfmHistoryPresentation,
  NfmPageMentionIntent,
  NfmReceivingPageTransferIntent,
  NfmStructuralTransferIntent,
  NfmStructuralPasteIntent,
  NfmStructuralDocumentTarget,
  NfmStructuralClipboardPresentation,
} from "./nfm-history-command";
export type {
  NfmStructuralDocumentTarget,
  NfmStructuralClipboardPresentation,
} from "./nfm-history-command";
import { NfmTextHistoryJournal } from "./nfm-text-history-journal";
import { NfmLocalHistoryRetention } from "./nfm-local-history-retention";
import {
  coreHistoryReconciliation,
  type NfmHistoryReconciliation,
} from "./nfm-history-reconciliation";
import { planBackspaceAcrossAtomicBlocks } from "./atomic-block-backspace";
import { getNfmBlockSelectionIds } from "./nfm-block-selection";
import { setNfmClipboardPastePending } from "./nfm-clipboard-paste-pending-extension";
import {
  DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
  assertDocumentWaitActive,
  waitForDocumentOperation,
  DocumentWaitError,
} from "../../../lib/document-wait";

export const NFM_CLIPBOARD_PASTE_PENDING_DELAY_MS = 150;

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

export interface NfmStructuralEditingSessionOptions {
  readonly editor: BlockNoteEditor<any, any, any>;
  readonly historyLane?: NfmHistoryLane | null;
  readonly interactionHistory?: InteractionHistory;
  readonly historyReconciliation?: NfmHistoryReconciliation;
  readonly apply?: typeof applyLibraryModule;
  readonly preparePromotion?: typeof prepareNfmBlockPromotion;
  readonly transfer?: typeof transferBlocks;
  readonly beginClipboard?: typeof beginStructuralClipboard;
  readonly publishClipboard?: typeof publishStructuralClipboard;
  readonly settleClipboard?: typeof settleStructuralClipboard;
  readonly awaitClipboard?: typeof awaitStructuralClipboard;
  readonly runtime?: NfmStructuralEditingRuntime;
}

export interface NfmStructuralEditingRuntime {
  readonly accessContext: ContentAccessContext;
  readonly libraryId: string;
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

const isFileLocator = (value: unknown): value is string =>
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
  if (record.type === "attachment" && props && isFileLocator(props.source)) {
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
  const imageLocator = isFileLocator(props.url) || isFileLocator(props.source);
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
  block: LibraryStructuralReplacementBlock,
): Readonly<Record<string, unknown>> => ({
  type: block.blockType,
  props: block.props ?? {},
  content: block.content ?? [],
  children: (block.children ?? []).map(withoutPortableBlockIdentity),
});

/**
 * One retained editor surface's structural input owner. React provides stable
 * runtime dependencies; semantic preparation and presentation use the shared history owner.
 */
export class NfmStructuralEditingSession {
  private readonly editor: StructuralEditor;
  private readonly apply: typeof applyLibraryModule;
  private readonly preparePromotion: typeof prepareNfmBlockPromotion;
  private readonly transfer: typeof transferBlocks;
  private readonly cleanupTransfer: typeof transferBlocks | undefined;
  private readonly cleanupApply: typeof applyLibraryModule | undefined;
  private readonly localRetention: NfmLocalHistoryRetention | undefined;
  private readonly beginClipboard: typeof beginStructuralClipboard;
  private readonly publishClipboard: typeof publishStructuralClipboard;
  private readonly settleClipboard: typeof settleStructuralClipboard;
  private readonly awaitClipboard: typeof awaitStructuralClipboard;
  private readonly history: NfmHistoryLane;
  private readonly ownsHistory: boolean;
  private readonly detachHistory: () => void;
  private readonly unbindHistory: () => void;
  private readonly historyReconciliation: NfmHistoryReconciliation;
  private unsubscribeHistoryChanges: (() => void) | undefined;
  private reconciliationRequested = false;
  private reconciliationTask: Promise<void> | undefined;
  private disposed = false;
  private readonly admissions = new WeakMap<
    NfmHistoryCommand,
    {
      cancellationVersion: number;
      deadlineAt: number;
      focusRevision: number;
      controller: AbortController;
      clipboardPublished?: boolean;
    }
  >();
  private focusRevision = 0;
  private focusDocument: Document | null = null;
  private readonly preparationLifetime = new AbortController();
  private readonly preparationWaits = new Set<AbortController>();
  private cancellationVersion = 0;
  private activeOperationVersion: number | undefined;
  private operationDeadlineAt: number | undefined;
  private backwardMergePending = false;
  private preparedPasteIntent: {
    readonly token: symbol;
    readonly intent: NfmStructuralPasteIntent;
  } | null = null;
  private runtime: NfmStructuralEditingRuntime | null;

  constructor(options: NfmStructuralEditingSessionOptions) {
    this.editor = options.editor as StructuralEditor;
    this.preparePromotion = options.preparePromotion ?? prepareNfmBlockPromotion;
    this.transfer = options.transfer ?? transferBlocks;
    this.cleanupTransfer = options.transfer;
    this.historyReconciliation = options.historyReconciliation ?? coreHistoryReconciliation;
    const apply = options.apply ?? applyLibraryModule;
    this.cleanupApply = options.apply;
    this.apply = (...args) =>
      waitForDocumentOperation(() => apply(...args), { signal: this.preparationLifetime.signal });
    this.beginClipboard = options.beginClipboard ?? beginStructuralClipboard;
    this.publishClipboard = options.publishClipboard ?? publishStructuralClipboard;
    this.settleClipboard = options.settleClipboard ?? settleStructuralClipboard;
    this.awaitClipboard = options.awaitClipboard ?? awaitStructuralClipboard;
    this.runtime = options.runtime ?? null;
    const backend = options.editor.getExtension<typeof YUndoExtension>("yUndo");
    if (!backend) throw new Error("NFM requires a registered collaborative history backend.");
    const journal = options.historyLane
      ? undefined
      : new NfmTextHistoryJournal(backend.fragment, backend.undoManager);
    this.localRetention = journal
      ? new NfmLocalHistoryRetention(backend.undoManager.doc, journal, {
          scope: () => this.boundRuntime,
          apply: options.apply,
          release: options.apply
            ? async (access, request) => {
                const result = await options.apply!(access, request);
                if (!result.ok) throw new Error(result.error.message);
              }
            : undefined,
          onError: (error) =>
            this.runtime?.onError?.(
              error instanceof Error ? error.message : "History retention failed.",
            ),
        })
      : undefined;
    this.history =
      options.historyLane ??
      new NfmHistoryLane({
        interactionHistory: options.interactionHistory,
        undoManager: backend.undoManager,
        textHistory: journal,
        textSelection: backend.getSemanticSelection,
      });
    this.unbindHistory = backend.bindHistory({
      beforeLocalCapture: () => this.history.beforeLocalCapture(),
      canUndo: () => this.history.canUndo(),
      canRedo: () => this.history.canRedo(),
      requestUndo: () => this.requestHistory("undo"),
      requestRedo: () => this.requestHistory("redo"),
    });
    this.ownsHistory = this.history !== options.historyLane;
    this.detachHistory = this.history.attach({
      prepareCommand: (command) => this.prepareCommand(command),
      prepareStructuralReverse: (token, selection) =>
        this.prepareHistory({ kind: "reverse_structural_edit", token }, selection),
      prepareTextReverse: (patch, selection) =>
        this.prepareHistory(
          {
            kind: "apply_structural_edit",
            command: {
              kind: "restore_editor_history",
              documentId: this.boundRuntime.source.documentId,
              generation: this.boundRuntime.source.generation,
              patch,
            },
          },
          selection,
        ),
      submit: (request) => this.submitCommand(request),
      releaseStructural: (tokens) => this.releaseStructuralHistory(tokens),
      abandonCommand: (request) => this.abandonCommand(request),
      reconcileStructural: (tokens) =>
        this.historyReconciliation.read(this.reconciliationScope, tokens),
      onCommitted: (receipt) => this.presentReceipt(receipt),
      onError: (error) => this.reportError(error),
    });
    this.bindFocusDocument();
    this.subscribeHistoryChanges();
  }

  /** Rebinds live Document authority without replacing the surface command queue. */
  rebind(runtime: NfmStructuralEditingRuntime): void {
    if (this.disposed) return;
    if (
      this.runtime &&
      (this.runtime.source.documentId !== runtime.source.documentId ||
        this.runtime.source.storeEpoch !== runtime.source.storeEpoch ||
        this.runtime.source.generation !== runtime.source.generation ||
        this.runtime.libraryId !== runtime.libraryId ||
        contentAccessContextKey(this.runtime.accessContext) !==
          contentAccessContextKey(runtime.accessContext))
    ) {
      throw new Error("A structural editing session cannot change its Document authority.");
    }
    this.runtime = runtime;
    this.bindFocusDocument();
    this.subscribeHistoryChanges();
  }

  private get reconciliationScope() {
    const runtime = this.boundRuntime;
    return {
      libraryId: runtime.libraryId,
      accessContext: runtime.accessContext,
      storeEpoch: runtime.source.storeEpoch,
    };
  }

  private subscribeHistoryChanges(): void {
    if (!this.runtime || this.unsubscribeHistoryChanges) return;
    this.unsubscribeHistoryChanges = this.historyReconciliation.subscribe(
      this.reconciliationScope,
      this.requestReconciliation,
    );
  }

  private readonly requestReconciliation = (): void => {
    if (this.disposed) return;
    this.reconciliationRequested = true;
    if (this.reconciliationTask) return;
    this.reconciliationTask = (async () => {
      while (this.reconciliationRequested && !this.disposed) {
        this.reconciliationRequested = false;
        try {
          await this.history.reconcile();
        } catch (error) {
          this.runtime?.onError?.(
            error instanceof Error ? error.message : "History reconciliation failed.",
          );
        }
      }
    })().finally(() => {
      this.reconciliationTask = undefined;
      if (this.reconciliationRequested) this.requestReconciliation();
    });
  };

  private get boundRuntime(): NfmStructuralEditingRuntime {
    if (this.runtime) return this.runtime;
    throw new Error("The editor surface is not ready for structural editing.");
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.disposed || event.isComposing || this.editor.prosemirrorView?.composing) return false;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && event.key.toLowerCase() === "z") {
      return this.requestHistory(event.shiftKey ? "redo" : "undo");
    }
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "y") {
      return this.requestHistory("redo");
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
    const roots = this.resolveRoots(rootBlockIds);
    if (!hasTypedOwnerBlock(roots)) return false;
    return this.start({ kind: "duplicate", roots: [...rootBlockIds] });
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
    return this.start({
      kind: "turn_into",
      roots: [...rootBlockIds],
      target: structuredClone(target),
    });
  }

  moveBlocksToDocument(
    rootBlockIds: readonly string[],
    prepareTarget: () => Promise<NfmStructuralDocumentTarget>,
  ): boolean {
    const roots = this.resolveRoots(rootBlockIds);
    if (roots.length === 0 || roots.length !== rootBlockIds.length) return false;
    return this.start({ kind: "move_to_document", roots: [...rootBlockIds], prepareTarget });
  }

  async transferBlocks(transfer: NfmStructuralTransferIntent): Promise<void> {
    await this.completeCommand({
      kind: "transfer",
      transfer: {
        ...transfer,
        rootBlockIds: [...transfer.rootBlockIds],
        target: { ...transfer.target },
      },
    });
  }

  async createPageMention(mention: NfmPageMentionIntent): Promise<void> {
    await this.completeCommand({ kind: "page_mention", mention: structuredClone(mention) });
  }

  async promoteBlocks(promotion: Omit<NfmBlockMoveRequest, "sourceHead">): Promise<void> {
    await this.completeCommand({ kind: "promotion", promotion: structuredClone(promotion) });
  }

  async receivePages(transfer: NfmReceivingPageTransferIntent): Promise<void> {
    await this.completeCommand({ kind: "receive_pages", transfer: structuredClone(transfer) });
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
    return this.start({ kind: "paste", envelope: structuredClone(envelope), target: intent });
  }

  handleStructuralClaimPaste(
    descriptor: NodexStructuralClipboardDescriptorV1,
    portableBlocks: readonly StructuralEditorBlock[],
  ): boolean {
    if (this.disposed) return false;
    const intent = this.consumePreparedPasteIntent() ?? this.capturePasteIntent();
    if (!intent) return false;
    return this.start({
      kind: "paste_claim",
      descriptor: structuredClone(descriptor),
      portableBlocks: portableBlocks.map(sanitizePortableFallbackBlock).map(toReplacementBlock),
      target: intent,
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
    if (this.disposed || event.isComposing || this.editor.prosemirrorView?.composing) return false;
    if (event.inputType === "historyUndo") return this.requestHistory("undo");
    if (event.inputType === "historyRedo") return this.requestHistory("redo");
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

  /** A foreign participant's fence may blur this input; preserve the invoking view. */
  private requestHistory(direction: SurfaceHistoryDirection): boolean {
    if (this.disposed) return false;
    const container = this.runtime?.getContainer();
    const document = container?.ownerDocument;
    const active = document?.activeElement;
    const ownsInput =
      container?.isConnected &&
      (!active ||
        active === document?.body ||
        active === document?.documentElement ||
        container.contains(active));
    const focusRevision = this.focusRevision;
    const handle = this.history.requestHistory(direction);
    if (ownsInput)
      void handle.result
        .then(() => {
          if (this.disposed || focusRevision !== this.focusRevision) return;
          this.restoreFocusIfUnclaimed();
        })
        .catch((error: unknown) => this.reportError(error));
    return true;
  }

  whenIdle(): Promise<void> {
    return this.history.whenIdle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.preparationLifetime.abort();
    this.bindFocusDocument(null);
    void this.localRetention
      ?.close()
      .catch((error: unknown) =>
        this.runtime?.onError?.(error instanceof Error ? error.message : "History cleanup failed."),
      );
    this.unsubscribeHistoryChanges?.();
    this.preparedPasteIntent = null;
    this.detachHistory();
    this.unbindHistory();
    if (this.ownsHistory) this.history.dispose();
  }

  async close(): Promise<void> {
    this.dispose();
    await Promise.all([
      this.localRetention?.close(),
      this.ownsHistory ? this.history.close() : undefined,
    ]);
  }

  private captureClipboard(
    action: "copy" | "cut",
    rootBlockIds: readonly string[],
    presentation: NfmStructuralClipboardPresentation,
    writeClaim: string,
  ): boolean {
    const roots = this.resolveRoots(rootBlockIds);
    if (roots.length === 0 || roots.length !== rootBlockIds.length) return false;
    return this.start({
      kind: "clipboard",
      action,
      roots: [...rootBlockIds],
      presentation: { ...presentation },
      writeClaim,
    });
  }

  private async abandonCommand(attempt: NfmHistoryRequest): Promise<void> {
    if (attempt.kind === "block_transfer") {
      if (!this.cleanupTransfer) return abandonPromotion(attempt.request);
      // An injected transport stands in for Main's exact-attempt owner.
      const result = await this.cleanupTransfer(attempt.request.projectId, attempt.request);
      if (!result.ok) {
        if (result.error.code === "unknown") throw new Error(result.error.message);
        return;
      }
      await this.releaseStructuralHistory(promotionRetentionResources(result.value));
      return;
    }
    if (this.cleanupApply) {
      // The injected transport owns its outstanding response, just as Main owns production attempts.
      void this.cleanupApply(attempt.accessContext, attempt.request)
        .then(async (result) => {
          if (!result.ok && result.error.code === "unknown") throw new Error(result.error.message);
          const token = result.ok ? result.value.structuralEdit?.history : undefined;
          if (token) await this.releaseStructuralHistory([token]);
        })
        .catch((error: unknown) => this.reportError(error));
      return;
    }
    await abandonStructuralHistory(attempt.accessContext, attempt.request);
  }

  private async releaseStructuralHistory(
    tokens: readonly LibraryStructuralHistoryToken[],
  ): Promise<void> {
    await releaseStructuralHistory(
      this.boundRuntime.accessContext,
      this.boundRuntime.source.storeEpoch,
      tokens,
      this.cleanupApply,
    );
  }

  private deleteRoots(
    roots: readonly StructuralEditorBlock[],
    direction: "backward" | "forward",
  ): boolean {
    return this.start({ kind: "delete", roots: roots.map((block) => block.id), direction });
  }

  private mergeBlockBackward(plan: {
    readonly sourceBlockId: string;
    readonly targetBlockId: string;
  }): boolean {
    if (this.disposed || this.backwardMergePending) return true;
    const source = this.editor.getBlock(plan.sourceBlockId);
    const joinOffset = this.inlineContentSize(plan.targetBlockId);
    if (!source || joinOffset === null) return false;
    this.backwardMergePending = true;
    const handle = this.executeCommand({
      kind: "merge_backward",
      sourceBlockId: plan.sourceBlockId,
      targetBlockId: plan.targetBlockId,
      joinOffset,
    });
    void handle.result.finally(() => {
      this.backwardMergePending = false;
    });
    return handle.accepted;
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
    focusRevision: number,
  ): Promise<void> {
    if (this.disposed || focusRevision !== this.focusRevision) return;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (this.disposed || focusRevision !== this.focusRevision) return;
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
    await this.restoreSelection(result, plan.targetBlockId, focusRevision);
  }

  cancelPreparations = (): void => {
    this.cancellationVersion += 1;
    this.preparationWaits.forEach((controller) => controller.abort());
  };

  private resolveRoots(ids: readonly string[]): readonly StructuralEditorBlock[] {
    return ids
      .map((id) => this.editor.getBlock(id) as StructuralEditorBlock | undefined)
      .filter((block): block is StructuralEditorBlock => Boolean(block));
  }

  private executeCommand(command: NfmHistoryCommand): HistoryCommandHandle<NfmHistoryReceipt> {
    this.admissions.set(command, {
      cancellationVersion: this.cancellationVersion,
      deadlineAt: Date.now() + DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
      focusRevision: ++this.focusRevision,
      controller: new AbortController(),
    });
    return this.history.execute(command);
  }

  private start(command: NfmHistoryCommand): boolean {
    if (this.disposed || !this.runtime) return false;
    return this.executeCommand(command).accepted;
  }

  private async completeCommand(command: NfmHistoryCommand): Promise<void> {
    const resolution = await this.executeCommand(command).result;
    if (resolution.status !== "committed" && resolution.status !== "noop")
      throw new Error(resolution.reason);
    await this.whenIdle();
  }

  recoverHistory(): Promise<void> {
    this.history.recover();
    return this.whenIdle();
  }

  get historyControls(): SurfaceHistoryControls {
    return this.history;
  }

  private readonly markFocusInteraction = (event: Event): void => {
    this.focusRevision++;
    if (event.type === "keydown" && (event as KeyboardEvent).key === "Escape")
      this.cancelPreparations();
  };

  private bindFocusDocument(
    document: Document | null = this.runtime?.getContainer()?.ownerDocument ?? null,
  ): void {
    if (this.focusDocument === document) return;
    for (const type of ["pointerdown", "keydown", "beforeinput"])
      this.focusDocument?.removeEventListener(type, this.markFocusInteraction, true);
    this.focusDocument = document;
    for (const type of ["pointerdown", "keydown", "beforeinput"])
      document?.addEventListener(type, this.markFocusInteraction, true);
  }

  private reportError(error: unknown): void {
    this.runtime?.onError?.(
      error instanceof Error ? error.message : "The content command could not be completed.",
    );
  }

  private requestFor(
    operation: LibraryApplyOperation,
    presentation: NfmHistoryPresentation,
    replay = false,
  ): NfmLibraryHistoryRequest {
    return {
      kind: "library",
      accessContext: this.boundRuntime.accessContext,
      request: {
        operationId: createUuidV7(),
        storeEpoch: this.boundRuntime.source.storeEpoch,
        operation,
      },
      presentation,
      replay,
    };
  }

  private async prepareCommand(
    command: NfmHistoryCommand,
  ): Promise<HistoryPreparation<NfmHistoryRequest, NfmHistoryReceipt>> {
    const admission = this.admissions.get(command);
    if (this.disposed || !admission || admission.cancellationVersion !== this.cancellationVersion)
      throw new DocumentWaitError("cancelled");
    this.activeOperationVersion = admission.cancellationVersion;
    this.operationDeadlineAt = admission.deadlineAt;
    const presentation: NfmHistoryPresentation = { focusRevision: admission.focusRevision };
    const controller = admission.controller;
    this.preparationWaits.add(controller);
    try {
      return await this.waitForGesture(command, () => this.prepareGesture(command, presentation));
    } catch (error) {
      if (command.kind === "clipboard")
        await this.settleClipboardSafely(
          admission.clipboardPublished
            ? { writeClaim: command.writeClaim, outcome: "source_preserved" }
            : { writeClaim: command.writeClaim, outcome: "failed", reason: "capture_failed" },
        );
      throw error;
    } finally {
      controller.abort();
      this.preparationWaits.delete(controller);
      this.activeOperationVersion = undefined;
      this.operationDeadlineAt = undefined;
    }
  }

  private waitForGesture<T>(command: NfmHistoryCommand, operation: () => Promise<T>): Promise<T> {
    const admission = this.admissions.get(command);
    if (!admission) return Promise.reject(new DocumentWaitError("cancelled"));
    return waitForDocumentOperation(operation, {
      signal: AbortSignal.any([admission.controller.signal, this.preparationLifetime.signal]),
      deadlineAt: admission.deadlineAt,
    });
  }

  private assertGestureActive(command: NfmHistoryCommand): void {
    const admission = this.admissions.get(command);
    if (!admission || admission.cancellationVersion !== this.cancellationVersion)
      throw new DocumentWaitError("cancelled");
    assertDocumentWaitActive({
      signal: this.preparationLifetime.signal,
      deadlineAt: admission.deadlineAt,
    });
  }

  private async prepareGesture(
    command: NfmHistoryCommand,
    presentation: NfmHistoryPresentation,
  ): Promise<HistoryPreparation<NfmHistoryRequest, NfmHistoryReceipt>> {
    switch (command.kind) {
      case "receive_pages": {
        const { transfer } = command;
        const runtime = this.boundRuntime;
        if (
          transfer.storeEpoch !== runtime.source.storeEpoch ||
          (runtime.accessContext.kind === "project" &&
            transfer.projectId !== runtime.accessContext.projectId) ||
          (transfer.target.kind === "document" &&
            transfer.target.documentId !== runtime.source.documentId)
        )
          throw new Error("The receiving Page changed; start the drag again.");
        const head = await this.prepareAndFence();
        this.assertSourceHead(head);
        return {
          kind: "submit",
          request: {
            kind: "block_transfer",
            presentation,
            request: {
              operationId: createUuidV7(),
              projectId: transfer.projectId,
              storeEpoch: transfer.storeEpoch,
              mode: transfer.mode,
              rootBlockIds: transfer.rootBlockIds,
              source: { kind: "data_source", dataSourceId: transfer.dataSourceId },
              target: transfer.target,
              causalDependencies: [
                {
                  documentId: head.documentId,
                  generation: head.generation,
                  expectedHeadSeq: head.expectedHeadSeq,
                },
              ],
              promotionPolicy: "literal",
            },
          },
        };
      }
      case "promotion": {
        const { promotion } = command;
        const runtime = this.boundRuntime;
        if (
          promotion.sourceDocumentId !== runtime.source.documentId ||
          promotion.storeEpoch !== runtime.source.storeEpoch ||
          promotion.sourceDocumentGeneration !== runtime.source.generation ||
          (runtime.accessContext.kind === "project" &&
            promotion.projectId !== runtime.accessContext.projectId)
        )
          throw new Error("The source Page changed; reopen it before moving Blocks.");
        const sourceHead = await this.prepareAndFence();
        this.assertSourceHead(sourceHead);
        const request = await this.preparePromotion({ ...promotion, sourceHead });
        return { kind: "submit", request: { kind: "block_transfer", request, presentation } };
      }
      case "clipboard":
        return this.prepareClipboard(command, presentation);
      case "paste_claim":
        return this.prepareClaimPaste(command, presentation);
      case "paste":
        return {
          kind: "submit",
          request: await this.preparePaste(command.envelope, command.target, presentation),
        };
      case "page_mention":
        return {
          kind: "submit",
          request: await this.preparePageMention(command.mention, presentation),
        };
      case "transfer": {
        const { transfer } = command;
        const { sourceHead, targetHead } = await transfer.prepareHeads();
        this.assertSourceHead(sourceHead);
        if (targetHead.storeEpoch !== this.boundRuntime.source.storeEpoch)
          throw new Error("The target belongs to another Store generation.");
        return {
          kind: "submit",
          request: this.requestFor(
            {
              kind: "apply_structural_edit",
              command: {
                kind: transfer.mode === "move" ? "move_selection" : "duplicate_selection",
                selection: this.selectionFromHead(transfer.rootBlockIds, sourceHead),
                target: {
                  targetDocumentId: targetHead.documentId,
                  ...transfer.target,
                  targetHead: {
                    documentId: targetHead.documentId,
                    generation: targetHead.generation,
                    expectedHeadSeq: targetHead.expectedHeadSeq,
                  },
                },
              },
            },
            { ...presentation, preferredBlockId: transfer.preferredSelectionBlockId },
          ),
        };
      }
      case "duplicate": {
        const { selection, target } = await this.prepareDuplicateCommand(command.roots);
        return {
          kind: "submit",
          request: this.requestFor(
            {
              kind: "apply_structural_edit",
              command: { kind: "duplicate_selection", selection, target },
            },
            presentation,
          ),
        };
      }
      case "move_to_document": {
        const target = await command.prepareTarget();
        if (target.storeEpoch !== this.boundRuntime.source.storeEpoch)
          throw new Error("The target belongs to another Store generation.");
        const selection = await this.prepareSelection(command.roots);
        return {
          kind: "submit",
          request: this.requestFor(
            {
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
            presentation,
          ),
        };
      }
      case "merge_backward": {
        const selection = await this.prepareSelection([command.sourceBlockId]);
        return {
          kind: "submit",
          request: this.requestFor(
            {
              kind: "apply_structural_edit",
              command: {
                kind: "merge_block_backward",
                selection,
                targetBlockId: command.targetBlockId,
              },
            },
            { ...presentation, merge: command },
          ),
        };
      }
      case "delete": {
        const selection = await this.prepareSelection(command.roots);
        return {
          kind: "submit",
          request: this.requestFor(
            {
              kind: "apply_structural_edit",
              command: {
                kind: "delete_selection",
                selection,
                direction: command.direction,
                reason: { kind: "delete" },
              },
            },
            presentation,
          ),
        };
      }
      case "turn_into": {
        const selection = await this.prepareSelection(command.roots);
        return {
          kind: "submit",
          request: this.requestFor(
            {
              kind: "apply_structural_edit",
              command: { kind: "turn_selection_into", selection, target: command.target },
            },
            presentation,
          ),
        };
      }
      case "replace": {
        const selection = await this.prepareSelection(command.roots);
        return {
          kind: "submit",
          request: this.requestFor(
            {
              kind: "apply_structural_edit",
              command: {
                kind: "replace_selection",
                selection,
                replacement: { kind: "blocks", blocks: command.blocks },
              },
            },
            presentation,
          ),
        };
      }
    }
  }

  private async prepareHistory(
    operation: LibraryApplyOperation,
    selection?: SurfaceHistorySelectionPair,
  ): Promise<NfmHistoryRequest> {
    const focusRevision = this.focusRevision;
    const head = await this.prepareAndFence();
    this.assertSourceHead(head);
    return this.requestFor(operation, { focusRevision, selection }, true);
  }

  private async submitCommand(
    attempt: NfmHistoryRequest,
  ): Promise<HistoryCommandOutcome<NfmHistoryReceipt>> {
    if (attempt.kind !== "library") {
      const outcome = await this.transfer(attempt.request.projectId, attempt.request);
      if (!outcome.ok) {
        const { error } = outcome;
        if (error.code === "unknown") return { kind: "unknown", reason: error.message };
        if (error.code === "recovery_required")
          return { kind: "unrecoverable", reason: error.message };
        return {
          kind: "rejected",
          reason: error.message,
          retryable: error.retryable || error.code === "undo_conflict",
        };
      }
      const result = outcome.value;
      return {
        kind: "committed",
        receipt: { kind: "block_transfer", result },
      };
    }
    const result = await this.apply(attempt.accessContext, attempt.request);
    if (!result.ok) {
      const { error } = result;
      if (error.code === "unknown") return { kind: "unknown", reason: error.message };
      // Expiry cannot prove whether Cut committed; retain its claim and the barrier.
      if (error.code === "recovery_required")
        return { kind: "unrecoverable", reason: error.message };
      if (attempt.presentation.cutClaim)
        await this.settleClipboardSafely({
          writeClaim: attempt.presentation.cutClaim,
          outcome: "source_preserved",
        });
      return { kind: "rejected", reason: error.message, retryable: canRetryNfmHistory(error) };
    }
    const structural = result.value.structuralEdit;
    const operation = attempt.request.operation;
    const invalidMention =
      operation.kind === "create_page_mention" &&
      (result.value.createdTarget?.kind !== "page" ||
        result.value.createdTarget.pageId !== operation.pageId);
    if (!structural || invalidMention) {
      if (structural?.history)
        void this.releaseStructuralHistory([structural.history]).catch((error: unknown) =>
          this.reportError(error),
        );
      return {
        kind: "committed",
        receipt: {
          kind: "barrier",
          reason: "The action committed without a complete structural receipt.",
        },
      };
    }
    return {
      kind: "committed",
      receipt: {
        kind: "structural",
        result: structural,
        presentation: attempt.presentation,
        replay: attempt.replay,
      },
    };
  }

  private async presentReceipt(receipt: NfmHistoryReceipt): Promise<void> {
    if (receipt.kind !== "structural" || this.disposed) return;
    const { result, presentation } = receipt;
    if (presentation?.cutClaim)
      await this.settleClipboardSafely({
        writeClaim: presentation.cutClaim,
        outcome: "cut_committed",
      });
    if (presentation?.clipboardFallback)
      this.runtime?.onClipboardFallback?.(presentation.clipboardFallback);
    if (!presentation || presentation.focusRevision !== this.focusRevision) return;
    if (!this.runtime?.getContainer()?.isConnected) return;
    const backend = this.editor.getExtension<typeof YUndoExtension>("yUndo");
    const restoredSemanticSelection =
      presentation.selection?.before &&
      backend?.restoreSemanticSelection(presentation.selection.before);
    if (!restoredSemanticSelection) {
      if (presentation.merge) {
        await this.restoreBackwardMergeSelection(
          presentation.merge,
          presentation.merge.joinOffset,
          result,
          presentation.focusRevision,
        );
      } else {
        await this.restoreSelection(
          result,
          presentation.preferredBlockId ?? result.resultRootBlockIds.at(-1),
          presentation.focusRevision,
        );
      }
    }
    // A restored caret still needs the DOM focus released by the preparation fence.
    if (!this.disposed && presentation.focusRevision === this.focusRevision)
      this.restoreFocusIfUnclaimed();
  }

  private async settleClipboardSafely(
    input: Parameters<typeof settleStructuralClipboard>[0],
  ): Promise<void> {
    try {
      await this.settleClipboard(input);
    } catch (error) {
      this.reportError(error);
    }
  }

  private async prepareClipboard(
    command: Extract<NfmHistoryCommand, { kind: "clipboard" }>,
    presentation: NfmHistoryPresentation,
  ): Promise<HistoryPreparation<NfmHistoryRequest, NfmHistoryReceipt>> {
    const { action, roots, writeClaim } = command;
    const begun = await this.beginClipboard({
      writeClaim,
      actionHint: action,
      libraryId: this.boundRuntime.libraryId,
      storeEpoch: this.boundRuntime.source.storeEpoch,
    });
    if (!begun.ok) throw new Error("The structural clipboard session could not be started.");
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
    if (!clipboard || !capturedResult.ok)
      throw new Error("Core omitted the structural clipboard capability.");
    const envelope: NodexClipboardEnvelopeV1 = {
      version: 1,
      profileId: capturedResult.value.profileId,
      libraryId: capturedResult.value.libraryId,
      storeEpoch: clipboard.storeEpoch,
      bundleId: clipboard.bundleId,
      capability: clipboard.capability,
      manifestHash: clipboard.manifestHash,
      actionHint: action,
    };
    const text = this.boundRuntime.resolveClipboardText
      ? await this.boundRuntime.resolveClipboardText(command.presentation.text)
      : command.presentation.text;
    this.assertGestureActive(command);
    const written = await this.publishClipboard({
      envelope,
      writeClaim,
      html: command.presentation.html,
      text,
    });
    if (!written.ok) {
      if (written.failure === "superseded")
        return { kind: "complete", receipt: { kind: "no_content_change" } };
      throw new Error(
        written.failure === "readback_mismatch"
          ? "The system clipboard could not verify the copied structure."
          : "The system clipboard could not be written.",
      );
    }
    this.admissions.get(command)!.clipboardPublished = true;
    if (action === "copy") return { kind: "complete", receipt: { kind: "no_content_change" } };
    const deleteSelection = await this.prepareSelection(roots);
    return {
      kind: "submit",
      request: this.requestFor(
        {
          kind: "apply_structural_edit",
          command: {
            kind: "delete_selection",
            selection: deleteSelection,
            reason: { kind: "cut", bundle: clipboard },
            direction: "backward",
          },
        },
        { ...presentation, cutClaim: writeClaim },
      ),
    };
  }

  private async prepareClaimPaste(
    command: Extract<NfmHistoryCommand, { kind: "paste_claim" }>,
    presentation: NfmHistoryPresentation,
  ): Promise<HistoryPreparation<NfmHistoryRequest, NfmHistoryReceipt>> {
    const releasePending = this.schedulePendingPasteIndicator(command.target);
    try {
      const resolution: StructuralClipboardResolution = await this.waitForGesture(command, () =>
        this.awaitClipboard({
          writeClaim: command.descriptor.writeClaim,
          ...(command.descriptor.phase === "ready"
            ? { publishedEnvelope: command.descriptor.envelope }
            : {}),
        }),
      );
      if (
        resolution.kind === "portable_fallback" ||
        !this.envelopeMatchesRuntime(resolution.envelope)
      ) {
        this.assertGestureActive(command);
        if (
          command.target.kind === "replace" &&
          hasTypedOwnerBlock(this.resolveRoots(command.target.rootBlockIds))
        ) {
          const selection = await this.prepareSelection(command.target.rootBlockIds);
          return {
            kind: "submit",
            request: this.requestFor(
              {
                kind: "apply_structural_edit",
                command: {
                  kind: "replace_selection",
                  selection,
                  replacement: { kind: "blocks", blocks: command.portableBlocks },
                },
              },
              presentation,
            ),
          };
        }
        const receipt = this.history.completeLocalCapture(() =>
          this.pastePortableBlocks(command.portableBlocks, command.target),
        );
        if (resolution.kind === "portable_fallback") {
          try {
            this.boundRuntime.onClipboardFallback?.(
              command.descriptor.actionHint === "cut"
                ? "Pasted a copy because the move could not be completed."
                : "Pasted portable content because structural clipboard data was unavailable.",
            );
          } catch (error) {
            this.reportError(error);
          }
        }
        return { kind: "complete", receipt };
      }
      const request = await this.preparePaste(resolution.envelope, command.target, {
        ...presentation,
        ...(resolution.disposition === "copy_fallback"
          ? { clipboardFallback: "Pasted a copy because the move could not be completed." }
          : {}),
      });
      return { kind: "submit", request };
    } finally {
      releasePending();
    }
  }

  private async preparePageMention(
    mention: NfmPageMentionIntent,
    presentation: NfmHistoryPresentation,
  ): Promise<NfmHistoryRequest> {
    const hostHead = await this.prepareAndFence();
    this.assertSourceHead(hostHead);
    const destinationPageId = mention.destinationPageId ?? mention.hostPageId;
    let destinationHead = hostHead;
    if (destinationPageId !== mention.hostPageId) {
      const read = await readLibraryModule(this.boundRuntime.accessContext, {
        read: { mode: "page_mention_destination", pageId: destinationPageId },
      });
      if (!read.ok) throw new Error(read.error.message);
      if (
        read.value.storeEpoch !== this.boundRuntime.source.storeEpoch ||
        read.value.value.kind !== "page_mention_destination" ||
        read.value.value.value.pageId !== destinationPageId
      )
        throw new Error("The destination Page is no longer available.");
      const destination = read.value.value.value;
      destinationHead = {
        documentId: destination.documentId,
        generation: destination.documentGeneration,
        expectedHeadSeq: destination.documentHeadSeq,
        storeEpoch: read.value.storeEpoch,
      };
      const mounted = resolveBlockDocumentStructuralMutationParticipantByDocumentId(
        destinationHead.documentId,
      );
      if (mounted) {
        const head = await mounted.prepareAndFence();
        if (
          head.storeEpoch !== destinationHead.storeEpoch ||
          head.documentId !== destinationHead.documentId ||
          head.generation !== destinationHead.generation
        )
          throw new Error("The destination Page changed; reopen it before creating the Page.");
        destinationHead = head;
      }
    }
    return this.requestFor(
      {
        kind: "create_page_mention",
        pageId: mention.pageId,
        documentId: createUuidV7(),
        title: mention.title.trim() || "Untitled",
        mentionHost: {
          pageId: mention.hostPageId,
          documentId: hostHead.documentId,
          expectedDocumentGeneration: hostHead.generation,
          expectedDocumentHeadSeq: hostHead.expectedHeadSeq,
          blockId: mention.blockId,
          expectedContent: mention.expectedContent,
          replacementContent: mention.replacementContent,
        },
        destination: {
          pageId: destinationPageId,
          documentId: destinationHead.documentId,
          expectedDocumentGeneration: destinationHead.generation,
          expectedDocumentHeadSeq: destinationHead.expectedHeadSeq,
          insertion: { kind: "append" },
        },
      },
      { ...presentation, preferredBlockId: mention.blockId },
    );
  }

  private async prepareAndFence() {
    if (
      this.activeOperationVersion !== undefined &&
      this.activeOperationVersion !== this.cancellationVersion
    )
      throw new DocumentWaitError("cancelled");
    const controller = new AbortController();
    const options = {
      signal: AbortSignal.any([controller.signal, this.preparationLifetime.signal]),
      deadlineAt: this.operationDeadlineAt ?? Date.now() + DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
    };
    this.preparationWaits.add(controller);
    try {
      const head = await waitForDocumentOperation(
        () => this.boundRuntime.participant.prepareAndFence(options),
        options,
      );
      if (this.disposed) throw new DocumentWaitError("cancelled");
      assertDocumentWaitActive(options);
      return head;
    } finally {
      this.preparationWaits.delete(controller);
    }
  }

  private async preparePaste(
    envelope: NodexClipboardEnvelopeV1,
    intent: NfmStructuralPasteIntent,
    presentation: NfmHistoryPresentation,
  ): Promise<NfmHistoryRequest> {
    const head = await this.prepareAndFence();
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
    return this.requestFor({ kind: "apply_structural_edit", command }, presentation);
  }

  private envelopeMatchesRuntime(envelope: NodexClipboardEnvelopeV1): boolean {
    return (
      (!this.boundRuntime.libraryId || envelope.libraryId === this.boundRuntime.libraryId) &&
      envelope.storeEpoch === this.boundRuntime.source.storeEpoch
    );
  }

  private pastePortableBlocks(
    blocks: readonly LibraryStructuralReplacementBlock[],
    intent: NfmStructuralPasteIntent,
  ): void {
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

  private async prepareSelection(roots: readonly string[]) {
    const head = await this.prepareAndFence();
    this.assertSourceHead(head);
    return this.selectionFromHead(roots, head);
  }

  private selectionFromHead(
    roots: readonly string[],
    head: {
      readonly documentId: string;
      readonly generation: number;
      readonly expectedHeadSeq: number;
    },
  ) {
    return {
      sourceDocumentId: this.boundRuntime.source.documentId,
      rootBlockIds: roots,
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
    if (roots.length === 0 || blocks.length === 0) return false;
    return this.start({
      kind: "replace",
      roots: roots.map((block) => block.id),
      blocks: structuredClone(blocks),
    });
  }

  private async prepareDuplicateCommand(roots: readonly string[]) {
    const lastRoot = roots.at(-1);
    if (!lastRoot) throw new Error("The duplicate target is no longer available.");
    const parent = this.editor.getParentBlock(lastRoot);
    const siblings = parent?.children ?? this.editor.document;
    const rootIndex = siblings.findIndex((block) => block.id === lastRoot);
    if (rootIndex < 0) throw new Error("The duplicate target is no longer available.");
    const head = await this.prepareAndFence();
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
    focusRevision = this.focusRevision,
  ): Promise<void> {
    if (this.disposed || focusRevision !== this.focusRevision) return;
    const candidates = [
      preferredBlockId,
      result.resume?.blockId,
      result.resume?.fallbackBeforeBlockId,
      result.resume?.fallbackAfterBlockId,
    ].filter((candidate): candidate is string => Boolean(candidate));
    if (candidates.length === 0) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.disposed) return;
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
  private disposePromise: Promise<void> | null = null;
  private historyLease: ReturnType<typeof acquireContentInteractionHistory> | undefined;
  private historyScopeKey: string | undefined;

  constructor(
    private readonly historyReconciliation: NfmHistoryReconciliation = coreHistoryReconciliation,
  ) {}

  get current(): NfmStructuralEditingSession | null {
    return this.activeSession;
  }

  attachEditor(
    editor: BlockNoteEditor<any, any, any>,
    historyScope?: ContentInteractionHistoryScope,
  ): NfmStructuralEditingSession {
    if (this.disposed) {
      throw new Error("Cannot attach an editor to a disposed structural editing controller.");
    }
    if (this.editor && this.editor !== editor) {
      throw new Error("A structural editing controller cannot change its editor.");
    }
    const scopeKey = historyScope && contentInteractionHistoryScopeKey(historyScope);
    if (this.session) {
      if (this.historyScopeKey !== scopeKey)
        throw new Error("A retained editor cannot change its content history authority.");
      return this.session;
    }

    this.editor = editor;
    this.historyScopeKey = scopeKey;
    this.historyLease = historyScope ? acquireContentInteractionHistory(historyScope) : undefined;
    this.session = new NfmStructuralEditingSession({
      editor,
      interactionHistory: this.historyLease?.history,
      historyReconciliation: this.historyReconciliation,
    });
    return this.session;
  }

  activate(session: NfmStructuralEditingSession, runtime: NfmStructuralEditingRuntime): void {
    if (this.disposed || session !== this.session) return;
    session.rebind(runtime);
    this.activeSession = session;
  }

  deactivate(session: NfmStructuralEditingSession): void {
    session.cancelPreparations();
    if (this.activeSession !== session) return;
    this.activeSession = null;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.activeSession = null;
    this.disposePromise = (this.session?.close() ?? Promise.resolve()).finally(() => {
      this.historyLease?.release();
      this.historyLease = undefined;
    });
    this.session = null;
    this.editor = null;
    return this.disposePromise;
  }
}
