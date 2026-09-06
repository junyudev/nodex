import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import {
  boardContainsPageIds,
  buildCompleteOrSkipOccurrenceTransform,
  buildPatchPageTransform,
  conflictKeyForCard,
  conflictKeysForPatch,
} from "./board-optimistic-ops";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  PAGE_DOCUMENT_MUTATION_REQUIRED_MESSAGE,
  findPageDocumentPatchFields,
} from "../../shared/page-content-authority";
import type {
  PageOccurrence,
  PageOccurrenceMutationResult,
  DatabasePage,
  PageCreateInput,
  PageCreateMutationResult,
  PageCreatePlacement,
  PageInput,
  PageUpdateMutationResult,
  PageUpdateResult,
  PageOccurrenceActionInput,
  PageOccurrenceCompleteInput,
  PageOccurrenceUpdateInput,
  WorkflowStatus,
  MovePageInput,
  MovePagesInput,
} from "./types";
import {
  completePageOccurrence,
  readBoardPage,
  readCalendarOccurrenceWindow,
  skipPageOccurrence,
  updatePageOccurrence,
} from "./page-occurrence-runtime";
import {
  getBoardProjectStore,
  type DatabaseViewTransform,
  type LocalProjectionCursor,
} from "./board-store";
import { getDatabaseRowDetail, setDatabaseRowDetail } from "./database-row-detail-store";
import { deleteBoardPage, moveBoardPage, moveBoardPages } from "./board-page-mutation-command";
import { isPageMetadataPatch } from "./page-detail-metadata-runtime";
import {
  commitPageMetadataPatchForBoardWithReceipt,
  type PageMetadataBoardMutationEnvelope,
} from "./page-metadata-board-runtime";
import { createBoardPage } from "./board-page-create-command";
import type {
  DatabaseViewPresentationOverride,
  DatabaseViewRulesOverride,
} from "../../shared/database-kernel";
import type { DatabaseViewMutationReceipt } from "./database-view-row-mutations";
import {
  withPublishedDatabaseViewDefinition,
  type DatabaseViewRenderModel,
  type PublishedDatabaseViewDefinitionPatch,
} from "./database-view-render-model";

export interface DatabaseViewDefinitionPublicationIntent {
  readonly kind: "rules" | "presentation" | "conditional-colors";
  readonly patch: PublishedDatabaseViewDefinitionPatch;
  readonly commit: (
    canonicalModel: DatabaseViewRenderModel,
    operationId: string,
  ) => Promise<DatabaseViewMutationReceipt>;
}

interface UseBoardOptions {
  projectId: string;
  databaseViewId?: string;
  sessionId?: string;
  onMutation?: () => void;
  enabled?: boolean;
  /**
   * Only the Database View presentation owner should provide this option.
   * Omitting it leaves a shared Board store's current presentation untouched;
   * passing `null` explicitly restores the durable View presentation.
   */
  presentationOverride?: DatabaseViewPresentationOverride | null;
  rulesOverride?: DatabaseViewRulesOverride | null;
  presentationOverrideReady?: boolean;
}

const MAX_CALENDAR_OCCURRENCES = 1_000;
const DATABASE_VIEW_DEFINITION_PUBLICATION_LANE = "database-view:definition-publication";

type NewPageOccurrenceAction = Omit<PageOccurrenceActionInput, "operationId">;
type NewPageOccurrenceComplete = Omit<PageOccurrenceCompleteInput, "operationId" | "createdPageId">;
type NewPageOccurrenceUpdate = Omit<PageOccurrenceUpdateInput, "operationId" | "createdPageId">;

type SuccessfulPageOccurrenceMutation = Extract<
  PageOccurrenceMutationResult,
  { readonly success: true }
>;

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "Unknown error";
}

const requireSuccessfulOccurrenceMutation = (
  result: PageOccurrenceMutationResult,
  fallbackError: string,
): SuccessfulPageOccurrenceMutation => {
  if (result.success) return result;
  throw new Error(result.error ?? fallbackError);
};

function normalizeOccurrenceUpdatesToPagePatch(
  input: PageOccurrenceUpdateInput,
): Partial<PageInput> {
  const patch: Partial<PageInput> = {};
  if (Object.prototype.hasOwnProperty.call(input.updates, "scheduledStart"))
    patch.scheduledStart = input.updates.scheduledStart;
  if (Object.prototype.hasOwnProperty.call(input.updates, "scheduledEnd"))
    patch.scheduledEnd = input.updates.scheduledEnd;
  if (Object.prototype.hasOwnProperty.call(input.updates, "isAllDay"))
    patch.isAllDay = input.updates.isAllDay;
  if (Object.prototype.hasOwnProperty.call(input.updates, "recurrence"))
    patch.recurrence = input.updates.recurrence;
  if (Object.prototype.hasOwnProperty.call(input.updates, "reminders"))
    patch.reminders = input.updates.reminders;
  if (Object.prototype.hasOwnProperty.call(input.updates, "scheduleTimezone"))
    patch.scheduleTimezone = input.updates.scheduleTimezone;
  return patch;
}

function buildCommittedPageDetailFromUpdate(
  existing: DatabasePage | null,
  result: Extract<PageUpdateResult, { status: "updated" }>,
): DatabasePage | null {
  if (!existing || !result.summary) return null;

  return {
    ...result.summary,
    description: existing.description,
  };
}

export function useBoard(options: UseBoardOptions) {
  const ownsPresentationOverride = Object.prototype.hasOwnProperty.call(
    options,
    "presentationOverride",
  );
  const ownsRulesOverride = Object.prototype.hasOwnProperty.call(options, "rulesOverride");
  const {
    projectId,
    databaseViewId,
    sessionId,
    onMutation,
    enabled = true,
    presentationOverride,
    rulesOverride,
    presentationOverrideReady = true,
  } = options;
  const store = useMemo(
    () => getBoardProjectStore(projectId, databaseViewId ?? null),
    [databaseViewId, projectId],
  );
  const setPresentationOverride = useCallback(
    (next: DatabaseViewPresentationOverride | null) => {
      store.setPresentationOverride(next && Object.keys(next).length > 0 ? next : null);
    },
    [store],
  );
  const setRulesOverride = useCallback(
    (next: DatabaseViewRulesOverride | null) => {
      store.setRulesOverride(next && Object.keys(next).length > 0 ? next : null);
    },
    [store],
  );

  useEffect(() => {
    if (!ownsPresentationOverride || !presentationOverrideReady) return;
    setPresentationOverride(presentationOverride ?? null);
  }, [
    ownsPresentationOverride,
    presentationOverride,
    presentationOverrideReady,
    setPresentationOverride,
  ]);

  useEffect(() => {
    if (!ownsRulesOverride || !presentationOverrideReady) return;
    setRulesOverride(rulesOverride ?? null);
  }, [ownsRulesOverride, presentationOverrideReady, rulesOverride, setRulesOverride]);

  const subscribe = useCallback(
    (listener: () => void) => (enabled ? store.subscribe(listener) : () => undefined),
    [enabled, store],
  );
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot);

  useLayoutEffect(() => {
    if (!enabled || snapshot.materializationRenderToken === null) return;
    store.markRendered(snapshot.materializationRenderToken);
  }, [enabled, snapshot.materializationRenderToken, store]);

  const fetchBoard = useCallback(
    async (minimum: number | LocalProjectionCursor = 0) => {
      await store.fetchBoard(minimum);
    },
    [store],
  );
  const refreshCanonicalDatabaseView = useCallback(async () => {
    if (!(await store.fetchBoard()))
      throw new Error("The Database View could not refresh its canonical projection.");
  }, [store]);

  const loadMore = useCallback(async () => {
    await store.loadMore();
  }, [store]);

  const loadMoreGroup = useCallback(
    async (scopeKey: string) => {
      await store.loadMoreGroup(scopeKey);
    },
    [store],
  );

  const requireWritableSelectedView = useCallback((): boolean => {
    if (!databaseViewId) return true;
    return store.getSnapshot().databaseView?.readOnlyReason === null;
  }, [databaseViewId, store]);

  const publishDatabaseViewDefinition = useCallback(
    async (
      input: DatabaseViewDefinitionPublicationIntent,
    ): Promise<DatabaseViewMutationReceipt> => {
      if (!databaseViewId) throw new Error("A durable Database View is required for publication");
      const visibleModel = store.getSnapshot().databaseView;
      if (!visibleModel) throw new Error("The Database View is not loaded");
      if (visibleModel.readOnlyReason) throw new Error(visibleModel.readOnlyReason);

      const apply: DatabaseViewTransform = (model) =>
        withPublishedDatabaseViewDefinition(model, input.patch);
      const operationId = createUuidV7();
      const outcome = await store.runOptimisticDatabaseViewMutation({
        kind: `database:view:${input.kind}:publish`,
        operationIdentity: operationId,
        conflictKeys: [`database-view:definition:${input.kind}`],
        remoteLane: DATABASE_VIEW_DEFINITION_PUBLICATION_LANE,
        apply,
        runRemote: async (canonicalModel) => await input.commit(canonicalModel, operationId),
        getCommitCursor: (receipt) => ({
          storeEpoch: receipt.storeEpoch,
          commitSeq: receipt.commitSeq,
        }),
      });
      if (!outcome.ok) {
        throw outcome.error ?? new Error("The Database View settings could not be published");
      }
      if (!outcome.result) throw new Error("The Database View publication returned no receipt");
      return outcome.result;
    },
    [databaseViewId, store],
  );

  const createPage = useCallback(
    async (
      columnId: string,
      input: PageCreateInput,
      placement: PageCreatePlacement = "bottom",
    ): Promise<PageCreateMutationResult> => {
      const result = await createBoardPage({
        projectId,
        databaseViewId,
        clientSessionId: sessionId,
        status: columnId as WorkflowStatus,
        input,
        placement,
      });
      if (result.status === "created") onMutation?.();
      return result;
    },
    [databaseViewId, onMutation, projectId, sessionId],
  );

  const updatePage = useCallback(
    async (
      columnId: string,
      pageId: string,
      updates: Partial<PageInput>,
    ): Promise<PageUpdateMutationResult> => {
      if (!requireWritableSelectedView()) {
        return { status: "error", error: "The selected Database View is read-only" };
      }
      const documentFields = findPageDocumentPatchFields(updates);
      if (documentFields.length > 0) {
        return {
          status: "error",
          error: PAGE_DOCUMENT_MUTATION_REQUIRED_MESSAGE,
        };
      }
      if (!isPageMetadataPatch(updates)) {
        return { status: "error", error: "No mutable Page metadata was specified" };
      }
      const conflictKeys = conflictKeysForPatch(pageId, updates);
      const metadataMutationId = createUuidV7();
      const outcome = await store.runOptimisticMutation<PageMetadataBoardMutationEnvelope>({
        kind: "block:properties",
        operationIdentity: metadataMutationId,
        conflictKeys,
        apply: buildPatchPageTransform(columnId, pageId, updates, { bumpRevision: true }),
        runRemote: async () =>
          await commitPageMetadataPatchForBoardWithReceipt({
            projectId,
            pageId: pageId,
            operationId: metadataMutationId,
            clientSessionId: sessionId,
            patch: updates,
          }),
        getCommitCursor: (result) => result.commitCursor,
        isCommitMaterialized: (canonicalBoard) => boardContainsPageIds(canonicalBoard, [pageId]),
      });

      if (!outcome.ok) {
        return {
          status: "error",
          error: outcome.error?.message ?? "Failed to update card",
        };
      }

      const envelope = outcome.result;
      if (!envelope) {
        return {
          status: "error",
          error: "Missing card update result",
        };
      }
      const { result } = envelope;
      if (outcome.superseded) return result;

      if (result.status === "updated") {
        const committedDetail = buildCommittedPageDetailFromUpdate(
          getDatabaseRowDetail(projectId, pageId),
          result,
        );
        if (committedDetail) {
          setDatabaseRowDetail(projectId, committedDetail, { acceptEqualRevision: true });
        }
        onMutation?.();
        return result;
      }

      if (result.status === "conflict") {
        setDatabaseRowDetail(projectId, result.page);
        store.resolveConflict(conflictKeys);
        await store.refreshBoard();
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("nodex:card-update-conflict", {
              detail: {
                projectId,
                pageId,
              },
            }),
          );
        }
        return result;
      }

      store.resolveConflict(conflictKeys);
      await store.refreshBoard();
      return result;
    },
    [onMutation, projectId, requireWritableSelectedView, sessionId, store],
  );

  const getPage = useCallback(
    async (
      pageId: string,
      columnId?: WorkflowStatus,
      cursor?: LocalProjectionCursor,
    ): Promise<DatabasePage | null> => {
      try {
        const card = await readBoardPage(projectId, pageId, columnId, cursor);
        if (!card) return null;
        setDatabaseRowDetail(projectId, card);
        return card;
      } catch (err) {
        store.setError(toErrorMessage(err));
        return null;
      }
    },
    [projectId, store],
  );

  const deletePage = useCallback(
    async (columnId: string | undefined, pageId: string): Promise<boolean> => {
      if (!requireWritableSelectedView()) return false;
      const deleted = await deleteBoardPage({
        store,
        projectId,
        ...(sessionId ? { clientSessionId: sessionId } : {}),
        ...(columnId ? { columnId } : {}),
        pageId,
        operationId: createUuidV7(),
      });
      if (!deleted) return false;
      onMutation?.();
      return true;
    },
    [onMutation, projectId, requireWritableSelectedView, sessionId, store],
  );

  const movePage = useCallback(
    async (input: MovePageInput): Promise<boolean> => {
      if (!requireWritableSelectedView()) return false;
      const moved = await moveBoardPage({
        store,
        projectId,
        move: input,
        operationId: createUuidV7(),
      });
      if (!moved) return false;
      onMutation?.();
      return true;
    },
    [onMutation, projectId, requireWritableSelectedView, store],
  );

  const movePages = useCallback(
    async (input: MovePagesInput): Promise<boolean> => {
      if (!requireWritableSelectedView()) return false;
      const moved = await moveBoardPages({
        store,
        projectId,
        move: input,
        operationId: createUuidV7(),
      });
      if (!moved) return false;
      onMutation?.();
      return true;
    },
    [onMutation, projectId, requireWritableSelectedView, store],
  );

  const listPageOccurrences = useCallback(
    async (windowStart: Date, windowEnd: Date, searchQuery?: string): Promise<PageOccurrence[]> => {
      try {
        const occurrences: PageOccurrence[] = [];
        let after: string | null = null;
        do {
          const result = await readCalendarOccurrenceWindow(
            projectId,
            windowStart,
            windowEnd,
            searchQuery,
            after,
          );
          occurrences.push(...result.occurrences);
          if (result.nextCursor === after && after !== null) {
            throw new Error("Calendar occurrence continuation did not advance");
          }
          after =
            occurrences.length < MAX_CALENDAR_OCCURRENCES ? (result.nextCursor ?? null) : null;
          if (occurrences.length >= MAX_CALENDAR_OCCURRENCES && result.nextCursor) {
            store.setError(
              `Calendar is limited to ${MAX_CALENDAR_OCCURRENCES.toLocaleString()} occurrences; narrow the date range or search.`,
            );
          }
        } while (after !== null);
        return occurrences.slice(0, MAX_CALENDAR_OCCURRENCES).map((occurrence) => ({
          ...occurrence,
          created: asDate(occurrence.created),
          dueDate: occurrence.dueDate ? asDate(occurrence.dueDate) : undefined,
          scheduledStart: asDate(occurrence.scheduledStart ?? occurrence.occurrenceStart),
          scheduledEnd: asDate(occurrence.scheduledEnd ?? occurrence.occurrenceEnd),
          occurrenceStart: asDate(occurrence.occurrenceStart),
          occurrenceEnd: asDate(occurrence.occurrenceEnd),
        }));
      } catch (err) {
        store.setError(toErrorMessage(err));
        return [];
      }
    },
    [projectId, store],
  );

  const completeOccurrence = useCallback(
    async (input: NewPageOccurrenceComplete): Promise<boolean> => {
      if (!requireWritableSelectedView()) return false;
      const command: PageOccurrenceCompleteInput = {
        ...input,
        operationId: createUuidV7(),
        createdPageId: createUuidV7(),
      };
      const outcome = await store.runOptimisticMutation<SuccessfulPageOccurrenceMutation>({
        kind: "page:occurrence:complete",
        operationIdentity: command.operationId,
        conflictKeys: [conflictKeyForCard(command.pageId)],
        apply: buildCompleteOrSkipOccurrenceTransform(command.pageId),
        runRemote: async () =>
          requireSuccessfulOccurrenceMutation(
            await completePageOccurrence(projectId, command, sessionId),
            "Failed to complete occurrence",
          ),
        getCommitCursor: (result) => result.commitCursor,
        isCommitMaterialized: () => true,
      });

      if (!outcome.ok) return false;
      if (!outcome.result?.success) return false;
      onMutation?.();
      return true;
    },
    [onMutation, projectId, requireWritableSelectedView, sessionId, store],
  );

  const skipOccurrence = useCallback(
    async (input: NewPageOccurrenceAction): Promise<boolean> => {
      if (!requireWritableSelectedView()) return false;
      const command: PageOccurrenceActionInput = {
        ...input,
        operationId: createUuidV7(),
      };
      const outcome = await store.runOptimisticMutation<SuccessfulPageOccurrenceMutation>({
        kind: "page:occurrence:skip",
        operationIdentity: command.operationId,
        conflictKeys: [conflictKeyForCard(command.pageId)],
        apply: buildCompleteOrSkipOccurrenceTransform(command.pageId),
        runRemote: async () =>
          requireSuccessfulOccurrenceMutation(
            await skipPageOccurrence(projectId, command, sessionId),
            "Failed to skip occurrence",
          ),
        getCommitCursor: (result) => result.commitCursor,
        isCommitMaterialized: () => true,
      });

      if (!outcome.ok) return false;
      if (!outcome.result?.success) return false;
      onMutation?.();
      return true;
    },
    [onMutation, projectId, requireWritableSelectedView, sessionId, store],
  );

  const updateOccurrence = useCallback(
    async (input: NewPageOccurrenceUpdate): Promise<boolean> => {
      if (!requireWritableSelectedView()) return false;
      const command = {
        ...input,
        operationId: createUuidV7(),
        ...(input.scope === "all" ? {} : { createdPageId: createUuidV7() }),
      } as PageOccurrenceUpdateInput;
      const optimisticPatch = normalizeOccurrenceUpdatesToPagePatch(command);
      const outcome = await store.runOptimisticMutation<SuccessfulPageOccurrenceMutation>({
        kind: "page:occurrence:update",
        operationIdentity: command.operationId,
        conflictKeys: conflictKeysForPatch(command.pageId, optimisticPatch),
        apply: buildPatchPageTransform(undefined, command.pageId, optimisticPatch),
        runRemote: async () =>
          requireSuccessfulOccurrenceMutation(
            await updatePageOccurrence(projectId, command, sessionId),
            "Failed to update occurrence",
          ),
        getCommitCursor: (result) => result.commitCursor,
        isCommitMaterialized: () => true,
      });

      if (!outcome.ok) return false;
      if (!outcome.result?.success) return false;
      onMutation?.();
      return true;
    },
    [onMutation, projectId, requireWritableSelectedView, sessionId, store],
  );

  const patchPage = useCallback(
    (columnId: string, pageId: string, updates: Partial<PageInput>) => {
      if (!requireWritableSelectedView()) return;
      store.enqueueLocalOverlay({
        kind: "page:patch-local",
        conflictKeys: conflictKeysForPatch(pageId, updates),
        apply: buildPatchPageTransform(columnId, pageId, updates),
      });
    },
    [requireWritableSelectedView, store],
  );

  const clearLastMutationError = useCallback(() => {
    store.clearLastMutationError();
  }, [store]);

  return {
    board: snapshot.board,
    databaseView: snapshot.databaseView,
    canonicalDatabaseView: snapshot.canonicalDatabaseView,
    canonicalReadGeneration: snapshot.canonicalReadGeneration,
    pageIndex: snapshot.pageIndex,
    loading: snapshot.loading,
    loadingMore: snapshot.loadingMore,
    hasMore: snapshot.hasMore,
    error: snapshot.error,
    pendingMutationCount: snapshot.pendingMutationCount,
    lastMutationError: snapshot.lastMutationError,
    groupPagination: snapshot.groupPagination,
    totalRows: snapshot.totalRows,
    setPresentationOverride,
    setRulesOverride,
    publishDatabaseViewDefinition,
    clearLastMutationError,
    refresh: fetchBoard,
    refreshCanonicalDatabaseView,
    loadMore,
    loadMoreGroup,
    createPage,
    getPage,
    updatePage,
    deletePage,
    movePage,
    movePages,
    listPageOccurrences,
    completeOccurrence,
    skipOccurrence,
    updateOccurrence,
    patchPage,
  };
}
