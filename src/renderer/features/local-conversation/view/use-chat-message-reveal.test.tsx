import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { createChatMessageRevealStore } from "../chat-message-navigation";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { useChatMessageReveal } from "./use-chat-message-reveal";

const scroll = vi.hoisted(() => ({ setScrollMode: vi.fn(), scrollElementIntoView: vi.fn() }));
vi.mock("./local-conversation-thread-scroll-controller", () => ({
  useLocalConversationThreadScrollController: () => scroll,
}));
vi.mock("@/lib/use-reduced-motion", () => ({ useResolvedReducedMotion: () => true }));

it("installs and reveals the addressed steer rather than the Run's first message", async () => {
  const store = createChatMessageRevealStore();
  const installMessage = vi.fn(async () => "applied" as const);
  const target = document.createElement("div");
  const reveal = vi.fn(async (_item: ThreadUserMessageNavigationItem) => target);
  const item = (messageId: string): ThreadUserMessageNavigationItem => ({
    messageId,
    id: messageId,
    turnId: "run",
    turnKey: "run",
    ordinal: 1,
    label: messageId,
    responsePreview: "",
    outputs: [],
    isHeartbeat: false,
  });
  const view = renderHook(() =>
    useChatMessageReveal(
      {
        threadId: "root",
        items: [item("opening"), item("steer")],
        reveal,
        history: {
          loadBoundary: async () => "stale",
          promptRail: { installMessage, loadIndex: async () => null, install: async () => "stale" },
        },
      },
      store,
    ),
  );
  await act(async () => {
    store.request({ sessionId: "chat", threadId: "root", messageId: "steer" });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(scroll.scrollElementIntoView).toHaveBeenCalledWith(target, "instant", "start"),
  );
  expect(installMessage).toHaveBeenCalledWith("steer", expect.any(AbortSignal));
  expect(reveal.mock.calls[0]?.[0]).toMatchObject({ messageId: "steer" });
  expect(store.read()).toBeNull();
  view.unmount();
});

it("leaves a reveal request pending across disabled floating mounts", async () => {
  const store = createChatMessageRevealStore();
  const installMessage = vi.fn(async () => "applied" as const);
  const reveal = vi.fn(async () => document.createElement("div"));
  store.request({ sessionId: "chat", threadId: "root", messageId: "steer" });
  const pending = store.read();
  for (let mount = 0; mount < 2; mount += 1) {
    const view = renderHook(() =>
      useChatMessageReveal(
        {
          enabled: false,
          threadId: "root",
          items: [],
          reveal,
          history: {
            loadBoundary: async () => "stale",
            promptRail: {
              installMessage,
              loadIndex: async () => null,
              install: async () => "stale",
            },
          },
        },
        store,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.read()).toBe(pending);
    view.unmount();
    expect(store.read()).toBe(pending);
  }
  expect(installMessage).not.toHaveBeenCalled();
  expect(reveal).not.toHaveBeenCalled();
});
