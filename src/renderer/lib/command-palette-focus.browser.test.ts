import { expect, test } from "vite-plus/test";
import {
  captureCommandPaletteFocus,
  readCommandPaletteSelectionQuery,
} from "./command-palette-focus";

test("restores the editor's directional selection without scrolling its owner", () => {
  const scroller = document.createElement("div");
  scroller.style.cssText = "height: 100px; overflow: auto";
  const spacer = document.createElement("div");
  spacer.style.height = "500px";
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  const start = document.createTextNode("First paragraph");
  const end = document.createTextNode("Second paragraph");
  editor.append(start, document.createElement("br"), end);
  scroller.append(spacer, editor);
  const search = document.createElement("input");
  document.body.append(scroller, search);
  editor.focus();
  const selection = document.getSelection();
  if (!selection) throw new Error("Expected Chromium document selection");
  selection.setBaseAndExtent(end, 6, start, 2);
  const snapshot = captureCommandPaletteFocus();
  search.focus();
  selection.removeAllRanges();
  scroller.scrollTop = 0;

  snapshot.restore();

  expect(document.activeElement).toBe(editor);
  expect(scroller.scrollTop).toBe(0);
  expect(selection.anchorNode).toBe(end);
  expect(selection.anchorOffset).toBe(6);
  expect(selection.focusNode).toBe(start);
  expect(selection.focusOffset).toBe(2);
});

test("restores the deepest shadow input and its native selection", () => {
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  outer.attachShadow({ mode: "open" }).append(inner);
  const input = document.createElement("input");
  input.value = "Search this phrase";
  inner.attachShadow({ mode: "open" }).append(input);
  const search = document.createElement("input");
  document.body.append(outer, search);
  input.focus();
  input.setSelectionRange(2, 9, "backward");
  const snapshot = captureCommandPaletteFocus();
  expect(snapshot.originElement).toBe(input);
  search.focus();
  input.setSelectionRange(0, 0);

  snapshot.restore();

  expect(document.activeElement).toBe(outer);
  expect(inner.shadowRoot?.activeElement).toBe(input);
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(9);
  expect(input.selectionDirection).toBe("backward");
});

test("restores the directional selection inside a shadow editor", () => {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" }) as ShadowRoot & {
    getSelection: () => Selection | null;
  };
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  const text = document.createTextNode("An embedded editor");
  editor.append(text);
  root.append(editor);
  const search = document.createElement("input");
  document.body.append(host, search);
  editor.focus();
  const selection = root.getSelection();
  if (!selection) throw new Error("Expected Chromium shadow selection");
  selection.setBaseAndExtent(text, 15, text, 3);
  expect(readCommandPaletteSelectionQuery()).toBe("embedded edi");
  const snapshot = captureCommandPaletteFocus();
  search.focus();
  selection.removeAllRanges();

  snapshot.restore();

  expect(root.activeElement).toBe(editor);
  expect(selection.anchorNode).toBe(text);
  expect(selection.anchorOffset).toBe(15);
  expect(selection.focusNode).toBe(text);
  expect(selection.focusOffset).toBe(3);
});

test("seeds only a bounded single-line selection and never reads password contents", () => {
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  const select = (text: string) => {
    input.value = text;
    input.select();
    return readCommandPaletteSelectionQuery();
  };
  expect(select("  chosen phrase  ")).toBe("chosen phrase");
  expect(select("x".repeat(256))).toHaveLength(256);
  expect(select("x".repeat(257))).toBeUndefined();
  expect(select("first\nsecond")).toBeUndefined();
  expect(select("first\0second")).toBeUndefined();
  expect(select(" \t ")).toBeUndefined();
  const password = document.createElement("input");
  password.type = "password";
  password.value = "private";
  document.body.append(password);
  password.focus();
  password.select();
  expect(readCommandPaletteSelectionQuery()).toBeUndefined();
});

test("leaves replacement surfaces alone after the original focus owner is removed", () => {
  const origin = document.createElement("button");
  const replacement = document.createElement("input");
  document.body.append(origin, replacement);
  origin.focus();
  const snapshot = captureCommandPaletteFocus();
  origin.remove();
  replacement.focus();

  snapshot.restore();

  expect(document.activeElement).toBe(replacement);
});

test("restores focus without reviving detached or shortened selection endpoints", () => {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  const text = document.createTextNode("Original paragraph");
  editor.append(text);
  const search = document.createElement("input");
  document.body.append(editor, search);
  editor.focus();
  document.getSelection()?.setBaseAndExtent(text, 3, text, 14);
  const snapshot = captureCommandPaletteFocus();
  search.focus();
  text.data = "New";

  expect(() => snapshot.restore()).not.toThrow();
  expect(document.activeElement).toBe(editor);
  search.focus();
  text.remove();
  expect(() => snapshot.restore()).not.toThrow();
  expect(document.activeElement).toBe(editor);
});
