import { describe, expect, test } from "vite-plus/test";
import { renderHook } from "@testing-library/react";
import type { SidebarLifecycleChat } from "@/lib/sidebar-chat-lifecycle";
import { useSidebarChatLanes } from "./use-sidebar-chat-lanes";

function chat(id: string, overrides: Partial<SidebarLifecycleChat> = {}): SidebarLifecycleChat {
  return {
    id,
    pinned: false,
    pinnedOrder: null,
    snoozedUntil: null,
    snoozedAt: null,
    attentionAt: 0,
    status: null,
    ...overrides,
  };
}

const pin = (id: string, pinnedOrder: number) => chat(id, { pinned: true, pinnedOrder });

describe("useSidebarChatLanes while the reader is in the sidebar", () => {
  test("moves the pins they reorder at once and keeps holding every other row", () => {
    const { result, rerender } = renderHook(
      ({ chats }: { chats: readonly SidebarLifecycleChat[] }) =>
        useSidebarChatLanes({ chats, activeSessionId: null, holding: true }),
      {
        initialProps: {
          chats: [pin("a", 0), pin("b", 1), pin("c", 2), chat("seen", { attentionAt: 1 })],
        },
      },
    );
    const ids = (lane: "pinned" | "active") => result.current[lane].map((entry) => entry.id);
    expect(ids("pinned")).toEqual(["a", "b", "c"]);

    // They drag `c` above `b`, then `b` above `a`, without leaving the sidebar. A chat that
    // comes back meanwhile still waits until they leave.
    rerender({
      chats: [
        pin("a", 0),
        pin("c", 1),
        pin("b", 2),
        chat("came-back", { attentionAt: 9 }),
        chat("seen", { attentionAt: 1 }),
      ],
    });
    expect(ids("pinned")).toEqual(["a", "c", "b"]);
    rerender({
      chats: [
        pin("b", 0),
        pin("a", 1),
        pin("c", 2),
        chat("came-back", { attentionAt: 9 }),
        chat("seen", { attentionAt: 1 }),
      ],
    });
    expect(ids("pinned")).toEqual(["b", "a", "c"]);
    expect(ids("active")).toEqual(["seen"]);
  });
});
