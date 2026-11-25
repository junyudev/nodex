import { afterEach, describe, expect, test } from "vite-plus/test";
import "../../../third_party/blocknote/packages/core/src/editor/Block.css";
import { render, screen } from "@testing-library/react";
import "@/globals.css";
import { installRendererThemeFixture } from "@/test/renderer-theme";

describe("page outliner disclosure", () => {
  function createDisclosure(expanded: boolean) {
    const wrapper = document.createElement("div");
    wrapper.className = "bn-toggle-wrapper";
    wrapper.dataset.showChildren = expanded ? "true" : "false";

    const caret = document.createElement("button");
    caret.className = "bn-toggle-button";
    caret.type = "button";
    wrapper.append(caret);

    return { caret, wrapper };
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  describe("nested Page outliner disclosure styling", () => {
    test("each caret reflects only its own disclosure wrapper", () => {
      const outer = createDisclosure(true);
      const inner = createDisclosure(false);
      outer.wrapper.append(inner.wrapper);
      document.body.append(outer.wrapper);

      expect(getComputedStyle(outer.caret).transform).not.toBe("none");
      expect(getComputedStyle(inner.caret).transform).toBe("none");

      outer.wrapper.dataset.showChildren = "false";
      inner.wrapper.dataset.showChildren = "true";

      expect(getComputedStyle(outer.caret).transform).toBe("none");
      expect(getComputedStyle(inner.caret).transform).not.toBe("none");
    });
  });
});

describe("text field scrollbar", () => {
  installRendererThemeFixture();

  test("a text area that scrolls has the app's scrollbar without asking for it", () => {
    render(
      <textarea aria-label="Field" className="max-h-10" readOnly value={"line\n".repeat(40)} />,
    );
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Field" });

    expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);
    // The thumb's shade follows the pointer; a clear track is what sets it apart from the platform's.
    expect(getComputedStyle(field).scrollbarColor).toMatch(/ rgba\(0, 0, 0, 0\)$/u);
  });
});
