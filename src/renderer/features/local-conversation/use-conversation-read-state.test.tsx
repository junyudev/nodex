import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useConversationReadState,
  type UseConversationReadStateInput,
} from "./use-conversation-read-state";

const nativeFocus = vi.hoisted(() => ({
  read: vi.fn<() => Promise<boolean>>(),
  listeners: new Set<(focused: boolean) => void>(),
  unsubscribe: vi.fn(),
}));

vi.mock("./local-conversation-deps", () => ({
  getWindowFocusState: nativeFocus.read,
  subscribeWindowFocusChanges: (listener: (focused: boolean) => void) => {
    nativeFocus.listeners.add(listener);
    return () => {
      nativeFocus.listeners.delete(listener);
      nativeFocus.unsubscribe();
    };
  },
}));

const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  nativeFocus.read.mockReset().mockResolvedValue(true);
  nativeFocus.listeners.clear();
  nativeFocus.unsubscribe.mockReset();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

function input(
  overrides: Partial<UseConversationReadStateInput> = {},
): UseConversationReadStateInput {
  return {
    identity: "local:thread",
    active: true,
    hasConversation: true,
    hasUnreadTurn: false,
    hasPersistedUnreadTurn: false,
    latestRequestId: null,
    latestTurnId: "turn",
    latestTurnStatus: "completed",
    activityToken: null,
    onMarkRead: vi.fn(),
    ...overrides,
  };
}

async function emitFocus(value: boolean) {
  await act(async () => {
    for (const listener of nativeFocus.listeners) listener(value);
    await Promise.resolve();
  });
}

it("uses native window focus even when an embedded guest owns DOM focus", async () => {
  const onMarkRead = vi.fn();
  renderHook(() => useConversationReadState(input({ hasUnreadTurn: true, onMarkRead })));
  await waitFor(() => expect(onMarkRead).toHaveBeenCalledOnce());
  expect(document.hasFocus()).toBe(false);
});

it("ignores an initial focus response superseded by a native focus event", async () => {
  let resolveFocus!: (focused: boolean) => void;
  nativeFocus.read.mockReturnValue(new Promise((resolve) => (resolveFocus = resolve)));
  const onMarkRead = vi.fn();
  renderHook(() => useConversationReadState(input({ hasUnreadTurn: true, onMarkRead })));
  await waitFor(() => expect(nativeFocus.read).toHaveBeenCalledOnce());
  await emitFocus(false);
  await act(async () => {
    resolveFocus(true);
    await Promise.resolve();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
  });
  expect(onMarkRead).not.toHaveBeenCalled();
  await emitFocus(true);
  expect(onMarkRead).toHaveBeenCalledOnce();
});

it("waits for native focus before consuming unread despite a focused DOM", async () => {
  vi.mocked(document.hasFocus).mockReturnValue(true);
  let resolveFocus!: (focused: boolean) => void;
  nativeFocus.read.mockReturnValue(new Promise((resolve) => (resolveFocus = resolve)));
  const onMarkRead = vi.fn();
  renderHook(() => useConversationReadState(input({ hasUnreadTurn: true, onMarkRead })));
  await waitFor(() => expect(nativeFocus.read).toHaveBeenCalledOnce());
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  expect(onMarkRead).not.toHaveBeenCalled();
  await act(async () => {
    resolveFocus(false);
    await Promise.resolve();
  });
  expect(onMarkRead).not.toHaveBeenCalled();
  await emitFocus(true);
  expect(onMarkRead).toHaveBeenCalledOnce();
});

it("uses DOM focus as a fallback when the native focus query is unavailable", async () => {
  nativeFocus.read.mockRejectedValue(new Error("unavailable"));
  const onMarkRead = vi.fn();
  renderHook(() => useConversationReadState(input({ hasUnreadTurn: true, onMarkRead })));
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  expect(onMarkRead).toHaveBeenCalledOnce();
});

it("defers consumption in a hidden document until it becomes visible", async () => {
  visibility = "hidden";
  const onMarkRead = vi.fn();
  renderHook(() => useConversationReadState(input({ hasUnreadTurn: true, onMarkRead })));
  await act(async () => {
    await Promise.resolve();
  });
  expect(onMarkRead).not.toHaveBeenCalled();
  await act(async () => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  expect(onMarkRead).toHaveBeenCalledOnce();
});

it("keeps manual unread until new activity or a valid transcript interaction", async () => {
  const onMarkRead = vi.fn();
  function Transcript(props: UseConversationReadStateInput) {
    const { onReadInteraction } = useConversationReadState(props);
    return (
      <div
        data-testid="transcript"
        onPointerDownCapture={onReadInteraction}
        onKeyDownCapture={onReadInteraction}
        onWheelCapture={onReadInteraction}
      />
    );
  }
  const props = input({ onMarkRead });
  const view = render(<Transcript {...props} />);
  await emitFocus(true);
  view.rerender(<Transcript {...props} hasUnreadTurn hasPersistedUnreadTurn />);
  await emitFocus(false);
  await emitFocus(true);
  expect(onMarkRead).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.keyDown(view.getByTestId("transcript"), { key: "Shift" });
    await Promise.resolve();
  });
  expect(onMarkRead).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.pointerDown(view.getByTestId("transcript"));
    fireEvent.keyDown(view.getByTestId("transcript"), { key: "ArrowDown" });
    fireEvent.wheel(view.getByTestId("transcript"), { deltaY: 20 });
    await Promise.resolve();
  });
  expect(onMarkRead).toHaveBeenCalledTimes(3);
});

it("uses the latest read callback for a delayed completion and resets when the route hides", async () => {
  const first = vi.fn();
  const next = vi.fn();
  const props = input({ onMarkRead: first });
  const view = renderHook(useConversationReadState, { initialProps: props });
  await emitFocus(true);
  view.rerender({ ...props, hasUnreadTurn: true, onMarkRead: next });
  expect(next).not.toHaveBeenCalled();
  view.rerender({
    ...props,
    hasUnreadTurn: true,
    onMarkRead: next,
    activityToken: {
      hostId: "local",
      threadId: "thread",
      activity: { type: "turn-completed" as const, turnId: "turn" },
    },
  });
  expect(first).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  view.rerender({ ...props, active: false, hasUnreadTurn: true, onMarkRead: next });
  view.rerender({ ...props, hasUnreadTurn: true, onMarkRead: next });
  expect(next).toHaveBeenCalledTimes(2);
});

it("releases focus listeners and ignores a native focus response after unmount", async () => {
  let resolveFocus!: (focused: boolean) => void;
  nativeFocus.read.mockReturnValue(new Promise((resolve) => (resolveFocus = resolve)));
  const onMarkRead = vi.fn();
  const view = renderHook(() =>
    useConversationReadState(input({ hasUnreadTurn: true, onMarkRead })),
  );
  await waitFor(() => expect(nativeFocus.read).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => {
    resolveFocus(true);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  expect(nativeFocus.listeners.size).toBe(0);
  expect(nativeFocus.unsubscribe).toHaveBeenCalledOnce();
  expect(onMarkRead).not.toHaveBeenCalled();
});
