import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { render } from "../test/dom";
import {
  handleWorkbenchMouseNavigationShortcut,
  handleWorkbenchShortcut,
  createWorkbenchShortcutRuntimeState,
  resolveWorkbenchMouseNavigationShortcut,
  shouldUseRendererWorkbenchCommandFallback,
  useWorkbenchShortcuts,
  type WorkbenchShortcutActions,
} from "./use-workbench-shortcuts";
import { createCommandKeymapState } from "../../shared/command-keybindings";
import {
  markContextualKeyboardActionTargetActive,
  registerContextualKeyboardActionTarget,
  resetContextualKeyboardActionRegistryForTests,
} from "./contextual-keyboard-actions";

test("uses the renderer workbench-command fallback only without native command ingress", () => {
  expect(shouldUseRendererWorkbenchCommandFallback(false)).toBe(true);
  expect(shouldUseRendererWorkbenchCommandFallback(true)).toBe(false);
});

function makeInputTarget(): EventTarget {
  return { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
}

function makeNfmEditorTarget(): EventTarget {
  return {
    tagName: "DIV",
    isContentEditable: true,
  } as unknown as EventTarget;
}

function makeComposerTarget(): EventTarget {
  return {
    tagName: "TEXTAREA",
    isContentEditable: false,
    getAttribute: (name: string) => (name === "data-nodex-keyboard-context" ? "composer" : null),
  } as unknown as EventTarget;
}

function makeTerminalTarget(): EventTarget {
  return {
    tagName: "DIV",
    isContentEditable: false,
    getAttribute: (name: string) => (name === "data-nodex-keyboard-scope" ? "terminal" : null),
  } as unknown as EventTarget;
}

function makeActions(overrides: Partial<WorkbenchShortcutActions> = {}): WorkbenchShortcutActions {
  return {
    projectOrder: ["a", "b", "c"],
    switchToProjectIndex: () => {},
    onRequestCommandPalette: () => {},
    onRequestContentSearch: () => {},
    onRequestSettingsToggle: () => {},
    onRequestKeyboardShortcuts: () => {},
    onRequestProcessManager: () => {},
    ...overrides,
  };
}

function ShortcutHarness({ actions }: { actions: WorkbenchShortcutActions }) {
  useWorkbenchShortcuts(actions);
  return createElement("div");
}

describe("handleWorkbenchShortcut", () => {
  test("routes literal Ctrl+Shift+M once to the active composer from editable focus", () => {
    const captured: string[] = [];
    resetContextualKeyboardActionRegistryForTests();
    registerContextualKeyboardActionTarget("composer", {
      surfaceId: "composer",
      presentationId: "thread-tab",
      canExecute: (commandId) => commandId === "openModelPicker",
      execute: (commandId) => {
        captured.push(commandId);
        return true;
      },
    });
    markContextualKeyboardActionTargetActive("composer");

    const handled = handleWorkbenchShortcut(
      {
        key: "m",
        code: "KeyM",
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: false,
        target: makeComposerTarget(),
      },
      makeActions(),
      true,
    );

    expect(handled).toBe(true);
    expect(captured).toEqual(["openModelPicker"]);
    resetContextualKeyboardActionRegistryForTests();
  });

  test("routes every Board navigation, selection, and move binding", () => {
    const captured: string[] = [];
    resetContextualKeyboardActionRegistryForTests();
    registerContextualKeyboardActionTarget("board", {
      surfaceId: "board",
      presentationId: "tab",
      canExecute: () => true,
      execute: (commandId) => {
        captured.push(commandId);
        return true;
      },
    });
    markContextualKeyboardActionTargetActive("board");
    const cases = [
      { key: "j", code: "KeyJ" },
      { key: "k", code: "KeyK" },
      { key: "ArrowDown", code: "ArrowDown" },
      { key: "ArrowUp", code: "ArrowUp" },
      { key: "ArrowLeft", code: "ArrowLeft" },
      { key: "ArrowRight", code: "ArrowRight" },
      { key: "x", code: "KeyX" },
      { key: "ArrowUp", code: "ArrowUp", altKey: true },
      { key: "ArrowDown", code: "ArrowDown", altKey: true },
      { key: "ArrowUp", code: "ArrowUp", altKey: true, shiftKey: true },
      { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true },
      { key: "ArrowLeft", code: "ArrowLeft", altKey: true },
      { key: "ArrowRight", code: "ArrowRight", altKey: true },
    ];

    try {
      for (const input of cases) {
        expect(
          handleWorkbenchShortcut(
            {
              key: input.key,
              code: input.code,
              ctrlKey: false,
              metaKey: false,
              shiftKey: input.shiftKey ?? false,
              altKey: input.altKey ?? false,
              target: null,
            },
            makeActions(),
            true,
          ),
        ).toBe(true);
      }
      expect(captured).toEqual([
        "boardFocusNext",
        "boardFocusPrevious",
        "boardFocusNext",
        "boardFocusPrevious",
        "boardFocusLeft",
        "boardFocusRight",
        "boardToggleSelection",
        "boardMoveUp",
        "boardMoveDown",
        "boardMoveTop",
        "boardMoveBottom",
        "boardMoveLeft",
        "boardMoveRight",
      ]);
    } finally {
      resetContextualKeyboardActionRegistryForTests();
    }
  });

  test("Cmd+Alt+R requests chat rename", () => {
    let source = "";
    const actions = makeActions({
      onRequestRenameThread: (nextSource) => {
        source = nextSource;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "R",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: true,
        target: makeInputTarget(),
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(source).toBe("keyboard_shortcut");
  });

  test("terminal focus leaves app-level shortcuts unhandled", () => {
    let opened = false;
    const actions = makeActions({
      onRequestCommandPalette: () => {
        opened = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "k",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeTerminalTarget(),
      },
      actions,
      true,
    );

    expect(handled).toBe(false);
    expect(opened).toBe(false);
  });

  test("Cmd+number remains available to the selected surface", () => {
    const handled = handleWorkbenchShortcut(
      {
        key: "3",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      makeActions(),
      true,
    );

    expect(handled).toBe(false);
  });

  test("Cmd+J requests the bottom-panel command from editable targets", () => {
    const commands: string[] = [];
    const handled = handleWorkbenchShortcut(
      {
        key: "j",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeInputTarget(),
      },
      makeActions({
        onRequestWorkbenchCommand: (commandId) => commands.push(commandId),
      }),
      true,
    );

    expect(handled).toBe(true);
    expect(commands).toEqual(["toggleBottomPanel"]);
  });

  test("Ctrl+J requests the bottom-panel command on Windows and Linux", () => {
    const commands: string[] = [];
    const handled = handleWorkbenchShortcut(
      {
        key: "j",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      makeActions({
        onRequestWorkbenchCommand: (commandId) => commands.push(commandId),
      }),
      false,
    );

    expect(handled).toBe(true);
    expect(commands).toEqual(["toggleBottomPanel"]);
  });

  test.each([
    ["macOS", true, false],
    ["windows", false, true],
    ["linux", false, true],
  ] as const)("dispatches full view from editable surfaces on %s", (platform, metaKey, ctrlKey) => {
    for (const target of [makeInputTarget(), makeNfmEditorTarget(), makeComposerTarget()]) {
      const commands: string[] = [];
      expect(
        handleWorkbenchShortcut(
          { key: "F", code: "KeyF", metaKey, ctrlKey, shiftKey: true, altKey: false, target },
          makeActions({
            commandKeymapState: createCommandKeymapState({}, platform),
            onRequestWorkbenchCommand: (id) => commands.push(id),
          }),
          platform === "macOS",
        ),
      ).toBe(true);
      expect(commands).toEqual(["toggleFullView"]);
    }
  });

  test("full view respects custom bindings and explicit unassignment", () => {
    const commands: string[] = [];
    const event = {
      key: "F",
      code: "KeyF",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      target: makeNfmEditorTarget(),
    };
    const actions = makeActions({
      commandKeymapState: createCommandKeymapState(
        { toggleFullView: ["CmdOrCtrl+Alt+F"] },
        "macOS",
      ),
      onRequestWorkbenchCommand: (id) => commands.push(id),
    });
    expect(handleWorkbenchShortcut(event, actions, true)).toBe(false);
    expect(
      handleWorkbenchShortcut({ ...event, shiftKey: false, altKey: true }, actions, true),
    ).toBe(true);
    expect(commands).toEqual(["toggleFullView"]);
    expect(
      handleWorkbenchShortcut(
        event,
        {
          ...actions,
          commandKeymapState: createCommandKeymapState({ toggleFullView: [] }, "macOS"),
        },
        true,
      ),
    ).toBe(false);
    expect(commands).toEqual(["toggleFullView"]);
  });

  test("leaves full view to native ingress and ignores consumed, composing, and repeated keys", () => {
    const commands: string[] = [];
    const event = {
      key: "F",
      code: "KeyF",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      target: makeInputTarget(),
    };
    expect(handleWorkbenchShortcut(event, makeActions(), true)).toBe(false);
    for (const blocked of [{ defaultPrevented: true }, { isComposing: true }, { repeat: true }]) {
      expect(
        handleWorkbenchShortcut(
          { ...event, ...blocked },
          makeActions({
            onRequestWorkbenchCommand: (id) => commands.push(id),
          }),
          true,
        ),
      ).toBe(false);
    }
    expect(commands).toEqual([]);
  });

  test("Create Page bindings run only for fresh events outside locally owned surfaces", () => {
    let requests = 0;
    const actions = makeActions({
      onRequestCreatePage: () => {
        requests += 1;
        return true;
      },
    });
    const event = (
      target: EventTarget | null,
      overrides: {
        metaKey?: boolean;
        shiftKey?: boolean;
        isComposing?: boolean;
        repeat?: boolean;
      } = {},
    ) => ({
      key: "c",
      ctrlKey: false,
      metaKey: overrides.metaKey ?? false,
      shiftKey: overrides.shiftKey ?? false,
      altKey: false,
      target,
      defaultPrevented: false,
      isComposing: overrides.isComposing ?? false,
      repeat: overrides.repeat ?? false,
      keyCode: 67,
      composedPath: () => (target ? [target] : []),
    });

    expect(handleWorkbenchShortcut(event(null), actions, true)).toBe(true);
    expect(handleWorkbenchShortcut(event(makeInputTarget()), actions, true)).toBe(false);
    expect(handleWorkbenchShortcut(event(makeComposerTarget()), actions, true)).toBe(false);
    expect(handleWorkbenchShortcut(event(makeNfmEditorTarget()), actions, true)).toBe(false);
    expect(handleWorkbenchShortcut(event(makeTerminalTarget()), actions, true)).toBe(false);
    expect(handleWorkbenchShortcut(event(null, { isComposing: true }), actions, true)).toBe(false);
    expect(handleWorkbenchShortcut(event(null, { repeat: true }), actions, true)).toBe(false);
    expect(
      handleWorkbenchShortcut(event(null, { metaKey: true, shiftKey: true }), actions, true),
    ).toBe(true);
    expect(requests).toBe(2);
  });

  test("leaves Create Page unhandled when the workflow rejects the request", () => {
    const handled = handleWorkbenchShortcut(
      {
        key: "c",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
        defaultPrevented: false,
        isComposing: false,
        repeat: false,
        keyCode: 67,
        composedPath: () => [],
      },
      makeActions({ onRequestCreatePage: () => false }),
      true,
    );

    expect(handled).toBe(false);
  });

  test("opens the expanded Page composer with V outside editable surfaces", () => {
    const commands: string[] = [];
    const handled = handleWorkbenchShortcut(
      {
        key: "v",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      makeActions({
        onRequestCreatePageExpanded: () => {
          commands.push("createPageExpanded");
          return true;
        },
      }),
      true,
    );

    expect(handled).toBe(true);
    expect(commands).toEqual(["createPageExpanded"]);
  });

  test("routes G then P through the sequence runtime and fails open in inputs", () => {
    let goToPagesCalls = 0;
    const actions = makeActions({
      onRequestGoToPages: () => {
        goToPagesCalls += 1;
      },
    });
    const runtime = createWorkbenchShortcutRuntimeState();
    const event = (key: string, target: EventTarget | null = null) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target,
    });

    expect(handleWorkbenchShortcut(event("g"), actions, true, runtime)).toBe(true);
    expect(goToPagesCalls).toBe(0);
    expect(handleWorkbenchShortcut(event("p"), actions, true, runtime)).toBe(true);
    expect(goToPagesCalls).toBe(1);

    const inputRuntime = createWorkbenchShortcutRuntimeState();
    expect(
      handleWorkbenchShortcut(event("g", makeInputTarget()), actions, true, inputRuntime),
    ).toBe(false);
    expect(
      handleWorkbenchShortcut(event("p", makeInputTarget()), actions, true, inputRuntime),
    ).toBe(false);
    expect(goToPagesCalls).toBe(1);
  });

  test("shows contextual shortcut help with question mark", () => {
    let calls = 0;
    const handled = handleWorkbenchShortcut(
      {
        key: "?",
        code: "Slash",
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        altKey: false,
        target: null,
      },
      makeActions({
        onRequestKeyboardShortcuts: () => {
          calls += 1;
        },
      }),
      true,
    );

    expect(handled).toBe(true);
    expect(calls).toBe(1);
  });

  test("uses a remapped Create Page binding instead of the default", () => {
    let requests = 0;
    const actions = makeActions({
      commandKeymapState: createCommandKeymapState(
        {
          createPage: ["CmdOrCtrl+Alt+C"],
        },
        "macOS",
      ),
      onRequestCreatePage: () => {
        requests += 1;
        return true;
      },
    });

    expect(
      handleWorkbenchShortcut(
        {
          key: "c",
          ctrlKey: false,
          metaKey: true,
          shiftKey: true,
          altKey: false,
          target: null,
        },
        actions,
        true,
      ),
    ).toBe(false);
    expect(
      handleWorkbenchShortcut(
        {
          key: "c",
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
          altKey: true,
          target: null,
        },
        actions,
        true,
      ),
    ).toBe(true);
    expect(requests).toBe(1);
  });

  test("an explicitly unassigned bottom-panel command does not handle Cmd+J", () => {
    const handled = handleWorkbenchShortcut(
      {
        key: "j",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      makeActions({
        commandKeymapState: createCommandKeymapState({ toggleBottomPanel: [] }, "macOS"),
        onRequestWorkbenchCommand: () => {
          throw new Error("Explicitly unassigned commands must not execute");
        },
      }),
      true,
    );

    expect(handled).toBe(false);
  });

  test("a custom bottom-panel binding replaces the default binding", () => {
    const commands: string[] = [];
    const actions = makeActions({
      commandKeymapState: createCommandKeymapState(
        {
          toggleBottomPanel: ["CmdOrCtrl+Alt+J"],
        },
        "macOS",
      ),
      onRequestWorkbenchCommand: (commandId) => commands.push(commandId),
    });

    const defaultHandled = handleWorkbenchShortcut(
      {
        key: "j",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );
    const customHandled = handleWorkbenchShortcut(
      {
        key: "j",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: true,
        target: null,
      },
      actions,
      true,
    );

    expect(defaultHandled).toBe(false);
    expect(customHandled).toBe(true);
    expect(commands).toEqual(["toggleBottomPanel"]);
  });

  test("Cmd+N is reserved for the workbench shell new chat action", () => {
    let called = false;
    const actions = makeActions({
      onRequestNewWindow: () => {
        called = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "n",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(false);
    expect(called).toBe(false);
  });

  test("Cmd+Shift+N requests a new window", () => {
    let called = false;
    const actions = makeActions({
      onRequestNewWindow: () => {
        called = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "N",
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
  });

  test("Cmd+K opens the command palette even inside inputs", () => {
    let called = false;
    const actions = makeActions({
      onRequestCommandPalette: () => {
        called = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "k",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeInputTarget(),
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
  });

  test("Cmd+P opens Page search", () => {
    let mode = "";
    const actions = makeActions({
      onRequestCommandPalette: (request) => {
        mode = request?.mode ?? "";
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "P",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(mode).toBe("pages");
  });

  test("Cmd+P opens Page search inside editable targets", () => {
    let calls = 0;
    let mode = "";
    const actions = makeActions({
      onRequestCommandPalette: (request) => {
        calls += 1;
        mode = request?.mode ?? "";
      },
    });

    for (const target of [makeInputTarget(), makeComposerTarget(), makeNfmEditorTarget()]) {
      const handled = handleWorkbenchShortcut(
        {
          key: "p",
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
          altKey: false,
          target,
        },
        actions,
        true,
      );

      expect(handled).toBe(true);
      expect(mode).toBe("pages");
    }

    expect(calls).toBe(3);
  });

  test("Cmd+G opens chats search", () => {
    let mode = "";
    const actions = makeActions({
      onRequestCommandPalette: (request) => {
        mode = request?.mode ?? "";
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "g",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(mode).toBe("chats");
  });

  test("Cmd+B toggles the sidebar from non-editable shell focus", () => {
    let source = "";
    const handled = handleWorkbenchShortcut(
      {
        key: "b",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      makeActions({
        onToggleSidebar: (nextSource) => {
          source = nextSource;
        },
      }),
      true,
    );

    expect(handled).toBe(true);
    expect(source).toBe("keyboard_shortcut");
  });

  test("Cmd+B toggles the sidebar from the composer with the Codex composer source", () => {
    let source = "";
    const handled = handleWorkbenchShortcut(
      {
        key: "B",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeComposerTarget(),
      },
      makeActions({
        onToggleSidebar: (nextSource) => {
          source = nextSource;
        },
      }),
      true,
    );

    expect(handled).toBe(true);
    expect(source).toBe("composer_sidebar_shortcut");
  });

  test("Cmd+B is left to editable non-composer surfaces", () => {
    let called = false;
    const handled = handleWorkbenchShortcut(
      {
        key: "b",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeNfmEditorTarget(),
      },
      makeActions({
        onToggleSidebar: () => {
          called = true;
        },
      }),
      true,
    );

    expect(handled).toBe(false);
    expect(called).toBe(false);
  });

  test("Cmd+F opens the current Workbench content search", () => {
    let contentSearchCalled = false;
    let contentSearchDomain: string | undefined;
    const actions = makeActions({
      onRequestContentSearch: (preferredDomain) => {
        contentSearchCalled = true;
        contentSearchDomain = preferredDomain;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "f",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeInputTarget(),
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(contentSearchCalled).toBe(true);
    expect(contentSearchDomain).toBeUndefined();
  });

  test("Cmd+F can cycle content-search domains from its own input", () => {
    let contentSearchCalled = false;
    const actions = makeActions({
      onRequestContentSearch: () => {
        contentSearchCalled = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "f",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeInputTarget(),
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(contentSearchCalled).toBe(true);
  });

  test("Cmd+[ navigates back even inside inputs", () => {
    let called = false;
    let source = "";
    const handled = handleWorkbenchShortcut(
      {
        key: "[",
        code: "BracketLeft",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeInputTarget(),
      },
      makeActions({
        navigateBack: (nextSource) => {
          called = true;
          source = nextSource;
        },
      }),
      true,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
    expect(source).toBe("keyboard_shortcut");
  });

  test("Ctrl+] navigates forward on non-mac platforms", () => {
    let called = false;
    let source = "";
    const handled = handleWorkbenchShortcut(
      {
        key: "]",
        code: "BracketRight",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      makeActions({
        navigateForward: (nextSource) => {
          called = true;
          source = nextSource;
        },
      }),
      false,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
    expect(source).toBe("keyboard_shortcut");
  });

  test("Cmd+comma toggles settings globally", () => {
    let called = false;
    const actions = makeActions({
      onRequestSettingsToggle: () => {
        called = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: ",",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: makeInputTarget(),
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
  });

  test("custom command keymap shortcut drives settings toggle", () => {
    let opened = false;
    const actions = makeActions({
      onRequestSettingsToggle: () => {
        opened = true;
      },
      commandKeymapState: createCommandKeymapState({ settings: ["CmdOrCtrl+Alt+,"] }, "macOS"),
    });

    const handled = handleWorkbenchShortcut(
      {
        key: ",",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: true,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(opened).toBe(true);
  });

  test("Cmd+Shift+slash opens keyboard shortcuts settings globally", () => {
    let called = false;
    const actions = makeActions({
      onRequestKeyboardShortcuts: () => {
        called = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "/",
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
        altKey: false,
        target: makeInputTarget(),
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
  });

  test("custom command keymap shortcut opens keyboard shortcuts settings", () => {
    let opened = false;
    const actions = makeActions({
      onRequestKeyboardShortcuts: () => {
        opened = true;
      },
      commandKeymapState: createCommandKeymapState(
        { showKeyboardShortcuts: ["CmdOrCtrl+Alt+/"] },
        "macOS",
      ),
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "/",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: true,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(opened).toBe(true);
  });

  test("Ctrl+Alt+M opens the process manager", () => {
    let opened = false;
    const actions = makeActions({
      onRequestProcessManager: () => {
        opened = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "m",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: true,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(opened).toBe(true);
  });

  test("Cmd+H remains available to the selected surface", () => {
    const handled = handleWorkbenchShortcut(
      {
        key: "h",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      makeActions(),
      true,
    );

    expect(handled).toBe(false);
  });

  test("Cmd+L is reserved for browser address focus", () => {
    const handled = handleWorkbenchShortcut(
      {
        key: "l",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      makeActions(),
      true,
    );

    expect(handled).toBe(false);
  });

  test("Cmd+Alt+number switches to project index", () => {
    let selectedProjectIndex = -1;
    const actions = makeActions({
      switchToProjectIndex: (index) => (selectedProjectIndex = index),
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "2",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: true,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(selectedProjectIndex).toBe(1);
  });

  test("Cmd+Shift+P opens root command search", () => {
    let mode = "";
    const actions = makeActions({
      onRequestCommandPalette: (request) => (mode = request?.mode ?? ""),
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "P",
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(mode).toBe("root");
  });

  test("Cmd+F opens content search without requiring a Project", () => {
    let called = false;
    const actions = makeActions({
      onRequestContentSearch: () => {
        called = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "f",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
  });

  test("Cmd+F opens content search from editable targets", () => {
    let called = false;
    const target = makeInputTarget();
    const actions = makeActions({
      onRequestContentSearch: () => {
        called = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "f",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
  });

  test("Cmd+Shift+P opens root command search inside NFM editor target", () => {
    let mode = "";
    const target = makeNfmEditorTarget();
    const actions = makeActions({
      onRequestCommandPalette: (request) => (mode = request?.mode ?? ""),
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "P",
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
        altKey: false,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(mode).toBe("root");
  });

  test("Cmd+Shift+P opens root command search inside plain inputs and composer targets", () => {
    let calls = 0;
    let lastMode = "";
    const actions = makeActions({
      onRequestCommandPalette: (request) => {
        calls += 1;
        lastMode = request?.mode ?? "";
      },
    });

    for (const target of [makeInputTarget(), makeComposerTarget()]) {
      const handled = handleWorkbenchShortcut(
        {
          key: "p",
          ctrlKey: false,
          metaKey: true,
          shiftKey: true,
          altKey: false,
          target,
        },
        actions,
        true,
      );

      expect(handled).toBe(true);
      expect(lastMode).toBe("root");
    }

    expect(calls).toBe(2);
  });

  test("Cmd+F opens content search inside NFM editor targets", () => {
    let called = false;
    const target = makeNfmEditorTarget();
    const actions = makeActions({ onRequestContentSearch: () => (called = true) });

    const handled = handleWorkbenchShortcut(
      {
        key: "f",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBe(true);
    expect(called).toBe(true);
  });

  test("Cmd+Alt+number remains unhandled inside NFM editor target", () => {
    let selectedProjectIndex = -1;
    const target = makeNfmEditorTarget();
    const actions = makeActions({
      switchToProjectIndex: (index) => (selectedProjectIndex = index),
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "1",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: true,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBe(false);
    expect(selectedProjectIndex).toBe(-1);
  });

  test("Cmd+number remains blocked for plain input targets", () => {
    const target = makeInputTarget();

    const handled = handleWorkbenchShortcut(
      {
        key: "1",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target,
      },
      makeActions(),
      true,
    );

    expect(handled).toBe(false);
  });

  test("ignores editable targets", () => {
    const target = makeInputTarget();
    const actions = makeActions();

    const handled = handleWorkbenchShortcut(
      {
        key: "Tab",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBe(false);
  });

  test("Cmd+H remains blocked for plain input targets", () => {
    const target = makeInputTarget();

    const handled = handleWorkbenchShortcut(
      {
        key: "h",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target,
      },
      makeActions(),
      true,
    );

    expect(handled).toBe(false);
  });
});

describe("handleWorkbenchMouseNavigationShortcut", () => {
  test("classifies browser back and forward mouse buttons", () => {
    expect(resolveWorkbenchMouseNavigationShortcut({ button: 3 })).toBe("back");
    expect(resolveWorkbenchMouseNavigationShortcut({ button: 4 })).toBe("forward");
    expect(resolveWorkbenchMouseNavigationShortcut({ button: 1 })).toBe(null);
  });

  test("MouseBack runs the back navigation command source", () => {
    let source = "";
    const handled = handleWorkbenchMouseNavigationShortcut(
      { button: 3 },
      makeActions({
        navigateBack: (nextSource) => {
          source = nextSource;
        },
      }),
    );

    expect(handled).toBe(true);
    expect(source).toBe("mouse_back");
  });

  test("MouseForward runs the forward navigation command source", () => {
    let source = "";
    const handled = handleWorkbenchMouseNavigationShortcut(
      { button: 4 },
      makeActions({
        navigateForward: (nextSource) => {
          source = nextSource;
        },
      }),
    );

    expect(handled).toBe(true);
    expect(source).toBe("mouse_forward");
  });

  test("unhandled mouse buttons do not claim the event", () => {
    const handled = handleWorkbenchMouseNavigationShortcut({ button: 0 }, makeActions());

    expect(handled).toBe(false);
  });
});

describe("useWorkbenchShortcuts", () => {
  test("lets a focused target own the key before the app-level shortcut listener", () => {
    let called = false;
    let targetSawDefaultPrevented = false;
    const actions = makeActions({
      onRequestCommandPalette: () => {
        called = true;
      },
    });
    const view = render(createElement(ShortcutHarness, { actions }));
    const input = document.createElement("input");
    input.addEventListener("keydown", (event) => {
      targetSawDefaultPrevented = event.defaultPrevented;
      event.stopPropagation();
    });
    document.body.appendChild(input);
    const isMac = navigator.platform.toUpperCase().includes("MAC");

    act(() => {
      fireEvent.keyDown(input, { key: "p", ctrlKey: !isMac, metaKey: isMac });
    });

    input.remove();
    view.unmount();
    expect(called).toBe(false);
    expect(targetSawDefaultPrevented).toBe(false);
  });
});
