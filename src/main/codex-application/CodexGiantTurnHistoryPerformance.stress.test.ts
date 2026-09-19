import { expect, test } from "vite-plus/test";
import { listCanonicalHistoryTurns } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { makeCanonicalHistoryPressureFixture } from "../../shared/codex-conversation-state/test-fixtures/canonical-history-pressure";

test("native history retains whole giant items without invented byte clipping or item splitting", async () => {
  const bytes = 2 * 1024 * 1024;
  const f = makeCanonicalHistoryPressureFixture(1, 1, bytes);
  const page = await listCanonicalHistoryTurns(f.client, "thread");
  const item = page.response.data[0]?.items[0];
  expect(item?.type).toBe("plan");
  if (item?.type !== "plan") throw new Error("Expected plan item");
  expect(item.text.length).toBe(bytes);
  expect(item.text).toBe("x".repeat(bytes));
  expect(page.response.data[0]?.items).toHaveLength(1);
  expect(f.calls).toHaveLength(2);
  expect(page.itemsPaginationByTurnId["0"]?.hasLoadedOldest).toBe(true);
});
