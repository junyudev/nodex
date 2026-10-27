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
  test("wraps keyboard selection, ignores composition, accepts a tool, and dismisses with Escape before restoring on a second Escape", async () => {
    const selectTool = vi.fn();
    const selectTab = vi.fn();
    const view = renderAddress({
      useWorkspaceSuggestions: () => [
        { id: "tool", kind: "launch-action", title: "Terminal", icon: null, onSelect: selectTool },
        {
          id: "tab",
          kind: "switch-tab",
          title: "Terminal docs",
          icon: null,
          trailing: "Switch to tab",
          onSelect: selectTab,
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
    expect(view.queryByRole("listbox")).toBeNull();
    await interact(() => input.blur());
    expect(navigations()).toEqual([]);

    await interact(() => {
      input.focus();
      fireEvent.change(input, { target: { value: "term" } });
    });
    await view.findByRole("listbox");
    await interact(() => fireEvent.keyDown(input, { key: "Escape" }));
    expect(view.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("term");
    expect(document.activeElement).toBe(input);
    await interact(() => fireEvent.keyDown(input, { key: "Escape" }));
    expect(input.value).toBe("");
    expect(document.activeElement).not.toBe(input);
    expect(navigations()).toEqual([]);
  });

  test("keeps focus on pointer selection and accepts the hovered Page without committing its query", async () => {
    const selectPage = vi.fn();
    const view = renderAddress({
      useWorkspaceSuggestions: () => [
        { id: "page", kind: "page", title: "Sprint plan", icon: null, onSelect: selectPage },
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

  test("submits the typed row and retains ordinary blur navigation on blank and loaded tabs", async () => {
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
    expect(input.getAttribute("role")).toBeNull();
    await interact(() => fireEvent.change(input, { target: { value: "second.example" } }));
    expect(view.queryByRole("listbox")).toBeNull();
    await interact(() => input.blur());
    expect(navigations()).toHaveLength(2);
    view.unmount();
    const blank = renderAddress(source);
    await settleAsyncRender();
    const blankInput = blank.getByRole("combobox") as HTMLInputElement;
    await interact(() => {
      blankInput.focus();
      fireEvent.change(blankInput, { target: { value: "a search" } });
    });
    await interact(() => blankInput.blur());
    expect(navigations().at(-1)).toMatchObject({
      url: "https://www.google.com/search?q=a%20search",
    });
    expect(blank.queryByRole("listbox")).toBeNull();
  });
});

function navigations() {
  return invoke.mock.calls
    .filter(
      ([channel, input]) =>
        channel === "browser-sidebar-command" && (input as { type: string }).type === "navigate",
    )
    .map(([, input]) => input);
}
