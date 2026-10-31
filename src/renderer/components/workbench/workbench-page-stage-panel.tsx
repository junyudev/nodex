import { useMemo, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { OwnedBlockDocumentBoundary } from "@/components/block-documents/owned-block-document-boundary";
import { PageStageLoadingFrame } from "@/components/board/page-stage/frame";
import type {
  PageStageRelatedChatCandidate,
  PageStageSessionSnapshot,
} from "@/components/board/page-stage/types";
import { NodexButton } from "@/components/ui/button";
import { usePageOwnershipPathReadModel } from "@/lib/block-reference-queries";
import {
  commitPageDetailMetadataPatch,
  commitPageDetailPropertyEdit,
} from "@/lib/page-detail-metadata-runtime";
import { makeEditorSurfaceKey } from "@/lib/document-session-registry";
import { projectPageDetailToStageModel } from "@/lib/page-stage-page";
import { pageStageSemanticValues, type PageStageSemanticValues } from "@/lib/page-stage-properties";
import { requestPageBlockFocus } from "@/lib/page-block-focus-intents";
import { fetchPageDetail, usePageDetail } from "@/lib/page-detail-store";
import { usePublishCanonicalPageTitle } from "@/lib/page-title-projection-context";
import { consumePageTitleFocus } from "@/lib/page-title-focus-intent";
import { projectContentRoute } from "../../../shared/content-routing-context";
import type {
  CodexPromptInput,
  CodexThreadSummary,
  PageInput,
  Project,
  WorkbenchTabProjection,
} from "@/lib/types";
import { useBoard } from "@/lib/use-board";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type { OpenPageInNewChatInput } from "@/lib/page-chat-actions";
import { projectWorkspaceRootOrNull } from "@/lib/workbench-workspace-context";
import type { OpenCanvasStageHandler } from "@/lib/use-workbench-panel-openers";
import type { WorkbenchSurfaceRelativePlacement } from "@/lib/workbench-panel-placement";
import type { WorkbenchProjectionPageStageTabConfig } from "../../../shared/types";
import { PageStage } from "./workbench-page-stage";
import { usePageChatSendPort } from "./use-page-chat-send-port";
import { usePageLinkedChats } from "@/lib/use-page-linked-chats";
import { useApplicationPending } from "@/bootstrap/application-surface";

export interface OpenPageTabOptions {
  placement?: WorkbenchSurfaceRelativePlacement;
  openMode?: "preview" | "durable";
}

export type OpenPageTabHandler = (
  projectId: string,
  pageId: string,
  titleSnapshot?: string,
  options?: OpenPageTabOptions,
) => Promise<void>;

export interface PageStageHistoryModalContext {
  sessionId: string;
  tabId: string;
  projectId: string;
  pageId: string;
  pageTitle?: string;
  pageMarkdown?: string;
}

interface PageStageDatabaseCapability {
  readonly onDelete?: (pageId: string) => Promise<void>;
  readonly onCompleteOccurrence: (pageId: string, occurrenceStart: Date) => Promise<void>;
  readonly onSkipOccurrence: (pageId: string, occurrenceStart: Date) => Promise<void>;
}

function PageStageDatabaseCapabilityBoundary({
  projectId,
  databaseViewId,
  sessionId,
  properties,
  children,
}: {
  projectId: string;
  databaseViewId: string | null;
  sessionId: string;
  properties: PageStageSemanticValues | null;
  children: (capability: PageStageDatabaseCapability | null) => ReactNode;
}) {
  const board = useBoard({
    projectId,
    databaseViewId: databaseViewId ?? undefined,
    sessionId,
    enabled: properties !== null && databaseViewId !== null,
  });
  if (!properties || !databaseViewId) return children(null);
  return children({
    onDelete: async (pageId: string) => {
      const deleted = await board.deletePage(properties.status, pageId);
      if (!deleted) throw new Error(`Page ${pageId} delete did not commit`);
    },
    onCompleteOccurrence: async (pageId, occurrenceStart) => {
      const completed = await board.completeOccurrence({
        pageId,
        occurrenceStart,
        source: "page-detail",
      });
      if (!completed) throw new Error(`Page ${pageId} occurrence completion did not commit`);
      await fetchPageDetail(projectId, pageId);
    },
    onSkipOccurrence: async (pageId, occurrenceStart) => {
      const skipped = await board.skipOccurrence({
        pageId,
        occurrenceStart,
        source: "page-detail",
      });
      if (!skipped) throw new Error(`Page ${pageId} occurrence skip did not commit`);
      await fetchPageDetail(projectId, pageId);
    },
  });
}

export function PageStageSessionTab({
  tab,
  project,
  closeRef,
  persistRef,
  sessionSnapshotRef,
  sessionId,
  sessionThread,
  canStartThreadInSession,
  sessionTitle = null,
  onLeavePage,
  onClose,
  onOpenTerminal,
  onEnsureDefaultDraftSessionForProject,
  onRefreshSessions,
  onOpenPageTab,
  onOpenPageFile,
  onOpenCanvasStage,
  onOpenThread,
  onOpenRelatedChat,
  onOpenPageInNewChat,
  onLinkPageToChat,
  onHandOffPageToChat,
  relatedChatCandidates,
  onResolveChatSessionForThread,
  historyPanelActive,
  onToggleHistoryPanel,
  isActivePanelTab,
  onAddToChatComposer,
}: {
  tab: WorkbenchTabProjection & {
    config: WorkbenchProjectionPageStageTabConfig;
    preview?: true;
  };
  project: Project | null;
  closeRef: RefObject<(() => Promise<void>) | null>;
  persistRef?: MutableRefObject<(() => Promise<void>) | null>;
  sessionSnapshotRef?: MutableRefObject<PageStageSessionSnapshot | null>;
  sessionId: string;
  sessionThread: CodexThreadSummary | null;
  canStartThreadInSession: boolean;
  sessionTitle?: string | null;
  onLeavePage: (snapshot: PageStageSessionSnapshot) => void;
  onClose: () => void;
  onOpenTerminal: () => Promise<void>;
  onEnsureDefaultDraftSessionForProject: (
    projectId: string,
    options?: { select?: boolean },
  ) => Promise<WorkbenchSessionRenderProjection>;
  onRefreshSessions: (projectId: string) => Promise<WorkbenchSessionRenderProjection[]>;
  onOpenPageTab: OpenPageTabHandler;
  onOpenPageFile?: import("@/lib/workbench-page-file-opener").OpenPageFileTabHandler;
  onOpenCanvasStage: OpenCanvasStageHandler;
  onOpenThread: (threadId: string) => Promise<void>;
  onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  onOpenPageInNewChat?: (input: OpenPageInNewChatInput) => Promise<void> | void;
  onLinkPageToChat: (input: {
    readonly pageId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  onHandOffPageToChat: (input: {
    readonly pageId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  relatedChatCandidates: readonly PageStageRelatedChatCandidate[];
  onResolveChatSessionForThread: (threadId: string) => Promise<{
    readonly id: string;
    readonly projectId: string | null;
    readonly executionRef?: { readonly runtimeId: string; readonly threadId: string } | null;
  }>;
  historyPanelActive: boolean;
  onToggleHistoryPanel: (context: PageStageHistoryModalContext) => void;
  isActivePanelTab: boolean;
  /** Present when this Page is shown beside a chat that can take Page content as a draft. */
  onAddToChatComposer?: (promptInput: CodexPromptInput) => void;
}) {
  if (tab.config.routingContext.kind !== "project")
    throw new Error("Project Page Stage requires a Project route");
  const pageAccessProjectId = tab.config.routingContext.projectId;
  // A Page created a moment ago opens ready to be named; reopening one never moves focus.
  const [focusTitle] = useState(() => consumePageTitleFocus(tab.config.pageId));
  const linkedChats = usePageLinkedChats(tab.config.pageId, { enabled: project !== null });
  const editorSessionKey = makeEditorSurfaceKey(sessionId, tab.id);

  const detailSnapshot = usePageDetail(
    project?.libraryId ?? null,
    pageAccessProjectId,
    tab.config.pageId,
  );
  const stageProjection = useMemo(() => {
    if (!detailSnapshot.detail) return { page: null, error: null };
    try {
      return {
        page: projectPageDetailToStageModel(detailSnapshot.detail),
        error: null,
      };
    } catch (error) {
      return {
        page: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [detailSnapshot.detail]);
  usePublishCanonicalPageTitle(
    detailSnapshot.detail?.libraryId ?? null,
    detailSnapshot.detail?.page.pageId ?? null,
    detailSnapshot.detail?.page.title ?? null,
    detailSnapshot.detail
      ? {
          generation: detailSnapshot.detail.page.documentGeneration,
          headSeq: detailSnapshot.detail.page.documentHeadSeq,
        }
      : undefined,
  );
  const page = stageProjection.page;
  const pageLoadError = !page
    ? (stageProjection.error ??
      (detailSnapshot.error === "Page not found" ? null : detailSnapshot.error))
    : null;
  const pageHydrating =
    !page && (detailSnapshot.loading || (!detailSnapshot.error && !stageProjection.error));
  useApplicationPending(isActivePanelTab && project != null && pageHydrating);

  const ownershipPath = usePageOwnershipPathReadModel(
    projectContentRoute(project?.id ?? pageAccessProjectId),
    tab.config.pageId,
  );
  const ownershipAncestors =
    ownershipPath.data?.status === "available" ? ownershipPath.data.ancestors : [];
  const breadcrumb =
    ownershipAncestors.length > 0
      ? {
          ancestors: ownershipAncestors.map((ancestor) => ({
            projectId: pageAccessProjectId,
            pageId: ancestor.pageId,
            title: ancestor.title.trim() || "Untitled",
            disabled: false,
          })),
          onOpenAncestor: (ancestor: { projectId: string; pageId: string; title: string }) => {
            void onOpenPageTab(ancestor.projectId, ancestor.pageId, ancestor.title, {
              placement: { kind: "same-group", sourceSurfaceId: tab.id },
              openMode: "durable",
            });
          },
        }
      : undefined;
  const chatSendPort = usePageChatSendPort({
    routingContext: projectContentRoute(pageAccessProjectId),
    pageId: tab.config.pageId,
    onEnsureDefaultDraftSessionForProject,
    onRefreshSessions,
    onResolveChatSessionForThread,
    onHandOffPageToChat,
    onAddToChatComposer,
  });

  if (!project) {
    return (
      <PageStageSessionNotice
        title="Project not found"
        description="This page tab points to a project that is no longer available."
        actionLabel="Close tab"
        onAction={onClose}
      />
    );
  }

  if (pageHydrating) {
    return (
      <PageStageLoadingFrame
        titleSnapshot={tab.config.titleSnapshot}
        breadcrumb={
          breadcrumb
            ? {
                ...breadcrumb,
                currentTitle: tab.config.titleSnapshot ?? tab.config.pageId,
              }
            : undefined
        }
      />
    );
  }

  if (pageLoadError) {
    return (
      <PageStageSessionNotice
        title="Could not load Page"
        description={
          tab.config.titleSnapshot
            ? `Nodex could not load ${tab.config.titleSnapshot} in ${project.name}. ${pageLoadError}`
            : `Nodex could not load this page in ${project.name}. ${pageLoadError}`
        }
      />
    );
  }

  if (!page) {
    return (
      <PageStageSessionNotice
        title="Page not found"
        description={
          tab.config.titleSnapshot
            ? `${tab.config.titleSnapshot} is no longer available in ${project.name}.`
            : `This page is no longer available in ${project.name}.`
        }
        actionLabel="Close tab"
        onAction={onClose}
      />
    );
  }

  const semanticValues =
    page.databaseContext.kind === "member"
      ? pageStageSemanticValues(page.databaseContext.semanticProperties)
      : null;
  const renderDocumentSurface = (
    databaseCapability: PageStageDatabaseCapability | null,
  ): ReactNode => (
    <OwnedBlockDocumentBoundary
      routingContext={projectContentRoute(pageAccessProjectId)}
      ownerBlockId={page.page.id}
    >
      {(documentModel, documentControls) => {
        if (documentModel.status === "error") {
          const retrying = documentModel.error.retrying === true;
          return (
            <PageStageSessionNotice
              title={documentModel.error.retryable ? "Core is busy" : "Could not open page"}
              description={documentModel.error.message}
              {...(!retrying
                ? {
                    actionLabel: "Retry",
                    onAction: () => {
                      void documentControls.reload();
                    },
                  }
                : {})}
            />
          );
        }
        const documentAuthority =
          documentModel.status === "ready"
            ? {
                kind: "yjs" as const,
                descriptor: documentModel.descriptor,
                reload: documentControls.reload,
              }
            : null;

        return (
          <PageStage
            contentRoutingContext={projectContentRoute(pageAccessProjectId)}
            editorSessionKey={editorSessionKey}
            pageTitleIdentity={
              project ? { libraryId: project.libraryId, pageId: tab.config.pageId } : undefined
            }
            retainEditorSession={tab.preview !== true}
            documentAuthority={documentAuthority}
            page={page}
            autoFocusTitle={focusTitle}
            projectName={project.name}
            projectWorkspacePath={projectWorkspaceRootOrNull(project)}
            closeRef={closeRef as MutableRefObject<(() => Promise<void>) | null>}
            persistRef={persistRef}
            sessionSnapshotRef={sessionSnapshotRef}
            onClose={onClose}
            onLeavePage={onLeavePage}
            onUpdate={async (pageId: string, updates: Partial<PageInput>) =>
              await commitPageDetailMetadataPatch({
                projectId: pageAccessProjectId,
                pageId,
                operationId: createUuidV7(),
                clientSessionId: tab.id,
                patch: updates,
              })
            }
            onUpdateProperty={async (pageId, propertyId, edit) =>
              await commitPageDetailPropertyEdit({
                projectId: pageAccessProjectId,
                pageId,
                propertyId,
                edit,
                operationId: createUuidV7(),
                clientSessionId: tab.id,
              })
            }
            onRefreshProperties={async () => {
              await fetchPageDetail(pageAccessProjectId, tab.config.pageId);
            }}
            {...(databaseCapability?.onDelete ? { onDelete: databaseCapability.onDelete } : {})}
            {...(databaseCapability
              ? {
                  onCompleteOccurrence: databaseCapability.onCompleteOccurrence,
                  onSkipOccurrence: databaseCapability.onSkipOccurrence,
                }
              : {})}
            onOpenTerminalPanel={() => {
              void onOpenTerminal();
            }}
            onToggleHistoryPanel={(snapshot) =>
              onToggleHistoryPanel({
                sessionId,
                tabId: tab.id,
                projectId: pageAccessProjectId,
                pageId: tab.config.pageId,
                pageTitle: snapshot.title || tab.config.titleSnapshot,
                pageMarkdown: snapshot.markdown,
              })
            }
            historyPanelActive={historyPanelActive}
            isActivePanelTab={isActivePanelTab}
            breadcrumb={breadcrumb}
            sessionId={sessionId}
            sessionThread={sessionThread}
            canStartThreadInSession={canStartThreadInSession}
            sessionTitle={sessionTitle}
            {...linkedChats}
            relatedChatCandidates={relatedChatCandidates}
            onOpenRelatedChat={onOpenRelatedChat}
            onCreateRelatedChat={
              onOpenPageInNewChat
                ? async () => {
                    await onOpenPageInNewChat({
                      projectId: pageAccessProjectId,
                      pageId: tab.config.pageId,
                      titleSnapshot: page.page.title,
                    });
                  }
                : undefined
            }
            onLinkRelatedChat={async (relatedSessionId) => {
              await onLinkPageToChat({
                pageId: tab.config.pageId,
                sessionId: relatedSessionId,
              });
            }}
            onOpenCodexThread={onOpenThread}
            onOpenPageFile={
              onOpenPageFile
                ? async (input) => {
                    await onOpenPageFile({
                      ...input,
                      placement: { kind: "same-group", sourceSurfaceId: tab.id },
                    });
                  }
                : undefined
            }
            onOpenPage={async ({ routingContext, pageId, titleSnapshot, sourceBlockId }) => {
              if (routingContext.kind !== "project") return;
              await onOpenPageTab(routingContext.projectId, pageId, titleSnapshot, {
                placement: { kind: "same-group", sourceSurfaceId: tab.id },
                openMode: "durable",
              });
              if (!sourceBlockId) return;
              requestPageBlockFocus({
                projectId: routingContext.projectId,
                pageId,
                blockId: sourceBlockId,
              });
            }}
            onOpenCanvas={({ routingContext, canvasBlockId, titleSnapshot }) => {
              if (routingContext.kind !== "project") return;
              void onOpenCanvasStage(routingContext.projectId, canvasBlockId, titleSnapshot, {
                placement: { kind: "same-group", sourceSurfaceId: tab.id },
              });
            }}
            {...chatSendPort}
          />
        );
      }}
    </OwnedBlockDocumentBoundary>
  );

  return (
    <PageStageDatabaseCapabilityBoundary
      projectId={pageAccessProjectId}
      databaseViewId={project.defaultDatabaseViewId}
      sessionId={tab.id}
      properties={semanticValues}
    >
      {renderDocumentSurface}
    </PageStageDatabaseCapabilityBoundary>
  );
}

function PageStageSessionNotice({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary p-3 select-none">
      <div className="mx-auto flex h-full w-full max-w-md flex-col items-center justify-center text-center">
        <div className="text-base font-medium text-token-text-primary">{title}</div>
        <div className="mt-1 text-sm text-token-text-secondary">{description}</div>
        {actionLabel && onAction ? (
          <NodexButton type="button" size="sm" className="mt-3" onClick={onAction}>
            {actionLabel}
          </NodexButton>
        ) : null}
      </div>
    </div>
  );
}
