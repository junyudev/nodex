import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { useCanonicalOrderHandoff } from "./use-canonical-order-handoff";

test("keeps an acknowledged order until canonical input changes and drops obsolete overlays", async () => {
  const reportError = vi.fn();
  const { result, rerender } = renderHook(
    ({ canonicalIds }) => useCanonicalOrderHandoff({ canonicalIds, reportError }),
    { initialProps: { canonicalIds: ["a", "b"] } },
  );
  await act(async () => result.current.submit(["b", "a"], () => Promise.resolve()));
  expect(result.current.displayedIds).toEqual(["b", "a"]);
  rerender({ canonicalIds: ["a", "b"] });
  expect(result.current.displayedIds).toEqual(["b", "a"]);
  rerender({ canonicalIds: ["b", "a"] });
  rerender({ canonicalIds: ["a", "b"] });
  expect(result.current.displayedIds).toEqual(["a", "b"]);
  expect(reportError).not.toHaveBeenCalled();
});
