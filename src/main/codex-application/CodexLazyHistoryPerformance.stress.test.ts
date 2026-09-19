import { expect, test } from "vite-plus/test";
import { listCanonicalHistoryTurns } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { makeCanonicalHistoryPressureFixture } from "../../shared/codex-conversation-state/test-fixtures/canonical-history-pressure";

test("native cold history and one older page stay bounded as logical history grows", async () => {
  for (const count of [10, 10_000, 1_000_000]) {
    const f = makeCanonicalHistoryPressureFixture(count, 100);
    const cold = await listCanonicalHistoryTurns(f.client, "thread", { limit: 5 });
    expect(cold.response.data).toHaveLength(5);
    expect(cold.response.data.reduce((sum, turn) => sum + turn.items.length, 0)).toBe(500);
    expect(f.calls).toHaveLength(6);
    const older = await listCanonicalHistoryTurns(f.client, "thread", {
      cursor: cold.response.nextCursor,
      limit: 5,
    });
    expect(older.response.data).toHaveLength(5);
    expect(f.calls).toHaveLength(12);
    expect(
      new Set([...cold.response.data, ...older.response.data].map((turn) => turn.id)).size,
    ).toBe(10);
    expect(older.response.nextCursor === null).toBe(count === 10);
  }
});

test("native paginated history consumes a shared 500-item budget at giant Turn boundaries", async () => {
  for (const count of [5, 500, 5000]) {
    const f = makeCanonicalHistoryPressureFixture(1, count);
    const result = await listCanonicalHistoryTurns(f.client, "thread");
    expect(result.response.data[0]?.items).toHaveLength(Math.min(count, 500));
    expect(result.itemsPaginationByTurnId["0"]?.hasLoadedOldest).toBe(count <= 500);
    expect(result.itemsPaginationByTurnId["0"]?.olderCursor).toBe(count > 500 ? "4500" : null);
    const descending = f.calls.filter(
      ({ method, params }) => method === "thread/items/list" && params.sortDirection === "desc",
    );
    expect(descending).toHaveLength(Math.ceil(Math.min(count, 500) / 100));
  }
});
