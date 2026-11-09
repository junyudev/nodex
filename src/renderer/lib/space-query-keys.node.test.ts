import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vite-plus/test";

afterEach(() => vi.resetModules());
test("each renderer retains its own cache keys even when both Spaces reuse resource IDs", async () => {
  vi.resetModules();
  const a = await import("./renderer-space");
  a.bindRendererSpace({
    spaceId: "space-a",
    memberId: "alice",
    kind: "team",
    name: "A",
    availability: "ready",
  });
  const keysA = (await import("./query-keys")).queryKeys;
  const filesA = keysA.library.pageFiles({ kind: "library" }, "same-page");
  vi.resetModules();
  const b = await import("./renderer-space");
  b.bindRendererSpace({
    spaceId: "space-b",
    memberId: "alice",
    kind: "team",
    name: "B",
    availability: "ready",
  });
  const keysB = (await import("./query-keys")).queryKeys;
  const filesB = keysB.library.pageFiles({ kind: "library" }, "same-page");
  const client = new QueryClient();
  client.setQueryData(filesA, "A");
  client.setQueryData(filesB, "B");
  expect(client.getQueryData(filesA)).toBe("A");
  expect(client.getQueryData(filesB)).toBe("B");
  expect(keysA.library.pageFiles({ kind: "library" }, "same-page")).toEqual(filesA);
  await client.invalidateQueries({
    queryKey: keysA.library.pageFiles({ kind: "library" }, "same-page"),
  });
  expect(client.getQueryState(filesA)?.isInvalidated).toBe(true);
  expect(client.getQueryState(filesB)?.isInvalidated).toBe(false);
  const automationsA = [keysA.automations.list(), keysA.automations.decisions("same-automation")];
  const automationsB = [keysB.automations.list(), keysB.automations.decisions("same-automation")];
  const runsA = keysA.automationRuns.inbox(20);
  const runsB = keysB.automationRuns.inbox(20);
  for (const key of [...automationsA, ...automationsB, runsA, runsB]) client.setQueryData(key, []);
  await client.invalidateQueries({ queryKey: keysA.automations.all() });
  for (const key of automationsA) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  for (const key of [...automationsB, runsA, runsB])
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  await client.invalidateQueries({ queryKey: keysA.automationRuns.all() });
  expect(client.getQueryState(runsA)?.isInvalidated).toBe(true);
  expect(client.getQueryState(runsB)?.isInvalidated).toBe(false);
  const sourcesA = keysA.sources.automationOptions();
  const sourcesB = keysB.sources.automationOptions();
  client.setQueryData(sourcesA, [{ id: "same-source", label: "A" }]);
  client.setQueryData(sourcesB, [{ id: "same-source", label: "B" }]);
  await client.invalidateQueries({ queryKey: keysA.sources.all() });
  expect(client.getQueryState(sourcesA)?.isInvalidated).toBe(true);
  expect(client.getQueryState(sourcesB)?.isInvalidated).toBe(false);
  expect(client.getQueryData(sourcesB)).toEqual([{ id: "same-source", label: "B" }]);
  expect(() => a.bindRendererSpace(b.rendererSpace())).toThrow("cannot change");
});
