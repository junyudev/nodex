import {
  useCallback,
  useMemo,
  type ComponentPropsWithoutRef,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { createCodexFirstSubmissionIdentity } from "../../../shared/codex-first-submission";
import { OwnedBlockDocumentBoundary } from "@/components/block-documents/owned-block-document-boundary";
import { PageStageContentSkeleton } from "@/components/board/page-stage/content-skeleton";
import { PageStageToolbar } from "@/components/board/page-stage/toolbar";
import type {
  PageStageRelatedChatCandidate,
  PageStageSessionSnapshot,
} from "@/components/board/page-stage/types";
import { NodexButton } from "@/components/ui/button";
import { useCodexAppServerControl } from "@/features/local-conversation";
import { usePageOwnershipPathReadModel } from "@/lib/block-reference-queries";
import {
  commitPageDetailMetadataPatch,
  commitPageDetailPropertyEdit,
} from "@/lib/page-detail-metadata-runtime";
import { makeEditorSurfaceKey } from "@/lib/document-session-registry";
import { projectPageDetailToStageModel } from "@/lib/page-stage-page";
import { pageStageSemanticValues, type PageStageSemanticValues } from "@/lib/page-stage-properties";
import { readPageStageContentWidthPreference } from "@/lib/page-stage-layout";
import { requestPageBlockFocus } from "@/lib/page-block-focus-intents";
import { fetchPageDetail, usePageDetail } from "@/lib/page-detail-store";
import { usePublishCanonicalPageTitle } from "@/lib/page-title-projection-context";
import { RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE } from "@/lib/right-panel-composer-overlay-reserve";
import { projectContentAccess } from "../../../shared/content-access-context";
import type {
  CodexPromptInput,
  CodexThreadSummary,
  PageInput,
  Project,
  WorkbenchTabProjection,
} from "@/lib/types";
import { useBoard } from "@/lib/use-board";
import { cn } from "@/lib/utils";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type { OpenPageInNewChatInput } from "@/lib/page-chat-actions";
import { projectWorkspaceRootOrNull } from "@/lib/workbench-workspace-context";
import type { OpenCanvasStageHandler } from "@/lib/use-workbench-panel-openers";
import type { WorkbenchSurfaceRelativePlacement } from "@/lib/workbench-panel-placement";
import type { WorkbenchProjectionPageStageTabConfig } from "../../../shared/types";
import { PageStage } from "./workbench-page-stage";
import { pageChatWindowQueryOptions } from "@/lib/query-options";
import { queryKeys } from "@/lib/query-keys";
import { unlinkPageChat } from "@/lib/page-chat-runtime";

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
  pageNfm?: string;
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
  onLeavePage,
  onClose,
  onOpenTerminal,
  onEnsureDefaultDraftSessionForProject,
  onRefreshSessions,
  onOpenPageTab,
  onOpenCanvasStage,
  onOpenThread,
  onOpenRelatedChat,
  onOpenPageInNewChat,
  onLinkPageToChat,
  relatedChatCandidates,
  onResolveChatSessionForThread,
  historyPanelActive,
  onToggleHistoryPanel,
  isActivePanelTab,
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
  onLeavePage: (snapshot: PageStageSessionSnapshot) => void;
  onClose: () => void;
  onOpenTerminal: () => Promise<void>;
  onEnsureDefaultDraftSessionForProject: (
    projectId: string,
    options?: { select?: boolean },
  ) => Promise<WorkbenchSessionRenderProjection>;
  onRefreshSessions: (projectId: string) => Promise<WorkbenchSessionRenderProjection[]>;
  onOpenPageTab: OpenPageTabHandler;
  onOpenCanvasStage: OpenCanvasStageHandler;
  onOpenThread: (threadId: string) => Promise<void>;
  onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  onOpenPageInNewChat?: (input: OpenPageInNewChatInput) => Promise<void> | void;
  onLinkPageToChat: (input: {
    readonly pageAccessProjectId: string;
    readonly pageId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  relatedChatCandidates: readonly PageStageRelatedChatCandidate[];
  onResolveChatSessionForThread: (
    threadId: string,
  ) => Promise<{ readonly id: string; readonly projectId: string | null }>;
  historyPanelActive: boolean;
  onToggleHistoryPanel: (context: PageStageHistoryModalContext) => void;
  isActivePanelTab: boolean;
}) {
  const codexControl = useCodexAppServerControl(tab.config.projectId);
  const queryClient = useQueryClient();
  const relatedChatsQuery = useInfiniteQuery({
    ...pageChatWindowQueryOptions({
      pageAccessProjectId: tab.config.projectId,
      pageId: tab.config.pageId,
      includeArchived: false,
      first: 20,
    }),
    enabled: project !== null,
  });
  const relatedChats = relatedChatsQuery.data?.pages.flatMap((window) => window.items) ?? [];
  const removeRelatedChat = useCallback(
    async (relatedSessionId: string): Promise<void> => {
      await unlinkPageChat(relatedSessionId, {
        pageAccessProjectId: tab.config.projectId,
        pageId: tab.config.pageId,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pageChats.all() });
    },
    [queryClient, tab.config.pageId, tab.config.projectId],
  );
  const editorSessionKey = makeEditorSurfaceKey(sessionId, tab.id);

  const detailSnapshot = usePageDetail(
    project?.libraryId ?? null,
    tab.config.projectId,
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

  const ownershipPath = usePageOwnershipPathReadModel(
    projectContentAccess(project?.id ?? tab.config.projectId),
    tab.config.pageId,
  );
  const ownershipAncestors =
    ownershipPath.data?.status === "available" ? ownershipPath.data.ancestors : [];
  const breadcrumb =
    ownershipAncestors.length > 0
      ? {
          ancestors: ownershipAncestors.map((ancestor) => ({
            projectId: tab.config.projectId,
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
  const handleStartNewSessionThreadFromEditor = useCallback(
    async (input: {
      projectId: string;
      targetSessionId?: string;
      prompt: string;
      promptInput?: CodexPromptInput;
      threadName?: string;
    }) => {
      const targetSessionId =
        input.targetSessionId?.trim() ||
        (await onEnsureDefaultDraftSessionForProject(input.projectId, { select: false })).id;
      await onLinkPageToChat({
        pageAccessProjectId: tab.config.projectId,
        pageId: tab.config.pageId,
        sessionId: targetSessionId,
      });
      const result = await codexControl.startThreadForSession({
        firstSubmission: createCodexFirstSubmissionIdentity(),
        projectId: input.projectId,
        sessionId: targetSessionId,
        prompt: input.prompt,
        promptInput: input.promptInput,
        threadName: input.threadName,
        skipAutoTitleGeneration: Boolean(input.threadName?.trim()),
        runInTarget: "localProject",
      });
      if (result.kind !== "started") {
        throw new Error("Page thread unexpectedly started in a worktree");
      }
      const { detail } = result;
      await onRefreshSessions(input.projectId);
      await codexControl.loadThreads(input.projectId);
      return {
        threadId: detail.threadId,
        sessionId: targetSessionId,
      };
    },
    [
      codexControl,
      onEnsureDefaultDraftSessionForProject,
      onLinkPageToChat,
      onRefreshSessions,
      tab.config.pageId,
      tab.config.projectId,
    ],
  );

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
      <PageStageSessionSkeleton
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
      accessContext={projectContentAccess(tab.config.projectId)}
      ownerBlockId={page.page.id}
    >
      {(documentModel, documentControls) => {
        if (documentModel.status === "loading") {
          return (
            <PageStageSessionSkeleton
              titleSnapshot={page.page.title}
              breadcrumb={
                breadcrumb
                  ? {
                      ...breadcrumb,
                      currentTitle: page.page.title,
                    }
                  : undefined
              }
            />
          );
        }
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
        if (documentModel.status !== "ready") {
          return (
            <PageStageSessionNotice
              title="Page content is not ready"
              description="This Page content is not ready to edit."
              actionLabel="Retry"
              onAction={() => {
                void documentControls.reload();
              }}
            />
          );
        }

        const documentAuthority = {
          kind: "yjs" as const,
          descriptor: documentModel.descriptor,
          reload: documentControls.reload,
        };

        return (
          <PageStage
            contentAccessContext={projectContentAccess(tab.config.projectId)}
            editorSessionKey={editorSessionKey}
            pageTitleIdentity={
              project ? { libraryId: project.libraryId, pageId: tab.config.pageId } : undefined
            }
            retainEditorSession={tab.preview !== true}
            documentAuthority={documentAuthority}
            page={page}
            projectName={project.name}
            projectWorkspacePath={projectWorkspaceRootOrNull(project)}
            closeRef={closeRef as MutableRefObject<(() => Promise<void>) | null>}
            persistRef={persistRef}
            sessionSnapshotRef={sessionSnapshotRef}
            onClose={onClose}
            onLeavePage={onLeavePage}
            onUpdate={async (pageId: string, updates: Partial<PageInput>) =>
              await commitPageDetailMetadataPatch({
                projectId: tab.config.projectId,
                pageId,
                operationId: createUuidV7(),
                clientSessionId: tab.id,
                patch: updates,
              })
            }
            onUpdateProperty={async (pageId, propertyId, edit) =>
              await commitPageDetailPropertyEdit({
                projectId: tab.config.projectId,
                pageId,
                propertyId,
                edit,
                operationId: createUuidV7(),
                clientSessionId: tab.id,
              })
            }
            onRefreshProperties={async () => {
              await fetchPageDetail(tab.config.projectId, tab.config.pageId);
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
                projectId: tab.config.projectId,
                pageId: tab.config.pageId,
                pageTitle: snapshot.title || tab.config.titleSnapshot,
                pageNfm: snapshot.nfm,
              })
            }
            historyPanelActive={historyPanelActive}
            isActivePanelTab={isActivePanelTab}
            breadcrumb={breadcrumb}
            sessionId={sessionId}
            sessionThread={sessionThread}
            canStartThreadInSession={canStartThreadInSession}
            relatedChats={relatedChats}
            relatedChatsLoading={relatedChatsQuery.isPending}
            relatedChatsError={relatedChatsQuery.error ? "Couldn’t load linked chats" : null}
            relatedChatsHasMore={relatedChatsQuery.hasNextPage}
            relatedChatsLoadingMore={relatedChatsQuery.isFetchingNextPage}
            relatedChatCandidates={relatedChatCandidates}
            onOpenRelatedChat={onOpenRelatedChat}
            onCreateRelatedChat={
              onOpenPageInNewChat
                ? async () => {
                    await onOpenPageInNewChat({
                      projectId: tab.config.projectId,
                      pageId: tab.config.pageId,
                      titleSnapshot: page.page.title,
                    });
                  }
                : undefined
            }
            onLinkRelatedChat={async (relatedSessionId) => {
              await onLinkPageToChat({
                pageAccessProjectId: tab.config.projectId,
                pageId: tab.config.pageId,
                sessionId: relatedSessionId,
              });
            }}
            onRemoveRelatedChat={removeRelatedChat}
            onRetryRelatedChats={async () => {
              await relatedChatsQuery.refetch();
            }}
            onLoadMoreRelatedChats={async () => {
              await relatedChatsQuery.fetchNextPage();
            }}
            onOpenCodexThread={onOpenThread}
            onOpenPage={async ({ accessContext, pageId, titleSnapshot, sourceBlockId }) => {
              if (accessContext.kind !== "project") return;
              await onOpenPageTab(accessContext.projectId, pageId, titleSnapshot, {
                placement: { kind: "same-group", sourceSurfaceId: tab.id },
                openMode: "durable",
              });
              if (!sourceBlockId) return;
              requestPageBlockFocus({
                projectId: accessContext.projectId,
                pageId,
                blockId: sourceBlockId,
              });
            }}
            onOpenCanvas={({ accessContext, canvasBlockId, titleSnapshot }) => {
              if (accessContext.kind !== "project") return;
              void onOpenCanvasStage(accessContext.projectId, canvasBlockId, titleSnapshot, {
                placement: { kind: "same-group", sourceSurfaceId: tab.id },
              });
            }}
            onStartNewSessionThreadFromEditor={handleStartNewSessionThreadFromEditor}
            onSendThreadSectionPrompt={async ({ threadId, prompt, promptInput }) => {
              const targetSession = await onResolveChatSessionForThread(threadId);
              if (!targetSession.projectId) {
                throw new Error("Page content can only be sent to a Project chat");
              }
              await onLinkPageToChat({
                pageAccessProjectId: tab.config.projectId,
                pageId: tab.config.pageId,
                sessionId: targetSession.id,
              });
              await codexControl.startTurn(threadId, prompt, {
                projectId: targetSession.projectId,
                promptInput,
              });
            }}
          />
        );
      }}
    </OwnedBlockDocumentBoundary>
  );

  return (
    <PageStageDatabaseCapabilityBoundary
      projectId={tab.config.projectId}
      databaseViewId={project.defaultDatabaseViewId}
      sessionId={tab.id}
      properties={semanticValues}
    >
      {renderDocumentSurface}
    </PageStageDatabaseCapabilityBoundary>
  );
}

function PageStageSessionSkeleton({
  titleSnapshot,
  breadcrumb,
}: {
  titleSnapshot?: string;
  breadcrumb?: ComponentPropsWithoutRef<typeof PageStageToolbar>["breadcrumb"];
}) {
  const title = titleSnapshot?.trim();
  const label = title ? `Loading ${titleSnapshot}` : "Loading card";
  const limitMainContentWidth = readPageStageContentWidthPreference();
  const contentBodyClassName = cn(
    "mx-auto w-full px-(--page-stage-body-gutter-inline)",
    limitMainContentWidth && "max-w-(--page-stage-body-max-width)",
  );

  return (
    <div
      className="flex h-full w-full flex-col bg-(--background) select-none"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <PageStageToolbar
        saving={false}
        disabled={true}
        historyPanelActive={false}
        limitMainContentWidth={limitMainContentWidth}
        showRawContent={false}
        onCopyDeeplink={() => undefined}
        onDelete={() => undefined}
        onToggleContentWidth={() => undefined}
        onToggleShowRawContent={() => undefined}
        onToggleHistoryPanel={() => undefined}
        breadcrumb={breadcrumb}
      />

      <div
        className="scrollbar-token min-h-0 flex-1 overflow-y-auto"
        style={RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE}
      >
        <div
          className={contentBodyClassName}
          data-page-stage-body="true"
          data-page-stage-body-width={limitMainContentWidth ? "constrained" : "full"}
        >
          <div className="w-full">
            <PageStageContentSkeleton titleSnapshot={title} announce={false} />
          </div>
        </div>
      </div>
    </div>
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
