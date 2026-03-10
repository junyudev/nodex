import { describe, expect, test } from "bun:test";
import { resolveHistoryShortcutAction } from "./use-keyboard-shortcuts";

type ShortcutEvent = Parameters<typeof resolveHistoryShortcutAction>[0];

function fakeEvent(
  overrides: Partial<ShortcutEvent>,
): ShortcutEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  };
}

function inputTarget(): EventTarget {
  return { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
}

function textareaTarget(): EventTarget {
  return { tagName: "TEXTAREA", isContentEditable: false } as unknown as EventTarget;
}

function contentEditableTarget(): EventTarget {
  return { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
}

function editorSurfaceTarget(): EventTarget {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: (selector: string) => (
      selector.includes(".nfm-editor")
        ? ({} as Element)
        : null
    ),
  } as unknown as EventTarget;
}

function plainTarget(): EventTarget {
  return { tagName: "DIV", isContentEditable: false } as unknown as EventTarget;
}

describe("resolveHistoryShortcutAction", () => {
  test("handles Cmd+Z as undo on Mac", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "z", metaKey: true, target: plainTarget() }),
      true,
      null,
    );
    expect(action).toBe("undo");
  });

  test("handles Cmd+Shift+Z as redo on Mac", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "z", metaKey: true, shiftKey: true, target: plainTarget() }),
      true,
      null,
    );
    expect(action).toBe("redo");
  });

  test("handles Ctrl+Y as redo on non-Mac", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "y", ctrlKey: true, target: plainTarget() }),
      false,
      null,
    );
    expect(action).toBe("redo");
  });

  test("ignores event without platform modifier", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "z", target: plainTarget() }),
      true,
      null,
    );
    expect(action).toBe(null);
  });

  test("ignores events from INPUT fields", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "z", metaKey: true, target: inputTarget() }),
      true,
      null,
    );
    expect(action).toBe(null);
  });

  test("ignores events from TEXTAREA fields", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "z", metaKey: true, target: textareaTarget() }),
      true,
      null,
    );
    expect(action).toBe(null);
  });

  test("ignores events from contentEditable elements", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "z", metaKey: true, target: contentEditableTarget() }),
      true,
      null,
    );
    expect(action).toBe(null);
  });

  test("ignores events from editor surface targets", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "z", metaKey: true, target: editorSurfaceTarget() }),
      true,
      null,
    );
    expect(action).toBe(null);
  });

  test("ignores events when activeElement is inside editor surface", () => {
    const action = resolveHistoryShortcutAction(
      fakeEvent({ key: "z", metaKey: true, target: plainTarget() }),
      true,
      editorSurfaceTarget(),
    );
    expect(action).toBe(null);
  });
});
