import { describe, expect, test } from "bun:test";
import { handleTabShortcut, type TabShortcutActions } from "./use-tab-shortcuts";
import type { Tab } from "./use-tabs";

function makeTabs(count: number): Tab[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `tab-${i}`,
    projectId: `project-${i}`,
    viewMode: "kanban" as const,
    searchQueries: {},
  }));
}

function makeActions(
  tabs: Tab[],
  activeTabId: string,
  overrides: Partial<TabShortcutActions> = {},
): TabShortcutActions & { calls: { setActiveTab: string[]; closeTab: string[]; addTab: number } } {
  const calls = { setActiveTab: [] as string[], closeTab: [] as string[], addTab: 0 };
  return {
    tabs,
    activeTabId,
    setActiveTab: (id) => calls.setActiveTab.push(id),
    closeTab: (id) => calls.closeTab.push(id),
    onRequestAddTab: () => { calls.addTab++; },
    ...overrides,
    calls,
  };
}

function fakeEvent(
  overrides: Partial<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "target">>,
): Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "target"> {
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
  return { tagName: "INPUT", isContentEditable: false } as unknown as HTMLElement;
}

function textareaTarget(): EventTarget {
  return { tagName: "TEXTAREA", isContentEditable: false } as unknown as HTMLElement;
}

function contentEditableTarget(): EventTarget {
  return { tagName: "DIV", isContentEditable: true } as unknown as HTMLElement;
}

// --- Ctrl+Tab cycling ---

describe("Ctrl+Tab: cycle tabs", () => {
  test("moves to next tab", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-0");
    const handled = handleTabShortcut(fakeEvent({ key: "Tab", ctrlKey: true }), actions, true);
    expect(handled).toBe(true);
    expect(actions.calls.setActiveTab.length).toBe(1);
    expect(actions.calls.setActiveTab[0]).toBe("tab-1");
  });

  test("wraps from last to first", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-2");
    handleTabShortcut(fakeEvent({ key: "Tab", ctrlKey: true }), actions, true);
    expect(actions.calls.setActiveTab[0]).toBe("tab-0");
  });

  test("Ctrl+Shift+Tab moves to previous tab", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-1");
    handleTabShortcut(fakeEvent({ key: "Tab", ctrlKey: true, shiftKey: true }), actions, true);
    expect(actions.calls.setActiveTab[0]).toBe("tab-0");
  });

  test("Ctrl+Shift+Tab wraps from first to last", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-0");
    handleTabShortcut(fakeEvent({ key: "Tab", ctrlKey: true, shiftKey: true }), actions, true);
    expect(actions.calls.setActiveTab[0]).toBe("tab-2");
  });

  test("single tab stays on same tab", () => {
    const tabs = makeTabs(1);
    const actions = makeActions(tabs, "tab-0");
    handleTabShortcut(fakeEvent({ key: "Tab", ctrlKey: true }), actions, true);
    expect(actions.calls.setActiveTab[0]).toBe("tab-0");
  });

  test("returns false for unknown activeTabId", () => {
    const tabs = makeTabs(2);
    const actions = makeActions(tabs, "nonexistent");
    const handled = handleTabShortcut(fakeEvent({ key: "Tab", ctrlKey: true }), actions, true);
    expect(handled).toBe(false);
    expect(actions.calls.setActiveTab.length).toBe(0);
  });
});

// --- Cmd+1-9: switch by index ---

describe("Cmd+1-9: switch to tab by index", () => {
  test("Cmd+1 switches to first tab (Mac)", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-2");
    const handled = handleTabShortcut(fakeEvent({ key: "1", metaKey: true }), actions, true);
    expect(handled).toBe(true);
    expect(actions.calls.setActiveTab[0]).toBe("tab-0");
  });

  test("Ctrl+3 switches to third tab (non-Mac)", () => {
    const tabs = makeTabs(5);
    const actions = makeActions(tabs, "tab-0");
    const handled = handleTabShortcut(fakeEvent({ key: "3", ctrlKey: true }), actions, false);
    expect(handled).toBe(true);
    expect(actions.calls.setActiveTab[0]).toBe("tab-2");
  });

  test("index beyond tab count does not call setActiveTab", () => {
    const tabs = makeTabs(2);
    const actions = makeActions(tabs, "tab-0");
    const handled = handleTabShortcut(fakeEvent({ key: "5", metaKey: true }), actions, true);
    expect(handled).toBe(true);
    expect(actions.calls.setActiveTab.length).toBe(0);
  });
});

// --- Cmd+W: close tab ---

describe("Cmd+W: close active tab", () => {
  test("closes active tab when multiple tabs exist", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-1");
    const handled = handleTabShortcut(fakeEvent({ key: "w", metaKey: true }), actions, true);
    expect(handled).toBe(true);
    expect(actions.calls.closeTab.length).toBe(1);
    expect(actions.calls.closeTab[0]).toBe("tab-1");
  });

  test("does not close last remaining tab", () => {
    const tabs = makeTabs(1);
    const actions = makeActions(tabs, "tab-0");
    const handled = handleTabShortcut(fakeEvent({ key: "w", metaKey: true }), actions, true);
    expect(handled).toBe(false);
    expect(actions.calls.closeTab.length).toBe(0);
  });
});

// --- Cmd+T: new tab ---

describe("Cmd+T: open new tab picker", () => {
  test("calls onRequestAddTab", () => {
    const tabs = makeTabs(1);
    const actions = makeActions(tabs, "tab-0");
    const handled = handleTabShortcut(fakeEvent({ key: "t", metaKey: true }), actions, true);
    expect(handled).toBe(true);
    expect(actions.calls.addTab).toBe(1);
  });

  test("does nothing when onRequestAddTab is not provided", () => {
    const tabs = makeTabs(1);
    const actions = makeActions(tabs, "tab-0", { onRequestAddTab: undefined });
    const handled = handleTabShortcut(fakeEvent({ key: "t", metaKey: true }), actions, true);
    expect(handled).toBe(false);
  });
});

// --- Input suppression ---

describe("input suppression", () => {
  test("ignores events from INPUT elements", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-0");
    const handled = handleTabShortcut(
      fakeEvent({ key: "Tab", ctrlKey: true, target: inputTarget() }),
      actions,
      true,
    );
    expect(handled).toBe(false);
    expect(actions.calls.setActiveTab.length).toBe(0);
  });

  test("ignores events from TEXTAREA elements", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-0");
    const handled = handleTabShortcut(
      fakeEvent({ key: "1", metaKey: true, target: textareaTarget() }),
      actions,
      true,
    );
    expect(handled).toBe(false);
  });

  test("ignores events from contentEditable elements", () => {
    const tabs = makeTabs(3);
    const actions = makeActions(tabs, "tab-0");
    const handled = handleTabShortcut(
      fakeEvent({ key: "w", metaKey: true, target: contentEditableTarget() }),
      actions,
      true,
    );
    expect(handled).toBe(false);
  });
});

// --- Unhandled keys ---

describe("unhandled keys", () => {
  test("returns false for unrelated key combos", () => {
    const tabs = makeTabs(2);
    const actions = makeActions(tabs, "tab-0");
    expect(handleTabShortcut(fakeEvent({ key: "a", metaKey: true }), actions, true)).toBe(false);
    expect(handleTabShortcut(fakeEvent({ key: "x", ctrlKey: true }), actions, false)).toBe(false);
  });

  test("returns false without modifier", () => {
    const tabs = makeTabs(2);
    const actions = makeActions(tabs, "tab-0");
    expect(handleTabShortcut(fakeEvent({ key: "1" }), actions, true)).toBe(false);
    expect(handleTabShortcut(fakeEvent({ key: "w" }), actions, true)).toBe(false);
  });
});
