import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { useSettingsListNavigation } from "./use-settings-list-navigation";

test("clears an unavailable selection and does not restore it when a list reopens", async () => {
  const { result, rerender } = renderHook(
    ({ items, isActive }) =>
      useSettingsListNavigation({
        items,
        isActive,
        initialHighlightedIndex: 1,
        onSelect: vi.fn(),
      }),
    { initialProps: { items: ["a", "b"], isActive: true } },
  );
  expect(result.current.highlightedIndex).toBe(1);
  rerender({ items: ["a"], isActive: true });
  expect(result.current.highlightedIndex).toBe(-1);
  await act(async () => result.current.setHighlightedIndex(0));
  rerender({ items: ["a"], isActive: false });
  rerender({ items: ["a"], isActive: true });
  expect(result.current.highlightedIndex).toBe(-1);
});
