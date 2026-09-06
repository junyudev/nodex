import { describe, expect, test } from "vite-plus/test";
import type { DatabaseViewMutationReceipt } from "@/lib/database-view-row-mutations";
import type { DatabaseListProjectionRowSnapshot } from "../../../../shared/database-views";
import { databaseListRowsCoverMoveReceipt } from "./database-list-receipt-proof";

const row = (
  pageId: string,
  revision: number,
  parentRevision = 0,
): DatabaseListProjectionRowSnapshot =>
  ({
    kind: "page",
    occurrenceKey: pageId,
    transientKind: "none",
    row: {
      page: { pageId },
      membership: { dataSourceId: "source", membershipId: `opaque:${pageId}` },
      position: { rankKey: "rank", revision },
      values: {
        task_parent: {
          propertyId: "task_parent",
          valueType: "relation",
          value: [],
          revision: parentRevision,
        },
      },
    },
  }) as unknown as DatabaseListProjectionRowSnapshot;

const receipt = (
  committedRevisions: Readonly<Record<string, number>>,
): DatabaseViewMutationReceipt =>
  ({
    operationKinds: ["move_list_occurrences"],
    operationOutcomes: [
      {
        kind: "list_occurrence_move",
        operationIndex: 0,
        moveRootPageIds: ["A"],
        undoRecipe: { viewId: "view", dataSourceId: "source" },
      },
    ],
    committedRevisions,
  }) as unknown as DatabaseViewMutationReceipt;

describe("List exact-resource receipt proof", () => {
  test("accepts original rank evidence when a later sibling appears before the old anchor", () => {
    expect(
      databaseListRowsCoverMoveReceipt({
        viewId: "view",
        rows: [row("A", 2), row("C", 5), row("B", 1)],
        receipt: receipt({ "position:view:A": 2 }),
      }),
    ).toBe(true);
  });

  test("accepts newer root ranks and exact Parent edge rank revisions", () => {
    expect(
      databaseListRowsCoverMoveReceipt({
        viewId: "view",
        rows: [row("A", 3)],
        receipt: receipt({ "position:view:A": 2 }),
      }),
    ).toBe(true);
    expect(
      databaseListRowsCoverMoveReceipt({
        viewId: "view",
        rows: [row("A", 0, 4)],
        receipt: receipt({ "value:source:opaque:A:task_parent": 4 }),
      }),
    ).toBe(true);
  });

  test.each<{
    name: string;
    rows: DatabaseListProjectionRowSnapshot[];
    revisions: Readonly<Record<string, number>>;
  }>([
    {
      name: "a stale moved rank",
      rows: [row("A", 1), row("C", 99)],
      revisions: { "position:view:A": 2 },
    },
    { name: "missing moved root", rows: [row("C", 99)], revisions: { "position:view:A": 2 } },
    {
      name: "a different membership",
      rows: [row("A", 2, 9)],
      revisions: { "value:source:previous-membership:task_parent": 2 },
    },
    {
      name: "an incomplete atomic property adoption",
      rows: [row("A", 2)],
      revisions: { "position:view:A": 2, "value:source:opaque:A:status": 2 },
    },
    {
      name: "a stale Parent edge",
      rows: [row("A", 99, 1)],
      revisions: { "value:source:opaque:A:task_parent": 2 },
    },
    { name: "another View's rank", rows: [row("A", 99)], revisions: { "position:other:A": 2 } },
    {
      name: "only unrelated metadata evidence",
      rows: [row("A", 99)],
      revisions: { "page:A:metadata": 2 },
    },
    { name: "no semantic evidence", rows: [row("A", 99)], revisions: {} },
  ])("rejects $name", ({ rows, revisions }) => {
    expect(
      databaseListRowsCoverMoveReceipt({ viewId: "view", rows, receipt: receipt(revisions) }),
    ).toBe(false);
  });

  test("requires complete concrete root evidence rather than transient context", () => {
    const concrete = row("A", 2);
    if (concrete.kind !== "page") throw new Error("Expected Page fixture");
    expect(
      databaseListRowsCoverMoveReceipt({
        viewId: "view",
        rows: [{ ...concrete, transientKind: "ancestor" }],
        receipt: receipt({ "position:view:A": 2 }),
      }),
    ).toBe(false);
  });

  test("rejects another authoritative View with coincidentally equal rank revisions", () => {
    expect(
      databaseListRowsCoverMoveReceipt({
        viewId: "other",
        rows: [row("A", 2)],
        receipt: receipt({ "position:view:A": 2 }),
      }),
    ).toBe(false);
  });
});
