import { useMemo, useState } from "react";
import { consumePageTitleFocus } from "@/lib/page-title-focus-intent";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { createUuidV7 } from "../../../shared/uuid-v7";

import { PageStage } from "./workbench-page-stage";
import { PageStageLoadingFrame } from "../board/page-stage/frame";
import { prepareLibraryOwnedBlockDocument } from "../../lib/api";
import {
  type ReadyPageBlockDocumentDescriptor,
  unwrapLibraryOwnedBlockDocumentPreparationResult,
  validateLibraryOwnedBlockDocumentDescriptor,
} from "../../lib/owned-block-document";
import { projectPageDetailToStageModel } from "../../lib/page-stage-page";
import {
  commitLibraryPageDetailMetadataPatch,
  commitLibraryPageDetailPropertyEdit,
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
import { libraryPageDetailQueryOptions } from "../../lib/library-page-detail-query";
import { useApplicationPending } from "@/bootstrap/application-surface";
import { usePageLinkedChats, type PageChatCommands } from "@/lib/use-page-linked-chats";

const ignoreLibraryPageClose = (): void => undefined;

export function WorkbenchLibraryPageSurface({
  pageId,
  surfaceId = pageId,
  editorSessionKey = `library-page:${surfaceId}`,
  isActivePanelTab = true,
  onClose = ignoreLibraryPageClose,
  onOpenDatabase,
  onOpenPage,
  onOpenCanvas,
  pageChats,
  currentSessionId = null,
}: {
  readonly pageId: string;
  readonly surfaceId?: string;
  readonly editorSessionKey?: string;
  readonly isActivePanelTab?: boolean;
  readonly onClose?: () => void;
  readonly onOpenDatabase: (databaseId: DatabaseId) => void;
  readonly onOpenPage?: (pageId: string, titleSnapshot?: string) => void;
  readonly onOpenCanvas?: (canvasBlockId: string, titleSnapshot?: string) => void;
  readonly pageChats?: PageChatCommands;
  /** The chat whose Scene shows this Page, if any. */
  readonly currentSessionId?: string | null;
}) {
  const queryClient = useQueryClient();
  const linkedChats = usePageLinkedChats(pageId, { enabled: pageChats !== undefined });
  // A Page created a moment ago opens ready to be named; reopening one never moves focus.
  const [focusTitle] = useState(() => consumePageTitleFocus(pageId));
  const detailQueryKey = useMemo(() => queryKeys.library.pageDetail(pageId), [pageId]);
  const documentQueryKey = useMemo(() => queryKeys.library.pageDocument(pageId), [pageId]);
  const detail = useQuery({
    ...libraryPageDetailQueryOptions(pageId),
  });
  const document = useQuery({
    queryKey: documentQueryKey,
    queryFn: async () => {
      const prepared = unwrapLibraryOwnedBlockDocumentPreparationResult(
        await prepareLibraryOwnedBlockDocument(pageId),
      );
      const descriptor = validateLibraryOwnedBlockDocumentDescriptor(pageId, prepared);
      return descriptor;
    },
  });
  const stagePage = useMemo(() => {
    if (!detail.data) return null;
    return projectPageDetailToStageModel(detail.data);
  }, [detail.data]);

  const authority = detail.data;
  const getCursor = () => {
    const currentDetail = queryClient.getQueryData<typeof authority>(detailQueryKey);
    const currentDocument =
      queryClient.getQueryData<ReadyPageBlockDocumentDescriptor>(documentQueryKey);
    if (!currentDetail || !currentDocument) return null;
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
  if (detail.isPending) return <PageStageLoadingFrame />;

  if (detail.isError || document.isError || !stagePage) {
    const error = detail.error ?? document.error;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-token-main-surface-primary px-6 text-center">
        <p className="text-sm text-token-text-primary">Could not open Page</p>
        <p className="max-w-lg text-sm text-token-description-foreground">
          {error instanceof Error ? error.message : "The Page is unavailable."}
        </p>
        <button
          type="button"
          className="mt-1 rounded-md bg-token-foreground/5 px-2.5 py-1.5 text-sm text-token-text-secondary hover:bg-token-foreground/10 hover:text-token-text-primary"
          onClick={() => {
            void Promise.all([detail.refetch(), document.refetch()]);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <PageStage
      contentRoutingContext={libraryContentRoute}
      editorSessionKey={editorSessionKey}
      pageTitleIdentity={{ libraryId: detail.data.libraryId, pageId }}
      retainEditorSession
      page={stagePage}
      autoFocusTitle={focusTitle}
      projectName={null}
      documentAuthority={
        document.data
          ? {
              kind: "yjs",
              descriptor: document.data,
              reload: async () => {
                await queryClient.resetQueries({ queryKey: documentQueryKey, exact: true });
              },
            }
          : null
      }
      onOpenDatabase={onOpenDatabase}
      onOpenPage={
        onOpenPage
          ? ({ pageId: nextPageId, titleSnapshot }) => {
              onOpenPage(nextPageId, titleSnapshot);
            }
          : undefined
      }
      onOpenCanvas={
        onOpenCanvas
          ? ({ canvasBlockId, titleSnapshot }) => {
              onOpenCanvas(canvasBlockId, titleSnapshot);
            }
          : undefined
      }
      onClose={onClose}
      isActivePanelTab={isActivePanelTab}
      {...(pageChats
        ? {
            ...linkedChats,
            sessionId: currentSessionId,
            relatedChatCandidates: pageChats.candidates,
            onOpenRelatedChat: pageChats.openChat,
            onLinkRelatedChat: async (sessionId: string) => {
              await pageChats.linkPage({ pageId, sessionId });
            },
          }
        : {})}
      onUpdate={async (targetPageId, patch) => {
        const result = await commitLibraryPageDetailMetadataPatch({
          pageId: targetPageId,
          operationId: createUuidV7(),
          clientSessionId: `library-page:${pageId}`,
          patch,
        });
        await queryClient.invalidateQueries({
          queryKey: detailQueryKey,
          exact: true,
        });
        return result;
      }}
      onUpdateProperty={async (targetPageId, propertyId, edit) => {
        const result = await commitLibraryPageDetailPropertyEdit({
          pageId: targetPageId,
          propertyId,
          edit,
          operationId: createUuidV7(),
          clientSessionId: `library-page:${pageId}`,
        });
        await queryClient.invalidateQueries({
          queryKey: detailQueryKey,
          exact: true,
        });
        return result;
      }}
    />
  );
}
