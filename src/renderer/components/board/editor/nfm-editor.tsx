import { useNfmSearchState } from "./use-nfm-search-state";
import type { PageChatSendResult } from "@/lib/page-chat-send";
import {
  createPageEditorSelectionObservation,
  readPageEditorSelectedBlockIds,
} from "@/lib/page-editor-selection";
import { markdownBlocksForEditor } from "../../../../shared/nodex-markdown/blocknote";
import { NfmStructuralRemovalPresentation } from "./nfm-structural-removal-presentation";
import { readCodexSubmissionPresentation } from "@/lib/codex-turn-presentation";
import type { WorkbenchSubmitPresentation } from "../../../../shared/nodex-app-tools/workbench";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import type { DocumentWaitOptions } from "@/lib/document-wait";
import { registerPageEditorObservationParticipant } from "@/lib/page-editor-observation-registry";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useMemo,
  useCallback,
  useState,
  type RefObject,
  type Ref,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SideMenuController, type LinkToolbarProps } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useSurfaceHistoryFocus } from "@/lib/surface-history/use-surface-history-focus";
import { CornerDownLeft } from "@/components/shared/icons/generic-icons";
import { ChevronDownIcon, CloseIcon, ReplaceIcon } from "@/components/shared/icons";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

import { NfmEditorOwnerBoundary, type NfmEditorOwner } from "./nfm-editor-owner";
import { ownsNfmEditorEvent } from "./nfm-editor-event-owner";
import { captureNfmPasteTarget, clearNfmPasteTargets } from "./nfm-paste-target";
import { readNativePastePayload } from "./nfm-paste-event";
import { readNfmLinkHrefAtElement } from "./nfm-link-element";
import { NOTION_BLOCKS_MIME, NOTION_MULTI_TEXT_MIME } from "./notion-paste";
import { NfmFormattingToolbar } from "./nfm-formatting-toolbar";
import { NfmFormattingToolbarController } from "./nfm-formatting-toolbar-controller";
import { NfmTextActionMenuRuntimeProvider } from "./nfm-text-action-menu-runtime";
import { NfmLinkToolbar } from "./nfm-link-toolbar";
import { NfmLinkToolbarController } from "./nfm-link-toolbar-controller";
import { toast } from "@/components/ui/toast";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { applyLibraryModule } from "@/lib/api";
import { resolveNfmLinkAction } from "@/lib/nfm-link-actions";
import {
  libraryContentRoute,
  projectIdFromContentRoutingContext,
  projectContentRoute,
  type ContentCanvasNavigationTarget,
  type ContentRoutingContext,
  type ContentPageNavigationTarget,
} from "../../../../shared/content-routing-context";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useEditorDragBehaviors } from "./use-editor-drag-behaviors";
import {
  beginLocalBlockDragSession,
  endLocalBlockDragSession,
} from "../../workbench/block-transfer/cross-surface-drag";
import {
  resolveDraggedBlockPromotionTitle,
  resolveTopLevelDraggedBlocks,
} from "./dragged-block-roots";
import { readCachedPageTargetReadModel } from "@/lib/block-reference-queries";
import { previewTaskShorthandInlineContent } from "@/lib/task-shorthand-preview";
import type { CodexPromptInput } from "@/lib/types";
import { NfmSlashMenu } from "./nfm-slash-menu";
import { NfmTableHandlesController } from "./nfm-table-handles";
import { NfmHeadingNavigationRail } from "./nfm-heading-navigation-rail";
import {
  getNfmSearchState,
  goToNextNfmSearchMatch,
  goToPreviousNfmSearchMatch,
  replaceActiveNfmSearchMatch,
  replaceAllNfmSearchMatches,
  revealActiveNfmSearchMatch,
  setNfmSearchQuery,
} from "./search-extension";
import { resolveFindShortcutSeedQuery } from "./find-shortcut-seed";
import { matchesNfmFindShortcut } from "./find-shortcut";
import { deferCollapsedToggleVerticalArrowToBrowser } from "./inline-view-arrow-nav";
import {
  focusEmbeddedEditorBoundary,
  handleArrowIntoEmbeddedSurface,
  isEditorAtVisibleBoundary,
  type EmbeddedSurfaceHostEditor,
  type VerticalArrowDirection,
} from "./embedded-surface-arrow-navigation";
import {
  NfmSideMenu,
  NfmSideMenuOpenProvider,
  NfmSideMenuShortcutController,
} from "./nfm-side-menu";
import { NfmCodeBlockController } from "./nfm-code-block-controller";
import type { NfmMoveToDestination } from "./nfm-move-to-menu-model";
import { projectMessageBlocks } from "../../../../shared/message-agent-input";
import {
  describeNfmSendToThreadPreferredTarget,
  resolveNfmSendToThreadPreferredDestination,
  resolveNfmSendToThreadPreferredTarget,
  type NfmSendToThreadRequest,
} from "./nfm-send-to-thread-menu-model";
import {
  NFM_INERT_PROMPT_RUNTIME,
  NfmPromptRuntimeProvider,
  type NfmPromptRuntimeValue,
} from "./nfm-prompt-runtime";
import { findNfmPromptBlockAtCaret } from "./nfm-prompt-block-model";
import { writeNfmPromptCollapsed } from "./nfm-prompt-collapse-store";
import { NfmSideMenuRuntimeProvider } from "./nfm-side-menu-runtime";
import { NfmChatSendShortcutController } from "./nfm-chat-send-shortcut-controller";
import { NfmAskForChangeProvider } from "./nfm-ask-for-change";
import { ReadonlyMarkdownBlockNotePreview } from "./readonly-nfm-blocknote-preview";
import { reportNfmChatSendFailure } from "./nfm-chat-send-feedback";
import { resolveSendBlockSelection } from "./send-block-selection";
import { PasteResourceDialog } from "./paste-resource-dialog";
import { pasteNfmImages, pasteNfmResourceAttachments } from "./nfm-paste-commands";
import {
  clipboardFilesFromDataTransfer,
  continueInlinePaste,
  capturePasteResourceTarget,
  normalizeClipboardFileDraftItems,
  shouldPromptForOversizedText,
  type PasteResourceDialogState,
} from "./paste-resource";
import {
  getSideMenuSelectionGuardFloatingOptions,
  useSideMenuSelectionGuard,
} from "./side-menu-selection-guard";
import { NfmEditorContextMenu } from "./nfm-editor-context-menu";
import {
  appendInlineCardAncestor,
  appendInlineDocumentOwnerAncestor,
  BlockReferenceRuntimeProvider,
  type BlockReferenceHostRuntime,
  useBlockReferenceHostRuntime,
} from "@/components/block-documents/block-reference-runtime-context";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import {
  isSpaceShortcut,
  resolveImagePreviewByBlockId,
  resolveFocusedImagePreview,
  type ImageBlockLookupEditor,
  type ImageSelectionEditor,
} from "./image-preview-shortcut";
import {
  type DragSessionBlock,
  type EditorForExternalBlockDrop,
} from "./external-block-drag-session";
import {
  ThreadMentionRuntimeProvider,
  type ThreadMentionRuntimeValue,
} from "./thread-mention-chip";
import { activateSelectedMention } from "./mention-chip-keyboard-navigation";
import { AgentConfigRuntimeProvider, type AgentConfigRuntimeValue } from "./agent-config-runtime";
import { resolveDefaultAgentConfigIntelligence } from "./agent-config-chip";
import { prepareOwnedBlockDocument } from "@/lib/api";
import { readSessionMentionSummary } from "@/lib/session-mentions";
import { readPlainTextBlocks } from "../../../../shared/markdown";
import { writeMarkdown, readMarkdown } from "../../../../shared/nodex-markdown";
import type { CodexThreadSummary } from "@/lib/types";

import { resolveLocalImageDisplayUrl } from "@/lib/assets";
import { readImageFileSourceDimensions } from "@/lib/image-source-dimensions";
import { parseFileSource } from "../../../../shared/file-resources";
import { useSpellcheck } from "@/lib/use-spellcheck";
import { useTheme } from "@/lib/use-theme";
import { usePasteResourceSettings } from "@/lib/use-paste-resource-settings";
import { readCopyFileReferencesAsLocalPaths } from "@/lib/copy-file-reference-settings";
import { resolvePageDeepLinkPasteIntent } from "@/lib/page-reference-paste";
import { cn } from "@/lib/utils";
import type {
  BlockDocumentMutationBarrier,
  DocumentHeadFence,
} from "@/lib/block-document-surface-runtime";
import {
  registerBlockDocumentStructuralMutationParticipant,
  resolveBlockDocumentStructuralMutationParticipant,
} from "@/lib/block-document-mutation-registry";
import {
  createCanvasInHostPage,
  isCanvasHostDocumentRuntime,
  registerCanvasHostDocumentRuntime,
  renameCanvasOwner,
} from "@/lib/canvas-host-operations";
import type { EditorSurfaceLease } from "@/lib/document-session-registry";
import {
  useCodexAvailableModels,
  useProjectThreadSummaries,
} from "@/features/local-conversation/local-conversation-store";
import type { ModifyShortcutEditor } from "./modify-block-shortcut";
import { handleNfmEditorModEnterShortcut } from "./nfm-editor-mod-enter-shortcut";
import {
  getNfmEditorInstanceKey,
  resolveNfmEditorBlockActionCapabilities,
  type NfmEditorSource,
} from "./nfm-editor-source";
import { isEmptyParagraphBlock } from "./nfm-empty-paragraph";
import { findToggleButtonForBlock } from "./toggle-shortcut";
import {
  hasNfmEditorTransientInput,
  prepareNfmEditorObservation,
  prepareNfmEditorStructuralMutation,
  type NfmEditorStructuralMutationRuntime,
} from "./nfm-editor-relocation";
import {
  createFilePlacementRuntime,
  createRendererFileReadCache,
  FileRuntimeProvider,
} from "./file-runtime";
import {
  hasTypedOwnerBlock,
  hasTypedOwnerType,
  resolveTypedOwnerDocumentChanges,
} from "@/lib/typed-owner-blocks";
import type { NfmReceivingPageTransferIntent } from "./nfm-history-command";
import { readNodexClipboardFragment } from "../../../../shared/clipboard-paste";
import { applyLocalNfmTurnInto, type NfmTurnBlocksIntoInput } from "@/lib/nfm-turn-into-targets";
import {
  copiedSelectionHasFileReferences,
  resolveManagedAssetReference,
  rewriteCopiedSelectionFileReferences,
  type CopiedSelectionPayload,
} from "./special-block-copy";

interface NfmEditorCommonProps {
  contentRoutingContext: ContentRoutingContext;
  projectName?: string | null;
  projectWorkspacePath?: string | null;
  sourcePageContext?: {
    pageId: string;
  };
  /** The independently synchronized owner whose body this editor renders. */
  documentOwnerBlockId?: string;
  sessionId?: string | null;
  sessionThread?: CodexThreadSummary | null;
  canStartThreadInSession?: boolean;
  sessionTitle?: string | null;
  /** The Project of the chat this Page is shown beside; a Library Page sends through it. */
  chatProjectId?: string | null;
  onOpenCodexThread?: (threadId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenPage?: (input: ContentPageNavigationTarget) => void | Promise<void>;
  onOpenDatabase?: BlockReferenceHostRuntime["openDatabase"];
  onOpenCanvas?: (input: ContentCanvasNavigationTarget) => void | Promise<void>;
  onOpenPageFile?: BlockReferenceHostRuntime["openPageFile"];
  onStartNewSessionThreadFromEditor?: (input: {
    projectId: string;
    targetSessionId?: string;
    prompt: string;
    promptInput?: CodexPromptInput;
    submittedPresentation?: WorkbenchSubmitPresentation;
    threadName?: string;
  }) => Promise<PageChatSendResult>;
  onSendPagePrompt?: (input: {
    projectId: string;
    threadId: string;
    prompt: string;
    promptInput?: CodexPromptInput;
    submittedPresentation?: WorkbenchSubmitPresentation;
  }) => Promise<PageChatSendResult>;
  /** Present when the Page is shown beside a chat: appends Page content to that chat's draft. */
  onAddPromptToChatComposer?: (promptInput: CodexPromptInput) => Promise<void>;
  isActivePanelTab?: boolean;
  headingRail?: {
    portalElement: HTMLElement | null;
    scrollContainerRef: RefObject<HTMLElement | null>;
  };
  placeholder?: string;
  className?: string;
  surfaceMutationBarrier?: BlockDocumentMutationBarrier;
  embeddedBoundary?: {
    navigationRef: Ref<NfmEditorBoundaryHandle>;
    onBoundaryArrow: (direction: VerticalArrowDirection) => boolean;
  };
  navigationRef?: Ref<NfmEditorBoundaryHandle>;
  onEditorViewMount?: (editorRoot: HTMLElement) => void;
  onEditorViewUnmount?: () => void;
  /** Optional PageTab-owned model whose lifetime exceeds this React view. */
  editorSession?: EditorSurfaceLease;
}

export interface NfmEditorBoundaryHandle {
  focus(): boolean;
  focusBlock(blockId: string): boolean;
  focusBoundary(direction: VerticalArrowDirection): boolean;
  /** Puts the caret on an empty first line, opening one above the content when needed. */
  openLineAtStart(): boolean;
}

export interface NfmEditorProps extends NfmEditorCommonProps {
  source: NfmEditorSource;
}

interface NfmEditorInstanceProps extends NfmEditorCommonProps {
  source: NfmEditorSource;
  editorInstanceKey: string;
  owner: NfmEditorOwner;
}

interface InlineViewHostContextRuntimeEditor {
  nodexSourcePageContext?: {
    projectId: string;
    pageId: string;
  } | null;
}

interface SendBlocksSelection {
  blockIds: string[];
  blocks: DragSessionBlock[];
}

function resolveImagePreview(input: { readonly source: string; readonly alt: string }): {
  readonly source: string;
  readonly alt: string;
} | null {
  const source = resolveLocalImageDisplayUrl(input.source);
  return source ? { source, alt: input.alt } : null;
}

export function NfmEditor(props: NfmEditorProps) {
  const source = props.source;
  const editorInstanceKey = getNfmEditorInstanceKey({
    routingContext: props.contentRoutingContext,
    source,
  });

  return (
    <NfmEditorOwnerBoundary
      key={editorInstanceKey}
      input={{
        pageId: props.sourcePageContext?.pageId,
        source,
        routingContext: props.contentRoutingContext,
        editorInstanceKey,
        libraryId: props.surfaceMutationBarrier?.libraryId,
        placeholder: props.placeholder,
        editorSession: props.editorSession,
      }}
    >
      {(owner) => (
        <NfmEditorInstance
          {...props}
          source={source}
          editorInstanceKey={editorInstanceKey}
          owner={owner}
        />
      )}
    </NfmEditorOwnerBoundary>
  );
}

/** Bind the external Editor's inline-view metadata only after its view commits. */
function bindNfmSourcePageContext(
  editor: unknown,
  context: InlineViewHostContextRuntimeEditor["nodexSourcePageContext"],
): void {
  (editor as InlineViewHostContextRuntimeEditor).nodexSourcePageContext = context;
}

/** Focus only a live Block and tolerate non-text or detached editor targets. */
function focusNfmEditorBlock(editor: NfmEditorOwner["editor"], blockId: string): boolean {
  if (!editor.getBlock(blockId)) return false;
  try {
    editor.setTextCursorPosition(blockId, "start");
    const cssEscape =
      globalThis.CSS?.escape ?? ((value: string) => value.replace(/["\\]/g, "\\$&"));
    editor.prosemirrorView?.dom
      .querySelector<HTMLElement>(`.bn-block[data-id="${cssEscape(blockId)}"]`)
      ?.scrollIntoView({ block: "center" });
    editor.focus();
    return true;
  } catch {
    return false;
  }
}

/** Non-inline Blocks keep their selection when the handoff cannot place a caret. */
function collapseNfmHandedOffSelection(
  editor: NfmEditorOwner["editor"],
  blockIds: readonly string[],
): void {
  const lastBlockId = blockIds.at(-1);
  try {
    if (lastBlockId && editor.getBlock(lastBlockId)) {
      editor.setTextCursorPosition(lastBlockId, "end");
    }
  } catch {
    // A Block without inline content keeps its selection.
  }
}

function NfmEditorInstance({
  owner,
  contentRoutingContext,
  projectName = null,
  projectWorkspacePath,
  source,
  sourcePageContext,
  documentOwnerBlockId,
  sessionId = null,
  sessionThread = null,
  canStartThreadInSession = false,
  sessionTitle = null,
  chatProjectId = null,
  onOpenSession,
  onOpenPage,
  onOpenDatabase,
  onOpenCanvas,
  onOpenPageFile,
  onStartNewSessionThreadFromEditor,
  onSendPagePrompt,
  onAddPromptToChatComposer,
  isActivePanelTab = true,
  headingRail,
  className,
  surfaceMutationBarrier,
  embeddedBoundary,
  navigationRef,
  onEditorViewMount,
  onEditorViewUnmount,
  editorSession,
}: NfmEditorInstanceProps) {
  const {
    editor,
    controller: structuralEditingController,
    structuralSession: structuralEditingSession,
  } = owner;
  const queryClient = useQueryClient();
  const executionProjectId = projectIdFromContentRoutingContext(contentRoutingContext);
  // Sends go through the beside chat's Project, which a Library Page does not have of its own.
  const chatSendProjectId = chatProjectId ?? executionProjectId;
  const parentBlockReferenceRuntime = useBlockReferenceHostRuntime();
  const { resolved: themeMode } = useTheme();
  const { spellcheck } = useSpellcheck();
  const { settings: pasteResourceSettings } = usePasteResourceSettings();
  const workbenchOwner = useWorkbenchWindowOwner();
  const availableCodexModels = useCodexAvailableModels();
  const projectThreadSummaries = useProjectThreadSummaries(executionProjectId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState("");
  const { totalMatches: searchMatchCount, activeIndex: searchActiveIndex } =
    useNfmSearchState(editor);
  const [pasteResourceDialog, setPasteResourceDialog] = useState<PasteResourceDialogState | null>(
    null,
  );
  const [pasteResourcePending, setPasteResourcePending] = useState(false);
  const [pasteResourceError, setPasteResourceError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{
    source: string;
    alt: string;
  } | null>(null);
  const renderLinkToolbar = useCallback(
    (linkToolbarProps: LinkToolbarProps) => (
      <NfmLinkToolbar {...linkToolbarProps} projectWorkspacePath={projectWorkspacePath} />
    ),
    [projectWorkspacePath],
  );
  const [threadMentionThreadsById, setThreadMentionThreadsById] = useState<
    Record<string, CodexThreadSummary>
  >({});
  const [threadMentionResolvingIds, setThreadMentionResolvingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const threadMentionResolvePromisesRef = useRef<Map<string, Promise<CodexThreadSummary | null>>>(
    new Map(),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  // A chat mention names its Session; the Project's live chats keep its title current.
  const projectSessionSummaryMap = useMemo(
    () =>
      projectThreadSummaries.reduce<Record<string, CodexThreadSummary>>((acc, thread) => {
        if (thread.sessionId) acc[thread.sessionId] = thread;
        return acc;
      }, {}),
    [projectThreadSummaries],
  );

  const sessionSendToThreadPreferredTarget = useMemo(
    () =>
      resolveNfmSendToThreadPreferredTarget({
        sessionId,
        sessionThread,
        canStartThreadInSession,
        sessionTitle,
      }),
    [canStartThreadInSession, sessionId, sessionThread, sessionTitle],
  );
  const sendToThreadProjectNameById = useMemo(() => {
    if (executionProjectId === null) return {};
    return {
      [executionProjectId]: projectName?.trim() || executionProjectId,
    };
  }, [executionProjectId, projectName]);

  const sourcePageId = sourcePageContext?.pageId;
  // Keep equivalent authority inputs referentially stable. Recreating this object on every
  // document commit would release live object URLs and remount otherwise unchanged media.
  const pageFileContentRoutingContext = useMemo(
    () => (executionProjectId ? projectContentRoute(executionProjectId) : libraryContentRoute),
    [executionProjectId],
  );
  // One editor instance owns one isolated cache; the Provider releases every acquired scope.
  const [pageFileReadCache] = useState(createRendererFileReadCache);
  const libraryId = surfaceMutationBarrier?.libraryId;
  const fileRuntime = useMemo(
    () =>
      sourcePageId && libraryId
        ? createFilePlacementRuntime(
            {
              contentRoutingContext: pageFileContentRoutingContext,
              libraryId,
              readSource: { kind: "page", page_id: sourcePageId },
              storeEpoch: source.storeEpoch,
            },
            pageFileReadCache,
            source.documentId,
          )
        : null,
    [
      pageFileReadCache,
      pageFileContentRoutingContext,
      source.storeEpoch,
      source.documentId,
      sourcePageId,
      libraryId,
    ],
  );
  const resolveLocalClipboardFileReference = useCallback(
    async (fileReference: string): Promise<string | null> => {
      if (!parseFileSource(fileReference)) {
        return await resolveManagedAssetReference(fileReference);
      }
      if (!fileRuntime) return null;

      try {
        return await fileRuntime.materialize(fileReference);
      } catch {
        return null;
      }
    },
    [fileRuntime],
  );
  const resolveCopiedFileReferences = useCallback(
    (payload: CopiedSelectionPayload): Promise<CopiedSelectionPayload> | null => {
      if (!readCopyFileReferencesAsLocalPaths()) return null;
      if (!copiedSelectionHasFileReferences(payload)) return null;
      return rewriteCopiedSelectionFileReferences(payload, resolveLocalClipboardFileReference);
    },
    [resolveLocalClipboardFileReference],
  );
  const threadMentionSummaryMap = useMemo(
    () => ({
      ...threadMentionThreadsById,
      ...projectSessionSummaryMap,
    }),
    [projectSessionSummaryMap, threadMentionThreadsById],
  );
  const threadMentionSummaryMapRef = useRef(threadMentionSummaryMap);
  useEffect(() => {
    threadMentionSummaryMapRef.current = threadMentionSummaryMap;
  }, [threadMentionSummaryMap]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!fileRuntime) throw new Error("File authority is unavailable");
      const [url, dimensions] = await Promise.all([
        fileRuntime.upload({ kind: "browser_file", file }),
        readImageFileSourceDimensions(file),
      ]);

      return {
        props: {
          url,
          name: file.name,
          ...(dimensions ?? {}),
        },
      };
    },
    [fileRuntime],
  );

  const resolveFileUrl = useCallback(
    async (fileSource: string) => {
      if (parseFileSource(fileSource)) {
        if (!fileRuntime) throw new Error("File authority is unavailable");
        return fileRuntime.readImageDataUrl(fileSource);
      }
      const displayUrl = resolveLocalImageDisplayUrl(fileSource);
      if (!displayUrl) throw new Error("Managed image path is unavailable");
      return displayUrl;
    },
    [fileRuntime],
  );

  const openImagePreview = useCallback(
    (input: { readonly source: string; readonly alt: string }) => {
      if (!parseFileSource(input.source)) {
        setImagePreview(resolveImagePreview(input));
        return;
      }
      if (!fileRuntime) {
        toast.danger("File authority is unavailable");
        return;
      }
      void fileRuntime
        .readImageDataUrl(input.source)
        .then((source) => setImagePreview({ source, alt: input.alt }))
        .catch(() => toast.danger("Couldn’t preview image"));
    },
    [fileRuntime],
  );

  useLayoutEffect(
    () => owner.bindCallbacks({ uploadFile, resolveFileUrl, resolveCopiedFileReferences }),
    [owner, uploadFile, resolveFileUrl, resolveCopiedFileReferences],
  );
  useLayoutEffect(() => {
    const view = editor.prosemirrorView;
    if (!isActivePanelTab) clearNfmPasteTargets(view);
    return () => clearNfmPasteTargets(view);
  }, [editor, isActivePanelTab]);
  useEffect(() => () => pasteResourceDialog?.target.selection?.release(), [pasteResourceDialog]);

  const resolveSessionMention = useCallback(
    async (threadId: string): Promise<CodexThreadSummary | null> => {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) return null;

      const cached = threadMentionSummaryMapRef.current[normalizedThreadId];
      if (cached) return cached;

      const existingPromise = threadMentionResolvePromisesRef.current.get(normalizedThreadId);
      if (existingPromise) return existingPromise;

      setThreadMentionResolvingIds((current) => {
        if (current.has(normalizedThreadId)) return current;
        const next = new Set(current);
        next.add(normalizedThreadId);
        return next;
      });

      const resolvePromise = readSessionMentionSummary(normalizedThreadId)
        .then((thread) => {
          const summary = thread as CodexThreadSummary | null;
          if (!summary) return null;

          setThreadMentionThreadsById((current) => {
            const existing = current[normalizedThreadId];
            if (
              existing &&
              existing.threadName === summary.threadName &&
              existing.threadPreview === summary.threadPreview &&
              existing.statusType === summary.statusType &&
              existing.archived === summary.archived &&
              existing.updatedAt === summary.updatedAt
            ) {
              return current;
            }
            return {
              ...current,
              [normalizedThreadId]: summary,
            };
          });
          return summary;
        })
        .finally(() => {
          threadMentionResolvePromisesRef.current.delete(normalizedThreadId);
          setThreadMentionResolvingIds((current) => {
            if (!current.has(normalizedThreadId)) return current;
            const next = new Set(current);
            next.delete(normalizedThreadId);
            return next;
          });
        });

      threadMentionResolvePromisesRef.current.set(normalizedThreadId, resolvePromise);
      return resolvePromise;
    },
    [],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setReplaceOpen(false);
    setReplaceQuery("");
    if (!editor) return;
    setNfmSearchQuery(editor, "");
  }, [editor]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const navigateSearch = useCallback(
    (direction: "next" | "prev", preserveInputFocus = false) => {
      if (!editor) return;
      if (direction === "next") {
        goToNextNfmSearchMatch(editor);
      } else {
        goToPreviousNfmSearchMatch(editor);
      }
      revealActiveNfmSearchMatch(editor);
      if (preserveInputFocus) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
        });
      }
    },
    [editor],
  );

  const replaceCurrentMatch = useCallback(() => {
    if (!editor) return;

    const state = getNfmSearchState(editor);
    if (state.totalMatches === 0) return;

    if (state.activeIndex < 0) {
      goToNextNfmSearchMatch(editor);
      revealActiveNfmSearchMatch(editor);
    }

    const replaced = replaceActiveNfmSearchMatch(editor, replaceQuery);
    if (!replaced) return;

    goToNextNfmSearchMatch(editor);
    revealActiveNfmSearchMatch(editor);

    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [editor, replaceQuery]);

  const replaceAllMatches = useCallback(() => {
    if (!editor) return;
    replaceAllNfmSearchMatches(editor, replaceQuery);

    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [editor, replaceQuery]);

  const serializeEditorToNfm = useCallback((): string => {
    if (!editor) return "";
    return writeMarkdown(editor.document);
  }, [editor]);

  // Keyboard handlers subscribe once; they read the current Prompt runtime through this ref.
  const promptRuntimeRef = useRef<NfmPromptRuntimeValue>(NFM_INERT_PROMPT_RUNTIME);
  const restoreEditorFocus = useCallback(() => {
    requestAnimationFrame(() => {
      editor?.focus();
    });
  }, [editor]);
  const previousActivePanelTabRef = useRef(isActivePanelTab);

  useEffect(() => {
    const wasActive = previousActivePanelTabRef.current;
    previousActivePanelTabRef.current = isActivePanelTab;

    if (!isActivePanelTab) return;
    if (wasActive) return;

    restoreEditorFocus();
  }, [isActivePanelTab, restoreEditorFocus]);

  const closePasteResourceDialog = useCallback(() => {
    setPasteResourcePending(false);
    setPasteResourceError(null);
    setPasteResourceDialog(null);
  }, []);

  useEffect(() => {
    bindNfmSourcePageContext(
      editor,
      sourcePageContext && executionProjectId
        ? { projectId: executionProjectId, pageId: sourcePageContext.pageId }
        : null,
    );
    return () => bindNfmSourcePageContext(editor, null);
  }, [editor, executionProjectId, sourcePageContext]);

  const handlePasteResourceChoice = async (mode: "materialized" | "link") => {
    if (!editor || !pasteResourceDialog || pasteResourcePending) return;
    return pasteNfmResourceAttachments({
      owner,
      fileRuntime,
      dialog: pasteResourceDialog,
      mode,
      setPending: setPasteResourcePending,
      setError: setPasteResourceError,
      closeDialog: closePasteResourceDialog,
    });
  };

  const handleContinuePasteInline = () => {
    if (!editor || !pasteResourceDialog?.textPayload || pasteResourcePending) return;
    if (!pasteResourceDialog.target.selection?.restore()) {
      toast.info("The original paste position is no longer available.");
      closePasteResourceDialog();
      return;
    }
    if (
      hasTypedOwnerType([
        ...(pasteResourceDialog.target.selectedBlockTypes ?? []),
        pasteResourceDialog.target.currentBlockType ?? null,
      ])
    ) {
      const blocks = pasteResourceDialog.blocknoteHtmlPayload
        ? editor.tryParseHTMLToBlocks(pasteResourceDialog.blocknoteHtmlPayload)
        : pasteResourceDialog.markdownPayload
          ? readClipboardMarkdown(pasteResourceDialog.markdownPayload)
          : pasteResourceDialog.htmlPayload
            ? editor.tryParseHTMLToBlocks(pasteResourceDialog.htmlPayload)
            : markdownBlocksForEditor(readPlainTextBlocks(pasteResourceDialog.textPayload));
      const handled =
        owner
          .getActiveStructuralSession()
          ?.handleBlockPaste(
            blocks as Parameters<
              NonNullable<
                ReturnType<NfmEditorOwner["getActiveStructuralSession"]>
              >["handleBlockPaste"]
            >[0],
          ) ?? false;
      if (!handled) {
        toast.info("The structural selection changed before paste could be applied.");
      }
      closePasteResourceDialog();
      return;
    }

    editor.focus();
    const continued = continueInlinePaste(editor, pasteResourceDialog);
    if (!continued) {
      editor.insertInlineContent(pasteResourceDialog.textPayload, {
        updateSelection: true,
      });
    }
    closePasteResourceDialog();
  };

  const handleImagePaste = async (
    files: File[],
    target: ReturnType<typeof capturePasteResourceTarget>,
  ) => {
    if (!editor || files.length === 0) return;
    return pasteNfmImages({ owner, files, target, uploadFile });
  };

  // Handle content changes from the editor
  const handleChange = useCallback(() => {
    if (!editor) return;
    source.onDocumentChange?.();
  }, [editor, source]);

  const pasteImageFromSubscription = useEffectEvent(handleImagePaste);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !editor) return;

    const handlePasteCapture = (event: ClipboardEvent) => {
      if (!event.clipboardData || pasteResourceDialog) return;

      const clipboardTypes = Array.from(event.clipboardData.types);
      if (
        clipboardTypes.includes(NOTION_BLOCKS_MIME) ||
        clipboardTypes.includes(NOTION_MULTI_TEXT_MIME)
      ) {
        return;
      }

      const currentBlock = editor.getTextCursorPosition().block;
      if (currentBlock.type === "codeBlock") return;
      const pagePasteIntent = resolvePageDeepLinkPasteIntent({
        plainText: event.clipboardData.getData("text/plain"),
        hasStructuredClipboard: clipboardTypes.some((type) =>
          ["text/html", "text/markdown", "blocknote/html"].includes(type),
        ),
        hasFiles: (event.clipboardData.files?.length ?? 0) > 0,
        hasTextSelection: editor.getSelectedText().length > 0,
        currentBlockType: currentBlock.type,
        currentBlockIsEmpty:
          Array.isArray(currentBlock.content) && currentBlock.content.length === 0,
      });
      if (pagePasteIntent) {
        event.preventDefault();
        event.stopPropagation();
        if (pagePasteIntent.kind === "link") {
          editor.createLink(pagePasteIntent.href);
          return;
        }
        if (pagePasteIntent.kind === "mention") {
          editor.insertInlineContent(
            [
              {
                type: "pageMention",
                props: { targetPageId: pagePasteIntent.pageId },
              },
              " ",
            ],
            { updateSelection: true },
          );
          return;
        }
        editor.updateBlock(currentBlock, {
          type: "pageRef",
          props: { targetBlockId: pagePasteIntent.pageId },
        });
        return;
      }

      const plainText = event.clipboardData.getData("text/plain");
      const clipboardFiles = clipboardFilesFromDataTransfer(event.clipboardData);
      const onlyImageFiles =
        clipboardFiles.length > 0 && clipboardFiles.every((file) => file.type.startsWith("image/"));
      if (onlyImageFiles) {
        event.preventDefault();
        event.stopPropagation();
        void pasteImageFromSubscription(clipboardFiles, capturePasteResourceTarget(editor));
        return;
      }
      const inspectedItems = readNativePastePayload(event)?.items ?? [];
      const shouldPromptFiles = inspectedItems.length > 0 || clipboardFiles.length > 0;
      const shouldPromptText =
        !shouldPromptFiles &&
        shouldPromptForOversizedText(
          plainText,
          serializeEditorToNfm().length,
          pasteResourceSettings,
        );

      if (!shouldPromptFiles && !shouldPromptText) return;

      event.preventDefault();
      event.stopPropagation();

      const target = capturePasteResourceTarget(editor);

      if (inspectedItems.length > 0) {
        setPasteResourceDialog({
          target,
          items: inspectedItems.map((item) => ({
            kind: item.kind,
            name: item.name,
            path: item.path,
            mimeType: item.mimeType,
            bytes: item.bytes,
          })),
          allowLink: inspectedItems.every((item) => item.path.length > 0),
        });
        return;
      }

      if (clipboardFiles.length > 0) {
        const fileDraftItems = normalizeClipboardFileDraftItems(clipboardFiles);
        setPasteResourceDialog({
          target,
          items: fileDraftItems,
          allowLink: fileDraftItems.every((item) => Boolean(item.path)),
        });
        return;
      }

      if (shouldPromptText) {
        setPasteResourceDialog({
          target,
          items: [{ kind: "text", name: "Pasted text" }],
          textPayload: plainText,
          htmlPayload: event.clipboardData.getData("text/html") || undefined,
          markdownPayload: event.clipboardData.getData("text/markdown") || undefined,
          blocknoteHtmlPayload:
            event.clipboardData.getData("blocknote/html") ||
            readNodexClipboardFragment(event.clipboardData.getData("text/html")) ||
            undefined,
          allowLink: false,
        });
      }
    };

    container.addEventListener("paste", handlePasteCapture, true);
    return () => {
      container.removeEventListener("paste", handlePasteCapture, true);
    };
  }, [editor, pasteResourceDialog, pasteResourceSettings, serializeEditorToNfm]);

  useEffect(() => {
    if (!editor) return;
    setNfmSearchQuery(editor, searchQuery);
  }, [editor, searchQuery]);

  const containerRef = useRef<HTMLDivElement>(null);
  const selectionObservationRef = useRef<ReturnType<
    typeof createPageEditorSelectionObservation
  > | null>(null);
  const readPendingObservationInput = useEffectEvent(() => pasteResourceDialog != null);
  useLayoutEffect(() => {
    if (!editorSession || editorSession.descriptor.ownerType !== "page") return;
    const runtime = editorSession.runtime;
    const selection = createPageEditorSelectionObservation({
      read: () => readPageEditorSelectedBlockIds(editor),
      focused: () => editor.prosemirrorView?.hasFocus() === true,
    });
    selectionObservationRef.current = selection;
    const unsubscribeSelection = editor.onSelectionChange(selection.update);
    const unregister = registerPageEditorObservationParticipant(editorSession.key, {
      readSelection: selection.readSelection,
      subscribeSelection: selection.subscribeSelection,
      read: () => ({
        mounted: containerRef.current?.isConnected === true,
        transientInput: readPendingObservationInput() || hasNfmEditorTransientInput(editor),
        status: runtime.getStatus(),
      }),
      prepare: async (options) => {
        if (readPendingObservationInput()) throw new Error("The Page editor has pending input");
        return prepareNfmEditorObservation(editor, containerRef.current, runtime, options);
      },
    });
    return () => {
      if (selectionObservationRef.current === selection) selectionObservationRef.current = null;
      unsubscribeSelection();
      unregister();
    };
  }, [editor, editorSession]);
  const removalPresentation = useMemo(() => {
    if (!editorSession) return null;
    const runtime = editorSession.runtime;
    return structuralEditingSession.retainRemovalPresentation(
      () =>
        new NfmStructuralRemovalPresentation({
          editor,
          readHead: () => {
            const status = runtime.getStatus();
            const provider = status.provider;
            if (
              status.reloadRequired ||
              status.phase === "closed" ||
              status.phase === "closing" ||
              provider.storeEpoch !== source.storeEpoch ||
              provider.generation !== source.generation
            )
              return null;
            return {
              documentId: source.documentId,
              storeEpoch: source.storeEpoch,
              generation: source.generation,
              expectedHeadSeq: provider.headSeq,
            };
          },
          subscribeHead: runtime.subscribe,
        }),
    );
  }, [
    editor,
    editorSession,
    structuralEditingSession,
    source.documentId,
    source.storeEpoch,
    source.generation,
  ]);
  useLayoutEffect(() => removalPresentation?.attach(), [removalPresentation]);

  const structuralMutationParticipant = useMemo(() => {
    if (!surfaceMutationBarrier) return undefined;
    return {
      documentId: source.documentId,
      presentRemoval: removalPresentation?.accept,
      prepareAndFence: async (options?: DocumentWaitOptions) => {
        return await prepareNfmEditorStructuralMutation(
          editor as unknown as NfmEditorStructuralMutationRuntime,
          containerRef.current,
          surfaceMutationBarrier,
          options,
        );
      },
    };
  }, [editor, source.documentId, surfaceMutationBarrier, removalPresentation]);

  useEffect(() => {
    if (!structuralMutationParticipant) return;
    return registerBlockDocumentStructuralMutationParticipant(
      source.clientSessionId,
      structuralMutationParticipant,
    );
  }, [source.clientSessionId, structuralMutationParticipant]);

  const historyEditableRoot = useCallback(() => editor.domElement ?? null, [editor]);
  useSurfaceHistoryFocus(
    containerRef,
    structuralEditingSession.historyControls,
    historyEditableRoot,
  );

  useLayoutEffect(() => {
    if (!structuralMutationParticipant || !surfaceMutationBarrier) return;
    if (!surfaceMutationBarrier.libraryId)
      throw new Error("Structural editing requires the Document's Library authority.");
    structuralEditingController.activate(structuralEditingSession, {
      routingContext: contentRoutingContext,
      libraryId: surfaceMutationBarrier.libraryId,
      source: {
        documentId: source.documentId,
        storeEpoch: source.storeEpoch,
        generation: source.generation,
      },
      participant: structuralMutationParticipant,
      getContainer: () => containerRef.current,
      copyFileReferencesAsLocalPaths: readCopyFileReferencesAsLocalPaths,
      onError: (message) => toast.danger(message),
      onClipboardFallback: (message) => toast.info(message),
    });
  }, [
    contentRoutingContext,
    source.documentId,
    source.generation,
    source.storeEpoch,
    structuralEditingController,
    structuralEditingSession,
    surfaceMutationBarrier,
    structuralMutationParticipant,
  ]);

  // Updating callbacks/props preserves a pending save wait; only leaving this view cancels it.
  useLayoutEffect(
    () => () => structuralEditingController.deactivate(structuralEditingSession),
    [structuralEditingController, structuralEditingSession],
  );

  useEffect(() => {
    if (!sourcePageContext || !isCanvasHostDocumentRuntime(surfaceMutationBarrier)) {
      return;
    }
    return registerCanvasHostDocumentRuntime(source.clientSessionId, surfaceMutationBarrier);
  }, [source.clientSessionId, sourcePageContext, surfaceMutationBarrier]);

  useImperativeHandle(
    navigationRef ?? embeddedBoundary?.navigationRef,
    () => ({
      focus: () => {
        if (!editor.domElement) return false;
        editor.focus();
        return true;
      },
      focusBlock: (blockId) => focusNfmEditorBlock(editor, blockId),
      focusBoundary: (direction) =>
        focusEmbeddedEditorBoundary(editor as unknown as EmbeddedSurfaceHostEditor, direction),
      openLineAtStart: () => {
        const first = editor.document[0];
        if (!first || !editor.isEditable) return false;
        const lineId = isEmptyParagraphBlock(first)
          ? first.id
          : editor.insertBlocks([{ type: "paragraph" }], first.id, "before")[0]?.id;
        if (!lineId) return false;
        editor.setTextCursorPosition(lineId, "start");
        editor.focus();
        return true;
      },
    }),
    [editor],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleBeforeInput = (event: InputEvent) => {
      if (!ownsNfmEditorEvent(el, event.target)) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (!owner.getActiveStructuralSession()?.handleBeforeInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!ownsNfmEditorEvent(el, event.target)) return;

      const targetIsTextField =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

      if (
        !targetIsTextField &&
        event.key === "Enter" &&
        !event.altKey &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.isComposing &&
        activateSelectedMention(editor)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (!targetIsTextField && owner.getActiveStructuralSession()?.handleKeyDown(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (
        !targetIsTextField &&
        !event.altKey &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.isComposing
      ) {
        if (isSpaceShortcut(event)) {
          const focusedImage = resolveFocusedImagePreview(
            editor as unknown as ImageSelectionEditor,
          );
          if (focusedImage) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) {
              openImagePreview(focusedImage);
            }
            return;
          }
        }

        if (
          (event.key === "ArrowUp" || event.key === "ArrowDown") &&
          handleArrowIntoEmbeddedSurface(
            editor as unknown as EmbeddedSurfaceHostEditor,
            event.key === "ArrowUp" ? "up" : "down",
          )
        ) {
          event.preventDefault();
          return;
        }

        const verticalDirection =
          event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : null;
        if (
          verticalDirection &&
          embeddedBoundary &&
          isEditorAtVisibleBoundary(
            editor as unknown as EmbeddedSurfaceHostEditor,
            verticalDirection,
          ) &&
          embeddedBoundary.onBoundaryArrow(verticalDirection)
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        if (
          event.key === "ArrowUp" &&
          deferCollapsedToggleVerticalArrowToBrowser(editor, el, "prev", event)
        ) {
          return;
        }

        if (
          event.key === "ArrowDown" &&
          deferCollapsedToggleVerticalArrowToBrowser(editor, el, "next", event)
        ) {
          return;
        }
      }

      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();

      if (!modifier) return;

      if (key === "enter" && !targetIsTextField && !event.altKey && !event.shiftKey) {
        // Activating a Prompt sends it, as activating a to-do checks it.
        const promptBlockId = promptRuntimeRef.current.destination
          ? findNfmPromptBlockAtCaret(
              editor as unknown as Parameters<typeof findNfmPromptBlockAtCaret>[0],
            )
          : null;
        if (promptBlockId) {
          event.preventDefault();
          event.stopPropagation();
          void promptRuntimeRef.current
            .send(promptBlockId)
            .catch((error: unknown) => reportNfmChatSendFailure("send", error));
          return;
        }
      }

      if (key === "enter" && !targetIsTextField) {
        const handled =
          !event.altKey &&
          !event.shiftKey &&
          handleNfmEditorModEnterShortcut(editor as unknown as ModifyShortcutEditor, {
            openImagePreview: (preview) => {
              openImagePreview(preview);
            },
          });
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      if (matchesNfmFindShortcut(event, isMac ? "macOS" : "windows")) {
        event.preventDefault();
        if (!targetIsTextField) {
          const seedQuery = resolveFindShortcutSeedQuery(editor);
          if (seedQuery.length > 0) {
            setSearchQuery(seedQuery);
          }
        }
        openSearch();
        return;
      }

      if (!searchOpen) return;

      if (key === "g") {
        event.preventDefault();
        navigateSearch(event.shiftKey ? "prev" : "next");
        return;
      }

      if (
        key === "enter" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        navigateSearch("next");
      }
    };

    el.addEventListener("beforeinput", handleBeforeInput, true);
    el.addEventListener("keydown", handleKeyDown, true);
    return () => {
      el.removeEventListener("beforeinput", handleBeforeInput, true);
      el.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [editor, embeddedBoundary, navigateSearch, openImagePreview, openSearch, searchOpen, owner]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleDoubleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      const nearestEditor = event.target.closest(".nfm-editor");
      if (nearestEditor && nearestEditor !== el) {
        return;
      }

      const imageContent = event.target.closest<HTMLElement>("[data-content-type='image']");
      if (!imageContent || !el.contains(imageContent)) return;

      const blockOuter = imageContent.closest<HTMLElement>(
        "[data-node-type='blockOuter'][data-id]",
      );
      const clickedImage = blockOuter?.dataset.id
        ? resolveImagePreviewByBlockId(
            editor as unknown as ImageBlockLookupEditor,
            blockOuter.dataset.id,
          )
        : null;
      const focusedImage = resolveFocusedImagePreview(editor as unknown as ImageSelectionEditor);
      const preview = clickedImage ?? focusedImage;
      if (!preview) return;

      event.preventDefault();
      event.stopPropagation();
      openImagePreview(preview);
    };

    el.addEventListener("dblclick", handleDoubleClick, true);
    return () => {
      el.removeEventListener("dblclick", handleDoubleClick, true);
    };
  }, [editor, openImagePreview]);

  const resolveSendBlocksSelection = useCallback(
    (fallbackBlockId: string, retainedBlockIds?: readonly string[]): SendBlocksSelection | null => {
      if (!sourcePageContext) return null;

      const container = containerRef.current;
      if (!container) return null;

      const dropEditor = editor as unknown as EditorForExternalBlockDrop;
      const selection = resolveSendBlockSelection(
        dropEditor,
        container,
        fallbackBlockId,
        retainedBlockIds,
      );
      if (selection.blockIds.length === 0) return null;

      return {
        blockIds: selection.blockIds,
        blocks: selection.blocks,
      };
    },
    [editor, sourcePageContext],
  );

  const commitBlockSelectionMove = async (
    selection: SendBlocksSelection,
    destination: Extract<NfmMoveToDestination, { kind: "db-column" }>,
  ) => {
    if (!sourcePageContext) {
      throw new Error("No blocks selected.");
    }
    if (executionProjectId === null) {
      throw new Error("Moving Blocks requires a Project.");
    }
    const session = owner.getActiveStructuralSession();
    if (!session) {
      throw new Error("The collaborative Page surface changed; reopen it before moving Blocks.");
    }
    await session.promoteBlocks({
      projectId: executionProjectId,
      storeEpoch: source.storeEpoch,
      sourcePageId: sourcePageContext.pageId,
      sourceDocumentId: source.documentId,
      sourceDocumentGeneration: source.generation,
      rootBlockIds: selection.blockIds,
      destination,
    });
  };

  const moveBlocksToDestination = async (
    destination: NfmMoveToDestination,
    fallbackBlockId: string,
    retainedBlockIds?: readonly string[],
  ) => {
    const selection = resolveSendBlocksSelection(fallbackBlockId, retainedBlockIds);
    if (!selection) {
      throw new Error("No blocks selected.");
    }

    if (destination.kind === "page") {
      if (
        !sourcePageContext ||
        destination.projectId !== executionProjectId ||
        destination.pageId === sourcePageContext.pageId
      ) {
        throw new Error("Choose another Page in this Project.");
      }
      const session = owner.getActiveStructuralSession();
      if (
        !session?.moveBlocksToDocument(selection.blockIds, async () => {
          const target = await prepareOwnedBlockDocument(destination.projectId, destination.pageId);
          if (!target.ok) throw new Error(target.error.message);
          return {
            documentId: target.value.documentId,
            storeEpoch: target.value.storeEpoch,
            generation: target.value.generation,
            headSeq: target.value.headSeq,
          };
        })
      ) {
        throw new Error("Structural editing is unavailable on this Page.");
      }
      await session.whenIdle();
      return;
    }

    if (hasTypedOwnerBlock(selection.blocks)) {
      throw new Error("Selections that own nested content can move only to another Page.");
    }
    await commitBlockSelectionMove(selection, destination);

    restoreEditorFocus();
  };

  /** Sends a compiled Page prompt to one chat; resolves to the accepted message. */
  const sendPromptInputToChat = useCallback(
    async (
      target: NfmSendToThreadRequest["target"],
      promptInput: CodexPromptInput,
    ): Promise<PageChatSendResult> => {
      if (chatSendProjectId === null) {
        throw new Error("Sending Blocks to a chat requires a Project.");
      }
      const submittedPresentation = readCodexSubmissionPresentation(workbenchOwner);
      await surfaceMutationBarrier?.flushAndFence();
      if (target.kind === "thread") {
        if (!onSendPagePrompt) throw new Error("Chat sending is not available.");
        return onSendPagePrompt({
          projectId: chatSendProjectId,
          threadId: target.threadId,
          prompt: promptInput.text,
          promptInput,
          submittedPresentation,
        });
      }
      if (!onStartNewSessionThreadFromEditor) {
        throw new Error("New chat creation is not available.");
      }
      return onStartNewSessionThreadFromEditor({
        projectId: chatSendProjectId,
        targetSessionId: target.sessionId,
        prompt: promptInput.text,
        promptInput,
        submittedPresentation,
      });
    },
    [
      chatSendProjectId,
      onSendPagePrompt,
      onStartNewSessionThreadFromEditor,
      surfaceMutationBarrier,
      workbenchOwner,
    ],
  );

  /** Compiles the retained or selected Blocks, or reports that there is nothing to hand over. */
  const compileSendBlocksPrompt = useCallback(
    (fallbackBlockId: string, retainedBlockIds?: readonly string[]) => {
      if (!sourcePageContext) {
        throw new Error("No blocks selected.");
      }
      const selection = resolveSendBlocksSelection(fallbackBlockId, retainedBlockIds);
      if (!selection) {
        throw new Error("No blocks selected.");
      }
      const promptInput = projectMessageBlocks(selection.blocks);
      if (promptInput.text.length === 0 && (promptInput.images?.length ?? 0) === 0) {
        toast.info("Selected blocks are empty.", { id: "nfm-send-to-thread" });
        return null;
      }
      return { selection, promptInput };
    },
    [resolveSendBlocksSelection, sourcePageContext],
  );

  /**
   * A finished handoff releases its selection, so the menus it came from close with it. A send
   * keeps writing in the Page; content added to a composer leaves focus with that composer.
   */
  const settleHandedOffSelection = useCallback(
    (blockIds: readonly string[], focus: "page" | "composer") => {
      collapseNfmHandedOffSelection(editor, blockIds);
      selectionObservationRef.current?.release();
      if (focus === "page") restoreEditorFocus();
    },
    [editor, restoreEditorFocus],
  );

  const blockActionCapabilities = resolveNfmEditorBlockActionCapabilities(
    sourcePageContext !== undefined,
    executionProjectId,
    chatSendProjectId,
  );

  /** A Prompt keeps its exact last accepted message; a folded Prompt leaves room for the next. */
  const recordPromptSends = useCallback(
    (
      blocks: readonly { id: string; type: string; children?: readonly unknown[] }[],
      accepted: PageChatSendResult,
    ) => {
      const sentAt = new Date().toISOString();
      for (const block of blocks) {
        if (block.type !== "prompt" || !editor.getBlock(block.id)) continue;
        editor.updateBlock(block.id, {
          props: { sentSessionId: accepted.sessionId, sentAt, sentMessageId: accepted.messageId },
        });
        if ((block.children?.length ?? 0) > 0) writeNfmPromptCollapsed(block.id, true);
      }
    },
    [editor],
  );

  /** The beside chat when there is one; otherwise a Prompt starts a new chat in this Project. */
  const promptDestinationTarget = useMemo((): NfmSendToThreadRequest["target"] | null => {
    if (!blockActionCapabilities.canSendBlocksToThread) return null;
    if (sessionSendToThreadPreferredTarget)
      return resolveNfmSendToThreadPreferredDestination(sessionSendToThreadPreferredTarget);
    return { kind: "new-thread" };
  }, [blockActionCapabilities.canSendBlocksToThread, sessionSendToThreadPreferredTarget]);

  const sendPromptBlock = useCallback(
    async (promptBlockId: string) => {
      const block = editor.getBlock(promptBlockId);
      if (!block || block.type !== "prompt" || !promptDestinationTarget) return;
      const promptInput = projectMessageBlocks([block]);
      if (promptInput.text.length === 0 && (promptInput.images?.length ?? 0) === 0) {
        toast.info("This prompt is empty.", { id: "nfm-send-to-thread" });
        return;
      }
      const accepted = await sendPromptInputToChat(promptDestinationTarget, promptInput);
      recordPromptSends([block], accepted);
    },
    [editor, promptDestinationTarget, recordPromptSends, sendPromptInputToChat],
  );

  /** A reply lands as a Reply toggle after its Prompt, outside what the Prompt sends next time. */
  const insertPromptReply = useCallback(
    (promptBlockId: string, reply: string) => {
      if (!editor.isEditable || !editor.getBlock(promptBlockId)) return;
      const children = markdownBlocksForEditor(readMarkdown(reply));
      if (children.length === 0) return;
      const [inserted] = editor.insertBlocks(
        [{ type: "toggleListItem", content: "Reply", children } as never],
        promptBlockId,
        "after",
      );
      if (inserted) {
        // The reply was asked for to be read: show it open, as the toggle shortcut would.
        const toggle = findToggleButtonForBlock(editor.domElement, inserted.id);
        if (toggle?.closest(".bn-toggle-wrapper")?.getAttribute("data-show-children") !== "true")
          toggle?.click();
        editor.setTextCursorPosition(inserted.id, "end");
      }
      editor.focus();
    },
    [editor],
  );

  const promptRuntimeValue = useMemo<NfmPromptRuntimeValue>(
    () => ({
      destination: !promptDestinationTarget
        ? null
        : sessionSendToThreadPreferredTarget
          ? {
              kind: "beside",
              sessionId: sessionSendToThreadPreferredTarget.sessionId,
              title: describeNfmSendToThreadPreferredTarget(sessionSendToThreadPreferredTarget),
            }
          : { kind: "new-chat" },
      send: sendPromptBlock,
      insertReply: insertPromptReply,
      renderReply: (reply: string) => (
        <ReadonlyMarkdownBlockNotePreview
          content={reply}
          projectId={executionProjectId ?? ""}
          pageId={sourcePageContext?.pageId ?? ""}
        />
      ),
      pageId: sourcePageContext?.pageId ?? null,
    }),
    [
      executionProjectId,
      insertPromptReply,
      promptDestinationTarget,
      sendPromptBlock,
      sessionSendToThreadPreferredTarget,
      sourcePageContext?.pageId,
    ],
  );
  useLayoutEffect(() => {
    promptRuntimeRef.current = promptRuntimeValue;
  }, [promptRuntimeValue]);

  const sendBlocksToThread = useCallback(
    async (
      request: NfmSendToThreadRequest,
      fallbackBlockId: string,
      retainedBlockIds?: readonly string[],
    ) => {
      const compiled = compileSendBlocksPrompt(fallbackBlockId, retainedBlockIds);
      if (!compiled) return;
      const accepted = await sendPromptInputToChat(request.target, compiled.promptInput);
      recordPromptSends(compiled.selection.blocks, accepted);
      toast.success(request.target.kind === "thread" ? "Sent to chat" : "Sent to new chat", {
        id: "nfm-send-to-thread",
      });
      settleHandedOffSelection(compiled.selection.blockIds, "page");
    },
    [compileSendBlocksPrompt, recordPromptSends, sendPromptInputToChat, settleHandedOffSelection],
  );

  const addBlocksToComposer = useCallback(
    async (fallbackBlockId: string, retainedBlockIds?: readonly string[]) => {
      if (!onAddPromptToChatComposer) return;
      const compiled = compileSendBlocksPrompt(fallbackBlockId, retainedBlockIds);
      if (!compiled) return;
      await surfaceMutationBarrier?.flushAndFence();
      await onAddPromptToChatComposer(compiled.promptInput);
      settleHandedOffSelection(compiled.selection.blockIds, "composer");
    },
    [
      compileSendBlocksPrompt,
      onAddPromptToChatComposer,
      settleHandedOffSelection,
      surfaceMutationBarrier,
    ],
  );

  const crossSurfaceDrag = (() => {
    if (!surfaceMutationBarrier) {
      return undefined;
    }
    return {
      surfaceId: source.clientSessionId,
      projectId: executionProjectId,
      documentId: source.documentId,
      storeEpoch: source.storeEpoch,
      blockTransferDrop: {
        surfaceId: source.clientSessionId,
        projectId: executionProjectId,
        documentId: source.documentId,
        storeEpoch: source.storeEpoch,
        ...(sourcePageContext?.pageId ? { hostPageId: sourcePageContext.pageId } : {}),
        ancestorPageIds: parentBlockReferenceRuntime?.ancestorPageIds ?? [],
        prepareAndFence: (options?: DocumentWaitOptions) => {
          if (!structuralMutationParticipant)
            throw new Error("The editor is not ready for a transfer.");
          return structuralMutationParticipant.prepareAndFence(options);
        },
        prepareSourceAndFence: async (sourceSurfaceId: string, options?: DocumentWaitOptions) => {
          const participant = resolveBlockDocumentStructuralMutationParticipant(sourceSurfaceId);
          if (!participant) {
            throw new Error("The dragged Page editor changed; start the drag again.");
          }
          return await participant.prepareAndFence(options);
        },
        receivePages: async (intent: NfmReceivingPageTransferIntent) => {
          const session = owner.getActiveStructuralSession();
          if (!session) throw new Error("The editor is not ready to receive Pages.");
          await session.receivePages(intent);
        },
        structuralTransfer: async ({
          mode,
          rootBlockIds,
          prepareHeads,
          target,
          preferredSelectionBlockId,
        }: {
          readonly mode: "move" | "copy";
          readonly rootBlockIds: readonly string[];
          readonly prepareHeads: () => Promise<{
            readonly sourceHead: DocumentHeadFence;
            readonly targetHead: DocumentHeadFence;
          }>;
          readonly target: {
            readonly parentBlockId: string | null;
            readonly beforeBlockId: string | null;
          };
          readonly preferredSelectionBlockId?: string;
        }) => {
          const session = owner.getActiveStructuralSession();
          if (!session) throw new Error("The editor is not ready for a structural transfer.");
          await session.transferBlocks({
            mode,
            rootBlockIds,
            prepareHeads,
            target,
            preferredSelectionBlockId,
          });
        },
        reportError: (message: string) => toast.danger(message),
      },
    };
  })();

  useEditorDragBehaviors({
    editor,
    containerRef,
    crossSurface: crossSurfaceDrag,
  });
  const sideMenuSelectionGuardActive = useSideMenuSelectionGuard(containerRef);
  const sideMenuFloatingOptions = useMemo(
    () => getSideMenuSelectionGuardFloatingOptions(sideMenuSelectionGuardActive),
    [sideMenuSelectionGuardActive],
  );

  // The side-menu component identity must stay stable across NfmEditor renders.
  // BlockNote renders the side menu as `<Component/>` where Component is this
  // value; if its identity changes, React remounts the whole side-menu (and its
  // native drag-handle) subtree. Because the editor can re-render at a high
  // frequency, an unstable side-menu identity remounts the grip mid-gesture and
  // aborts native block drag-and-drop. Route volatile values through a ref so
  // the callback identity below never changes.
  const handleBlockDragStart = useCallback(
    ({ dataTransfer, blockIds }: { dataTransfer: DataTransfer; blockIds: readonly string[] }) => {
      const roots = resolveTopLevelDraggedBlocks(editor, [...blockIds]);
      if (roots.length === 0) return;
      beginLocalBlockDragSession(
        {
          sourceSurfaceId: source.clientSessionId,
          projectId: executionProjectId,
          storeEpoch: source.storeEpoch,
          source: sourcePageContext
            ? { kind: "page", pageId: sourcePageContext.pageId }
            : { kind: "document", documentId: source.documentId },
          rootBlockIds: roots.map((block) => block.id),
          displayHints: roots.map((block) =>
            block.type === "page" || block.type === "canvas" || block.type === "database"
              ? block.type
              : hasTypedOwnerBlock([block])
                ? "structural"
                : block.type,
          ),
          promotionPreviews: roots.map((block) => ({
            rootBlockId: block.id,
            title: resolveDraggedBlockPromotionTitle(block, (pageId) => {
              const target = readCachedPageTargetReadModel(
                queryClient,
                contentRoutingContext,
                pageId,
              );
              return target?.status === "available" ? target.page.title : null;
            }),
          })),
          taskShorthandPreviewHints: roots.flatMap((block) => {
            const content = (block as { readonly content?: unknown }).content;
            const preview = previewTaskShorthandInlineContent(content);
            return preview
              ? [
                  {
                    rootBlockId: block.id,
                    priority: preview.priority,
                    estimate: preview.estimate,
                    tagCount: preview.tags.length,
                  },
                ]
              : [];
          }),
        },
        dataTransfer,
      );
    },
    [contentRoutingContext, editor, executionProjectId, queryClient, source, sourcePageContext],
  );
  const handleBlockDragEnd = useCallback(
    () => endLocalBlockDragSession({ sourceSurfaceId: source.clientSessionId }),
    [source.clientSessionId],
  );
  const handleTurnBlocksInto = (input: NfmTurnBlocksIntoInput) => {
    const expandedBlocks = input.expandedBlockIds.flatMap((blockId) => {
      const block = editor.getBlock(blockId);
      return block ? [block] : [];
    });
    const unsupportedOwner = expandedBlocks.find(
      (block) => hasTypedOwnerType([block.type]) && block.type !== "page",
    );
    if (unsupportedOwner) {
      toast.info("Canvas and Database blocks cannot be turned into text content.");
      return true;
    }
    if (expandedBlocks.some((block) => block.type === "page")) {
      return (
        owner
          .getActiveStructuralSession()
          ?.turnBlocksInto(input.rootBlockIds, input.expandedBlockIds, input.target) ?? false
      );
    }
    applyLocalNfmTurnInto(editor, expandedBlocks, input.localPatch);
    return true;
  };
  const sideMenuHandlers = {
    canSendBlocks: blockActionCapabilities.canMoveBlocks,
    canSendToThread: blockActionCapabilities.canSendBlocksToThread,
    sendToThreadProjectNameById,
    sendToThreadPreferredTarget: sessionSendToThreadPreferredTarget,
    onSendBlocksToThread: (request: NfmSendToThreadRequest, blockIds: readonly string[]) =>
      sendBlocksToThread(request, blockIds[0] ?? "", blockIds),
    ...(onAddPromptToChatComposer
      ? {
          onAddBlocksToComposer: (blockIds: readonly string[]) =>
            addBlocksToComposer(blockIds[0] ?? "", blockIds),
        }
      : {}),
    sourceProjectId: sourcePageContext ? executionProjectId : null,
    sendToThreadProjectId: sourcePageContext ? chatSendProjectId : null,
    sourcePageId: sourcePageContext?.pageId ?? null,
    onMoveBlocksToDestination: moveBlocksToDestination,
    onBlockDragStart: handleBlockDragStart,
    onBlockDragEnd: handleBlockDragEnd,
    onDuplicateBlocks: (blockIds: readonly string[]) =>
      owner.getActiveStructuralSession()?.duplicateBlocks(blockIds) ?? false,
    onDeleteBlocks: (blockIds: readonly string[]) =>
      owner.getActiveStructuralSession()?.deleteBlocks(blockIds, "backward") ?? false,
    onTurnBlocksInto: handleTurnBlocksInto,
  };

  const sideMenuRuntimeValue = {
    getSnapshot: () => sideMenuHandlers,
  };

  const customSideMenu = useCallback(() => <NfmSideMenu />, []);

  const textActionMenuRuntimeValue = useMemo(
    () => ({
      chat: blockActionCapabilities.canSendBlocksToThread
        ? {
            projectId: sourcePageContext ? chatSendProjectId : null,
            sourcePageId: sourcePageContext?.pageId ?? null,
            projectNameById: sendToThreadProjectNameById,
            contextualTarget: sessionSendToThreadPreferredTarget,
            send: (request: NfmSendToThreadRequest, selectedBlockIds: readonly string[]) =>
              sendBlocksToThread(request, selectedBlockIds[0] ?? "", selectedBlockIds),
            ...(onAddPromptToChatComposer
              ? {
                  addToComposer: (selectedBlockIds: readonly string[]) =>
                    addBlocksToComposer(selectedBlockIds[0] ?? "", selectedBlockIds),
                }
              : {}),
          }
        : null,
    }),
    [
      addBlocksToComposer,
      onAddPromptToChatComposer,
      blockActionCapabilities.canSendBlocksToThread,
      chatSendProjectId,
      sendToThreadProjectNameById,
      sendBlocksToThread,
      sessionSendToThreadPreferredTarget,
      sourcePageContext,
    ],
  );

  const openSessionMention = useCallback(
    (sessionId: string) => {
      if (!onOpenSession) return;
      void onOpenSession(sessionId);
    },
    [onOpenSession],
  );

  const createCanvasAtEmptyParagraph = useCallback(
    async ({
      blockId,
      displayName,
    }: {
      readonly blockId: string;
      readonly displayName?: string;
    }) => {
      if (!sourcePageContext) {
        throw new Error("Canvas can only be added inside a Page.");
      }
      if (!isCanvasHostDocumentRuntime(surfaceMutationBarrier)) {
        throw new Error("The Page Document is not ready to create a Canvas.");
      }
      return createCanvasInHostPage({
        routingContext: contentRoutingContext,
        hostPageId: sourcePageContext.pageId,
        replacementBlockId: blockId,
        displayName,
        runtime: surfaceMutationBarrier,
      });
    },
    [contentRoutingContext, sourcePageContext, surfaceMutationBarrier],
  );

  const createSubpageAtEmptyParagraph = useCallback(
    async ({ blockId, title }: { readonly blockId: string; readonly title: string }) => {
      if (!sourcePageContext) {
        throw new Error("A Subpage can only be created inside a Page.");
      }
      if (!structuralMutationParticipant) {
        throw new Error("The Page Document is not ready to create a Subpage.");
      }
      const hostHead = await structuralMutationParticipant.prepareAndFence();
      if (
        hostHead.storeEpoch !== source.storeEpoch ||
        hostHead.documentId !== source.documentId ||
        hostHead.generation !== source.generation
      ) {
        throw new Error("The host Page changed; reopen it before creating the Subpage.");
      }
      const pageId = createUuidV7();
      const result = await applyLibraryModule(contentRoutingContext, {
        operationId: createUuidV7(),
        storeEpoch: source.storeEpoch,
        operation: {
          kind: "create_page",
          pageId,
          documentId: createUuidV7(),
          title: title.trim() || "Untitled",
          parent: {
            kind: "page",
            pageId: sourcePageContext.pageId,
            expectedDocumentGeneration: hostHead.generation,
            expectedDocumentHeadSeq: hostHead.expectedHeadSeq,
            insertion: { kind: "replace_empty_paragraph", blockId },
          },
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      if (
        result.value.createdTarget?.kind !== "page" ||
        result.value.createdTarget.pageId !== pageId
      ) {
        throw new Error("Core did not return the created Subpage.");
      }
      return { pageId };
    },
    [
      contentRoutingContext,
      source.documentId,
      source.generation,
      source.storeEpoch,
      sourcePageContext,
      structuralMutationParticipant,
    ],
  );

  const createPageMention = async ({
    pageId,
    title,
    blockId,
    expectedContent,
    replacementContent,
    destinationPageId,
  }: Parameters<NonNullable<BlockReferenceHostRuntime["createPageMention"]>>[0]) => {
    if (!sourcePageContext) {
      throw new Error("A Page mention can only create a Page inside another Page.");
    }
    if (!structuralMutationParticipant) {
      throw new Error("The Page Document is not ready to create a Page mention.");
    }
    const session = owner.getActiveStructuralSession();
    if (!session) throw new Error("The editor is not ready to create a Page mention.");
    await session.createPageMention({
      pageId,
      title,
      hostPageId: sourcePageContext.pageId,
      blockId,
      expectedContent,
      replacementContent,
      destinationPageId,
    });
    return { pageId };
  };

  const handleEditorClickCapture = useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = readNfmLinkHrefAtElement(editor, anchor);
      const action = resolveNfmLinkAction(href);
      if (action?.kind !== "page") return;
      event.preventDefault();
      event.stopPropagation();
      if (!onOpenPage) return;
      void onOpenPage({
        routingContext: contentRoutingContext,
        pageId: action.pageId,
      });
    },
    [contentRoutingContext, editor, onOpenPage],
  );

  const duplicateCanvasAfter = async (canvasBlockId: string) => {
    const session = owner.getActiveStructuralSession();
    if (!session?.duplicateBlocks([canvasBlockId])) {
      throw new Error("Structural editing is unavailable for this Canvas.");
    }
    await session.whenIdle();
  };

  const deleteCanvas = async (canvasBlockId: string) => {
    const session = owner.getActiveStructuralSession();
    if (!session?.deleteBlocks([canvasBlockId], "backward")) {
      throw new Error("Structural editing is unavailable for this Canvas.");
    }
    await session.whenIdle();
  };

  useEffect(
    () =>
      editor.onBeforeChange(({ getChanges }) => {
        const decision = resolveTypedOwnerDocumentChanges(getChanges());
        if (decision.kind === "allow") return;
        queueMicrotask(() => {
          toast.danger(
            "Nodex blocked an incomplete structural change. Retry the action after the editor settles.",
          );
        });
        return false;
      }),
    [editor],
  );

  const renameCanvas = useCallback(
    async ({
      canvasBlockId,
      displayName,
    }: {
      readonly canvasBlockId: string;
      readonly displayName: string;
    }) => {
      await renameCanvasOwner({
        routingContext: contentRoutingContext,
        canvasBlockId,
        displayName,
      });
    },
    [contentRoutingContext],
  );
  const threadMentionRuntimeValue = useMemo<ThreadMentionRuntimeValue>(
    () => ({
      sessions: threadMentionSummaryMap,
      resolvingIds: threadMentionResolvingIds,
      resolveSession: resolveSessionMention,
      ...(onOpenSession ? { openSession: openSessionMention } : {}),
    }),
    [
      onOpenSession,
      openSessionMention,
      resolveSessionMention,
      threadMentionResolvingIds,
      threadMentionSummaryMap,
    ],
  );

  const agentConfigRuntimeValue = useMemo<AgentConfigRuntimeValue>(
    () => ({
      projectId: executionProjectId,
      availableModels: availableCodexModels,
      availableModelsLoading: availableCodexModels.length === 0,
      defaultIntelligence: resolveDefaultAgentConfigIntelligence(availableCodexModels),
    }),
    [availableCodexModels, executionProjectId],
  );

  const blockReferenceRuntimeValue: BlockReferenceHostRuntime = (() => {
    const currentDocumentOwnerBlockId = documentOwnerBlockId ?? sourcePageContext?.pageId;
    return {
      contentRoutingContext,
      projectName,
      projectWorkspacePath: projectWorkspacePath ?? null,
      hostPageId: sourcePageContext?.pageId ?? null,
      ancestorPageIds: appendInlineCardAncestor(
        parentBlockReferenceRuntime?.ancestorPageIds ?? [],
        sourcePageContext?.pageId,
      ),
      ancestorDocumentOwnerBlockIds: appendInlineDocumentOwnerAncestor(
        parentBlockReferenceRuntime?.ancestorDocumentOwnerBlockIds ?? [],
        currentDocumentOwnerBlockId,
      ),
      isActiveSurface: isActivePanelTab,
      documentSurfaceId: source.clientSessionId,
      historyControls: structuralEditingSession.historyControls,
      ...(onOpenPage ? { openPage: onOpenPage } : {}),
      ...(onOpenDatabase ? { openDatabase: onOpenDatabase } : {}),
      ...(onOpenCanvas ? { openCanvas: onOpenCanvas } : {}),
      ...(onOpenPageFile ? { openPageFile: onOpenPageFile } : {}),
      ...(sourcePageContext && isCanvasHostDocumentRuntime(surfaceMutationBarrier)
        ? {
            createCanvasAtEmptyParagraph,
            deleteCanvas,
            duplicateCanvasAfter,
            renameCanvas,
          }
        : {}),
      ...(sourcePageContext && surfaceMutationBarrier
        ? { createPageMention, createSubpageAtEmptyParagraph }
        : {}),
    };
  })();

  const activeMatchLabel =
    searchMatchCount === 0
      ? "0 of 0"
      : `${Math.max(searchActiveIndex + 1, 0)} of ${searchMatchCount}`;

  return (
    <FileRuntimeProvider value={fileRuntime}>
      <div
        ref={containerRef}
        className={cn("nfm-editor relative", className)}
        spellCheck={spellcheck}
        onClickCapture={handleEditorClickCapture}
        onFocusCapture={(event) => {
          if (!editorSession) return;
          const target = event.target;
          if (!(target instanceof Element)) return;
          const ownsFocusedEditor =
            target.closest(".nfm-editor") === event.currentTarget &&
            target.closest(".ProseMirror") !== null;
          editorSession.setShouldRestoreEditorFocus(ownsFocusedEditor);
        }}
        onBlurCapture={(event) => {
          if (!editorSession) return;
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Element)) return;
          if (!nextTarget.closest('[data-page-stage-surface="true"]')) return;
          editorSession.setShouldRestoreEditorFocus(false);
        }}
      >
        {searchOpen && (
          <div className="pointer-events-none sticky top-2 z-90 flex h-0 justify-end">
            <div className="pointer-events-auto mr-2 flex w-fit max-w-[calc(100%-16px)] flex-col self-start overflow-hidden rounded-lg border-[0.5px] border-(--border) bg-(--card) shadow-[0_2px_8px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.32),0_0_0_1px_rgba(255,255,255,0.06)]">
              <div className="flex items-center gap-0.5 px-1 py-1 pl-2.5">
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      navigateSearch(e.shiftKey ? "prev" : "next", true);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeSearch();
                    }
                  }}
                  placeholder="Find in description"
                  className="h-7 min-w-35 flex-1 border-none bg-transparent text-base/7 font-normal text-(--foreground) outline-none placeholder:text-(--foreground-tertiary)"
                  aria-label="Find in description"
                />
                <span className="min-w-10.5 pr-0.5 text-right text-xs whitespace-nowrap text-(--foreground-tertiary) tabular-nums">
                  {activeMatchLabel}
                </span>
                <NodexTooltip tooltipContent="Previous match (Shift+Enter)">
                  <button
                    type="button"
                    className="inline-flex h-6.5 w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)"
                    onClick={() => navigateSearch("prev", true)}
                    aria-label="Previous match"
                  >
                    <ChevronDownIcon className="size-4 rotate-180" />
                  </button>
                </NodexTooltip>
                <NodexTooltip tooltipContent="Next match (Enter)">
                  <button
                    type="button"
                    className="inline-flex h-6.5 w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)"
                    onClick={() => navigateSearch("next", true)}
                    aria-label="Next match"
                  >
                    <ChevronDownIcon className="size-4" />
                  </button>
                </NodexTooltip>
                <NodexTooltip
                  tooltipContent={replaceOpen ? "Hide replace controls" : "Show replace controls"}
                >
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-6.5 w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)",
                      replaceOpen && "text-info",
                    )}
                    onClick={() => setReplaceOpen((prev) => !prev)}
                    aria-label={replaceOpen ? "Hide replace controls" : "Show replace controls"}
                  >
                    <ReplaceIcon className="size-4" />
                  </button>
                </NodexTooltip>
                <NodexTooltip tooltipContent="Close (Esc)">
                  <button
                    type="button"
                    className="inline-flex h-6.5 w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)"
                    onClick={closeSearch}
                    aria-label="Close find"
                  >
                    <CloseIcon className="size-4" />
                  </button>
                </NodexTooltip>
              </div>

              {replaceOpen && (
                <div className="flex items-center gap-0.5 px-1 py-1 pt-0 pl-2.5">
                  <input
                    value={replaceQuery}
                    onChange={(e) => setReplaceQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        replaceCurrentMatch();
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        closeSearch();
                      }
                    }}
                    placeholder="Replace with..."
                    className="h-7 min-w-30 flex-1 border-none bg-transparent text-base/7 font-normal text-(--foreground) outline-none placeholder:text-(--foreground-tertiary)"
                    aria-label="Replace text"
                  />
                  <div className="ml-auto flex items-center gap-1">
                    <NodexTooltip tooltipContent="Replace all matches">
                      <button
                        type="button"
                        className="h-6.5 cursor-pointer rounded-sm border-none bg-transparent px-2 text-xs font-medium whitespace-nowrap text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)"
                        onClick={replaceAllMatches}
                        aria-label="Replace all matches"
                      >
                        Replace all
                      </button>
                    </NodexTooltip>
                    <NodexTooltip tooltipContent="Replace current match">
                      <button
                        type="button"
                        className="inline-flex h-6.5 cursor-pointer items-center gap-1 rounded-sm border-none bg-primary-solid px-2.5 text-xs font-medium whitespace-nowrap text-primary-solid transition-filter duration-swift ease-out hover:brightness-110"
                        onClick={replaceCurrentMatch}
                        aria-label="Replace current match"
                      >
                        Replace
                        <CornerDownLeft className="size-4" />
                      </button>
                    </NodexTooltip>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {headingRail?.portalElement ? (
          <NfmHeadingNavigationRail
            editor={editor as unknown as Parameters<typeof NfmHeadingNavigationRail>[0]["editor"]}
            scrollContainerRef={headingRail.scrollContainerRef}
            portalElement={headingRail.portalElement}
            isActivePanelTab={isActivePanelTab}
          />
        ) : null}
        <BlockReferenceRuntimeProvider value={blockReferenceRuntimeValue}>
          <AgentConfigRuntimeProvider value={agentConfigRuntimeValue}>
            <ThreadMentionRuntimeProvider value={threadMentionRuntimeValue}>
              <NfmPromptRuntimeProvider value={promptRuntimeValue}>
                <NfmEditorContextMenu
                  editor={editor}
                  onPreparePaste={() => {
                    const target = captureNfmPasteTarget(editor.prosemirrorView);
                    const releaseStructural = owner
                      .getActiveStructuralSession()
                      ?.prepareNextStructuralPaste();
                    return {
                      restore: target.restore,
                      release: () => {
                        target.release();
                        releaseStructural?.();
                      },
                    };
                  }}
                >
                  <NfmTextActionMenuRuntimeProvider value={textActionMenuRuntimeValue}>
                    <NfmSideMenuRuntimeProvider value={sideMenuRuntimeValue}>
                      <BlockNoteView
                        editor={editor}
                        onEditorViewMount={(editorRoot) => {
                          editorSession?.restoreSelection(editor);
                          onEditorViewMount?.(editorRoot);
                        }}
                        onEditorViewUnmount={() => {
                          onEditorViewUnmount?.();
                          editorSession?.captureSelection(editor);
                        }}
                        editable
                        onChange={handleChange}
                        theme={themeMode}
                        attributionTooltip={false}
                        formattingToolbar={false}
                        emojiPicker={false}
                        linkToolbar={false}
                        slashMenu={false}
                        sideMenu={false}
                        tableHandles={false}
                        data-theming-css-variables-demo
                      >
                        <NfmSideMenuOpenProvider>
                          <NfmAskForChangeProvider
                            projectId={executionProjectId}
                            pageId={sourcePageContext?.pageId ?? null}
                          >
                            <NfmCodeBlockController />
                            <NfmSideMenuShortcutController />
                            <NfmChatSendShortcutController />
                            <SideMenuController
                              sideMenu={customSideMenu}
                              floatingUIOptions={sideMenuFloatingOptions}
                            />
                            <NfmFormattingToolbarController
                              formattingToolbar={NfmFormattingToolbar}
                            />
                            <NfmLinkToolbarController
                              linkToolbar={renderLinkToolbar}
                              floatingUIOptions={{
                                useTransitionStylesProps: {
                                  duration: 0,
                                },
                                useTransitionStatusProps: {
                                  duration: 0,
                                },
                              }}
                            />
                            <NfmSlashMenu
                              executionProjectId={executionProjectId}
                              allowPageReferences
                            />
                            <NfmTableHandlesController />
                          </NfmAskForChangeProvider>
                        </NfmSideMenuOpenProvider>
                      </BlockNoteView>
                    </NfmSideMenuRuntimeProvider>
                  </NfmTextActionMenuRuntimeProvider>
                </NfmEditorContextMenu>
              </NfmPromptRuntimeProvider>
            </ThreadMentionRuntimeProvider>
          </AgentConfigRuntimeProvider>
        </BlockReferenceRuntimeProvider>
        {pasteResourceDialog && (
          <PasteResourceDialog
            open={pasteResourceDialog !== null}
            state={pasteResourceDialog}
            pending={pasteResourcePending}
            error={pasteResourceError}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                closePasteResourceDialog();
              }
            }}
            finalFocus={() => {
              restoreEditorFocus();
              return false;
            }}
            onChooseMode={(mode) => {
              void handlePasteResourceChoice(mode);
            }}
            onContinueInline={handleContinuePasteInline}
          />
        )}
        {imagePreview && (
          <ImagePreviewDialog
            open={imagePreview !== null}
            src={imagePreview.source}
            alt={imagePreview.alt}
            allowLocalPath
            closeOnSpace
            finalFocus={() => {
              restoreEditorFocus();
              return false;
            }}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                setImagePreview(null);
              }
            }}
          />
        )}
      </div>
    </FileRuntimeProvider>
  );
}

const readClipboardMarkdown = (text: string) =>
  markdownBlocksForEditor(readMarkdown(text, "boundary"));
