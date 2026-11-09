import { describe, expect, test } from "vite-plus/test";
import {
  buildPanelGroupBodyDropData,
  buildPanelTabDragData,
  canPanelGroupAcceptTabDrag,
  resolvePanelGroupBodyDropZone,
  resolvePanelGroupBodyDropZoneForSource,
  resolvePanelTabDropCommit,
  resolvePanelTabRowInsertion,
  resolveSameLeafInsertionIndex,
} from "./panel-tab-dnd";

describe("panel tab drag and drop helpers", () => {
  test("resolves tab row insertion before and after tab midpoints", () => {
    const beforeSecond = resolvePanelTabRowInsertion({
      pointerClientX: 149,
      rowLeft: 100,
      rowScrollLeft: 0,
      tabRects: [
        { id: "one", left: 100, right: 140 },
        { id: "two", left: 150, right: 210 },
      ],
    });
    const afterSecond = resolvePanelTabRowInsertion({
      pointerClientX: 190,
      rowLeft: 100,
      rowScrollLeft: 0,
      tabRects: [
        { id: "one", left: 100, right: 140 },
        { id: "two", left: 150, right: 210 },
      ],
    });

    expect(beforeSecond.targetIndex).toBe(1);
    expect(beforeSecond.markerLeft).toBe(50);
    expect(afterSecond.targetIndex).toBe(2);
    expect(afterSecond.markerLeft).toBe(110);
  });

  test("appends after the final tab and supports an empty row", () => {
    const append = resolvePanelTabRowInsertion({
      pointerClientX: 260,
      rowLeft: 100,
      rowScrollLeft: 12,
      tabRects: [{ id: "one", left: 100, right: 140 }],
    });
    const empty = resolvePanelTabRowInsertion({
      pointerClientX: 260,
      rowLeft: 100,
      rowScrollLeft: 12,
      tabRects: [],
    });

    expect(append.targetIndex).toBe(1);
    expect(append.markerLeft).toBe(52);
    expect(empty.targetIndex).toBe(0);
    expect(empty.markerLeft).toBe(16);
  });

  test("normalizes same-leaf insertion after removing the dragged tab", () => {
    expect(
      resolveSameLeafInsertionIndex({
        tabIds: ["one", "two", "three"],
        sourceTabId: "one",
        targetIndex: 3,
      }),
    ).toBe(2);
    expect(
      resolveSameLeafInsertionIndex({
        tabIds: ["one", "two", "three"],
        sourceTabId: "three",
        targetIndex: 0,
      }),
    ).toBe(0);
    expect(
      resolveSameLeafInsertionIndex({
        tabIds: ["one", "two", "three"],
        sourceTabId: "two",
        targetIndex: 1,
      }),
    ).toBe(null);
    expect(
      resolveSameLeafInsertionIndex({
        tabIds: ["one", "two", "three"],
        sourceTabId: "two",
        targetIndex: 2,
      }),
    ).toBe(null);
  });

  test("uses VSCode-style ten percent body edge zones", () => {
    const rect = { left: 100, top: 50, width: 300, height: 200 };

    expect(resolvePanelGroupBodyDropZone({ pointerClientX: 120, pointerClientY: 130, rect })).toBe(
      "left",
    );
    expect(resolvePanelGroupBodyDropZone({ pointerClientX: 380, pointerClientY: 130, rect })).toBe(
      "right",
    );
    expect(resolvePanelGroupBodyDropZone({ pointerClientX: 250, pointerClientY: 65, rect })).toBe(
      "up",
    );
    expect(resolvePanelGroupBodyDropZone({ pointerClientX: 250, pointerClientY: 235, rect })).toBe(
      "down",
    );
    expect(resolvePanelGroupBodyDropZone({ pointerClientX: 250, pointerClientY: 130, rect })).toBe(
      "center",
    );
  });

  test("classifies tab-row drops as reorder or move and body edges as split", () => {
    const source = buildPanelTabDragData({
      sessionId: "session-1",
      panelId: "right",
      leafId: "leaf-a",
      tabId: "tab-1",
      placement: ["right", "bottom"],
    });
    const reorder = resolvePanelTabDropCommit(source, {
      kind: "tab-row",
      panelId: "right",
      leafId: "leaf-a",
      targetIndex: 2,
      markerLeft: 120,
    });
    const move = resolvePanelTabDropCommit(source, {
      kind: "tab-row",
      panelId: "right",
      leafId: "leaf-b",
      targetIndex: 0,
      markerLeft: 4,
    });
    const split = resolvePanelTabDropCommit(source, {
      kind: "body",
      panelId: "bottom",
      leafId: "leaf-c",
      zone: "right",
    });
    const sameBody = resolvePanelTabDropCommit(source, {
      kind: "body",
      panelId: "right",
      leafId: "leaf-a",
      zone: "center",
    });

    if (reorder?.kind !== "reorder") throw new Error("Expected reorder commit");
    if (move?.kind !== "move") throw new Error("Expected move commit");
    if (split?.kind !== "split") throw new Error("Expected split commit");
    expect(reorder.targetIndex).toBe(2);
    expect(move.targetLeafId).toBe("leaf-b");
    expect(split.side).toBe("right");
    expect(sameBody).toBe(null);
  });

  test("offers a dragged tab only to groups in the panels its placement allows", () => {
    const sideChat = buildPanelTabDragData({
      sessionId: "session-1",
      panelId: "right",
      leafId: "leaf-a",
      tabId: "sidechat-session:child",
      placement: ["right", "bottom"],
    });
    const plan = buildPanelTabDragData({
      sessionId: "session-1",
      panelId: "right",
      leafId: "leaf-a",
      tabId: "plan",
      placement: ["right"],
    });

    expect(
      canPanelGroupAcceptTabDrag(sideChat, { sessionId: "session-1", panelId: "bottom" }),
    ).toBe(true);
    expect(canPanelGroupAcceptTabDrag(plan, { sessionId: "session-1", panelId: "right" })).toBe(
      true,
    );
    expect(canPanelGroupAcceptTabDrag(plan, { sessionId: "session-1", panelId: "bottom" })).toBe(
      false,
    );
    expect(canPanelGroupAcceptTabDrag(sideChat, { sessionId: "session-2", panelId: "right" })).toBe(
      false,
    );
    expect(
      canPanelGroupAcceptTabDrag(
        { ...sideChat, placement: "right" },
        { sessionId: "session-1", panelId: "right" },
      ),
    ).toBe(false);
  });

  test("splits a tab's own group only away from the tabs it leaves behind", () => {
    const source = buildPanelTabDragData({
      sessionId: "session-1",
      panelId: "right",
      leafId: "leaf-a",
      tabId: "tab-1",
      placement: ["right", "bottom"],
    });
    const group = (leafId: string, tabCount: number) =>
      buildPanelGroupBodyDropData({ sessionId: "session-1", panelId: "right", leafId, tabCount });

    expect(
      resolvePanelGroupBodyDropZoneForSource({ source, target: group("leaf-a", 2), zone: "right" }),
    ).toBe("right");
    expect(
      resolvePanelGroupBodyDropZoneForSource({
        source,
        target: group("leaf-a", 2),
        zone: "center",
      }),
    ).toBe(null);
    expect(
      resolvePanelGroupBodyDropZoneForSource({ source, target: group("leaf-a", 1), zone: "down" }),
    ).toBe(null);
    expect(
      resolvePanelGroupBodyDropZoneForSource({
        source,
        target: group("leaf-b", 1),
        zone: "center",
      }),
    ).toBe("center");
  });
});
