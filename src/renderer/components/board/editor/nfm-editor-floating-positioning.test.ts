import {
  computePosition,
  type Middleware,
  type Placement,
  type Platform,
  type Rect,
} from "@floating-ui/react";
import { describe, expect, test } from "vite-plus/test";
import { createNfmEditorFloatingMiddleware } from "./nfm-blocknote-floating-ui";
import { NFM_TEXT_ACTION_MENU_FLOATING_OPTIONS } from "./nfm-text-action-menu-floating";

const VIEWPORT = { x: 0, y: 0, width: 800, height: 600 };
const SURFACE = { width: 224, height: 282 };
const VIEWPORT_MARGIN = 8;

async function positionSurface(reference: Rect, placement: Placement, middleware: Middleware[]) {
  const floatingElement = {} as HTMLElement;
  const platform: Platform = {
    getElementRects: () => ({ reference, floating: { x: 0, y: 0, ...SURFACE } }),
    getClippingRect: () => VIEWPORT,
    getDimensions: () => SURFACE,
    getOffsetParent: () => floatingElement,
    getDocumentElement: () => floatingElement,
    getClientRects: () => [referenceElement.getBoundingClientRect()],
    getScale: () => ({ x: 1, y: 1 }),
    convertOffsetParentRelativeRectToViewportRelativeRect: ({ rect }) => rect,
    isElement: () => false,
    isRTL: () => false,
  };

  // The custom platform owns all geometry; neither element reaches a DOM API.
  const referenceElement = {
    getBoundingClientRect: () => ({
      ...reference,
      top: reference.y,
      right: reference.x + reference.width,
      bottom: reference.y + reference.height,
      left: reference.x,
    }),
  };

  return computePosition(referenceElement, floatingElement, {
    placement,
    strategy: "fixed",
    middleware,
    platform,
  });
}

function expectWithinViewport(position: { x: number; y: number }) {
  expect(position.x).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  expect(position.y).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  expect(position.x + SURFACE.width).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN);
  expect(position.y + SURFACE.height).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT_MARGIN);
}

const TEXT_ACTION_POSITIONING = NFM_TEXT_ACTION_MENU_FLOATING_OPTIONS.useFloatingOptions;

describe("NFM editor floating positioning", () => {
  test("keeps the preferred text-action placement when it fits", async () => {
    const reference = { x: 100, y: 100, width: 200, height: 20 };
    const result = await positionSurface(
      reference,
      TEXT_ACTION_POSITIONING.placement,
      TEXT_ACTION_POSITIONING.middleware,
    );

    expect(result.placement).toBe("bottom-start");
    expect(result.y).toBeGreaterThanOrEqual(reference.y + reference.height);
    expectWithinViewport(result);
  });

  test("flips text actions above the selection when only that side fits", async () => {
    const reference = { x: 100, y: 500, width: 200, height: 20 };
    const result = await positionSurface(
      reference,
      TEXT_ACTION_POSITIONING.placement,
      TEXT_ACTION_POSITIONING.middleware,
    );

    expect(result.placement).toBe("top-start");
    expect(result.y + SURFACE.height).toBeLessThanOrEqual(reference.y);
    expectWithinViewport(result);
  });

  test("keeps text actions visible when a multiline selection fills the viewport", async () => {
    const result = await positionSurface(
      { x: 50, y: 40, width: 500, height: 520 },
      TEXT_ACTION_POSITIONING.placement,
      TEXT_ACTION_POSITIONING.middleware,
    );

    expectWithinViewport(result);
  });

  test.each<Placement>(["top-start", "top", "top-end", "bottom-start", "left", "right"])(
    "keeps %s editor chrome visible when neither side of a large anchor fits",
    async (placement) => {
      const result = await positionSurface(
        { x: 40, y: 40, width: 720, height: 520 },
        placement,
        createNfmEditorFloatingMiddleware(10),
      );

      expectWithinViewport(result);
    },
  );

  test("keeps a fitting side while shifting centered chrome away from a viewport edge", async () => {
    const reference = { x: 600, y: 40, width: 20, height: 20 };
    const result = await positionSurface(reference, "left", createNfmEditorFloatingMiddleware(10));

    expect(result.placement).toBe("left");
    expect(result.x + SURFACE.width).toBeLessThanOrEqual(reference.x);
    expectWithinViewport(result);
  });
});
