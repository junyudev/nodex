import { expect, test, describe } from "vite-plus/test";
import { deliverBrowserAnnotations } from "./browser-annotation-delivery";
import type {
  BrowserAnnotationAttachment,
  BrowserAnnotationAnchor,
  BrowserAnnotationSelectionEvent,
} from "../../../shared/browser-annotation";
import { placeBrowserAnnotationEditor } from "./browser-annotation-editor-position";
import {
  applyBrowserAnnotationAnchorUpdate,
  applyBrowserAnnotationSelection,
  createBrowserAnnotationDraftState,
  navigateBrowserAnnotationDraft,
  removeBrowserAnnotationAnchor,
  updateBrowserAnnotationDesignChange,
} from "./browser-annotation-state";

describe("browser annotation delivery", () => {
  const note = (id: string): BrowserAnnotationAttachment => ({
    schemaVersion: 1,
    id,
    browserTabId: "tab",
    createdAt: 1,
    note: id,
    pageTitle: "Example",
    pageUrl: "https://example.com",
    anchors: [],
  });
  test.each(["refused", "error", "missing"])(
    "direct delivery %s leaves the saved note available",
    async (outcome) => {
      let saved = [note("one")];
      const result = await deliverBrowserAnnotations({
        destination: "chat",
        annotations: saved,
        admit:
          outcome === "missing"
            ? undefined
            : async () => {
                if (outcome === "error") throw new Error("Disconnected");
                return false;
              },
        consume: async (ids) => {
          saved = saved.filter((record) => !ids.includes(record.id));
        },
      });
      expect(result).toMatchObject({ admitted: false, reason: expect.stringContaining("saved") });
      expect(saved.map((record) => record.id)).toEqual(["one"]);
    },
  );
  test("send-all admits one message and consumes its exact set after admission", async () => {
    let saved = [note("one"), note("two")];
    const sent: BrowserAnnotationAttachment[][] = [];
    const result = await deliverBrowserAnnotations({
      destination: "chat",
      annotations: [...saved],
      admit: async (annotations) => {
        sent.push([...annotations]);
        saved.push(note("three"));
        return true;
      },
      consume: async (ids) => {
        saved = saved.filter((record) => !ids.includes(record.id));
      },
    });
    expect(result.admitted).toBe(true);
    expect(sent.map((message) => message.map((record) => record.id))).toEqual([["one", "two"]]);
    expect(saved.map((record) => record.id)).toEqual(["three"]);
  });
});

describe("browser annotation editor placement", () => {
  const page = { width: 800, height: 600 };
  const editor = { width: 320, height: 240 };
  describe("Browser annotation editor placement", () => {
    test("places beside the target and flips at the right edge", () => {
      expect(
        placeBrowserAnnotationEditor({ x: 20, y: 30, width: 80, height: 50 }, page, editor),
      ).toMatchObject({ left: 108, top: 30 });
      expect(
        placeBrowserAnnotationEditor({ x: 700, y: 30, width: 80, height: 50 }, page, editor),
      ).toMatchObject({ left: 372, top: 30 });
    });
    test("goes below a target with no room beside it, and above one at the bottom", () => {
      expect(
        placeBrowserAnnotationEditor({ x: 20, y: 30, width: 760, height: 50 }, page, editor),
      ).toMatchObject({ left: 20, top: 88 });
      expect(
        placeBrowserAnnotationEditor({ x: 20, y: 500, width: 760, height: 50 }, page, editor),
      ).toMatchObject({ left: 20, top: 252 });
    });
    test("clamps offscreen anchors and constrains an oversized editor", () => {
      expect(
        placeBrowserAnnotationEditor({ x: -200, y: 700, width: 1, height: 1 }, page, editor),
      ).toMatchObject({ left: 8, top: 352 });
      expect(
        placeBrowserAnnotationEditor(
          { x: 200, y: -20, width: 1, height: 1 },
          { width: 200, height: 100 },
          editor,
        ),
      ).toEqual({ left: 8, top: 8, maxWidth: 184, maxHeight: 84 });
    });
  });
});

describe("browser annotation state", () => {
  function elementAnchor(id: string, selector = "#target"): BrowserAnnotationAnchor {
    return {
      id,
      kind: "element",
      pageUrl: "https://example.test/page",
      selector,
      elementPath: "main > button",
      framePath: [],
      rect: { x: 10, y: 20, width: 30, height: 40 },
      computedStyle: {
        color: "rgb(0, 0, 0)",
        backgroundColor: "rgba(0, 0, 0, 0)",
        fontSize: "16px",
        borderRadius: "4px",
        opacity: "1",
      },
    };
  }

  function select(
    anchor: BrowserAnnotationAnchor,
    multiSelect = false,
  ): BrowserAnnotationSelectionEvent {
    return { sessionId: "annotation-session", multiSelect, anchor };
  }

  describe("Browser annotation draft state", () => {
    test("toggles equivalent Shift selections instead of accumulating duplicate anchors", () => {
      const initial = createBrowserAnnotationDraftState("https://example.test/page");
      const selected = applyBrowserAnnotationSelection(initial, select(elementAnchor("one")));
      const added = applyBrowserAnnotationSelection(
        selected,
        select(elementAnchor("two", "#second"), true),
      );
      expect(added.anchors.map((anchor) => anchor.id)).toEqual(["one", "two"]);

      const removed = applyBrowserAnnotationSelection(
        added,
        select(elementAnchor("new-id", "#second"), true),
      );
      expect(removed.anchors.map((anchor) => anchor.id)).toEqual(["one"]);
    });

    test("updates live anchor geometry by stable id and ignores stale pages", () => {
      const selected = applyBrowserAnnotationSelection(
        createBrowserAnnotationDraftState("https://example.test/page"),
        select(elementAnchor("one")),
      );
      const updated = applyBrowserAnnotationAnchorUpdate(selected, {
        ...elementAnchor("one"),
        rect: { x: 40, y: 50, width: 60, height: 70 },
      });
      expect(updated.anchors[0]?.rect).toEqual({
        x: 40,
        y: 50,
        width: 60,
        height: 70,
      });
      expect(
        applyBrowserAnnotationAnchorUpdate(updated, {
          ...elementAnchor("one"),
          pageUrl: "https://other.test/",
        }),
      ).toBe(updated);
    });

    test("invalidates all anchors and design state on navigation", () => {
      const selected = applyBrowserAnnotationSelection(
        createBrowserAnnotationDraftState("https://example.test/page"),
        select(elementAnchor("one")),
      );
      const designed = updateBrowserAnnotationDesignChange(selected, {
        anchorId: "one",
        property: "fontSize",
        after: "20px",
      });
      const navigated = navigateBrowserAnnotationDraft(designed, "https://example.test/next");
      expect(navigated.anchors).toEqual([]);
      expect(navigated.designChange).toBeNull();
      expect(navigated.pageUrl).toBe("https://example.test/next");
    });

    test("records bounded before/after design values and clears them with the target", () => {
      const selected = applyBrowserAnnotationSelection(
        createBrowserAnnotationDraftState("https://example.test/page"),
        select(elementAnchor("one")),
      );
      const designed = updateBrowserAnnotationDesignChange(selected, {
        anchorId: "one",
        property: "borderRadius",
        after: "12px",
      });
      expect(designed.designChange).toEqual({
        anchorId: "one",
        property: "borderRadius",
        before: "4px",
        after: "12px",
      });
      expect(removeBrowserAnnotationAnchor(designed, "one").designChange).toBeNull();
    });
  });
});
