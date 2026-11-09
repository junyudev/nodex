import { expect, test } from "vite-plus/test";
import { selectReusableSideChat, type SideChatSelectionCandidate } from "./side-chat-selection";

const candidate = (
  tabId: string,
  overrides: Partial<SideChatSelectionCandidate> = {},
): SideChatSelectionCandidate => ({
  tabId,
  panelId: "right",
  active: false,
  accepting: true,
  ...overrides,
});

test("reuses the active accepting side chat, then other right-panel chats before bottom-panel chats", () => {
  const first = candidate("first");
  const active = candidate("active", { active: true });
  const bottom = candidate("bottom", { panelId: "bottom", active: true });
  expect(selectReusableSideChat([first, active, bottom])).toBe(active);
  expect(selectReusableSideChat([first, { ...active, accepting: false }, bottom])).toBe(first);
  expect(
    selectReusableSideChat([
      { ...first, accepting: false },
      { ...active, accepting: false },
      bottom,
    ]),
  ).toBe(bottom);
});

test("finds no side chat when every candidate is busy", () => {
  expect(
    selectReusableSideChat([
      candidate("running", { accepting: false, active: true }),
      candidate("failed", { accepting: false }),
    ]),
  ).toBeNull();
});
