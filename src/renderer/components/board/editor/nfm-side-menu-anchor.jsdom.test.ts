import { describe, expect, test } from "vite-plus/test";
import type { NfmPopoverReference } from "./nfm-floating-popover";
import {
  createNfmSideMenuBlockReference,
  createNfmSideMenuStaticReference,
  resolveNfmSideMenuReference,
} from "./nfm-side-menu-anchor";

function readReferenceRect(reference: NfmPopoverReference): DOMRect {
  if (!("getBoundingClientRect" in reference)) {
    throw new Error("Expected a virtual side-menu reference.");
  }

  return reference.getBoundingClientRect();
}

function makeBlockElement(initialRect: DOMRect) {
  let currentRect = initialRect;
  const element = document.createElement("div");
  element.className = "bn-block";
  element.dataset.id = "block-1";
  element.getBoundingClientRect = () => currentRect;

  return {
    element,
    setRect(rect: DOMRect) {
      currentRect = rect;
    },
  };
}

describe("markdown side menu anchor", () => {
  test("reads the current block rect every time for live block anchors", () => {
    const block = makeBlockElement(new DOMRect(100, 200, 300, 60));
    const reference = createNfmSideMenuBlockReference(block.element);

    const firstRect = readReferenceRect(reference);
    expect(firstRect.left).toBe(92);
    expect(firstRect.top).toBe(200);
    expect(firstRect.width).toBe(18);
    expect(firstRect.height).toBe(40);

    block.setRect(new DOMRect(130, 240, 300, 20));

    const secondRect = readReferenceRect(reference);
    expect(secondRect.left).toBe(122);
    expect(secondRect.top).toBe(240);
    expect(secondRect.width).toBe(18);
    expect(secondRect.height).toBe(24);
  });

  test("prefers a live block anchor over a fallback static rect", () => {
    const root = document.createElement("div");
    const block = makeBlockElement(new DOMRect(160, 320, 300, 32));
    root.appendChild(block.element);

    const reference = resolveNfmSideMenuReference({
      root,
      blockId: "block-1",
      fallbackRect: {
        left: 1,
        top: 2,
        width: 3,
        height: 4,
      },
    });
    if (!reference) throw new Error("Expected a side-menu reference.");

    const rect = readReferenceRect(reference);
    expect(rect.left).toBe(152);
    expect(rect.top).toBe(320);
    expect(rect.width).toBe(18);
    expect(rect.height).toBe(32);
  });

  test("uses the fallback static rect only when the block DOM is unavailable", () => {
    const reference = resolveNfmSideMenuReference({
      root: document.createElement("div"),
      blockId: "missing-block",
      fallbackRect: {
        left: 11,
        top: 22,
        width: 33,
        height: 44,
      },
    });
    if (!reference) throw new Error("Expected a fallback side-menu reference.");

    const rect = readReferenceRect(reference);
    expect(reference.element === undefined).toBe(true);
    expect(rect.left).toBe(11);
    expect(rect.top).toBe(22);
    expect(rect.width).toBe(33);
    expect(rect.height).toBe(44);
  });

  test("static references preserve the provided fallback rect", () => {
    const reference = createNfmSideMenuStaticReference({
      left: 5,
      top: 6,
      width: 7,
      height: 8,
    });

    const rect = readReferenceRect(reference);
    expect(reference.element === undefined).toBe(true);
    expect(rect.left).toBe(5);
    expect(rect.top).toBe(6);
    expect(rect.width).toBe(7);
    expect(rect.height).toBe(8);
  });
});
