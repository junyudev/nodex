import { describe, expect, test } from "bun:test";
import {
  clampStagePanelWidth,
  resolveResizedPanelWidth,
  resolveResizedPanelPair,
  STAGE_PANEL_RESIZE_LEFT_EDGE,
  STAGE_PANEL_RESIZE_RIGHT_EDGE,
} from "./stage-panel-resize";

describe("clampStagePanelWidth", () => {
  test("clamps values to configured bounds", () => {
    expect(clampStagePanelWidth(220, 280, 1400)).toBe(280);
    expect(clampStagePanelWidth(900, 280, 1400)).toBe(900);
    expect(clampStagePanelWidth(1800, 280, 1400)).toBe(1400);
  });

  test("falls back when width is invalid", () => {
    expect(clampStagePanelWidth(Number.NaN, 280, 1400)).toBe(280);
  });
});

describe("resolveResizedPanelPair", () => {
  test("moves width from right panel to left panel", () => {
    const result = resolveResizedPanelPair({
      leftStartWidth: 500,
      rightStartWidth: 500,
      deltaPx: 120,
      minPanelWidth: 280,
      maxPanelWidth: 1400,
    });

    expect(result.leftWidth).toBe(620);
    expect(result.rightWidth).toBe(380);
  });

  test("enforces left panel minimum width", () => {
    const result = resolveResizedPanelPair({
      leftStartWidth: 420,
      rightStartWidth: 620,
      deltaPx: -600,
      minPanelWidth: 280,
      maxPanelWidth: 1400,
    });

    expect(result.leftWidth).toBe(280);
    expect(result.rightWidth).toBe(760);
  });

  test("enforces right panel minimum width", () => {
    const result = resolveResizedPanelPair({
      leftStartWidth: 620,
      rightStartWidth: 420,
      deltaPx: 600,
      minPanelWidth: 280,
      maxPanelWidth: 1400,
    });

    expect(result.leftWidth).toBe(760);
    expect(result.rightWidth).toBe(280);
  });

  test("enforces maximum width on either side", () => {
    const result = resolveResizedPanelPair({
      leftStartWidth: 1000,
      rightStartWidth: 700,
      deltaPx: 400,
      minPanelWidth: 280,
      maxPanelWidth: 1200,
    });

    expect(result.leftWidth).toBe(1200);
    expect(result.rightWidth).toBe(500);
  });
});

describe("resolveResizedPanelWidth", () => {
  test("grows panel width when dragging the right border to the right", () => {
    const result = resolveResizedPanelWidth({
      startWidth: 500,
      deltaPx: 100,
      edge: STAGE_PANEL_RESIZE_RIGHT_EDGE,
      minPanelWidth: 280,
      maxPanelWidth: 1400,
    });

    expect(result).toBe(600);
  });

  test("shrinks panel width when dragging the left border to the right", () => {
    const result = resolveResizedPanelWidth({
      startWidth: 500,
      deltaPx: 100,
      edge: STAGE_PANEL_RESIZE_LEFT_EDGE,
      minPanelWidth: 280,
      maxPanelWidth: 1400,
    });

    expect(result).toBe(400);
  });

  test("clamps independent panel width to min/max bounds", () => {
    const min = resolveResizedPanelWidth({
      startWidth: 320,
      deltaPx: 200,
      edge: STAGE_PANEL_RESIZE_LEFT_EDGE,
      minPanelWidth: 280,
      maxPanelWidth: 1400,
    });
    const max = resolveResizedPanelWidth({
      startWidth: 1350,
      deltaPx: 300,
      edge: STAGE_PANEL_RESIZE_RIGHT_EDGE,
      minPanelWidth: 280,
      maxPanelWidth: 1400,
    });

    expect(min).toBe(280);
    expect(max).toBe(1400);
  });
});
