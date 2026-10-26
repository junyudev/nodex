import { expect, test } from "vite-plus/test";
import { selectReusableSideChat } from "./side-chat-selection";
import type { SideChatPanelTab } from "./workbench-panel-tab-model";

const tab = (id: string, overrides: Partial<SideChatPanelTab> = {}): SideChatPanelTab => ({
  sideChat: true,
  id,
  sessionId: "parent",
  panelId: "right",
  parentThreadId: "thread",
  parentNavigationPath: "",
  threadId: id,
  title: id,
  status: "ready",
  stateKey: 1,
  ...overrides,
});

test("reuses the active idle side chat, then other right-panel chats before bottom-panel chats", () => {
  const tabs = [tab("first"), tab("active"), tab("bottom", { panelId: "bottom" })];
  const input = {
    tabs,
    isActive: (entry: SideChatPanelTab) => entry.id !== "first",
    isIdle: () => true,
  };
  expect(selectReusableSideChat(input)?.id).toBe("active");
  expect(selectReusableSideChat({ ...input, isIdle: (entry) => entry.id !== "active" })?.id).toBe(
    "first",
  );
  expect(
    selectReusableSideChat({ ...input, isIdle: (entry) => entry.panelId === "bottom" })?.id,
  ).toBe("bottom");
});

test("queues more selected context while its side chat opens and skips failed or running chats", () => {
  const loading = tab("pending", {
    status: "loading",
    threadId: null,
    draftAttachmentMode: "append",
  });
  expect(
    selectReusableSideChat({
      tabs: [tab("running"), tab("failed", { status: "failed" }), loading],
      isActive: () => false,
      isIdle: () => false,
    }),
  ).toBe(loading);
  expect(
    selectReusableSideChat({
      tabs: [tab("running"), tab("failed", { status: "failed" })],
      isActive: () => true,
      isIdle: () => false,
    }),
  ).toBeNull();
});
