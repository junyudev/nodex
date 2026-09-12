import { expect, it, vi } from "vitest";
import { ConversationActivity } from "./codex-conversation-activity";

it("retains a conversation until its last independent view releases it", () => {
  const changed = vi.fn();
  const activity = new ConversationActivity(changed);
  const first = activity.retain("thread");
  const second = activity.retain("thread");
  expect(changed.mock.calls).toEqual([["thread", true]]);
  first[Symbol.dispose]();
  first[Symbol.dispose]();
  expect(activity.has("thread")).toBe(true);
  expect(changed).toHaveBeenCalledOnce();
  second[Symbol.dispose]();
  expect(activity.has("thread")).toBe(false);
  expect(changed.mock.calls).toEqual([
    ["thread", true],
    ["thread", false],
  ]);
});

it.each(["remove", "clear"] as const)(
  "ignores old handles after %s and reacquisition",
  (operation) => {
    const changed = vi.fn();
    const activity = new ConversationActivity(changed);
    const old = activity.retain("thread");
    if (operation === "remove") activity.remove("thread");
    else activity.clear();
    const current = activity.retain("thread");
    changed.mockClear();
    old[Symbol.dispose]();
    expect(activity.has("thread")).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    current[Symbol.dispose]();
    expect(changed.mock.calls).toEqual([["thread", false]]);
  },
);
