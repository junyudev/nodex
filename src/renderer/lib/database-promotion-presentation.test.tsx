import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../shared/database-identities";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import type { DatabaseViewRenderModel } from "./database-view-render-model";
import { databasePromotionReadIdentity } from "./database-promotion-read-evidence";
import {
  useDatabasePromotionPresentation,
  type DatabasePromotionAdmission,
} from "./database-promotion-presentation";
import { localStructuralTransactionPresentation } from "./local-structural-transaction-presentation";

const databaseId = parseDatabaseId("database");
const dataSourceId = parseDataSourceId("source");
const databaseViewId = parseDatabaseViewId("view");
const config = upgradeDatabaseViewConfigV2({
  schemaKey: "nodex.database-view",
  schemaVersion: 2,
  filter: { kind: "group", operator: "and", children: [] },
  sort: [],
  group: null,
  display: { propertyIds: [], showTitle: true },
});
const effective = {
  layout: "board" as const,
  rules: config.rules,
  presentation: config.presentation,
};

/** Only promotion-owner identity/evidence fields are relevant to this hook regression. */
const model = (windowKey: string): DatabaseViewRenderModel => {
  const base = {
    libraryId: "library",
    accessContext: { kind: "project" as const, projectId: "project" },
    databaseId,
    dataSourceId,
    databaseViewId,
    databaseName: "Database",
    dataSourceName: "Source",
    viewName: "Board",
    storeEpoch: "epoch",
    commitSeq: 10,
    authorization: null,
    readOnlyReason: null,
    columns: [],
    query: {
      view: { config },
    },
  } as unknown as Omit<DatabaseViewRenderModel, "boundedRead">;
  return {
    ...base,
    boundedRead: {
      identity: databasePromotionReadIdentity(base, effective),
      windowKey,
      storeEpoch: "epoch",
      scopeKey: "scope",
      commitSeq: 10,
      pageIds: [],
    },
  };
};

describe("useDatabasePromotionPresentation", () => {
  test("keeps an admitted prediction owned while the bounded window reshapes", () => {
    const hook = renderHook(
      ({ current }) =>
        useDatabasePromotionPresentation({
          model: current,
          effective,
          evidence: current.boundedRead ?? null,
          pageIds: new Set(),
          canonicalPageIds: new Set(),
          displayIdentity: "board:",
        }),
      { initialProps: { current: model("first-window") } },
    );
    const operationId = "window-handoff";
    const admission: DatabasePromotionAdmission = {
      operationId,
      storeEpoch: "epoch",
      rootBlockIds: ["source-block"],
      previews: [{ rootBlockId: "source-block", title: "Moved Page" }],
      mode: "move",
      placement: {
        kind: "direct",
        viewId: "view",
        groupKey: null,
        preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
      },
      refresh: vi.fn(),
      observe: (listener) => {
        listener({ status: "preparing" });
        return () => {};
      },
    };

    act(() => hook.result.current.owner.accept(admission));
    const owner = hook.result.current.owner;
    expect(hook.result.current.slots).toHaveLength(1);

    hook.rerender({ current: model("through:next-window") });

    expect(hook.result.current.owner).toBe(owner);
    expect(hook.result.current.slots).toHaveLength(1);

    hook.unmount();
    localStructuralTransactionPresentation.reject(operationId);
  });
});
