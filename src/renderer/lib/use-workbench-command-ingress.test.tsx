import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  reminderOpenToPageDeepLink,
  useWorkbenchCommandIngress,
  type WorkbenchCommandPort,
} from "./use-workbench-command-ingress";

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, "api");

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, "api", originalApiDescriptor);
    return;
  }
  Reflect.deleteProperty(window, "api");
});

function makePort(): WorkbenchCommandPort {
  return {
    navigate: vi.fn(),
    toggleSidebar: vi.fn(),
    renameThread: vi.fn(),
    openContentSearch: vi.fn(),
    cyclePanelTab: vi.fn(),
    closePanelTab: vi.fn(),
    execute: vi.fn(() => true),
    openCommandPalette: vi.fn(),
    toggleSettings: vi.fn(),
    openKeyboardShortcuts: vi.fn(),
    openDesktopNotification: vi.fn(),
    goToPages: vi.fn(),
    goToSettings: vi.fn(),
  };
}

describe("useWorkbenchCommandIngress", () => {
  test("normalizes reminder notifications into the Page deep-link workflow", () => {
    expect(
      reminderOpenToPageDeepLink({
        projectId: "alpha",
        pageId: "page-1",
        occurrenceStart: "2026-08-11T09:00:00.000Z",
      }),
    ).toEqual({
      projectId: "alpha",
      pageId: "page-1",
    });
  });

  test("reports whether the active command port accepted a command", () => {
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {},
    });
    const { result } = renderHook(() => useWorkbenchCommandIngress());
    const port = makePort();

    expect(result.current.execute("createPage", "keyboard_shortcut")).toBe(false);

    act(() => {
      result.current.register(port);
    });

    expect(result.current.execute("createPage", "keyboard_shortcut")).toBe(true);
    expect(port.execute).toHaveBeenCalledWith("createPage", "keyboard_shortcut");
  });

  test("forwards native commands directly to the registered port", () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const subscribe = (name: string) =>
      vi.fn((handler: (...args: unknown[]) => void) => {
        handlers[name] = handler;
        return vi.fn();
      });
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        onNavigateBack: subscribe("back"),
        onNavigateForward: subscribe("forward"),
        onToggleSidebar: subscribe("sidebar"),
        onRenameThread: subscribe("rename"),
        onOpenContentSearch: subscribe("search"),
        onCyclePanelTabPrevious: subscribe("previous"),
        onCyclePanelTabNext: subscribe("next"),
        onClosePanelTab: subscribe("close"),
        onWorkbenchCommand: subscribe("command"),
      },
    });

    const { result } = renderHook(() => useWorkbenchCommandIngress());
    const port = makePort();
    act(() => {
      result.current.register(port);
      handlers.back?.();
      handlers.sidebar?.();
      handlers.previous?.();
      handlers.close?.();
      handlers.command?.({
        commandId: "toggleBottomPanel",
        source: "menu",
      });
    });

    expect(port.navigate).toHaveBeenCalledWith("back", "menu");
    expect(port.toggleSidebar).toHaveBeenCalledWith("menu");
    expect(port.cyclePanelTab).toHaveBeenCalledWith("previous");
    expect(port.closePanelTab).toHaveBeenCalledOnce();
    expect(port.execute).toHaveBeenCalledWith("toggleBottomPanel", "menu");
  });

  test("unregistering an old port does not clear its replacement", () => {
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {},
    });
    const { result } = renderHook(() => useWorkbenchCommandIngress());
    const first = makePort();
    const second = makePort();
    let unregisterFirst: () => void = () => undefined;

    act(() => {
      unregisterFirst = result.current.register(first);
      result.current.register(second);
      unregisterFirst();
      result.current.navigate("forward", "keyboard_shortcut");
    });

    expect(first.navigate).not.toHaveBeenCalled();
    expect(second.navigate).toHaveBeenCalledWith("forward", "keyboard_shortcut");
  });

  test("validates native navigation payloads before forwarding them", () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const onReminderOpen = vi.fn();
    const onPageDeepLinkOpen = vi.fn();
    const onSessionDeepLinkOpen = vi.fn();
    const onViewDeepLinkOpen = vi.fn();
    const onRequestNewWindow = vi.fn();
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
          return vi.fn();
        }),
        onRequestNewWindow: vi.fn((handler: () => void) => {
          handlers["window:new"] = handler;
          return vi.fn();
        }),
      },
    });

    renderHook(() =>
      useWorkbenchCommandIngress({
        onReminderOpen,
        onPageDeepLinkOpen,
        onSessionDeepLinkOpen,
        onViewDeepLinkOpen,
        onRequestNewWindow,
      }),
    );
    act(() => {
      handlers["reminder:open"]?.({
        projectId: "alpha",
        pageId: "page-1",
        occurrenceStart: "2026-07-28T10:00:00.000Z",
      });
      handlers["deeplink:open-page"]?.({
        projectId: "beta",
        pageId: "page-2",
      });
      handlers["deeplink:open-session"]?.({
        projectId: null,
        sessionId: "session:projectless",
      });
      handlers["deeplink:open-view"]?.({
        projectId: "beta",
        viewId: "view-2",
      });
      handlers["window:new"]?.();
      handlers["reminder:open"]?.({
        projectId: "alpha",
        pageId: 42,
        occurrenceStart: "invalid",
      });
      handlers["deeplink:open-session"]?.({
        projectId: undefined,
        sessionId: "invalid",
      });
    });

    expect(onReminderOpen).toHaveBeenCalledOnce();
    expect(onReminderOpen).toHaveBeenCalledWith({
      projectId: "alpha",
      pageId: "page-1",
      occurrenceStart: "2026-07-28T10:00:00.000Z",
    });
    expect(onPageDeepLinkOpen).toHaveBeenCalledWith({
      projectId: "beta",
      pageId: "page-2",
    });
    expect(onSessionDeepLinkOpen).toHaveBeenCalledWith({
      projectId: null,
      sessionId: "session:projectless",
    });
    expect(onViewDeepLinkOpen).toHaveBeenCalledWith({
      projectId: "beta",
      viewId: "view-2",
    });
    expect(onRequestNewWindow).toHaveBeenCalledOnce();
  });

  test("routes validated desktop notification actions through the command port", async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
          return vi.fn();
        }),
      },
    });

    const { result } = renderHook(() => useWorkbenchCommandIngress());
    const port = makePort();
    result.current.register(port);
    const invocation = {
      notificationId: "approval-local-request-1",
      actionId: "approve",
      actionType: "approve",
      hostId: "local",
      conversationId: "thread-1",
      navigationPath: "thread:thread-1",
      activateTabId: null,
      requestId: "request-1",
    } as const;

    await act(async () => {
      handlers["desktop-notification:action"]?.(invocation);
      handlers["desktop-notification:action"]?.({
        ...invocation,
        hostId: "",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(port.openDesktopNotification).toHaveBeenCalledOnce();
    expect(port.openDesktopNotification).toHaveBeenCalledWith(invocation);
  });

  test("queues native notification actions until Workbench registers its port", async () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
          return vi.fn();
        }),
      },
    });
    const invocation = {
      notificationId: "question-default-request-1",
      actionId: null,
      actionType: "open",
      hostId: "local",
      conversationId: "thread-1",
      navigationPath: "thread:thread-1",
      activateTabId: null,
      requestId: "request-1",
    } as const;
    const { result } = renderHook(() => useWorkbenchCommandIngress());

    act(() => {
      handlers["desktop-notification:action"]?.(invocation);
    });
    const port = makePort();
    await act(async () => {
      result.current.register(port);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(port.openDesktopNotification).toHaveBeenCalledWith(invocation);
  });
});
