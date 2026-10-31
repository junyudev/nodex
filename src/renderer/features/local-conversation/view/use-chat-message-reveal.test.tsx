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
