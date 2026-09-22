import { describe, expect, test } from "vite-plus/test";
import {
  applyCommandKeybindingUpdate,
  CODEX_COMMAND_REGISTRY,
  compileMacNativeHotkey,
  validateGlobalDictationShortcut,
  createKeyboardLayoutSnapshot,
  createCommandKeymapState,
  findCommandKeybindingConflict,
  formatAcceleratorAriaKeyShortcut,
  formatAcceleratorLabel,
  formatCommandShortcutLabel,
  getPrimaryCommandAccelerator,
  keyboardEventToAccelerator,
  matchKeyboardShortcutSequence,
  matchesKeyboardEventToCommand,
  matchesMouseEventToCommand,
  normalizeAccelerator,
  normalizeCommandKeybindingOverrides,
  NEXT_PANEL_TAB_COMMAND_ID,
  PREVIOUS_PANEL_TAB_COMMAND_ID,
  resolveRuntimePlatform,
  resolveCommandShortcutPresentation,
  toElectronAccelerator,
  type KeyboardShortcutEventLike,
} from "./command-keybindings";

function keyboardEvent(
  key: string,
  overrides: Partial<KeyboardShortcutEventLike> = {},
): KeyboardShortcutEventLike {
  return {
    key,
    code: overrides.code ?? "",
    metaKey: overrides.metaKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    altKey: overrides.altKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
  };
}

describe("command keybindings", () => {
  test("preserves Windows global modifier spelling through admission and storage", () => {
    for (const key of ["Meta+K", "CommandOrControl+K", "Super+K"]) {
      expect(() =>
        applyCommandKeybindingUpdate(
          {},
          "globalDictationHold",
          { type: "set", keybinding: { key } },
          "windows",
        ),
      ).toThrow();
      expect(
        normalizeCommandKeybindingOverrides({ globalDictationHold: [key] }, "windows"),
      ).toEqual({});
    }
    const updated = applyCommandKeybindingUpdate(
      {},
      "globalDictationHold",
      { type: "set", keybinding: { key: "Super+Shift+K" } },
      "windows",
    );
    const restored = normalizeCommandKeybindingOverrides(updated, "windows");
    expect(restored.globalDictationHold).toEqual(["Super+Shift+K"]);
    expect(
      createCommandKeymapState(restored, "windows").entries.find(
        (entry) => entry.id === "globalDictationHold",
      )?.keybindings,
    ).toEqual([{ key: "Super+Shift+K" }]);
    expect(
      applyCommandKeybindingUpdate(
        {},
        "toggleSidebar",
        { type: "set", keybinding: { key: "Meta+K" } },
        "windows",
      ).toggleSidebar,
    ).toEqual(["Command+K"]);
  });

  test("formats platform labels and normalizes CmdOrCtrl accelerators", () => {
    expect(normalizeAccelerator("CommandOrControl+Alt+r")).toBe("CmdOrCtrl+Alt+R");
    expect(formatAcceleratorLabel("CmdOrCtrl+Alt+R", "macOS")).toBe("⌘⌥R");
    expect(formatAcceleratorLabel("CmdOrCtrl+Alt+R", "windows")).toBe("Ctrl+Alt+R");
    expect(formatAcceleratorAriaKeyShortcut("CmdOrCtrl+Alt+R", "macOS")).toBe("Meta+Alt+R");
    expect(formatAcceleratorAriaKeyShortcut("Ctrl+Shift+M", "macOS")).toBe("Control+Shift+M");
    expect(formatAcceleratorLabel("LeftControl", "macOS")).toBe("Left ⌃");
    expect(formatAcceleratorLabel("DoubleOption", "macOS")).toBe("⌥ + ⌥");
    expect(formatAcceleratorLabel("RightCommand", "windows")).toBe("Right Command");
  });

  test("projects command shortcuts for visible and assistive labels", () => {
    const defaultState = createCommandKeymapState({}, "macOS");
    const customState = createCommandKeymapState(
      {
        openModelPicker: ["CmdOrCtrl+Alt+M"],
      },
      "macOS",
    );
    const unassignedState = createCommandKeymapState(
      {
        openModelPicker: [],
      },
      "macOS",
    );

    expect(resolveCommandShortcutPresentation(defaultState, "openModelPicker")).toEqual({
      label: "⌃⇧M",
      ariaKeyShortcuts: "Control+Shift+M",
    });
    expect(resolveCommandShortcutPresentation(customState, "openModelPicker")).toEqual({
      label: "⌘⌥M",
      ariaKeyShortcuts: "Meta+Alt+M",
    });
    expect(resolveCommandShortcutPresentation(unassignedState, "openModelPicker")).toBeNull();
  });

  test("matches CmdOrCtrl keyboard events by platform", () => {
    const macState = createCommandKeymapState({}, "macOS");
    const windowsState = createCommandKeymapState({}, "windows");

    expect(
      matchesKeyboardEventToCommand(
        keyboardEvent("b", { metaKey: true }),
        macState,
        "toggleSidebar",
      ),
    ).toBe(true);
    expect(
      matchesKeyboardEventToCommand(
        keyboardEvent("b", { ctrlKey: true }),
        windowsState,
        "toggleSidebar",
      ),
    ).toBe(true);
    expect(
      matchesKeyboardEventToCommand(
        keyboardEvent("b", { ctrlKey: true }),
        macState,
        "toggleSidebar",
      ),
    ).toBe(false);
  });

  test("matches physical Control literals on every platform", () => {
    const controlM = keyboardEvent("m", { ctrlKey: true });

    for (const platform of ["macOS", "windows", "linux"] as const) {
      expect(
        matchesKeyboardEventToCommand(
          controlM,
          createCommandKeymapState({}, platform),
          "composerDictationHold",
        ),
      ).toBe(true);
    }

    expect(
      matchesKeyboardEventToCommand(
        keyboardEvent("m", { metaKey: true }),
        createCommandKeymapState({}, "macOS"),
        "composerDictationHold",
      ),
    ).toBe(false);
  });

  test("does not restore fallback labels for explicitly unassigned commands", () => {
    const state = createCommandKeymapState({ toggleBottomPanel: [] }, "macOS");
    const runtimeFallback = resolveRuntimePlatform() === "macOS" ? "⌘J" : "Ctrl+J";

    expect(formatCommandShortcutLabel(state, "toggleBottomPanel", "CmdOrCtrl+J")).toBeUndefined();
    expect(formatCommandShortcutLabel(undefined, "toggleBottomPanel", "CmdOrCtrl+J")).toBe(
      runtimeFallback,
    );
  });

  test("keeps close-tab and close-window defaults distinct", () => {
    const macState = createCommandKeymapState({}, "macOS");

    expect(getPrimaryCommandAccelerator(macState, PREVIOUS_PANEL_TAB_COMMAND_ID)).toBe(
      "CmdOrCtrl+Shift+[",
    );
    expect(getPrimaryCommandAccelerator(macState, NEXT_PANEL_TAB_COMMAND_ID)).toBe(
      "CmdOrCtrl+Shift+]",
    );
    expect(
      toElectronAccelerator(getPrimaryCommandAccelerator(macState, NEXT_PANEL_TAB_COMMAND_ID)),
    ).toBe("CommandOrControl+Shift+]");
    expect(getPrimaryCommandAccelerator(macState, "closeTab")).toBe("CmdOrCtrl+W");
    expect(getPrimaryCommandAccelerator(macState, "closeWindow")).toBe("CmdOrCtrl+Shift+W");
    expect(toElectronAccelerator(getPrimaryCommandAccelerator(macState, "closeWindow"))).toBe(
      "CommandOrControl+Shift+W",
    );
    expect(formatAcceleratorLabel("CmdOrCtrl+Shift+W", "macOS")).toBe("⌘⇧W");
    expect(
      matchesKeyboardEventToCommand(keyboardEvent("w", { metaKey: true }), macState, "closeWindow"),
    ).toBe(false);
    expect(
      matchesKeyboardEventToCommand(
        keyboardEvent("w", { metaKey: true, shiftKey: true }),
        macState,
        "closeWindow",
      ),
    ).toBe(true);
  });

  test("captures keyboard events and mouse navigation bindings", () => {
    expect(
      keyboardEventToAccelerator(keyboardEvent("A", { metaKey: true, shiftKey: true }), "macOS"),
    ).toBe("CmdOrCtrl+Shift+A");
    expect(keyboardEventToAccelerator(keyboardEvent("+", { shiftKey: true }), "macOS")).toBe(
      "Shift+Plus",
    );
    expect(formatAcceleratorLabel("Shift+Plus", "macOS")).toBe("⇧+");

    const state = createCommandKeymapState({}, "macOS");
    expect(matchesMouseEventToCommand({ button: 3 }, state, "navigateBack")).toBe(true);
    expect(matchesMouseEventToCommand({ button: 4 }, state, "navigateForward")).toBe(true);
  });

  test("captures Alt chords from their physical code instead of the Option-produced character", () => {
    expect(
      keyboardEventToAccelerator(keyboardEvent("¥", { altKey: true, code: "KeyY" }), "macOS"),
    ).toBe("Alt+Y");
    expect(
      keyboardEventToAccelerator(keyboardEvent("å", { altKey: true, code: "KeyA" }), "macOS"),
    ).toBe("Alt+A");

    const dvorak = createKeyboardLayoutSnapshot(4, { KeyY: "f", KeyA: "a" });
    expect(
      keyboardEventToAccelerator(keyboardEvent("ƒ", { altKey: true, code: "KeyY" }), "macOS", {
        keyboardLayout: dvorak,
      }),
    ).toBe("Alt+F");
  });

  test("applies set append remove and reset update shapes", () => {
    const setOverrides = applyCommandKeybindingUpdate(
      {},
      "openThreadInNewWindow",
      {
        type: "set",
        keybinding: { key: "CmdOrCtrl+Alt+W" },
      },
      "macOS",
    );
    expect(JSON.stringify(setOverrides)).toBe(
      JSON.stringify({ openThreadInNewWindow: ["CmdOrCtrl+Alt+W"] }),
    );

    const appendOverrides = applyCommandKeybindingUpdate(
      {},
      "newThread",
      {
        type: "append",
        keybinding: { key: "CmdOrCtrl+Alt+Shift+N" },
      },
      "macOS",
    );
    expect(JSON.stringify(appendOverrides.newThread)).toBe(
      JSON.stringify(["CmdOrCtrl+N", "CmdOrCtrl+Shift+O", "CmdOrCtrl+Alt+Shift+N"]),
    );

    const removeOverrides = applyCommandKeybindingUpdate(
      appendOverrides,
      "newThread",
      {
        type: "remove",
        keybinding: { key: "CmdOrCtrl+N" },
      },
      "macOS",
    );
    expect(JSON.stringify(removeOverrides.newThread)).toBe(
      JSON.stringify(["CmdOrCtrl+Shift+O", "CmdOrCtrl+Alt+Shift+N"]),
    );

    const resetOverrides = applyCommandKeybindingUpdate(
      removeOverrides,
      "newThread",
      { type: "reset" },
      "macOS",
    );
    expect(Object.prototype.hasOwnProperty.call(resetOverrides, "newThread")).toBe(false);
  });

  test("detects conflicts and rejects invalid accelerators", () => {
    const state = createCommandKeymapState({}, "macOS");
    const conflict = findCommandKeybindingConflict(state, "renameThread", "CmdOrCtrl+B");
    expect(conflict?.commandId).toBe("toggleSidebar");

    let threw = false;
    try {
      applyCommandKeybindingUpdate(
        {},
        "renameThread",
        {
          type: "set",
          keybinding: { key: "CmdOrCtrl+B" },
        },
        "macOS",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("allows hold and toggle dictation to share one shortcut", () => {
    const overrides = { globalDictationHold: ["Fn"] };
    expect(
      applyCommandKeybindingUpdate(
        overrides,
        "globalDictationToggle",
        {
          type: "set",
          keybinding: { key: "Fn" },
        },
        "macOS",
      ),
    ).toMatchObject({ globalDictationHold: ["Fn"], globalDictationToggle: ["Fn"] });
    expect(
      findCommandKeybindingConflict(
        createCommandKeymapState(overrides, "macOS"),
        "renameThread",
        "Fn",
      )?.commandId,
    ).toBe("globalDictationHold");
  });

  test("requires Cmd/Ctrl or Alt for ordinary global dictation shortcuts", () => {
    const setGlobalHold = (key: string) =>
      applyCommandKeybindingUpdate(
        {},
        "globalDictationHold",
        { type: "set", keybinding: { key } },
        "macOS",
      );

    expect(() => setGlobalHold("Y")).toThrow("Shortcut must include Cmd/Ctrl or Alt.");
    expect(() => setGlobalHold("Shift+Y")).toThrow("Shortcut must include Cmd/Ctrl or Alt.");
    expect(() => setGlobalHold("Ctrl")).toThrow("Shortcut must include a non-modifier key.");
    expect(() => setGlobalHold("Ctrl+Y+Z")).toThrow(
      "Shortcut must include exactly one non-modifier key.",
    );
    expect(setGlobalHold("Ctrl+Y").globalDictationHold).toEqual(["Ctrl+Y"]);
    expect(setGlobalHold("Alt+Y").globalDictationHold).toEqual(["Alt+Y"]);
    expect(() => setGlobalHold("Alt+¥")).toThrow("This shortcut key is not supported.");
  });

  test("compiles canonical global shortcuts through the current keyboard layout", () => {
    expect(
      compileMacNativeHotkey({
        accelerator: "Alt+Y",
        bindingId: "global-dictation-hold",
        mode: "hold",
      }),
    ).toEqual({
      type: "compiled",
      spec: {
        bindingId: "global-dictation-hold",
        mode: "hold",
        registrationAccelerator: "Alt+Y",
        modifiers: ["option"],
        keyCode: 16,
        bareModifierKeyCodes: null,
      },
    });

    const dvorak = createKeyboardLayoutSnapshot(5, {
      KeyF: "u",
      KeyK: "t",
      KeyU: "g",
      KeyY: "f",
    });
    expect(
      compileMacNativeHotkey({
        accelerator: "Alt+F",
        bindingId: "global-dictation-toggle",
        mode: "toggle",
        layout: dvorak,
      }),
    ).toMatchObject({
      type: "compiled",
      spec: { keyCode: 16, registrationAccelerator: "Alt+Y" },
    });
  });

  test("compiles modifier-family gestures independently of modifier side", () => {
    for (const [accelerator, modifiers] of [
      ["Ctrl+Alt", ["control", "option"]],
      ["Shift+Fn", ["shift", "function"]],
      ["Meta+Control+Option", ["control", "command", "option"]],
    ] as const) {
      expect(validateGlobalDictationShortcut(accelerator, "macOS")).toBeNull();
      expect(compileMacNativeHotkey({ accelerator, bindingId: "hold", mode: "hold" })).toEqual({
        type: "compiled",
        spec: {
          bindingId: "hold",
          mode: "hold",
          registrationAccelerator: null,
          modifiers,
          keyCode: null,
          bareModifierKeyCodes: null,
        },
      });
      expect(validateGlobalDictationShortcut(accelerator, "windows")).not.toBeNull();
    }
    expect(validateGlobalDictationShortcut("Ctrl+Control", "macOS")).not.toBeNull();
  });

  test("drops persisted global bindings outside the finite native key domain", () => {
    expect(
      normalizeCommandKeybindingOverrides(
        {
          globalDictationHold: ["Alt+¥"],
          globalDictationToggle: ["Alt+Y"],
          renameThread: ["CmdOrCtrl+Alt+Ω"],
        },
        "macOS",
      ),
    ).toEqual({
      globalDictationToggle: ["Alt+Y"],
      renameThread: ["CmdOrCtrl+Alt+Ω"],
    });
    const migrated = createCommandKeymapState(
      normalizeCommandKeybindingOverrides({ globalDictationHold: ["Alt+¥"] }, "macOS"),
      "macOS",
    );
    expect(migrated.entries.find((entry) => entry.id === "globalDictationHold")).toMatchObject({
      isCustom: false,
      keybindings: [],
    });
  });

  test("admits Windows global chords without exposing macOS bare modifiers", () => {
    const overrides = applyCommandKeybindingUpdate(
      {},
      "globalDictationHold",
      { type: "set", keybinding: { key: "Ctrl+Alt+D" } },
      "windows",
    );
    expect(
      createCommandKeymapState(overrides, "windows").entries.find(
        (entry) => entry.id === "globalDictationHold",
      ),
    ).toMatchObject({ available: true, keybindings: [{ key: "Ctrl+Alt+D" }] });
    expect(normalizeCommandKeybindingOverrides({ globalDictationHold: ["Fn"] }, "windows")).toEqual(
      {},
    );
    expect(
      createCommandKeymapState({}, "linux").entries.find(
        (entry) => entry.id === "globalDictationHold",
      )?.available,
    ).toBe(false);
  });

  test("accepts only supported macOS bare global modifiers", () => {
    const setGlobalHold = (key: string) =>
      applyCommandKeybindingUpdate(
        {},
        "globalDictationHold",
        { type: "set", keybinding: { key } },
        "macOS",
      );

    expect(setGlobalHold("Fn").globalDictationHold).toEqual(["Fn"]);
    expect(setGlobalHold("LeftControl").globalDictationHold).toEqual(["LeftControl"]);
    expect(setGlobalHold("RightOption").globalDictationHold).toEqual(["RightOption"]);
    expect(setGlobalHold("LeftAlt").globalDictationHold).toEqual(["LeftOption"]);
    expect(setGlobalHold("LeftOption+RightOption").globalDictationHold).toEqual(["DoubleOption"]);
    expect(() => setGlobalHold("RightControl")).toThrow("This shortcut key is not supported.");
    expect(() => setGlobalHold("LeftShift")).toThrow("This shortcut key is not supported.");
  });

  test("uses current command palette labels and hides unavailable shell commands", () => {
    const byId = new Map(CODEX_COMMAND_REGISTRY.map((entry) => [entry.id, entry]));

    expect(byId.get("searchPages")?.title).toBe("Search Pages");
    expect(byId.get("searchFiles")?.title).toBe("Search files");
    expect(byId.get("openCommandMenu")?.title).toBe("Open command palette");
    expect(byId.get("toggleTerminal")?.title).toBe("Open terminal tab");
    expect(byId.get("searchChats")?.available).toBe(true);
    expect(byId.get("searchFiles")?.available).toBe(true);
    expect(byId.get("toggleBrowserPanel")?.available).toBe(false);
  });

  test("offers bare C as the primary Create Page shortcut with a modifier fallback", () => {
    const state = createCommandKeymapState({}, "macOS");
    const entry = state.entries.find((candidate) => candidate.id === "createPage");

    expect(entry?.keybindings).toEqual([{ key: "C" }, { key: "CmdOrCtrl+Shift+C" }]);
    expect(entry?.allowsMultiple).toBe(true);
    expect(getPrimaryCommandAccelerator(state, "createPage")).toBe("C");
    expect(formatCommandShortcutLabel(state, "createPage")).toBe("C");
  });

  test("matches configurable two-chord sequences without treating their prefix as a command", () => {
    const state = createCommandKeymapState({}, "macOS");
    const first = matchKeyboardShortcutSequence(
      keyboardEvent("g"),
      state,
      { prefix: [], expiresAt: 0 },
      { now: 100 },
    );
    expect(first.kind).toBe("pending");
    if (first.kind !== "pending") return;

    const second = matchKeyboardShortcutSequence(keyboardEvent("p"), state, first.state, {
      now: 200,
    });
    expect(second.kind).toBe("matched");
    expect(second.kind === "matched" ? second.commandId : null).toBe("goToPages");
  });

  test("expires sequences and displays question mark as one keycap", () => {
    const state = createCommandKeymapState({}, "macOS");
    const stale = matchKeyboardShortcutSequence(
      keyboardEvent("p"),
      state,
      { prefix: ["G"], expiresAt: 100 },
      { now: 101 },
    );
    expect(stale.kind).toBe("none");
    expect(formatAcceleratorLabel("Shift+/", "macOS")).toBe("?");
  });
});
