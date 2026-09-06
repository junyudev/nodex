import { useId, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { contentAccessContextKey } from "../../shared/content-access-context";
import type { DatabaseApplyOperationV2 } from "../../shared/database-module-v2";
import type { DatabaseViewRenderModel } from "./database-view-render-model";
import { compileDatabaseViewOperationProjection } from "./database-view-operation-projection";
import {
  commitDatabaseViewOperations,
  DatabaseViewMutationError,
} from "./database-view-row-mutations";
import { ReceiptFencedOptimisticJournal } from "./receipt-fenced-optimistic-journal";
import { registerContentProjectionActivity } from "./content-interaction-history";
import { getRendererProjectionInvalidationRegistry } from "./projection-invalidation-service";
import type { ProjectionInvalidationRegistry } from "./projection-invalidation-registry";

let nextPresentationOwner = 0;

export const classifyDatabasePresentationFailure = (error: Error): "rejected" | "unknown" =>
  error instanceof DatabaseViewMutationError && error.commandError.code !== "unknown"
    ? "rejected"
    : "unknown";

export const databaseOperationsRequirePlacementFence = (
  operations: readonly DatabaseApplyOperationV2[],
): boolean =>
  operations.some(
    (operation) =>
      operation.kind === "position_page" ||
      operation.kind === "position_pages" ||
      operation.kind === "move_list_occurrences" ||
      operation.kind === "undo_list_occurrence_move" ||
      (operation.kind === "reverse_data_edit" && operation.recipe.positionStates.length > 0),
  );

export const databasePresentationFailure = (
  error: Error | undefined,
  outcome: "rejected" | "unknown" | undefined,
): Error => {
  const cause = error ?? new Error("The Database edit was not confirmed.");
  if (outcome !== "rejected" || cause instanceof DatabaseViewMutationError) return cause;
  return new DatabaseViewMutationError({
    code: "revision_conflict",
    message: cause.message,
    retryable: true,
  });
};

/** One bounded read source owns presentation; durable history may retain its command Adapter. */
export class DatabaseViewPresentationStore {
  private readonly consumerKey = `database-presentation:${++nextPresentationOwner}`;
  private releaseRevocations: (() => void) | null = null;
  private authorityGeneration = 0;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private model: DatabaseViewRenderModel;
  private canonicalModel: DatabaseViewRenderModel;
  private previousRead:
    | { readonly identity: DatabaseViewRenderModel; readonly generation: number | undefined }
    | undefined;
  private readGeneration = 0;
  private presentations = 0;
  private refresh: (() => Promise<void> | void) | undefined;
  private readonly pendingDependencyPageIds = new Set<string>();
  private readonly journal = new ReceiptFencedOptimisticJournal<DatabaseViewRenderModel>({
    onChange: () => {
      if (!this.journal.hasWork()) this.pendingDependencyPageIds.clear();
      this.revision += 1;
      for (const listener of this.listeners) listener();
    },
  });

  constructor(
    model: DatabaseViewRenderModel,
    private readonly getProjectionRegistry: () => Pick<
      ProjectionInvalidationRegistry,
      "register"
    > = getRendererProjectionInvalidationRegistry,
  ) {
    this.model = model;
    this.canonicalModel = model;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): number => this.revision;
  getActivity = () => this.journal.getActivity();
  hasWork = (): boolean => this.journal.hasWork();
  hasPendingPlacement = (): boolean =>
    this.journal.hasMatchingConflict((keys) => keys.includes("database:placement"));
  isActive = (): boolean => this.listeners.size > 0;
  attach = (): (() => void) => {
    this.presentations += 1;
    if (this.presentations === 1 && this.model.authorization !== null) {
      const revoke = () => {
        if (this.presentations === 0) return;
        this.authorityGeneration += 1;
        this.journal.revoke("authority_revoked");
        this.pendingDependencyPageIds.clear();
        for (const listener of this.authorityListeners) listener();
        this.revision += 1;
        for (const listener of this.listeners) listener();
      };
      this.releaseRevocations = this.getProjectionRegistry().register({
        scope: { ...this.model.accessContext, libraryId: this.model.libraryId },
        consumerKey: this.consumerKey,
        projectionEffects: "ignore",
        getDependencies: () => ({
          databaseIds: [this.model.databaseId],
          dataSourceIds: [this.model.dataSourceId],
          viewIds: [this.model.databaseViewId],
          pageIds: [
            ...new Set([
              ...this.model.query.rows.map((row) => row.page.pageId),
              ...this.pendingDependencyPageIds,
            ]),
          ],
        }),
        getCursor: () => ({
          storeEpoch: this.canonicalModel.storeEpoch,
          commitSeq: this.canonicalModel.commitSeq,
        }),
        revoke,
        fence: revoke,
        invalidate: () => undefined,
      });
    }
    return () => {
      this.presentations -= 1;
      if (this.presentations > 0) return;
      this.releaseRevocations?.();
      this.releaseRevocations = null;
      this.previousRead = undefined;
      this.journal.revoke("authority_revoked");
      this.pendingDependencyPageIds.clear();
      for (const listener of this.authorityListeners) listener();
    };
  };
  markRendered = (token: number): void => this.journal.markRendered(token);
  discard = (operationId: string): void => {
    this.journal.discard(operationId);
  };

  update(
    model: DatabaseViewRenderModel,
    refresh?: () => Promise<void> | void,
    canonicalModel = model,
    readGeneration?: number,
    readIdentity = canonicalModel,
  ): void {
    const previous = this.previousRead;
    const changed =
      previous !== undefined &&
      (readGeneration !== undefined
        ? previous.generation !== undefined && readGeneration > previous.generation
        : readIdentity !== previous.identity);
    if (
      !previous ||
      readGeneration === undefined ||
      previous.generation === undefined ||
      readGeneration >= previous.generation
    )
      this.previousRead = { identity: readIdentity, generation: readGeneration };
    if (
      canonicalModel.storeEpoch !== this.canonicalModel.storeEpoch ||
      canonicalModel.commitSeq < this.canonicalModel.commitSeq
    )
      return;
    if (changed) this.readGeneration += 1;
    this.model = model;
    this.canonicalModel = canonicalModel;
    this.refresh = refresh;
    for (const listener of this.authorityListeners) listener();
    if (changed && this.journal.hasWork()) {
      this.revision += 1;
      for (const listener of this.listeners) listener();
    }
  }

  private readonly authorityListeners = new Set<() => void>();

  private waitForAuthority(storeEpoch: string, commitSeq: number): Promise<boolean> {
    if (this.presentations === 0) return Promise.resolve(false);
    const generation = this.authorityGeneration;
    const check = () =>
      this.canonicalModel.storeEpoch === storeEpoch && this.canonicalModel.commitSeq >= commitSeq;
    if (check()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const listener = () => {
        if (
          generation === this.authorityGeneration &&
          this.presentations > 0 &&
          this.model.storeEpoch === storeEpoch &&
          !check()
        )
          return;
        this.authorityListeners.delete(listener);
        resolve(generation === this.authorityGeneration && this.presentations > 0 && check());
      };
      this.authorityListeners.add(listener);
    });
  }

  project(model: DatabaseViewRenderModel, canonicalModel = model) {
    return this.journal.project(
      model,
      { storeEpoch: canonicalModel.storeEpoch, commitSeq: canonicalModel.commitSeq },
      true,
      canonicalModel,
    );
  }

  submit = async (
    request: Parameters<typeof commitDatabaseViewOperations>[0],
    transport: typeof commitDatabaseViewOperations = commitDatabaseViewOperations,
    projection?: ReturnType<typeof compileDatabaseViewOperationProjection>,
  ): ReturnType<typeof commitDatabaseViewOperations> => {
    if (this.presentations === 0) return transport(request);
    for (const row of this.model.query.rows) this.pendingDependencyPageIds.add(row.page.pageId);
    const plan =
      projection ?? compileDatabaseViewOperationProjection(this.model, request.operations);
    const placement = databaseOperationsRequirePlacementFence(request.operations);
    let pendingReadFloor = Infinity;
    const result = await this.journal.run({
      operationIdentity: request.operationId,
      conflictKeys: placement ? [...plan.conflictKeys, "database:placement"] : plan.conflictKeys,
      apply: plan.apply,
      runRemote: () => transport(request),
      getCommitCursor: (receipt) => {
        if (receipt) plan.acknowledge?.(receipt);
        pendingReadFloor = this.readGeneration + 1;
        return receipt && { storeEpoch: receipt.storeEpoch, commitSeq: receipt.commitSeq };
      },
      isCommitMaterialized: (model) =>
        plan.predictable ? plan.apply(model) === model : this.readGeneration >= pendingReadFloor,
      remoteLane: placement ? "database-view:position" : undefined,
      classifyFailure: classifyDatabasePresentationFailure,
      refresh: async (cursor) => {
        if (!cursor) return true;
        await this.refresh?.();
        return await this.waitForAuthority(cursor.storeEpoch, cursor.commitSeq);
      },
    });
    if (!result.ok) throw databasePresentationFailure(result.error, result.outcome);
    if (result.result === null && request.operationId) this.discard(request.operationId);
    return result.result ?? null;
  };
}

export const databaseViewPresentationIdentity = (model: DatabaseViewRenderModel): string =>
  JSON.stringify([
    model.libraryId,
    contentAccessContextKey(model.accessContext),
    model.storeEpoch,
    model.databaseId,
    model.dataSourceId,
    model.databaseViewId,
    model.query.view.config,
  ]);

export function useDatabaseViewPresentation(
  model: DatabaseViewRenderModel,
  refresh: (() => Promise<void> | void) | undefined,
  transport: typeof commitDatabaseViewOperations,
  canonicalModel = model,
  canonicalReadGeneration?: number,
  readIdentity = canonicalModel,
) {
  const identity = databaseViewPresentationIdentity(model);
  const source = useId();
  const owner = useMemo(
    () => new DatabaseViewPresentationStore(model),
    // Each mounted read source owns its render handoff; another host cannot settle it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity],
  );
  const revision = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useLayoutEffect(() => owner.attach(), [owner]);
  useLayoutEffect(() => {
    owner.update(model, refresh, canonicalModel, canonicalReadGeneration, readIdentity);
  }, [owner, model, refresh, canonicalModel, canonicalReadGeneration, readIdentity]);
  const observationScope = useMemo(
    () => ({
      libraryId: model.libraryId,
      accessContext: model.accessContext,
      storeEpoch: model.storeEpoch,
    }),
    [model.libraryId, model.accessContext, model.storeEpoch],
  );
  useLayoutEffect(
    () =>
      registerContentProjectionActivity(observationScope, {
        id: `${identity}:${source}`,
        label: model.viewName,
        getActivity: owner.getActivity,
        subscribe: owner.subscribe,
      }),
    [identity, source, observationScope, model.viewName, owner],
  );
  const projected = useMemo(() => {
    // An external journal change invalidates the memoized projection.
    void revision;
    return owner.project(model, canonicalModel);
  }, [owner, model, canonicalModel, revision]);
  useLayoutEffect(() => {
    if (projected.renderToken !== null) owner.markRendered(projected.renderToken);
  }, [owner, projected.renderToken]);
  return {
    model: projected.model,
    owner,
    submit: (
      request: Parameters<typeof transport>[0],
      projection?: ReturnType<typeof compileDatabaseViewOperationProjection>,
    ) => owner.submit(request, transport, projection),
  };
}
