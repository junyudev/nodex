import { describe, expect, test } from "bun:test";
import { resolveStageSidebarSectionRenderState } from "./left-sidebar-section-state";

function makeSection(itemStates: Array<{ id: string; active?: boolean }>) {
  return {
    id: "cards:status:6-in-progress",
    label: "In Progress",
    collapsible: true,
    items: itemStates.map((item) => ({
      id: item.id,
      label: item.id,
      active: item.active,
      onSelect: () => undefined,
    })),
  };
}

describe("resolveStageSidebarSectionRenderState", () => {
  test("keeps only active rows visible when a section is collapsed", () => {
    const state = resolveStageSidebarSectionRenderState(
      makeSection([
        { id: "card-1" },
        { id: "card-2", active: true },
        { id: "card-3" },
      ]),
      { "cards:status:6-in-progress": false },
      {},
    );

    expect(state.expanded).toBeFalse();
    expect(state.hasOverflow).toBeFalse();
    expect(state.visibleItems.length).toBe(0);
    expect(state.pinnedItems.map((item) => item.id).join(",")).toBe("card-2");
  });

  test("defaults sections to expanded when no persisted state exists", () => {
    const state = resolveStageSidebarSectionRenderState(
      makeSection([
        { id: "card-1" },
        { id: "card-2", active: true },
      ]),
      {},
      {},
    );

    expect(state.expanded).toBeTrue();
    expect(state.visibleItems.map((item) => item.id).join(",")).toBe("card-1,card-2");
    expect(state.pinnedItems.length).toBe(0);
  });

  test("preserves overflow slicing while a section stays expanded", () => {
    const state = resolveStageSidebarSectionRenderState(
      makeSection(Array.from({ length: 12 }, (_, index) => ({ id: `card-${index + 1}` }))),
      {},
      {},
    );

    expect(state.expanded).toBeTrue();
    expect(state.hasOverflow).toBeTrue();
    expect(state.visibleItems.length).toBe(10);
    expect(state.overflowItems.length).toBe(2);
    expect(state.pinnedItems.length).toBe(0);
  });
});
