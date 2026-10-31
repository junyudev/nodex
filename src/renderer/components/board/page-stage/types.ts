import type { WorkbenchSubmitPresentation } from "../../../../shared/nodex-app-tools/workbench";
import type { MutableRefObject } from "react";
import type { PageInput, CodexPromptInput, CodexThreadSummary, PageChatItem } from "@/lib/types";
import type { ReadyPageBlockDocumentDescriptor } from "@/lib/owned-block-document";
import type { BlockDocumentSurfaceDependencies } from "@/components/block-documents/block-document-surface";
import type { PageTitleResourceIdentity } from "@/lib/page-title-projection-context";
import type { PageStagePageModel, PageStageMetadataMutationResult } from "@/lib/page-stage-page";
import type { PageStageBreadcrumbProps } from "./breadcrumb";
import type { DatabaseId } from "../../../../shared/database-identities";
import type {
  ContentRoutingContext,
  ContentCanvasNavigationTarget,
  ContentPageNavigationTarget,
} from "../../../../shared/content-routing-context";
import type { PageStagePropertyEdit } from "@/lib/page-stage-properties";

export type { PageStageMetadataMutationResult } from "@/lib/page-stage-page";

export type PageStageRelatedChat = PageChatItem;

export interface PageStageRelatedChatCandidate {
  readonly sessionId: string;
  readonly displayTitle: string;
  readonly projectName: string | null;
}

export interface PageStageSessionSnapshot {
  projectId: string;
  pageId: string;
  titleSnapshot: string;
}

export interface PageStageHistorySnapshot {
  readonly title: string;
  readonly markdown: string;
}

/**
 * Makes the content authority impossible to infer from a Page read model.
 * Page Stage can only mount the owned Y.Doc identified by the prepared
 * descriptor; a Page read-model projection is never an editor input.
 */
export interface PageStageDocumentAuthority {
  readonly kind: "yjs";
  readonly descriptor: ReadyPageBlockDocumentDescriptor;
  readonly reload: () => Promise<void>;
  /** In-memory transport seam for isolated fixtures and tests. */
  readonly surfaceDependencies?: BlockDocumentSurfaceDependencies;
}

export interface PageStageProps {
  onClose: () => void;
  /** Stable PageTab identity whose editor model may outlive this React view. */
  editorSessionKey?: string;
  /** Stable resource identity for renderer-local live title projection. */
  pageTitleIdentity?: PageTitleResourceIdentity;
  /** False for an unpromoted preview whose model ends with this view. */
  retainEditorSession?: boolean;
  /** Optional route-level navigation control for standalone Page surfaces. */
  onNavigateBack?: () => void;
  onLeavePage?: (snapshot: PageStageSessionSnapshot) => void;
  /** Focuses the collaborative title when this Page surface first mounts. */
  autoFocusTitle?: boolean;
  closeRef?: MutableRefObject<(() => Promise<void>) | null>;
  persistRef?: MutableRefObject<(() => Promise<void>) | null>;
  sessionSnapshotRef?: MutableRefObject<PageStageSessionSnapshot | null>;
  isActivePanelTab?: boolean;
  page: PageStagePageModel | null;
  /** Content authority selected by the mounted Project or Resource surface. */
  contentRoutingContext: ContentRoutingContext;
  projectName?: string | null;
  /** Workspace context for editor-owned local execution surfaces. */
  projectWorkspacePath?: string | null;
  onUpdate: (
    pageId: string,
    updates: Partial<PageInput>,
  ) => Promise<PageStageMetadataMutationResult | void>;
  onUpdateProperty: (
    pageId: string,
    propertyId: string,
    edit: PageStagePropertyEdit,
  ) => Promise<PageStageMetadataMutationResult | void>;
  /** Re-reads current Page/Property authority after a stale read window. */
  onRefreshProperties?: () => Promise<void>;
  onDelete?: (pageId: string) => Promise<void>;
  onCompleteOccurrence?: (pageId: string, occurrenceStart: Date) => Promise<void>;
  onSkipOccurrence?: (pageId: string, occurrenceStart: Date) => Promise<void>;
  onOpenTerminalPanel?: () => void;
  onToggleHistoryPanel?: (snapshot: PageStageHistorySnapshot) => void;
  sessionId?: string | null;
  sessionThread?: CodexThreadSummary | null;
  canStartThreadInSession?: boolean;
  /** The chat's title, naming it where the Page is offered to it. */
  sessionTitle?: string | null;
  relatedChats?: readonly PageStageRelatedChat[];
  relatedChatsLoading?: boolean;
  relatedChatsError?: string | null;
  relatedChatsHasMore?: boolean;
  relatedChatsLoadingMore?: boolean;
  relatedChatCandidates?: readonly PageStageRelatedChatCandidate[];
  onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  onCreateRelatedChat?: () => Promise<void> | void;
  onLinkRelatedChat?: (sessionId: string) => Promise<void>;
  onRemoveRelatedChat?: (sessionId: string) => Promise<void>;
  onRetryRelatedChats?: () => Promise<void> | void;
  onLoadMoreRelatedChats?: () => Promise<void> | void;
  /** Opens an attached Thread referenced inside the Page editor. */
  onOpenCodexThread?: (threadId: string) => Promise<void>;
  onOpenPage?: (input: ContentPageNavigationTarget) => void | Promise<void>;
  onOpenDatabase?: (databaseId: DatabaseId) => void | Promise<void>;
  onOpenCanvas?: (input: ContentCanvasNavigationTarget) => void | Promise<void>;
  breadcrumb?: Omit<PageStageBreadcrumbProps, "currentTitle">;
  onStartNewSessionThreadFromEditor?: (input: {
    projectId: string;
    targetSessionId?: string;
    prompt: string;
    promptInput?: CodexPromptInput;
    submittedPresentation?: WorkbenchSubmitPresentation;
    threadName?: string;
  }) => Promise<{ threadId: string; sessionId?: string }>;
  onSendPagePrompt?: (input: {
    projectId: string;
    threadId: string;
    prompt: string;
    promptInput?: CodexPromptInput;
    submittedPresentation?: WorkbenchSubmitPresentation;
  }) => Promise<void>;
  historyPanelActive?: boolean;
  /**
   * The prepared owned Document, or null while it is still being prepared. Page Detail
   * (properties, capabilities) renders immediately; title and body editors wait for it.
   */
  documentAuthority: PageStageDocumentAuthority | null;
}
