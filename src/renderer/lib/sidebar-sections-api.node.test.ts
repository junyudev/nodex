import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { BuiltinSidebarOrderWindow } from "../../shared/sidebar-sections";
import { readSidebarPinnedSessionOrder } from "./sidebar-sections-api";

const query = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<BuiltinSidebarOrderWindow>>());
vi.mock("./renderer-command", () => ({ invokeRendererQuery: query }));

const window = (
  sessionIds: string[],
  nextCursor: string | null,
  orderRevision = "pins:3",
): BuiltinSidebarOrderWindow => ({
  orderRevision,
  items: sessionIds.map((sessionId) => ({ kind: "session", sessionId, title: sessionId })),
  nextCursor,
  hasMore: nextCursor !== null,
  projectionRevision: 3,
});

beforeEach(() => query.mockReset());

describe("canonical Pinned Session order", () => {
  test("collects the complete Session order and its revision across windows", async () => {
    query.mockResolvedValueOnce(window(["draft", "acp"], "after-acp"));
    query.mockResolvedValueOnce(window(["native", "runtime"], null));
    expect(await readSidebarPinnedSessionOrder()).toEqual({
      orderRevision: "pins:3",
      sessionIds: ["draft", "acp", "native", "runtime"],
    });
    expect(query).toHaveBeenLastCalledWith("sidebar:builtin-order:list", "pinned_sessions", {
      after: "after-acp",
      first: 200,
    });
  });

  test("rejects concurrent reordering instead of combining incompatible windows", async () => {
    query.mockResolvedValueOnce(window(["draft", "acp"], "after-acp"));
    query.mockResolvedValueOnce(window(["native"], null, "pins:4"));
    await expect(readSidebarPinnedSessionOrder()).rejects.toThrow("Pinned chat order changed");
  });
});
