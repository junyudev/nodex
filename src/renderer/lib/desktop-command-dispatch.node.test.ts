import { describe, expect, test } from "vite-plus/test";
import {
  formatWindowsMenuAccelerator,
  resolveApplicationMenubarKey,
} from "./application-menubar-keyboard";
import {
  keyboardActionHasContext,
  keyboardActionMayRun,
  type KeyboardActionEventLike,
  type KeyboardActionPolicy,
} from "./keyboard-action-runtime";
import { decodeNewTabShortcutPreferences } from "./workbench-new-tab-shortcuts";

describe("application menubar keyboard", () => {
  const idle = { altPending: false, focused: false, open: false };
  const key = (key: string, input: Partial<KeyboardEvent> = {}) => ({
    key,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...input,
  });

  describe("Windows menu keyboard ownership", () => {
    test("Alt alone toggles on release, while a chord cancels its pending toggle", () => {
      expect(resolveApplicationMenubarKey(key("Alt"), idle, "down")).toBe("alt");
      expect(resolveApplicationMenubarKey(key("Alt"), { ...idle, altPending: true }, "up")).toBe(
        "toggle",
      );
      expect(
        resolveApplicationMenubarKey(
          key("Tab", { altKey: true }),
          { ...idle, altPending: true },
          "down",
        ),
      ).toBe("cancel-alt");
      expect(resolveApplicationMenubarKey(key("Alt"), idle, "up")).toBeNull();
    });
    test("mnemonics belong to Alt or focused menubar mode", () => {
      expect(resolveApplicationMenubarKey(key("f", { altKey: true }), idle, "down")).toEqual({
        mnemonic: "f",
      });
      expect(resolveApplicationMenubarKey(key("e"), { ...idle, focused: true }, "down")).toEqual({
        mnemonic: "e",
      });
      expect(
        resolveApplicationMenubarKey(key("e"), { ...idle, focused: true, open: true }, "down"),
      ).toBeNull();
      expect(resolveApplicationMenubarKey(key("f"), idle, "down")).toBeNull();
    });
    test("does not claim repeated, composed, or modified F10", () => {
      expect(resolveApplicationMenubarKey(key("F10"), idle, "down")).toBe("toggle");
      for (const input of [
        { repeat: true },
        { isComposing: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
      ]) {
        expect(resolveApplicationMenubarKey(key("F10", input), idle, "down")).toBeNull();
      }
      expect(resolveApplicationMenubarKey(key("Escape"), { ...idle, open: true }, "down")).toBe(
        "close",
      );
    });
    test.each([
      ["Shift+Control+Alt+Super+F", "Win+Alt+Ctrl+Shift+F"],
      ["CommandOrControl+Plus", "Ctrl+Shift+="],
      ["Command+Meta+Ctrl+-", "Win+Ctrl+-"],
      ["Alt+F4", "Alt+F4"],
    ])("formats %s for native menu presentation", (input, output) =>
      expect(formatWindowsMenuAccelerator(input)).toBe(output),
    );
  });
});

describe("keyboard action runtime", () => {
  const defaultPolicy: KeyboardActionPolicy = {
    runWithEditableFocus: false,
    runInsideLocalSurface: false,
    runInsideTerminal: false,
    allowRepeat: false,
  };

  function event(overrides: Partial<KeyboardActionEventLike> = {}): KeyboardActionEventLike {
    return {
      target: null,
      defaultPrevented: false,
      isComposing: false,
      repeat: false,
      keyCode: 67,
      composedPath: () => [],
      ...overrides,
    };
  }

  function element(input: {
    tagName?: string;
    editable?: boolean;
    role?: string;
    contentEditable?: string;
    scope?: "local" | "terminal";
    context?: "composer";
    inputType?: string;
  }): EventTarget {
    const attributes = new Map<string, string>();
    if (input.role) attributes.set("role", input.role);
    if (input.contentEditable !== undefined) {
      attributes.set("contenteditable", input.contentEditable);
    }
    if (input.scope) attributes.set("data-nodex-keyboard-scope", input.scope);
    if (input.context) attributes.set("data-nodex-keyboard-context", input.context);
    if (input.inputType) attributes.set("type", input.inputType);
    return {
      tagName: input.tagName,
      isContentEditable: input.editable ?? false,
      getAttribute: (name: string) => attributes.get(name) ?? null,
    } as unknown as EventTarget;
  }

  describe("keyboard action ownership", () => {
    test("runs only fresh unconsumed keyboard events", () => {
      expect(keyboardActionMayRun(event(), defaultPolicy)).toBe(true);
      expect(keyboardActionMayRun(event({ defaultPrevented: true }), defaultPolicy)).toBe(false);
      expect(keyboardActionMayRun(event({ isComposing: true }), defaultPolicy)).toBe(false);
      expect(keyboardActionMayRun(event({ keyCode: 229 }), defaultPolicy)).toBe(false);
      expect(keyboardActionMayRun(event({ repeat: true }), defaultPolicy)).toBe(false);
      expect(
        keyboardActionMayRun(event({ repeat: true }), { ...defaultPolicy, allowRepeat: true }),
      ).toBe(true);
    });

    test("keeps editable and local surface keys with their nearest owner", () => {
      const textInput = element({ tagName: "INPUT", inputType: "text" });
      const checkbox = element({ tagName: "INPUT", inputType: "checkbox" });
      const textarea = element({ tagName: "TEXTAREA" });
      const combobox = element({ tagName: "DIV", role: "combobox" });
      const editable = element({ tagName: "DIV", contentEditable: "true" });
      const explicitlyStatic = element({ tagName: "DIV", contentEditable: "false" });
      const child = element({ tagName: "BUTTON" });
      const localSurface = element({ tagName: "DIV", scope: "local" });
      const terminalSurface = element({ tagName: "DIV", scope: "terminal" });

      for (const target of [textInput, textarea, combobox, editable]) {
        expect(
          keyboardActionMayRun(
            event({
              target,
              composedPath: () => [target],
            }),
            defaultPolicy,
          ),
        ).toBe(false);
      }
      expect(
        keyboardActionMayRun(
          event({
            target: textInput,
            composedPath: () => [textInput],
          }),
          { ...defaultPolicy, runWithEditableFocus: true },
        ),
      ).toBe(true);
      expect(
        keyboardActionMayRun(
          event({
            target: checkbox,
            composedPath: () => [checkbox],
          }),
          defaultPolicy,
        ),
      ).toBe(true);
      expect(
        keyboardActionMayRun(
          event({
            target: explicitlyStatic,
            composedPath: () => [explicitlyStatic],
          }),
          defaultPolicy,
        ),
      ).toBe(true);

      expect(
        keyboardActionMayRun(
          event({
            target: child,
            composedPath: () => [child, localSurface],
          }),
          defaultPolicy,
        ),
      ).toBe(false);
      expect(
        keyboardActionMayRun(
          event({
            target: child,
            composedPath: () => [child, localSurface],
          }),
          { ...defaultPolicy, runInsideLocalSurface: true },
        ),
      ).toBe(true);
      expect(
        keyboardActionMayRun(
          event({
            target: child,
            composedPath: () => [child, localSurface, terminalSurface],
          }),
          { ...defaultPolicy, runInsideLocalSurface: true },
        ),
      ).toBe(false);
      expect(
        keyboardActionMayRun(
          event({
            target: child,
            composedPath: () => [child, localSurface, terminalSurface],
          }),
          {
            ...defaultPolicy,
            runInsideLocalSurface: true,
            runInsideTerminal: true,
          },
        ),
      ).toBe(true);
    });

    test("projects semantic keyboard context through the composed path", () => {
      const editor = element({ tagName: "DIV" });
      const composer = element({ tagName: "DIV", context: "composer" });

      expect(
        keyboardActionHasContext(
          event({
            target: editor,
            composedPath: () => [editor, composer],
          }),
          "composer",
        ),
      ).toBe(true);
      expect(
        keyboardActionHasContext(
          event({
            target: editor,
            composedPath: () => [editor],
          }),
          "composer",
        ),
      ).toBe(false);
    });
  });
});

describe("decodeNewTabShortcutPreferences", () => {
  const bottom = { order: ["files", "terminal"], pinned: [] };

  test("keeps a valid arrangement for each panel, including an empty pin set", () => {
    const value = {
      right: { order: ["side_chat", "new_page", "review"], pinned: ["review", "side_chat"] },
      bottom,
    };

    expect(decodeNewTabShortcutPreferences(value)).toEqual(value);
  });

  test("keeps the first occurrence of each recognized tool and drops Browser", () => {
    expect(
      decodeNewTabShortcutPreferences({
        right: {
          order: ["browser", "files", 3, "files", "unknown", "new_page", "page_stage"],
          pinned: ["terminal", null, "browser", "terminal", "new_page", "unknown"],
        },
      }),
    ).toEqual({
      right: { order: ["files", "new_page", "page_stage"], pinned: ["terminal", "new_page"] },
    });
  });

  test.each([[null], [false], ["right"], [[]]])(
    "defaults both panels for a malformed root (%j)",
    (value) => {
      expect(decodeNewTabShortcutPreferences(value)).toEqual({});
    },
  );

  test.each([
    [null],
    [[]],
    [{ order: ["files"] }],
    [{ pinned: ["files"] }],
    [{ order: "files", pinned: [] }],
    [{ order: [], pinned: {} }],
  ])("defaults only the malformed panel (%j)", (right) => {
    expect(decodeNewTabShortcutPreferences({ right, bottom })).toEqual({ bottom });
  });

  test("ignores unknown and inherited panel keys", () => {
    const value = Object.assign(Object.create({ right: bottom }), { left: bottom, bottom });

    expect(decodeNewTabShortcutPreferences(value)).toEqual({ bottom });
  });

  test("defaults an unreadable panel without losing the other panel", () => {
    const value = {
      get right() {
        throw new Error("Unreadable preference");
      },
      bottom,
    };

    expect(decodeNewTabShortcutPreferences(value)).toEqual({ bottom });
  });
});
