import { toDatabasePageSummary } from "../../shared/page-summary";
import type { DatabasePage, PageInput, PageUpdateField, PageUpdateResult } from "./types";
import { invokeRendererQuery as invoke } from "./renderer-command";
import {
  commitPageDetailMetadataPatchWithReceipt,
  isPageMetadataPatch,
  type PageDetailMetadataMutationEnvelope,
  type PageMetadataCommitCursor,
} from "./page-detail-metadata-runtime";

export interface PageMetadataBoardRuntimeDependencies {
  readonly commit: (input: {
    readonly projectId: string;
    readonly pageId: string;
    readonly operationId: string;
    readonly clientSessionId?: string;
    readonly patch: Partial<PageInput>;
  }) => Promise<PageDetailMetadataMutationEnvelope>;
  readonly readBoardProjection: (
    projectId: string,
    pageId: string,
    minimumCommitCursor?: PageMetadataCommitCursor,
  ) => Promise<DatabasePage | null>;
}

export interface PageMetadataBoardMutationEnvelope {
  readonly result: PageUpdateResult;
  readonly commitCursor: PageMetadataCommitCursor | null;
}

const DEFAULT_DEPENDENCIES: PageMetadataBoardRuntimeDependencies = {
  commit: commitPageDetailMetadataPatchWithReceipt,
  readBoardProjection: async (projectId, pageId, minimumCommitCursor) =>
    (await invoke(
      "database-row:get",
      projectId,
      pageId,
      undefined,
      minimumCommitCursor,
    )) as DatabasePage | null,
};

const readScopedBoardProjection = async (
  projectId: string,
  pageId: string,
  dependencies: PageMetadataBoardRuntimeDependencies,
  minimumCommitCursor?: PageMetadataCommitCursor,
): Promise<DatabasePage | null> => {
  const card = await dependencies.readBoardProjection(projectId, pageId, minimumCommitCursor);
  if (!card || card.id === pageId) return card;
  throw new Error(`Board projection returned Page ${card.id} for requested Page ${pageId}`);
};

const readBoardProjectionBestEffort = async (
  projectId: string,
  pageId: string,
  dependencies: PageMetadataBoardRuntimeDependencies,
  commitCursor: PageMetadataCommitCursor | null,
): Promise<DatabasePage | null> => {
  try {
    return await readScopedBoardProjection(
      projectId,
      pageId,
      dependencies,
      commitCursor ?? undefined,
    );
  } catch {
    return null;
  }
};

const changedFields = (
  patch: Partial<PageInput>,
  didMutate: boolean,
): readonly PageUpdateField[] => (didMutate ? (Object.keys(patch) as PageUpdateField[]) : []);

/**
 * Adapts the canonical Page metadata command to the Board result shape without
 * confusing its durable receipt with a best-effort visual projection.
 */
export const commitPageMetadataPatchForBoardWithReceipt = async (input: {
  readonly projectId: string;
  readonly pageId: string;
  readonly operationId: string;
  readonly clientSessionId?: string;
  readonly patch: Partial<PageInput>;
  readonly dependencies?: PageMetadataBoardRuntimeDependencies;
}): Promise<PageMetadataBoardMutationEnvelope> => {
  if (!isPageMetadataPatch(input.patch)) {
    throw new TypeError("Page metadata patch contains unsupported fields");
  }
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const committed = await dependencies.commit({
    projectId: input.projectId,
    pageId: input.pageId,
    operationId: input.operationId,
    ...(input.clientSessionId ? { clientSessionId: input.clientSessionId } : {}),
    patch: input.patch,
  });
  const { result, commitCursor } = committed;
  if (result.status === "not_found") {
    return { result, commitCursor: null };
  }
  if (result.status === "error") throw new Error(result.error);

  if (result.status === "conflict") {
    const page = await readScopedBoardProjection(input.projectId, input.pageId, dependencies);
    return {
      result: page ? { status: "conflict", page } : { status: "not_found" },
      commitCursor: null,
    };
  }

  const page = await readBoardProjectionBestEffort(
    input.projectId,
    input.pageId,
    dependencies,
    commitCursor,
  );
  const updated: Extract<PageUpdateResult, { readonly status: "updated" }> = {
    status: "updated",
    projectId: input.projectId,
    pageId: input.pageId,
    changedFields: [...changedFields(input.patch, result.didMutate)],
    didMutate: result.didMutate,
  };
  if (!page) return { result: updated, commitCursor };
  return {
    result: {
      ...updated,
      revision: page.revision ?? 0,
      summary: toDatabasePageSummary(page),
    },
    commitCursor,
  };
};

export const commitPageMetadataPatchForBoard = async (input: {
  readonly projectId: string;
  readonly pageId: string;
  readonly operationId: string;
  readonly clientSessionId?: string;
  readonly patch: Partial<PageInput>;
  readonly dependencies?: PageMetadataBoardRuntimeDependencies;
}): Promise<PageUpdateResult> => {
  const envelope = await commitPageMetadataPatchForBoardWithReceipt(input);
  return envelope.result;
};
