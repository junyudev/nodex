import type { PageInput, PageUpdateMutationResult } from "@/lib/types";
import type { PageStageHandlers } from "@/lib/page-stage-handlers";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { isWorkflowStatus } from "../../../shared/workflow-status";
import { getBoardProjectStore } from "@/lib/board-store";
import { deleteBoardPage, moveBoardPage } from "@/lib/board-page-mutation-command";
import { isPageMetadataPatch } from "@/lib/page-detail-metadata-runtime";
import { commitPageMetadataPatchForBoard } from "@/lib/page-metadata-board-runtime";
import { completePageOccurrence, skipPageOccurrence } from "@/lib/page-occurrence-runtime";
import {
  PAGE_DOCUMENT_MUTATION_REQUIRED_MESSAGE,
  findPageDocumentPatchFields,
} from "../../../shared/page-content-authority";

export function makeRemotePageStageHandlers(
  projectId: string,
  databaseViewId: string,
): PageStageHandlers {
  return {
    onPatch: () => {
      // no-op for remote-opened sessions
    },
    onUpdate: async (columnId: string, pageId: string, updates: Partial<PageInput>) => {
      void columnId;
      if (findPageDocumentPatchFields(updates).length > 0) {
        return {
          status: "error",
          error: PAGE_DOCUMENT_MUTATION_REQUIRED_MESSAGE,
        } satisfies PageUpdateMutationResult;
      }
      if (!isPageMetadataPatch(updates)) {
        return {
          status: "error",
          error: "No mutable Page metadata was specified",
        } satisfies PageUpdateMutationResult;
      }
      return await commitPageMetadataPatchForBoard({
        projectId,
        pageId: pageId,
        operationId: createUuidV7(),
        patch: updates,
      });
    },
    onDelete: async (columnId: string, pageId: string) => {
      const deleted = await deleteBoardPage({
        store: getBoardProjectStore(projectId, databaseViewId),
        projectId,
        columnId,
        operationId: createUuidV7(),
        pageId,
      });
      if (!deleted) throw new Error("Failed to delete Page");
    },
    onMove: async (fromStatus: string, pageId: string, toStatus: string) => {
      if (!isWorkflowStatus(fromStatus) || !isWorkflowStatus(toStatus)) {
        throw new Error("Page Stage move requires canonical Page statuses");
      }
      const moved = await moveBoardPage({
        store: getBoardProjectStore(projectId, databaseViewId),
        projectId,
        operationId: createUuidV7(),
        move: { pageId: pageId, fromStatus, toStatus },
      });
      if (!moved) throw new Error("Failed to move Page");
    },
    onCompleteOccurrence: async (pageId: string, occurrenceStart: Date) => {
      await completePageOccurrence(projectId, {
        operationId: createUuidV7(),
        createdPageId: createUuidV7(),
        pageId: pageId,
        occurrenceStart,
        source: "page-detail",
      });
    },
    onSkipOccurrence: async (pageId: string, occurrenceStart: Date) => {
      await skipPageOccurrence(projectId, {
        operationId: createUuidV7(),
        pageId: pageId,
        occurrenceStart,
        source: "page-detail",
      });
    },
  };
}
