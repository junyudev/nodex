import { getSelectedMessageText } from "./shared/message-clipboard";
import { describe, expect, test } from "vite-plus/test";
import {
  resolveCommonSelectedTextTarget,
  clampSelectionRange,
  createResponseTextAnnotation,
  resolveResponseAnnotationRange,
  intersectSelectionRect,
  type SelectedTextRectLike,
} from "./thread-text-selection-dom";

function rect(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): SelectedTextRectLike {
  return {
    left: input.left,
    top: input.top,
    right: input.left + input.width,
    bottom: input.top + input.height,
    width: input.width,
    height: input.height,
  };
}

describe("thread text selection", () => {
  test("resolves a shared selected-text target", () => {
    const root = document.createElement("div");
    const target = document.createElement("p");
    target.dataset.threadSelectedTextTarget = "true";
    const first = document.createTextNode("Plan the ");
    const second = document.createTextNode("migration");
    target.append(first, second);
    root.append(target);

    const resolved = resolveCommonSelectedTextTarget({
      rootElement: root,
      anchorNode: first,
      focusNode: second,
    });

    expect(resolved === target).toBe(true);
  });

  test("rejects selections that cross selected-text targets", () => {
    const root = document.createElement("div");
    const firstTarget = document.createElement("p");
    const secondTarget = document.createElement("p");
    firstTarget.dataset.threadSelectedTextTarget = "true";
    secondTarget.dataset.threadSelectedTextTarget = "true";
    const first = document.createTextNode("First");
    const second = document.createTextNode("Second");
    firstTarget.append(first);
    secondTarget.append(second);
    root.append(firstTarget, secondTarget);

    const resolved = resolveCommonSelectedTextTarget({
      rootElement: root,
      anchorNode: first,
      focusNode: second,
    });

    expect(resolved === null).toBe(true);
  });

  test("clips selected text to its message and restores the exact repeated occurrence", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p data-thread-selected-text-target="true" data-response-annotation-target="message" data-response-annotation-thread="thread">same <strong>same</strong> same</p><p>outside</p>';
    const target = root.firstElementChild as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(target.querySelector("strong")!);
    const annotation = createResponseTextAnnotation(target, range, "same")!;
    expect(annotation.source).toMatchObject({ startOffset: 5, endOffset: 9, rangeText: "same" });
    const restored = resolveResponseAnnotationRange(root, annotation)!;
    expect(restored.startContainer).toBe(target.firstChild);
    expect(restored.toString()).toBe("same");
    target.querySelector("strong")!.textContent = "changed";
    expect(resolveResponseAnnotationRange(root, annotation)).toBeNull();
    range.selectNodeContents(root);
    expect(clampSelectionRange(range, target).toString()).toBe("same changed same");
  });

  test("keeps paragraph boundaries and removes copy controls from selected context", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>First <strong>sentence</strong>.</p><p>Second sentence.</p><button>Copy</button>";
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(getSelectedMessageText(range)).toBe("First sentence.\n\nSecond sentence.");
  });

  test("intersects only visible selection geometry", () => {
    const bounds = rect({ left: 10, top: 50, width: 200, height: 100 });
    expect(
      intersectSelectionRect(rect({ left: 0, top: 45, width: 90, height: 20 }), bounds)?.toJSON(),
    ).toMatchObject({ x: 10, y: 50, width: 80, height: 15 });
    expect(
      intersectSelectionRect(rect({ left: 30, top: 160, width: 90, height: 20 }), bounds),
    ).toBeNull();
  });
});
