import { describe, expect, test, vi } from "vite-plus/test";
import {
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
        viewportRows: [
          { kind: "content", turnId: "turn", turnIndex: 0, status: "inProgress", turnItemIds },
        ],
      });
      expect(boundary?.firstProtectedItemId).toBe(count < 500 ? null : String(count - 500));
    },
  );
  test("a second viewer null veto persists until that viewer is actually removed", () => {
    const changed = vi.fn();
    const viewports = new CodexHistoryViewportRegistry(changed);
    const first = Symbol();
    const second = Symbol();
    const boundary = { oldestProtectedTurnId: "turn", firstProtectedItemId: "item" };
    expect(viewports.set(first, boundary)).toBe(true);
    expect(viewports.set(first, { ...boundary })).toBe(false);
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
      viewportRows: [live],
    };
    expect(projectCodexHistoryViewportBoundary(input)).toEqual({
      oldestProtectedTurnId: "live",
      firstProtectedItemId: "1000",
    });
    expect(projectCodexHistoryViewportBoundary({ ...input, distanceFromBottom: 24.1 })).toBeNull();
    expect(
      projectCodexHistoryViewportBoundary({ ...input, hasPendingScrollTarget: true }),
    ).toBeNull();
    expect(
      projectCodexHistoryViewportBoundary({
        ...input,
        retainedRows: [{ ...live, turnId: "retained", status: "completed", turnIndex: 1 }],
      }),
    ).toEqual({ oldestProtectedTurnId: "retained", firstProtectedItemId: null });
    // A visible gap means older history is being read, so nothing beneath it may be released.
    expect(
      projectCodexHistoryViewportBoundary({
        ...input,
        viewportRows: [{ kind: "gap", turnIndex: 1 }, live],
      }),
    ).toBeNull();
    // A gap inside the Turn below stays on screen whenever that Turn folds its work.
    expect(
      projectCodexHistoryViewportBoundary({
        ...input,
        viewportRows: [{ kind: "gap", turnIndex: 1, insideTurn: true }, live],
      }),
    ).toEqual({ oldestProtectedTurnId: "live", firstProtectedItemId: "1000" });
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
    ).toEqual({ oldestProtectedTurnId: "live", firstProtectedItemId: null });
  });
});
