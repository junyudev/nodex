import { describe, expect, test, afterEach, vi } from "vite-plus/test";
import { readCaptureSelection } from "./capture-selection";
import {
  readPlainTextFromClipboard,
  writeTextToClipboard,
  writeTextToClipboardStrict,
} from "./clipboard";
import { selectEditableLeafContent, selectionCoversEditableLeaf } from "./editable-leaf-selection";
import { fireEvent, act, renderHook } from "@testing-library/react";
import {
  ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE,
  claimEditorSelectionSurface,
  clearActiveEditorSelectionSurface,
  EDITOR_SELECTION_SURFACE_ATTRIBUTE,
  registerEditorSelectionSurface,
  releaseEditorSelectionSurface,
} from "./editor-selection-presentation";
import { useElementVisibility } from "./use-element-visibility";
import { usePageEditorSelection } from "./use-page-editor-selection";
import { registerPageEditorObservationParticipant } from "./page-editor-observation-registry";
import { createPageEditorSelectionObservation } from "./page-editor-selection";

describe("capture selection", () => {
  const selectNodeContents = (element: HTMLElement): Selection => {
    const selection = window.getSelection();
    if (!selection) throw new Error("Selection API is unavailable");
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.addRange(range);
    return selection;
  };

  describe("Capture selection", () => {
    test("keeps the lines of text selected on a global surface", () => {
      const surface = document.createElement("p");
      surface.textContent = "  Fix release\r\nnotes  ";
      document.body.append(surface);

      expect(readCaptureSelection(selectNodeContents(surface))).toBe("Fix release\nnotes");

      surface.remove();
    });

    test("ignores editable and local-surface selections", () => {
      const editor = document.createElement("div");
      editor.setAttribute("contenteditable", "true");
      editor.textContent = "Editor title";
      document.body.append(editor);
      expect(readCaptureSelection(selectNodeContents(editor))).toBeNull();
      editor.remove();

      const localSurface = document.createElement("div");
      localSurface.dataset.nodexKeyboardScope = "local";
      localSurface.textContent = "Dialog title";
      document.body.append(localSurface);
      expect(readCaptureSelection(selectNodeContents(localSurface))).toBeNull();
      localSurface.remove();
    });

    test("ignores a selection that crosses a locally owned surface", () => {
      const surface = document.createElement("div");
      const before = document.createTextNode("Before ");
      const local = document.createElement("span");
      local.dataset.nodexKeyboardScope = "local";
      local.textContent = "local";
      const after = document.createTextNode(" after");
      surface.append(before, local, after);
      document.body.append(surface);

      const selection = window.getSelection();
      if (!selection) throw new Error("Selection API is unavailable");
      const range = document.createRange();
      range.setStart(before, 0);
      range.setEnd(after, after.length);
      selection.removeAllRanges();
      selection.addRange(range);

      expect(readCaptureSelection(selection)).toBeNull();
      surface.remove();
    });
  });
});

describe("clipboard", () => {
  const originalApi = window.api;
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;

  afterEach(() => {
    vi.restoreAllMocks();
    window.api = originalApi;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: originalExecCommand,
    });
  });

  describe("renderer text clipboard", () => {
    test("reads native plaintext even when Web Clipboard permission is denied", async () => {
      const invoke = vi.fn(async () => ({ text: "native\r\nplaintext", html: "<b>rich</b>" }));
      const readText = vi.fn(async () => {
        throw new Error("Read permission denied");
      });
      window.api = { invoke, on: () => () => {} };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

      await expect(readPlainTextFromClipboard()).resolves.toBe("native\r\nplaintext");
      await expect(readPlainTextFromClipboard("text/plain")).resolves.toBe("native\r\nplaintext");

      expect(invoke).toHaveBeenCalledWith("clipboard:read-paste");
      expect(readText).not.toHaveBeenCalled();
    });

    test("does not substitute HTML or Markdown when the native clipboard has no plaintext", async () => {
      window.api = {
        invoke: vi.fn(async () => ({ html: "<b>rich</b>", markdown: "**rich**" })),
        on: () => () => {},
      };

      await expect(readPlainTextFromClipboard()).resolves.toBe("");
    });

    test.each(["text/html", "application/x-pierre-multi-selection"])(
      "does not misread ordinary text as the unsupported %s format",
      async (type) => {
        const invoke = vi.fn(async () => ({ text: '["first","second"]' }));
        const readText = vi.fn(async () => '["first","second"]');
        window.api = { invoke, on: () => () => {} };
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

        await expect(readPlainTextFromClipboard(type)).resolves.toBe("");

        expect(invoke).not.toHaveBeenCalled();
        expect(readText).not.toHaveBeenCalled();
      },
    );

    test("keeps native read failures visible instead of retrying a denied browser API", async () => {
      const readText = vi.fn(async () => "browser");
      window.api = {
        invoke: vi.fn(async () => {
          throw new Error("Native read failed");
        }),
        on: () => () => {},
      };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

      await expect(readPlainTextFromClipboard()).rejects.toThrow("Native read failed");

      expect(readText).not.toHaveBeenCalled();
    });

    test("reads plaintext through Web Clipboard when no native bridge exists", async () => {
      const readText = vi.fn(async () => "browser plaintext");
      window.api = undefined;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

      await expect(readPlainTextFromClipboard()).resolves.toBe("browser plaintext");

      expect(readText).toHaveBeenCalledOnce();
    });

    test("strict writes recover through the shared DOM fallback when Web Clipboard is denied", async () => {
      const browserWriteText = vi.fn(async () => {
        throw new Error("Clipboard permission denied");
      });
      const execCommand = vi.fn((command: string) => command === "copy");
      window.api = undefined;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: browserWriteText },
      });
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: execCommand,
      });

      await expect(writeTextToClipboardStrict("complete transcript")).resolves.toBeUndefined();

      expect(browserWriteText).toHaveBeenCalledWith("complete transcript");
      expect(execCommand).toHaveBeenCalledWith("copy");
    });

    test("keeps browser clipboard support when no Electron bridge exists", async () => {
      const browserWriteText = vi.fn(async () => undefined);
      window.api = undefined;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: browserWriteText },
      });

      await expect(writeTextToClipboard("browser task")).resolves.toBe(true);

      expect(browserWriteText).toHaveBeenCalledWith("browser task");
    });
  });
});

describe("editable leaf selection", () => {
  const createFixture = (): HTMLDivElement => {
    const root = document.createElement("div");
    root.innerHTML = "<span>Hello </span><strong>world</strong>";
    document.body.append(root);
    return root;
  };

  describe("editable leaf selection", () => {
    test("selects the complete leaf from a partial text selection", () => {
      const root = createFixture();
      const text = root.querySelector("span")?.firstChild;
      if (!(text instanceof Text)) throw new TypeError("Missing text fixture");
      document.getSelection()?.setBaseAndExtent(text, 2, text, 4);

      expect(selectEditableLeafContent(root)).toBe(true);
      expect(selectionCoversEditableLeaf(root)).toBe(true);
      expect(document.getSelection()?.toString()).toBe("Hello world");
      root.remove();
    });

    test("yields when the leaf is already fully selected", () => {
      const root = createFixture();
      const firstText = root.querySelector("span")?.firstChild;
      const lastText = root.querySelector("strong")?.firstChild;
      if (!(firstText instanceof Text) || !(lastText instanceof Text)) {
        throw new TypeError("Missing text fixture");
      }
      document.getSelection()?.setBaseAndExtent(firstText, 0, lastText, lastText.length);

      expect(selectionCoversEditableLeaf(root)).toBe(true);
      expect(selectEditableLeafContent(root)).toBe(false);
      root.remove();
    });

    test("recognizes a parent-editor selection that contains the leaf", () => {
      const host = document.createElement("div");
      const before = document.createTextNode("before");
      const root = createFixture();
      const after = document.createTextNode("after");
      host.append(before, root, after);
      document.body.append(host);
      document.getSelection()?.setBaseAndExtent(before, 0, after, after.length);

      expect(selectionCoversEditableLeaf(root)).toBe(true);
      expect(selectEditableLeafContent(root)).toBe(false);
      host.remove();
    });
  });
});

describe("editor selection presentation", () => {
  const mounted: HTMLElement[] = [];

  function createSurface(): HTMLElement {
    const surface = document.createElement("div");
    surface.setAttribute(EDITOR_SELECTION_SURFACE_ATTRIBUTE, "");
    document.body.append(surface);
    mounted.push(surface);
    return surface;
  }

  afterEach(() => {
    for (const element of mounted.splice(0)) element.remove();
  });

  describe("editor selection presentation ownership", () => {
    test("repairs stale duplicate owners from the DOM root", () => {
      const staleSurface = createSurface();
      const nextSurface = createSurface();
      staleSurface.setAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE, "");
      nextSurface.setAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE, "");

      claimEditorSelectionSurface(nextSurface);

      expect(staleSurface.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(false);
      expect(nextSurface.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(true);
      expect(
        document.querySelectorAll(`[${ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE}]`),
      ).toHaveLength(1);
    });

    test("clears every owner and releases only the requested surface", () => {
      const firstSurface = createSurface();
      const secondSurface = createSurface();
      firstSurface.setAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE, "");
      secondSurface.setAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE, "");

      clearActiveEditorSelectionSurface(firstSurface);
      expect(
        document.querySelectorAll(`[${ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE}]`),
      ).toHaveLength(0);

      claimEditorSelectionSurface(secondSurface);
      releaseEditorSelectionSurface(firstSurface);
      expect(secondSurface.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(true);
    });

    test("follows the deepest registered editor and clears ownership outside every editor", () => {
      const outerSurface = createSurface();
      const innerSurface = createSurface();
      const outside = document.createElement("button");
      outerSurface.append(innerSurface);
      document.body.append(outside);
      mounted.push(outside);

      const unregisterOuter = registerEditorSelectionSurface(outerSurface);
      const unregisterInner = registerEditorSelectionSurface(innerSurface);
      try {
        fireEvent.pointerDown(outerSurface);
        expect(outerSurface.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(true);
        expect(innerSurface.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(false);

        fireEvent.pointerDown(innerSurface);
        expect(outerSurface.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(false);
        expect(innerSurface.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(true);

        fireEvent.pointerDown(outside);
        expect(
          document.querySelectorAll(`[${ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE}]`),
        ).toHaveLength(0);
      } finally {
        unregisterInner();
        unregisterOuter();
      }
    });
  });
});

describe("use element visibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("resets prewarm visibility for another node or margin and releases observations", async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const disconnects: Array<ReturnType<typeof vi.fn>> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        disconnect = vi.fn();
        observe = vi.fn();
        constructor(callback: IntersectionObserverCallback) {
          callbacks.push(callback);
          disconnects.push(this.disconnect);
        }
      },
    );
    const { result, rerender, unmount } = renderHook(({ margin }) => useElementVisibility(margin), {
      initialProps: { margin: "160px 0px" },
    });
    const element = document.createElement("div");
    await act(async () => result.current.ref(element));
    await act(async () =>
      callbacks[0]!(
        [
          {
            isIntersecting: true,
            boundingClientRect: { top: 0, left: 0, right: 20, bottom: 20, width: 20, height: 20 },
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
    expect(result.current.visible).toBe(true);
    rerender({ margin: "20px" });
    expect(result.current.visible).toBe(false);
    expect(disconnects[0]).toHaveBeenCalledOnce();
    await act(async () => result.current.ref(document.createElement("div")));
    expect(result.current.visible).toBe(false);
    unmount();
    expect(disconnects.every((disconnect) => disconnect.mock.calls.length === 1)).toBe(true);
  });

  test("falls back to visible and records document order without an observer", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { result } = renderHook(() => useElementVisibility());
    const element = document.createElement("div");
    Object.defineProperty(element, "offsetTop", { value: 42 });
    await act(async () => result.current.ref(element));
    expect(result.current.visible).toBe(true);
    expect(result.current.intersecting).toBe(true);
    expect(result.current.documentOrder).toBe(42);
  });
});

describe("use page editor selection", () => {
  test("selection observers follow late editor mount, replacement, and unmount by exact lease", async () => {
    const subject = renderHook(() => usePageEditorSelection("selection-test"));
    const participant = (id: string) => ({
      ...createPageEditorSelectionObservation({ read: () => [id], focused: () => true }),
      read: () => {
        throw new Error("Selection must not read content");
      },
      prepare: async () => {
        throw new Error("Selection must not prepare content");
      },
    });
    let first = () => {};
    let second = () => {};
    try {
      expect(subject.result.current).toEqual([]);
      await act(async () => {
        first = registerPageEditorObservationParticipant("selection-test", participant("a"));
      });
      expect(subject.result.current).toEqual(["a"]);
      await act(async () => {
        second = registerPageEditorObservationParticipant("selection-test", participant("b"));
        first();
      });
      expect(subject.result.current).toEqual(["b"]);
      await act(async () => {
        second();
      });
      expect(subject.result.current).toEqual([]);
    } finally {
      subject.unmount();
      second();
      first();
    }
  });
});
