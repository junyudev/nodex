import { describe, expect, it } from "vitest";
import {
  applyWireItemPatch,
  diffWireItem,
  isLiveWireItem,
  LiveWireItems,
  type WireItem,
} from "./ItemPatch.ts";

const reply = (text: string, extra: Record<string, unknown> = {}): WireItem => ({
  id: "item-1",
  type: "assistant_message",
  threadId: "thread-1",
  runId: "run-1",
  status: "running",
  streaming: true,
  messageId: "message-1",
  text,
  updatedAt: "2026-11-22T00:00:00.000Z",
  ...extra,
});

const roundTrip = (previous: WireItem, next: WireItem) => {
  const patch = diffWireItem(previous, next);
  expect(patch).not.toBeNull();
  expect(applyWireItemPatch(previous, patch!)).toEqual(next);
  return patch!;
};

describe("item patches", () => {
  it("carries only appended text and the fields that changed", () => {
    const patch = roundTrip(
      reply("Hello"),
      reply("Hello, world", { updatedAt: "2026-11-22T00:00:01.000Z" }),
    );
    expect(patch).toEqual({
      itemId: "item-1",
      set: { updatedAt: "2026-11-22T00:00:01.000Z" },
      append: { field: "text", offset: 5, text: ", world" },
    });
  });

  it("sends rewritten text whole instead of appending", () => {
    const patch = roundTrip(reply("Draft answer"), reply("Final answer"));
    expect(patch.set).toEqual({ text: "Final answer" });
    expect(patch.append).toBeUndefined();
  });

  it("settles an item without resending its text", () => {
    const patch = roundTrip(
      reply("Done."),
      reply("Done.", { status: "completed", streaming: false }),
    );
    expect(patch).toEqual({ itemId: "item-1", set: { status: "completed", streaming: false } });
  });

  it("records removed and nested fields", () => {
    const previous = reply("x", { attachments: [{ id: "a" }], memoryCitation: { id: "m" } });
    const { memoryCitation: _removed, ...rest } = reply("xy", { attachments: [{ id: "b" }] });
    const patch = roundTrip(previous, rest as WireItem);
    expect(patch.unset).toEqual(["memoryCitation"]);
    expect(patch.set).toEqual({ attachments: [{ id: "b" }] });
  });

  it("appends to a plan's markdown and keeps multi-unit characters intact", () => {
    const plan = (markdown: string): WireItem => ({
      id: "plan-1",
      type: "proposed_plan",
      status: "running",
      markdown,
    });
    const patch = roundTrip(plan("1. 🚀"), plan("1. 🚀 ship"));
    expect(patch.append).toEqual({ field: "markdown", offset: 5, text: " ship" });
  });

  it("treats a different item or type as a whole delivery", () => {
    expect(diffWireItem(reply("a"), { ...reply("a"), id: "item-2" })).toBeNull();
    expect(diffWireItem(reply("a"), { ...reply("a"), type: "reasoning" })).toBeNull();
  });

  it("refuses a patch built against another version", () => {
    const patch = diffWireItem(reply("Hello"), reply("Hello there"))!;
    expect(applyWireItemPatch(reply("Hell"), patch)).toBeNull();
    expect(applyWireItemPatch({ ...reply("Hello"), id: "other" }, patch)).toBeNull();
  });

  it("makes a stream's delivered text linear in its final length", () => {
    const words = Array.from({ length: 400 }, (_, index) => `word${index} `);
    let previous = reply("");
    let delivered = 0;
    let text = "";
    for (const word of words) {
      text += word;
      const next = reply(text);
      delivered += JSON.stringify(diffWireItem(previous, next)).length;
      previous = next;
    }
    const perFrameOverhead = 96;
    expect(delivered).toBeLessThanOrEqual(text.length + words.length * perFrameOverhead);
  });
});

describe("live item bases", () => {
  it("keeps live items, forgets settled ones and bounds how many it holds", () => {
    const live = new LiveWireItems(2);
    live.remember(reply("a"));
    expect(live.get("item-1")?.text).toBe("a");
    live.remember(reply("a", { status: "completed", streaming: false }));
    expect(live.get("item-1")).toBeUndefined();
    for (const id of ["x", "y", "z"]) live.remember({ ...reply(id), id });
    expect([live.get("x"), live.get("y")?.id, live.get("z")?.id]).toEqual([undefined, "y", "z"]);
  });

  it("recognizes live work and streaming text", () => {
    expect(isLiveWireItem(reply("a"))).toBe(true);
    expect(isLiveWireItem(reply("a", { status: "completed", streaming: true }))).toBe(true);
    expect(isLiveWireItem(reply("a", { status: "completed", streaming: false }))).toBe(false);
  });
});
