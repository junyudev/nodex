import { afterEach, expect, test } from "vite-plus/test";
import { embeddedEditorSelectionContextAttributes } from "@/lib/editor-selection-presentation";
import { ownsNfmEditorEvent } from "./nfm-editor-event-owner";

afterEach(() => document.body.replaceChildren());

test("only the deepest NFM owns history inside an embedded Page, including another embed", () => {
  const outer = document.createElement("div");
  outer.className = "nfm-editor";
  const boundary = document.createElement("section");
  for (const [name, value] of Object.entries(embeddedEditorSelectionContextAttributes)) {
    boundary.setAttribute(name, value);
  }
  const inner = document.createElement("div");
  inner.className = "nfm-editor";
  const paragraph = document.createElement("p");
  const title = document.createElement("div");
  title.setAttribute("data-embedded-surface-input", "page-title");
  const titleText = document.createElement("span");
  title.append(titleText);
  const nestedScene = boundary.cloneNode() as HTMLElement;
  const canvas = document.createElement("button");
  nestedScene.append(canvas);
  inner.append(paragraph, nestedScene);
  boundary.append(title, inner);
  outer.append(boundary);
  document.body.append(outer);

  const calls: string[] = [];
  for (const [element, label] of [
    [outer, "outer"],
    [inner, "inner"],
  ] as const) {
    element.addEventListener(
      "beforeinput",
      (event) => {
        if (!ownsNfmEditorEvent(element, event.target)) return;
        calls.push(label);
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
  }
  const undo = () =>
    new InputEvent("beforeinput", {
      inputType: "historyUndo",
      bubbles: true,
      cancelable: true,
    });
  expect(paragraph.dispatchEvent(undo())).toBe(false);
  expect(calls).toEqual(["inner"]);
  expect(titleText.dispatchEvent(undo())).toBe(true);
  expect(canvas.dispatchEvent(undo())).toBe(true);
  expect(calls).toEqual(["inner"]);
});
