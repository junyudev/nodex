import { createUuidV7 } from "../../shared/uuid-v7";
import { isWorkflowStatus } from "../../shared/workflow-status";
import type { PageLifecycleExecutionResultV2 } from "../../shared/page-lifecycle-v2-runtime";
import {
  boardContainsPageIds,
  buildCreateCardTransform,
  conflictKeysForCreate,
  createOptimisticCard,
  BOARD_PLACEMENT_REMOTE_LANE,
} from "./board-optimistic-ops";
import { getBoardProjectStore } from "./board-store";
import { setDatabaseRowDetail } from "./database-row-detail-store";
import { commitPageLifecycleIntent } from "./page-lifecycle-runtime";
import {
  gatePageCreateInputByCapabilities,
  resolvePageCreatePropertyCapabilities,
} from "./page-create-capabilities";
import type {
  DatabasePage,
  PageCreateInput,
  PageCreateMutationResult,
  PageCreatePlacement,
  WorkflowStatus,
} from "./types";

export interface CreateBoardPageCommandInput {
  readonly projectId: string;
  readonly databaseViewId?: string | null;
  readonly clientSessionId?: string;
  readonly status: WorkflowStatus;
  readonly input: PageCreateInput;
  readonly placement?: PageCreatePlacement;
}

function ensureCreateInputId(input: PageCreateInput): PageCreateInput {
  if (input.id?.trim()) return input;
  return {
    ...input,
    id: createUuidV7(),
  };
}

function materializeCommittedCreateFallback(
  optimisticPage: ReturnType<typeof createOptimisticCard>,
  input: PageCreateInput,
  committed: PageLifecycleExecutionResultV2,
): DatabasePage {
  const { descriptionPreview, descriptionLength, hasDescription, ...page } = optimisticPage;
  void descriptionPreview;
  void descriptionLength;
  void hasDescription;
  return {
    ...page,
    description: input.description ?? "",
    revision: committed.receipt.metadataRevision,
    created: new Date(committed.receipt.committedAt),
  };
}

async function requireWritableSelectedView(
  store: ReturnType<typeof getBoardProjectStore>,
  databaseViewId: string | null | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!databaseViewId) return { ok: true };

  if (!store.getSnapshot().databaseView) {
    await store.fetchBoard();
  }

  const databaseView = store.getSnapshot().databaseView;
  if (databaseView?.readOnlyReason === null) return { ok: true };

  const error =
    databaseView?.readOnlyReason ?? "The selected Database View is not ready for writes";
  store.setError(error);
  return { ok: false, error };
}

/**
 * The renderer command shared by every Page-creation entry point. It keeps the
 * optimistic projection and Core lifecycle boundaries independent of any
 * mounted Board component.
 */
export async function createBoardPage({
  projectId,
  databaseViewId,
  clientSessionId,
  status,
  input,
  placement = "bottom",
}: CreateBoardPageCommandInput): Promise<PageCreateMutationResult> {
  const store = getBoardProjectStore(projectId, databaseViewId ?? null);
  const writable = await requireWritableSelectedView(store, databaseViewId);
  if (!writable.ok) {
    return { status: "error", error: writable.error };
  }
  if (!isWorkflowStatus(status)) {
    return {
      status: "error",
      error: "Page creation requires a canonical Page status",
    };
  }

  const currentView = databaseViewId ? store.getSnapshot().databaseView : null;
  const capabilityGatedInput = currentView
    ? gatePageCreateInputByCapabilities(
        input,
        resolvePageCreatePropertyCapabilities(currentView.query.properties),
      )
    : input;
  const createInput = ensureCreateInputId(capabilityGatedInput);
  const optimisticPage = createOptimisticCard({
    ...createInput,
    status,
  });
  const operationId = createUuidV7();
  const outcome = await store.runOptimisticMutation<PageLifecycleExecutionResultV2>({
    kind: "page:create",
    operationIdentity: operationId,
    conflictKeys: conflictKeysForCreate(status, optimisticPage.id),
    apply: buildCreateCardTransform(status, optimisticPage, placement),
    remoteLane: BOARD_PLACEMENT_REMOTE_LANE,
    runRemote: async () => {
      const committed = await commitPageLifecycleIntent({
        kind: "create",
        projectId,
        operationId,
        clientSessionId,
        pageId: optimisticPage.id,
        status,
        input: createInput,
        placement,
      });
      return committed;
    },
    getCommitCursor: (committed) => ({
      storeEpoch: committed.receipt.storeEpoch,
      commitSeq: committed.receipt.commitSeq,
    }),
    isCommitMaterialized: (canonicalBoard) =>
      boardContainsPageIds(canonicalBoard, [optimisticPage.id]),
  });

  if (!outcome.ok) {
    return {
      status: "error",
      error: outcome.error?.message ?? "Failed to create Page",
    };
  }
  if (!outcome.result) {
    return { status: "error", error: "Missing Page create result" };
  }

  const page =
    outcome.result.boardProjection ??
    materializeCommittedCreateFallback(optimisticPage, createInput, outcome.result);
  if (outcome.result.boardProjection && !outcome.superseded) {
    setDatabaseRowDetail(projectId, outcome.result.boardProjection);
  }
  return { status: "created", page };
}
