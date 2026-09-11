import {
  stableStringifyDatabaseJson,
  type EffectiveDatabaseView,
} from "../../shared/database-kernel";
import type { DatabaseViewRenderModel } from "./database-view-render-model";

/** A complete bounded query response, not a RowsById cache or stream cursor. */
export interface DatabasePromotionReadEvidence {
  readonly identity: string;
  readonly windowKey: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly scopeKey: string;
  readonly pageIds: readonly string[];
}

export const databasePromotionReadIdentity = (
  model: DatabaseViewRenderModel,
  effective: Pick<EffectiveDatabaseView, "rules" | "presentation"> = model.query.view.config,
): string =>
  stableStringifyDatabaseJson({
    libraryId: model.libraryId,
    accessContext: model.accessContext,
    storeEpoch: model.storeEpoch,
    databaseId: model.databaseId,
    dataSourceId: model.dataSourceId,
    viewId: model.databaseViewId,
    rules: effective.rules,
    presentation: effective.presentation,
  });
