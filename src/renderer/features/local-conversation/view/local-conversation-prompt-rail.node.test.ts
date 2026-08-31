import { describe, expect, test, vi } from "vite-plus/test";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { waitForLocalConversationPromptRailResidentTarget } from "./local-conversation-prompt-rail";

const residentItem = {
  id: "turn-older:item-real-user-message",
  turnId: "turn-older",
  turnKey: "turn-older",
  ordinal: 1,
  label: "Older prompt",
  responsePreview: "",
  outputs: [],
  isHeartbeat: false,
} satisfies ThreadUserMessageNavigationItem;

describe("prompt rail installed target resolution", () => {
  test("waits by Turn identity and reveals the real resident marker", async () => {
    const target = {} as HTMLElement;
    let residentItems: readonly ThreadUserMessageNavigationItem[] = [];
    const waitForNextRender = vi.fn(async () => {
      residentItems = [residentItem];
    });
    const revealResidentItem = vi.fn(() => target);

    const result = await waitForLocalConversationPromptRailResidentTarget({
      turnId: "turn-older",
      mode: "smooth",
      signal: new AbortController().signal,
      readResidentItems: () => residentItems,
      revealResidentItem,
      waitForNextRender,
    });

    expect(result).toBe(target);
    expect(waitForNextRender).toHaveBeenCalledOnce();
    expect(revealResidentItem).toHaveBeenCalledWith(residentItem, "smooth");
    expect(residentItem.id).not.toBe("turn-older:user:0");
  });

  test("stops at cancellation without invoking renderer navigation", async () => {
    const controller = new AbortController();
    controller.abort();
    const waitForNextRender = vi.fn(async () => {});
    const revealResidentItem = vi.fn(() => null);

    const result = await waitForLocalConversationPromptRailResidentTarget({
      turnId: "turn-older",
      mode: "instant",
      signal: controller.signal,
      readResidentItems: () => [residentItem],
      revealResidentItem,
      waitForNextRender,
    });

    expect(result).toBeNull();
    expect(waitForNextRender).not.toHaveBeenCalled();
    expect(revealResidentItem).not.toHaveBeenCalled();
  });
});
