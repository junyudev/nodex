import { commitPageLifecycleIntent } from "@/lib/page-lifecycle-runtime";
import { completePageOccurrence, skipPageOccurrence } from "@/lib/page-occurrence-runtime";
import { workbenchPageEditorKey } from "@/lib/workbench-page-editor-key";
import { usePublishCanonicalPageTitle } from "@/lib/page-title-projection-context";
import { usePageExecutionContext } from "@/lib/use-page-execution-context";
import { ownedBlockDocumentQueryOptions } from "@/lib/owned-block-document-query";
import type { OpenPageInNewChatInput } from "@/lib/page-chat-actions";
import type { Project } from "@/lib/types";
import type { MutableRefObject, RefObject } from "react";
import type { PageStageProps, PageStageSessionSnapshot } from "../board/page-stage/types";
import type { WorkbenchPageStageSurfaceConfig } from "../../../shared/workbench-scene";
import type { PageStageHistoryModalContext } from "@/lib/workbench-page-history";
import { useIntl } from "@/lib/i18n";
import type { WorkbenchSceneOwner } from "../../../shared/workbench-scene";
import { useWorkbenchPageSearchReveal } from "@/lib/workbench-surface-reveal";
import type { OpenPageInNewWindowHandler } from "@/lib/workbench-shell-operations";
import type { WorkbenchSurfaceRelativePlacement } from "@/lib/workbench-panel-placement";
import { useMemo } from "react";
import { useConsumePageTitleFocus } from "@/lib/page-title-focus-intent";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { createUuidV7 } from "../../../shared/uuid-v7";

import { PageStage } from "./workbench-page-stage";
import { PageStageLoadingFrame } from "../board/page-stage/frame";
import { type ReadyPageBlockDocumentDescriptor } from "../../lib/owned-block-document";
import { projectPageDetailToStageModel } from "../../lib/page-stage-page";
import {
  commitPageDetailMetadataPatch,
  commitPageDetailPropertyEdit,
} from "../../lib/page-detail-metadata-runtime";
import type { DatabaseId } from "../../../shared/database-identities";
import { queryKeys } from "../../lib/query-keys";
import { invalidateExactQuery } from "../../lib/query-invalidation";
import { useProjectionRegistration } from "../../lib/projection-invalidation-context";
import { libraryContentRoute } from "../../../shared/content-routing-context";
import {
  pageDetailDataDependencies,
  pageDetailDocumentDependencies,
} from "../../lib/page-detail-projection-dependencies";
import {
  libraryPageDetailQueryOptions,
  LibraryPageDetailReadError,
} from "../../lib/library-page-detail-query";
import { useApplicationPending } from "@/bootstrap/application-surface";
import { usePageLinkedChats, type PageChatCommands } from "@/lib/use-page-linked-chats";
import type { CodexThreadSummary } from "@/lib/types";
import { usePageChatSendPort, type PageChatSendPortInput } from "./use-page-chat-send-port";

/** A chat and its composer as presented beside the Page. */
export interface WorkbenchBesideChat {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly sessionThread: CodexThreadSummary | null;
  readonly canStartThreadInSession: boolean;
  readonly sessionTitle: string | null;
  readonly onAddToChatComposer: NonNullable<PageChatSendPortInput["onAddToChatComposer"]>;
}

export interface OpenPageTabOptions {
  placement?: WorkbenchSurfaceRelativePlacement;
  openMode?: "preview" | "durable";
  reveal?: import("@/lib/page-search-reveal").PageSearchReveal;
}

export type OpenPageTabHandler = (
  projectId: string,
  pageId: string,
  titleSnapshot?: string,
  options?: OpenPageTabOptions,
) => Promise<void>;

export function WorkbenchPageSurface({
  config,
  surfaceId,
  sceneOwner,
  sceneProjectId,
  projects,
  preview,
  isActivePanelTab,
  closeRef,
  persistRef,
  sessionSnapshotRef,
  onClose,
  onLeavePage,
  onOpenDatabase,
  onOpenPage,
  onOpenPageFile,
  onOpenPageInNewWindow,
  onOpenCanvas,
  onOpenTerminalPanel,
  onOpenCodexThread,
  onOpenPageInNewChat,
  pageChats,
  besideChat,
  chatCommands,
  historyPanelActive,
  onToggleHistoryPanel,
}: {
  readonly config: WorkbenchPageStageSurfaceConfig;
  readonly surfaceId: string;
  readonly sceneOwner: WorkbenchSceneOwner;
  readonly sceneProjectId: string | null;
  readonly projects: readonly Project[];
  readonly preview?: boolean;
  readonly isActivePanelTab: boolean;
  readonly closeRef: RefObject<(() => Promise<void>) | null>;
  readonly persistRef?: MutableRefObject<(() => Promise<void>) | null>;
  readonly sessionSnapshotRef?: MutableRefObject<PageStageSessionSnapshot | null>;
  readonly onLeavePage: PageStageProps["onLeavePage"];
  readonly onClose: () => void;
  readonly onOpenDatabase: (databaseId: DatabaseId) => void;
  readonly onOpenPageInNewWindow?: OpenPageInNewWindowHandler;
  readonly onOpenPageFile?: import("@/lib/workbench-page-file-opener").OpenPageFileTabHandler;
  readonly onOpenPage: (
    pageId: string,
    titleSnapshot: string | undefined,
    placement: WorkbenchSurfaceRelativePlacement,
    blockId?: string,
  ) => void;
  readonly onOpenCanvas: (canvasBlockId: string, titleSnapshot?: string) => void;
  readonly pageChats?: PageChatCommands;
  readonly besideChat?: WorkbenchBesideChat | null;
  readonly chatCommands: Omit<
    PageChatSendPortInput,
    "routingContext" | "pageId" | "onAddToChatComposer"
  >;
  readonly onOpenTerminalPanel?: () => void;
  readonly onOpenCodexThread: (threadId: string) => Promise<void>;
  readonly onOpenPageInNewChat?: (input: OpenPageInNewChatInput) => Promise<void> | void;
  readonly historyPanelActive: boolean;
  readonly onToggleHistoryPanel: (context: PageStageHistoryModalContext) => void;
}) {
  const { pageId, titleSnapshot } = config;
  const intl = useIntl();
  const searchReveal = useWorkbenchPageSearchReveal(sceneOwner, surfaceId);
  const editorSessionKey = workbenchPageEditorKey(sceneOwner, surfaceId);
  const execution = usePageExecutionContext(pageId, sceneProjectId, projects, besideChat);
  const chatSendPort = usePageChatSendPort({
    routingContext: libraryContentRoute,
    pageId,
    ...chatCommands,
    onAddToChatComposer: besideChat?.onAddToChatComposer,
  });
  const queryClient = useQueryClient();
  const linkedChats = usePageLinkedChats(pageId, { enabled: pageChats !== undefined });
  const detailQueryKey = useMemo(() => queryKeys.library.pageDetail(pageId), [pageId]);
  const detail = useQuery(libraryPageDetailQueryOptions(pageId));
  const documentOptions = ownedBlockDocumentQueryOptions({
    routingContext: libraryContentRoute,
    ownerBlockId: pageId,
  });
  const documentQueryKey = documentOptions.queryKey;
  const document = useQuery(documentOptions);
  usePublishCanonicalPageTitle(
    detail.data?.libraryId ?? null,
    detail.data?.page.pageId ?? null,
    detail.data?.page.title ?? null,
    detail.data
      ? {
          generation: detail.data.page.documentGeneration,
          headSeq: detail.data.page.documentHeadSeq,
        }
      : undefined,
  );
  const stagePage = useMemo(() => {
    if (!detail.data) return null;
    return projectPageDetailToStageModel(detail.data);
  }, [detail.data]);
  // A Page created a moment ago opens ready to be named; reopening one never moves focus.
  const focusTitle = useConsumePageTitleFocus(pageId, Boolean(stagePage && document.data));

  const authority = detail.data;
  const getCursor = () => {
    const currentDetail = queryClient.getQueryData<typeof authority>(detailQueryKey);
    const currentDocument =
      queryClient.getQueryData<ReadyPageBlockDocumentDescriptor>(documentQueryKey);
    if (!currentDetail || !currentDocument || currentDetail.libraryId !== currentDocument.libraryId)
      return null;
    if (
      currentDetail.storeEpoch !== currentDocument.storeEpoch ||
      currentDetail.page.documentGeneration !== currentDocument.generation ||
      currentDetail.page.documentHeadSeq !== currentDocument.headSeq
    )
      return null;
    return {
      storeEpoch: currentDetail.storeEpoch,
      commitSeq: currentDetail.commitSeq,
    };
  };
  useProjectionRegistration(
    authority
      ? {
          scope: { kind: "library", libraryId: authority.libraryId },
          consumerKey: hashKey(["projection", detailQueryKey]),
          getDependencies: () => {
            const currentDetail = queryClient.getQueryData<typeof authority>(detailQueryKey);
            return pageDetailDataDependencies(currentDetail ?? null, pageId);
          },
          getCursor,
          invalidate: async () => {
            await invalidateExactQuery(queryClient, detailQueryKey);
          },
        }
      : null,
  );
  useProjectionRegistration(
    authority
      ? {
          scope: { kind: "library", libraryId: authority.libraryId },
          consumerKey: hashKey(["projection", documentQueryKey]),
          getDependencies: () =>
            pageDetailDocumentDependencies(
              queryClient.getQueryData<typeof authority>(detailQueryKey) ?? null,
              pageId,
            ),
          getCursor,
          invalidate: async () => {
            await invalidateExactQuery(queryClient, documentQueryKey);
          },
        }
      : null,
  );

  useApplicationPending(isActivePanelTab && detail.isPending);
  if (detail.isPending)
    return <PageStageLoadingFrame pageId={pageId} titleSnapshot={titleSnapshot} />;

  const pageMissing =
    detail.error instanceof LibraryPageDetailReadError &&
    detail.error.failure.code === "page_not_found";
  const documentFailure = document.error ?? document.failureReason;
  const documentRetrying = !detail.isError && !document.isError && documentFailure !== null;
  if (detail.isError || documentFailure || !stagePage) {
    const error = detail.error ?? documentFailure;
    const coreBusy = error instanceof Error && "retryable" in error && error.retryable;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-token-main-surface-primary px-6 text-center">
        <p className="text-sm text-token-text-primary">
          {coreBusy
            ? intl.formatMessage({
                id: "workbench.workbenchPageStagePanel.coreBusy",
                defaultMessage: "Core is busy",
              })
            : intl.formatMessage({
                id: "workbench.workbenchLibraryPageSurface.openFailed",
                defaultMessage: "Could not open Page",
              })}
        </p>
        <p className="max-w-lg text-sm text-token-description-foreground">
          {error instanceof Error && !coreBusy && !pageMissing
            ? error.message
            : intl.formatMessage({
                id: "workbench.workbenchLibraryPageSurface.unavailable",
                defaultMessage: "The Page is unavailable.",
              })}
        </p>
        {!documentRetrying && (
          <button
            type="button"
            className="mt-1 rounded-md bg-token-foreground/5 px-2.5 py-1.5 text-sm text-token-text-secondary hover:bg-token-foreground/10 hover:text-token-text-primary"
            onClick={() => {
              if (pageMissing) onClose();
              else void Promise.all([detail.refetch(), document.refetch()]);
            }}
          >
            {pageMissing
              ? intl.formatMessage({
                  id: "workbench.workbenchPageStagePanel.closeTab",
                  defaultMessage: "Close tab",
                })
              : intl.formatMessage({
                  id: "workbench.workbenchLibraryPageSurface.retry",
                  defaultMessage: "Retry",
                })}
          </button>
        )}
      </div>
    );
  }

  const descriptor =
    document.data?.libraryId === detail.data.libraryId &&
    document.data?.storeEpoch === detail.data.storeEpoch
      ? document.data
      : null;
  const refreshProperties = () => invalidateExactQuery(queryClient, detailQueryKey);
  const openBeside = { kind: "same-group", sourceSurfaceId: surfaceId } as const;
  return (
    <PageStage
      contentRoutingContext={descriptor?.routingContext ?? libraryContentRoute}
      editorSessionKey={editorSessionKey}
      pageTitleIdentity={{ libraryId: detail.data.libraryId, pageId }}
      retainEditorSession={!preview}
      page={stagePage}
      autoFocusTitle={focusTitle}
      searchReveal={searchReveal}
      closeRef={closeRef}
      persistRef={persistRef}
      sessionSnapshotRef={sessionSnapshotRef}
      onLeavePage={onLeavePage}
      executionProjectId={execution.executionProjectId}
      launchProjectId={execution.launchProjectId}
      projectName={execution.projectName}
      projectWorkspacePath={execution.workspaceRoot}
      documentAuthority={
        descriptor
          ? {
              kind: "yjs",
              descriptor,
              reload: async () => {
                await queryClient.resetQueries({ queryKey: documentQueryKey, exact: true });
              },
            }
          : null
      }
      onOpenDatabase={onOpenDatabase}
      onOpenPageFile={
        onOpenPageFile
          ? async (input) => {
              await onOpenPageFile({ ...input, placement: openBeside });
            }
          : undefined
      }
      onOpenPage={({ pageId: nextPageId, titleSnapshot, sourceBlockId }) =>
        onOpenPage(nextPageId, titleSnapshot, openBeside, sourceBlockId)
      }
      onOpenCanvas={({ canvasBlockId, titleSnapshot }) =>
        onOpenCanvas(canvasBlockId, titleSnapshot)
      }
      onClose={onClose}
      onOpenOnRight={() =>
        onOpenPage(pageId, stagePage.page.title.slice(0, 2_000), {
          kind: "adjacent-right",
          sourceSurfaceId: surfaceId,
        })
      }
      onOpenInNewWindow={
        onOpenPageInNewWindow
          ? () =>
              onOpenPageInNewWindow(
                { pageId, titleSnapshot: stagePage.page.title.slice(0, 2_000) },
                sceneOwner.kind === "project" ? sceneOwner : undefined,
              )
          : undefined
      }
      onOpenTerminalPanel={execution.executionProjectId ? onOpenTerminalPanel : undefined}
      onOpenCodexThread={onOpenCodexThread}
      onToggleHistoryPanel={
        descriptor
          ? (snapshot) =>
              onToggleHistoryPanel({
                sceneOwner,
                surfaceId,
                pageId,
                descriptor,
                pageTitle: snapshot.title || titleSnapshot,
                pageMarkdown: snapshot.markdown,
                workspaceRoot: execution.workspaceRoot,
              })
          : undefined
      }
      historyPanelActive={historyPanelActive}
      isActivePanelTab={isActivePanelTab}
      sessionId={
        besideChat?.sessionId ?? (sceneOwner.kind === "session" ? sceneOwner.sessionId : null)
      }
      sessionThread={besideChat?.sessionThread}
      canStartThreadInSession={besideChat?.canStartThreadInSession}
      sessionTitle={besideChat?.sessionTitle}
      chatProjectId={besideChat ? execution.targetProjectId : undefined}
      {...chatSendPort}
      {...linkedChats}
      relatedChatCandidates={pageChats?.candidates}
      onOpenRelatedChat={pageChats?.openChat}
      onCreateRelatedChat={
        onOpenPageInNewChat
          ? async () => {
              await onOpenPageInNewChat({
                projectId: execution.launchProjectId,
                pageId,
                titleSnapshot: stagePage.page.title,
              });
            }
          : undefined
      }
      onLinkRelatedChat={
        pageChats
          ? async (sessionId) => {
              await pageChats.linkPage({ pageId, sessionId });
            }
          : undefined
      }
      onUpdate={async (targetPageId, patch) => {
        const result = await commitPageDetailMetadataPatch({
          executionProjectId: execution.executionProjectId,
          pageId: targetPageId,
          operationId: createUuidV7(),
          clientSessionId: surfaceId,
          patch,
        });
        await refreshProperties();
        return result;
      }}
      onUpdateProperty={async (targetPageId, propertyId, edit) => {
        const result = await commitPageDetailPropertyEdit({
          pageId: targetPageId,
          propertyId,
          edit,
          operationId: createUuidV7(),
        });
        await refreshProperties();
        return result;
      }}
      onRefreshProperties={refreshProperties}
      onDelete={async (targetPageId) => {
        const result = await commitPageLifecycleIntent({
          kind: "delete",
          projectId: null,
          pageId: targetPageId,
          operationId: createUuidV7(),
          clientSessionId: surfaceId,
        });
        if (result.receipt.lifecycle !== "deleted")
          throw new Error(
            intl.formatMessage({
              id: "lib.boardPageMutationCommand.deleteFailed",
              defaultMessage: "Failed to delete Page",
            }),
          );
      }}
      onCompleteOccurrence={async (targetPageId, occurrenceStart) => {
        const result = await completePageOccurrence(
          null,
          {
            operationId: createUuidV7(),
            createdPageId: createUuidV7(),
            pageId: targetPageId,
            occurrenceStart,
            source: "page-detail",
          },
          surfaceId,
        );
        if (!result.success)
          throw new Error(
            result.error ??
              intl.formatMessage({
                id: "lib.useBoard.completeFailed",
                defaultMessage: "Failed to complete occurrence",
              }),
          );
        await refreshProperties();
      }}
      onSkipOccurrence={async (targetPageId, occurrenceStart) => {
        const result = await skipPageOccurrence(
          null,
          {
            operationId: createUuidV7(),
            pageId: targetPageId,
            occurrenceStart,
            source: "page-detail",
          },
          surfaceId,
        );
        if (!result.success)
          throw new Error(
            result.error ??
              intl.formatMessage({
                id: "lib.useBoard.skipFailed",
                defaultMessage: "Failed to skip occurrence",
              }),
          );
        await refreshProperties();
      }}
    />
  );
}
