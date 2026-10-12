import { describe, expect, test, vi } from "vite-plus/test";
import {
  CodexHistoryPolicy,
  CodexHistoryViewportRegistry,
  projectCodexHistoryViewportBoundary,
} from "./codex-history-policy";

describe("history experiment and viewport ownership", () => {
  test.each([0, 1, 499, 500, 501])(
    "live protected item at %i entries matches the exact negative-index boundary",
    (count) => {
      const turnItemIds = Array.from({ length: count }, (_, index) => String(index));
      const boundary = projectCodexHistoryViewportBoundary({
        distanceFromBottom: 0,
        hasPendingScrollTarget: false,
        viewportRows: [{ kind: "content", turnId: "turn", status: "inProgress", turnItemIds }],
      });
      expect(boundary?.firstProtectedItemId).toBe(count < 500 ? null : String(count - 500));
    },
  );
  test.each([false, true])("captures the first assigned eviction result %s", (assigned) => {
    let value: boolean | null | undefined;
    const read = vi.fn(() => value);
    const policy = new CodexHistoryPolicy({
      source: "development-features",
      scope: "host:local",
      readThreadTimelineEnabled: () => value,
      readActiveHistoryEvictionEnabled: read,
    });
    expect(policy.readActiveHistoryEvictionEnabled()).toBeUndefined();
    value = null;
    expect(policy.readActiveHistoryEvictionEnabled()).toBeUndefined();
    value = assigned;
    expect(policy.readActiveHistoryEvictionEnabled()).toBe(assigned);
    value = !assigned;
    expect(policy.readActiveHistoryEvictionEnabled()).toBe(assigned);
    expect(read).toHaveBeenCalledTimes(3);
    expect(policy.readThreadTimelineEnabled()).toBe(!assigned);
  });

  test("a second viewer null veto persists until that viewer is actually removed", () => {
    const changed = vi.fn();
    const viewports = new CodexHistoryViewportRegistry(changed);
    const first = Symbol();
    const second = Symbol();
    const boundary = { oldestRenderedTurnId: "turn", firstProtectedItemId: "item" };
    viewports.set(first, boundary);
    viewports.set(first, { ...boundary });
    viewports.set(second, null);
    expect(viewports.getBoundaries()).toEqual([boundary, null]);
    viewports.set(second, undefined);
    expect(viewports.getBoundaries()).toEqual([boundary]);
    viewports.set(second, [null, boundary]);
    expect(viewports.getBoundaries()).toEqual([boundary, null, boundary]);
    viewports.clear();
    expect(viewports.getBoundaries()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(5);
  });

  test("only the real bottom viewport protects the last 500 items in its first live row", () => {
    const live = {
      kind: "content" as const,
      turnId: "live",
      status: "inProgress" as const,
      turnItemIds: Array.from({ length: 1500 }, (_, index) => String(index)),
      turnIndex: 2,
    };
    const input = {
      distanceFromBottom: 24,
      hasPendingScrollTarget: false,
      viewportRows: [{ kind: "gap" as const }, live],
    };
    expect(projectCodexHistoryViewportBoundary(input)).toEqual({
      oldestRenderedTurnId: "live",
      firstProtectedItemId: "1000",
    });
    expect(projectCodexHistoryViewportBoundary({ ...input, distanceFromBottom: 24.1 })).toBeNull();
    expect(
      projectCodexHistoryViewportBoundary({ ...input, hasPendingScrollTarget: true }),
    ).toBeNull();
    expect(
      projectCodexHistoryViewportBoundary({
        ...input,
        retainedRow: { ...live, turnId: "retained", status: "completed", turnIndex: 1 },
      }),
    ).toEqual({ oldestRenderedTurnId: "retained", firstProtectedItemId: null });
    expect(
      projectCodexHistoryViewportBoundary({ ...input, viewportRows: [{ ...live, turnId: null }] }),
    ).toBeNull();
    expect(
      projectCodexHistoryViewportBoundary({
        ...input,
        viewportRows: [live, { ...live, turnId: null, turnIndex: 3 }],
      }),
    ).toBeNull();
    expect(
      projectCodexHistoryViewportBoundary({
        ...input,
        viewportRows: [{ ...live, turnItemIds: ["short"] }],
      }),
    ).toEqual({ oldestRenderedTurnId: "live", firstProtectedItemId: null });
  });
});
