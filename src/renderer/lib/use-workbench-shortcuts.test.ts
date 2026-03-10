import { describe, expect, test } from "bun:test";
import {
  handleWorkbenchShortcut,
  type WorkbenchShortcutActions,
} from "./use-workbench-shortcuts";

function makeInputTarget(): EventTarget {
  return { tagName: "INPUT", isContentEditable: false, closest: () => null } as unknown as EventTarget;
}

function makeNfmEditorTarget(): EventTarget {
  return {
    tagName: "DIV",
    isContentEditable: true,
    closest: (selector: string) =>
      selector.includes(".nfm-editor") ? ({} as Element) : null,
  } as unknown as EventTarget;
}

function makeActions(overrides: Partial<WorkbenchShortcutActions> = {}): WorkbenchShortcutActions {
  return {
    spaces: [{ projectId: "a" }, { projectId: "b" }, { projectId: "c" }],
    dbProjectId: "a",
    focusedStage: "db",
    focusAdjacentStage: () => {},
    switchToStageIndex: () => {},
    switchToProjectIndex: () => {},
    toggleTerminalPanel: () => {},
    onRequestProjectPicker: () => {},
    onRequestTaskSearch: () => {},
    onRequestSettingsToggle: () => {},
    ...overrides,
  };
}

describe("handleWorkbenchShortcut", () => {
  test("Ctrl+Tab cycles stages forward", () => {
    let direction: -1 | 1 | null = null;
    const actions = makeActions({ focusAdjacentStage: (_, next) => (direction = next) });

    const handled = handleWorkbenchShortcut(
      {
        key: "Tab",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBeTrue();
    expect(direction).toBe(1);
  });

  test("Ctrl+Shift+Tab cycles stages backward", () => {
    let direction: -1 | 1 | null = null;
    const actions = makeActions({ focusAdjacentStage: (_, next) => (direction = next) });

    const handled = handleWorkbenchShortcut(
      {
        key: "Tab",
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBeTrue();
    expect(direction).toBe(-1);
  });

  test("Cmd+number switches to stage index", () => {
    let selectedIndex = -1;
    const actions = makeActions({ switchToStageIndex: (_, index) => (selectedIndex = index) });

    const handled = handleWorkbenchShortcut(
      {
        key: "3",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBeTrue();
    expect(selectedIndex).toBe(2);
  });

  test("Cmd+5 does not map to a stage index", () => {
    let selectedIndex = -1;
    const actions = makeActions({ switchToStageIndex: (_, index) => (selectedIndex = index) });

    const handled = handleWorkbenchShortcut(
      {
        key: "5",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBeFalse();
    expect(selectedIndex).toBe(-1);
  });

  test("Cmd+J toggles terminal panel globally", () => {
    let calledWithProjectId: string | null = null;
    const actions = makeActions({
      dbProjectId: "b",
      toggleTerminalPanel: (projectId) => {
        calledWithProjectId = projectId;
      },
    });

    const handled = handleWorkbenchShortcut(
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

    expect(handled).toBeTrue();
    expect(calledWithProjectId).toBe("b");
  });

  test("Cmd+J still works inside editable targets", () => {
    let called = false;
    const target = makeInputTarget();
    const actions = makeActions({
      toggleTerminalPanel: () => {
        called = true;
      },
    });

    const handled = handleWorkbenchShortcut(
      {
        key: "j",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBeTrue();
    expect(called).toBeTrue();
  });

  test("Cmd+N requests a new window", () => {
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

    expect(handled).toBeTrue();
    expect(called).toBeTrue();
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

    expect(handled).toBeTrue();
    expect(called).toBeTrue();
  });

  test("Cmd+H focuses previous stage", () => {
    let direction: -1 | 1 | null = null;
    const actions = makeActions({ focusAdjacentStage: (_, next) => (direction = next) });

    const handled = handleWorkbenchShortcut(
      {
        key: "h",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBeTrue();
    expect(direction).toBe(-1);
  });

  test("Cmd+L focuses next stage", () => {
    let direction: -1 | 1 | null = null;
    const actions = makeActions({ focusAdjacentStage: (_, next) => (direction = next) });

    const handled = handleWorkbenchShortcut(
      {
        key: "l",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
      },
      actions,
      true,
    );

    expect(handled).toBeTrue();
    expect(direction).toBe(1);
  });

  test("Cmd+Alt+number switches to project index", () => {
    let selectedProjectIndex = -1;
    const actions = makeActions({ switchToProjectIndex: (index) => (selectedProjectIndex = index) });

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

    expect(handled).toBeTrue();
    expect(selectedProjectIndex).toBe(1);
  });

  test("Cmd+Shift+P opens project picker", () => {
    let called = false;
    const actions = makeActions({ onRequestProjectPicker: () => (called = true) });

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

    expect(handled).toBeTrue();
    expect(called).toBeTrue();
  });

  test("Cmd+F opens task search for active project", () => {
    let calledWithProjectId: string | null = null;
    const actions = makeActions({
      dbProjectId: "c",
      onRequestTaskSearch: (projectId) => {
        calledWithProjectId = projectId;
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

    expect(handled).toBeTrue();
    expect(calledWithProjectId).toBe("c");
  });

  test("Cmd+F ignores editable targets", () => {
    let called = false;
    const target = makeInputTarget();
    const actions = makeActions({
      onRequestTaskSearch: () => {
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

    expect(handled).toBeFalse();
    expect(called).toBeFalse();
  });

  test("Cmd+number switches stage inside NFM editor target", () => {
    let selectedIndex = -1;
    const target = makeNfmEditorTarget();
    const actions = makeActions({ switchToStageIndex: (_, index) => (selectedIndex = index) });

    const handled = handleWorkbenchShortcut(
      {
        key: "3",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBeTrue();
    expect(selectedIndex).toBe(2);
  });

  test("Ctrl+Tab cycles stages inside NFM editor target", () => {
    let direction: -1 | 1 | null = null;
    const target = makeNfmEditorTarget();
    const actions = makeActions({ focusAdjacentStage: (_, next) => (direction = next) });

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

    expect(handled).toBeTrue();
    expect(direction).toBe(1);
  });

  test("Cmd+Shift+P opens project picker inside NFM editor target", () => {
    let called = false;
    const target = makeNfmEditorTarget();
    const actions = makeActions({ onRequestProjectPicker: () => (called = true) });

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

    expect(handled).toBeTrue();
    expect(called).toBeTrue();
  });

  test("Cmd+F remains unhandled inside NFM editor target", () => {
    let called = false;
    const target = makeNfmEditorTarget();
    const actions = makeActions({ onRequestTaskSearch: () => (called = true) });

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

    expect(handled).toBeFalse();
    expect(called).toBeFalse();
  });

  test("Cmd+Alt+number remains unhandled inside NFM editor target", () => {
    let selectedProjectIndex = -1;
    const target = makeNfmEditorTarget();
    const actions = makeActions({ switchToProjectIndex: (index) => (selectedProjectIndex = index) });

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

    expect(handled).toBeFalse();
    expect(selectedProjectIndex).toBe(-1);
  });

  test("Cmd+number remains blocked for plain input targets", () => {
    let selectedIndex = -1;
    const target = makeInputTarget();
    const actions = makeActions({ switchToStageIndex: (_, index) => (selectedIndex = index) });

    const handled = handleWorkbenchShortcut(
      {
        key: "1",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBeFalse();
    expect(selectedIndex).toBe(-1);
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

    expect(handled).toBeFalse();
  });

  test("Cmd+H remains blocked for plain input targets", () => {
    let direction: -1 | 1 | null = null;
    const target = makeInputTarget();
    const actions = makeActions({ focusAdjacentStage: (_, next) => (direction = next) });

    const handled = handleWorkbenchShortcut(
      {
        key: "h",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        target,
      },
      actions,
      true,
    );

    expect(handled).toBeFalse();
    expect(direction).toBe(null);
  });
});
