import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { WorkbenchTabProjection } from "@/lib/types";
import { DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES } from "../../../shared/browser-sidebar";
import { render, settleAsyncRender } from "../../test/dom";
import { browserSidebarRendererWebviewManager } from "./browser-sidebar-webview-manager";
import type { BrowserAddressSuggestionsSource } from "./browser-sidebar-panel";

let BrowserSidebarPanel: (typeof import("./browser-sidebar-panel"))["BrowserSidebarPanel"];
const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
  if (channel === "browser-downloads-list") return { downloads: [] };
  if (channel === "browser-local-server-preferences-get")
    return { ...DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES, expandedProjectIds: [] };
  return { ok: true };
});
vi.mock("@/lib/api", () => ({
  invoke: (channel: string, ...args: unknown[]) => invoke(channel, ...args),
  subscribeBoardChanges: () => () => undefined,
  subscribeProjectSessionChanges: () => () => undefined,
  subscribeProjectChanges: () => () => undefined,
  subscribeCodexHostMessages: () => () => undefined,
  subscribeDesktopNotificationActions: () => () => undefined,
  subscribeAppUpdateStatus: () => () => undefined,
  getWindowFocusState: async () => true,
  subscribeWindowFocusChanges: () => () => undefined,
}));
vi.mock("@/lib/use-theme", () => ({
  useTheme: () => ({ theme: "dark", resolved: "dark", setTheme: () => undefined }),
}));

beforeAll(async () => {
  ({ BrowserSidebarPanel } = await import("./browser-sidebar-panel"));
});
beforeEach(() => {
  invoke.mockClear();
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { invoke, on: () => () => undefined },
  });
});
afterEach(async () => {
  await act(async () => {
    browserSidebarRendererWebviewManager.disposeAll();
    await Promise.resolve();
  });
});

const tab: Extract<WorkbenchTabProjection, { kind: "browser" }> & { preview: true } = {
  id: "new-tab",
  browserTabId: "new-tab",
  sessionId: "session",
  projectId: "project",
  panelId: "right",
  kind: "browser",
  title: "New tab",
  order: 0,
  config: { projectId: "project", url: "about:blank" },
  stateKey: 0,
  state: null,
  createdAt: "2026-10-27T00:00:00Z",
  updatedAt: "2026-10-27T00:00:00Z",
  preview: true,
};

async function interact(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

function renderAddress(source: BrowserAddressSuggestionsSource, url = "about:blank") {
  return render(
    <BrowserSidebarPanel
      tab={{ ...tab, config: { ...tab.config, url } }}
      browserViewScopeId="window"
      surfaceContext={{ browserConversationId: "session", codexSessionId: null }}
      onRefreshSessions={async () => []}
      addressSuggestions={source}
      isVisible
    />,
  );
}

describe("New tab address combobox", () => {
  test.each(["about:blank", "https://example.com", "file:///tmp/page.html"])(
    "does not navigate when submitting or blurring empty input from %s",
    async (url) => {
      const view = renderAddress({ useWorkspaceSuggestions: () => [] }, url);
      await settleAsyncRender();
      const input = view.getByPlaceholderText(
        url === "about:blank" ? "Search pages or enter a URL" : "Search or enter a URL",
      ) as HTMLInputElement;
      await interact(() => {
        input.focus();
        fireEvent.change(input, { target: { value: "   " } });
      });
      await interact(() => fireEvent.submit(input.closest("form")!));
      expect(navigations()).toEqual([]);
      await interact(() => {
        fireEvent.change(input, { target: { value: "" } });
        input.blur();
      });
      expect(navigations()).toEqual([]);
    },
  );

  test("wraps a query's keyboard selection, ignores composition, accepts a tool, and clears the search with Escape before leaving the field", async () => {
    const selectTool = vi.fn();
    const selectTab = vi.fn();
    const view = renderAddress({
      useWorkspaceSuggestions: (query) =>
        query?.trim()
          ? [
              {
                id: "tool",
                kind: "launch-action",
                title: "Terminal",
                icon: null,
                onSelect: selectTool,
              },
              {
                id: "tab",
                kind: "switch-tab",
                title: "Terminal docs",
                icon: null,
                onSelect: selectTab,
              },
            ]
          : [
              {
                id: "recent",
                kind: "content",
                title: "Recent notes",
                icon: null,
                onSelect: vi.fn(),
              },
            ],
    });
    await settleAsyncRender();
    const input = view.getByRole("combobox") as HTMLInputElement;
    await interact(() => {
      input.focus();
      fireEvent.change(input, { target: { value: "term" } });
    });
    const options = await view.findAllByRole("option");
    expect(options.map(optionName)).toEqual(["Terminal", "Terminal docs", "term"]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(view.getByRole("listbox").id);
    await interact(() => fireEvent.keyDown(input, { key: "ArrowUp" }));
    expect(options[2]?.getAttribute("aria-selected")).toBe("true");
    await interact(() => fireEvent.keyDown(input, { key: "ArrowDown" }));
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    await interact(() => fireEvent.keyDown(input, { key: "ArrowDown" }));
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    await interact(() => fireEvent.keyDown(input, { key: "ArrowUp" }));
    await interact(() => fireEvent.keyDown(input, { key: "Enter", isComposing: true }));
    await interact(() => fireEvent.keyDown(input, { key: "Enter", keyCode: 229 }));
    expect(selectTool).not.toHaveBeenCalled();
    await interact(() => fireEvent.keyDown(input, { key: "Enter" }));
    expect(selectTool).toHaveBeenCalledOnce();
    expect(selectTab).not.toHaveBeenCalled();
    // Accepting clears the search, so the list returns to what an empty field suggests.
    expect(input.value).toBe("");
    expect(view.getByRole("option", { name: "Recent notes" })).toBeTruthy();
    await interact(() => input.blur());
    expect(navigations()).toEqual([]);

    await interact(() => {
      input.focus();
      fireEvent.change(input, { target: { value: "term" } });
    });
    await view.findByRole("option", { name: "Terminal" });
    await interact(() => fireEvent.keyDown(input, { key: "Escape" }));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(view.getByRole("option", { name: "Recent notes" })).toBeTruthy();
    await interact(() => fireEvent.keyDown(input, { key: "Escape" }));
    expect(document.activeElement).not.toBe(input);
    expect(navigations()).toEqual([]);
  });

  test("lists an empty field's suggestions unselected; arrows enter and leave them, and Escape lets go before leaving", async () => {
    const openFirst = vi.fn();
    const view = renderAddress({
      useWorkspaceSuggestions: (query) =>
        query?.trim()
          ? []
          : [
              { id: "first", kind: "content", title: "First", icon: null, onSelect: openFirst },
              { id: "second", kind: "content", title: "Second", icon: null, onSelect: vi.fn() },
            ],
    });
    await settleAsyncRender();
    const input = view.getByRole("combobox") as HTMLInputElement;
    await interact(() => input.focus());
    const [first, second] = await view.findAllByRole("option");
    const selected = () =>
      view
        .getAllByRole("option")
        .flatMap((option) =>
          option.getAttribute("aria-selected") === "true" ? [optionName(option)] : [],
        );
    expect(selected()).toEqual([]);
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    // Enter on an untouched empty field opens nothing.
    await interact(() => fireEvent.keyDown(input, { key: "Enter" }));
    expect(openFirst).not.toHaveBeenCalled();
    await interact(() => fireEvent.keyDown(input, { key: "ArrowDown" }));
    expect(input.getAttribute("aria-activedescendant")).toBe(first?.id);
    await interact(() => fireEvent.keyDown(input, { key: "ArrowDown" }));
    await interact(() => fireEvent.keyDown(input, { key: "ArrowDown" }));
    expect(input.getAttribute("aria-activedescendant")).toBe(second?.id);
    await interact(() => fireEvent.keyDown(input, { key: "ArrowUp" }));
    await interact(() => fireEvent.keyDown(input, { key: "ArrowUp" }));
    expect(selected()).toEqual([]);
    await interact(() => fireEvent.keyDown(input, { key: "ArrowDown" }));
    await interact(() => fireEvent.keyDown(input, { key: "Escape" }));
    expect(selected()).toEqual([]);
    expect(document.activeElement).toBe(input);
    await interact(() => fireEvent.keyDown(input, { key: "ArrowDown" }));
    await interact(() => fireEvent.keyDown(input, { key: "Enter" }));
    expect(openFirst).toHaveBeenCalledOnce();
    expect(navigations()).toEqual([]);
  });

  test("keeps focus on pointer selection and accepts the hovered Page without committing its query", async () => {
    const selectPage = vi.fn();
    const view = renderAddress({
      useWorkspaceSuggestions: () => [
        {
          id: "page",
          kind: "content",
          title: "Sprint plan",
          icon: null,
          onSelect: selectPage,
          pageMatches: [{ source: "title", quality: "prefix", parts: [] }],
        },
      ],
    });
    await settleAsyncRender();
    const input = view.getByRole("combobox") as HTMLInputElement;
    await interact(() => {
      input.focus();
      fireEvent.change(input, { target: { value: "plan" } });
    });
    const option = await view.findByRole("option", { name: "Sprint plan" });
    await interact(() => fireEvent.mouseEnter(option));
    expect(option.getAttribute("aria-selected")).toBe("true");
    await interact(() => {
      expect(fireEvent.mouseDown(option)).toBe(false);
      fireEvent.click(option);
    });
    expect(document.activeElement).toBe(input);
    expect(selectPage).toHaveBeenCalledOnce();
    await interact(() => input.blur());
    expect(navigations()).toEqual([]);
  });

  test("submits the typed row, navigates loaded tabs on blur, and keeps a New tab's draft on blur", async () => {
    const source: BrowserAddressSuggestionsSource = { useWorkspaceSuggestions: () => [] };
    const view = renderAddress(source);
    await settleAsyncRender();
    const input = view.getByRole("combobox") as HTMLInputElement;
    await interact(() => {
      input.focus();
      fireEvent.change(input, { target: { value: "example.com" } });
    });
    await interact(() => fireEvent.keyDown(input, { key: "Enter" }));
    await waitFor(() =>
      expect(navigations()).toEqual([expect.objectContaining({ url: "https://example.com" })]),
    );
    expect(view.queryByRole("listbox")).toBeNull();
    const toolbarInput = view.getByRole("textbox", { name: "Search or enter a URL" });
    await interact(() => {
      toolbarInput.focus();
      fireEvent.change(toolbarInput, { target: { value: "second.example" } });
    });
    expect(view.queryByRole("listbox")).toBeNull();
    await interact(() => toolbarInput.blur());
    expect(navigations()).toHaveLength(2);
    view.unmount();
    const blank = renderAddress(source);
    await settleAsyncRender();
    const blankInput = blank.getByRole("combobox") as HTMLInputElement;
    await interact(() => {
      blankInput.focus();
      fireEvent.change(blankInput, { target: { value: "a search" } });
    });
    const navigationCount = navigations().length;
    await interact(() => blankInput.blur());
    // Leaving the New tab's search, for example to pick a tool, neither searches nor clears it,
    // and its results stay on the page.
    expect(navigations()).toHaveLength(navigationCount);
    expect(blankInput.value).toBe("a search");
    expect(blank.getByRole("option", { name: "a search" })).toBeTruthy();
  });
});

/** An option's name: the title line its `aria-labelledby` points at. */
function optionName(option: HTMLElement) {
  return document.getElementById(option.getAttribute("aria-labelledby") ?? "")?.textContent;
}

function navigations() {
  return invoke.mock.calls
    .filter(
      ([channel, input]) =>
        channel === "browser-sidebar-command" && (input as { type: string }).type === "navigate",
    )
    .map(([, input]) => input);
}
