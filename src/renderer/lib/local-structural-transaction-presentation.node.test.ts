import { describe, expect, test } from "vite-plus/test";

import { LocalStructuralTransactionPresentationStore } from "./local-structural-transaction-presentation";

describe("local structural transaction presentation", () => {
  test("a newer Page move permanently supersedes an older promotion presentation", () => {
    const store = new LocalStructuralTransactionPresentationStore();
    store.begin("promotion", "epoch");
    expect(store.claimPageIds("promotion", "epoch", ["page"])).toBe(true);
    expect(store.ownsPage("promotion", "epoch", "page")).toBe(true);

    store.beginDatabasePageMove({
      operationId: "move-away",
      projectId: "project",
      storeEpoch: "epoch",
      dataSourceId: "source",
      pageIds: ["page"],
    });

    expect(store.ownsPage("promotion", "epoch", "page")).toBe(false);
    expect(store.ownsPage("move-away", "epoch", "page")).toBe(true);
    store.reject("move-away");
    expect(store.claimPageIds("promotion", "epoch", ["page"])).toBe(false);
  });

  test("keeps the source Page hidden until both projections prove the committed move", () => {
    const store = new LocalStructuralTransactionPresentationStore();
    const scope = { projectId: "project", storeEpoch: "epoch", dataSourceId: "source" };
    store.beginDatabasePageMove({
      operationId: "move",
      ...scope,
      pageIds: ["page"],
    });
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set(["page"]));

    store.acknowledge({
      operationId: "move",
      storeEpoch: "epoch",
      commitSeq: 10,
      resultPageIds: ["page"],
    });
    store.markTargetMaterialized("move");
    store.observeDatabaseProjection({ ...scope, commitSeq: 9, pageIds: new Set() });
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set(["page"]));
    store.observeDatabaseProjection({ ...scope, commitSeq: 10, pageIds: new Set(["page"]) });
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set(["page"]));

    store.observeDatabaseProjection({ ...scope, commitSeq: 10, pageIds: new Set() });
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set());
  });

  test("deterministic rejection removes the predicted source projection", () => {
    const store = new LocalStructuralTransactionPresentationStore();
    const scope = { projectId: "project", storeEpoch: "epoch", dataSourceId: "source" };
    store.beginDatabasePageMove({ operationId: "move", ...scope, pageIds: ["page"] });
    store.reject("move");
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set());
  });

  test("replaces planned Page claims atomically without exposing an ownership gap", () => {
    const store = new LocalStructuralTransactionPresentationStore();
    store.begin("promotion", "epoch");
    expect(store.claimPageIds("promotion", "epoch", ["planned"])).toBe(true);

    const ownershipSnapshots: boolean[] = [];
    const release = store.subscribe(() => {
      ownershipSnapshots.push(
        store.ownsPage("promotion", "epoch", "planned") ||
          store.ownsPage("promotion", "epoch", "committed"),
      );
    });

    expect(
      store.replacePageClaims({
        operationId: "promotion",
        storeEpoch: "epoch",
        previousPageIds: ["planned"],
        nextPageIds: ["planned"],
      }),
    ).toBe(true);
    expect(ownershipSnapshots).toEqual([]);

    expect(
      store.replacePageClaims({
        operationId: "promotion",
        storeEpoch: "epoch",
        previousPageIds: ["planned"],
        nextPageIds: ["committed"],
      }),
    ).toBe(true);
    expect(ownershipSnapshots).toEqual([true]);
    expect(store.ownsPage("promotion", "epoch", "planned")).toBe(false);
    expect(store.ownsPage("promotion", "epoch", "committed")).toBe(true);
    release();
  });
});
