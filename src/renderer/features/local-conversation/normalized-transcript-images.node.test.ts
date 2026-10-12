import { describe, expect, test, vi } from "vite-plus/test";
import { projectCodexTranscript } from "../../../shared/codex-transcript-projection";
import { timelineOwnerFixture } from "./projection/normalized-timeline.test-fixtures";
import { nativeGeneratedImage } from "./projection/normalized-timeline-image.test-fixtures";
import { projectGeneratedImageTranscriptGroups } from "./projection/generated-image-transcript-groups";

const page = { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
const key = { hostId: "local", threadId: "thread", entityKey: "turn:one" };
const src = "data:image/png;base64,aW1hZ2U=";

function fixture() {
  return timelineOwnerFixture(page, [
    nativeGeneratedImage("first", "completed", src),
    {
      type: "agentMessage",
      id: "answer",
      text: "Answer",
      phase: "commentary",
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
    nativeGeneratedImage("second"),
  ]);
}

describe("resident normalized image collection", () => {
  test("text deltas neither read other raw items nor wake the image aggregate", () => {
    const { owner } = fixture();
    const notify = vi.fn();
    const release = owner.subscribeGeneratedImages(notify);
    const initial = owner.readGeneratedImages();
    const reads = vi.spyOn(owner, "readItem");
    try {
      for (let i = 0; i < 20; i++)
        owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "text",
              key: { ...key, itemId: "answer" },
              target: { field: "text" },
              edits: [{ at: 6 + i, deleteCount: 0, insert: "." }],
            },
          ],
        });
      expect(owner.readGeneratedImages()).toBe(initial);
      expect(notify).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "item",
            key: { ...key, itemId: "second" },
            value: { ...nativeGeneratedImage("second", "completed", src), src },
          },
        ],
      });
      expect(notify).toHaveBeenCalledOnce();
      expect(owner.readGeneratedImages()[0]).toBe(initial[0]);
      expect(owner.readGeneratedImages()[1]?.item).toMatchObject({
        id: "second",
        status: "completed",
        src,
      });
      const groups = projectGeneratedImageTranscriptGroups(
        owner.readGeneratedImages(),
        "Thread title",
      );
      expect(groups.flatMap((group) => group.images.map((image) => image.id))).toEqual([
        "first",
        "second",
      ]);
      expect(groups[1]?.images[0]?.tabTitle).toBe("Thread title - Generated image 2");
    } finally {
      reads.mockRestore();
      release();
    }
    expect(owner.readGeneratedImages()).toEqual([]);
    expect(owner.readItem("turn:one", "first")).toBeNull();
  });

  test("slot eviction and restoration change the native image index without a materialized Turn", () => {
    const { owner } = fixture();
    const release = owner.subscribeGeneratedImages(() => {});
    const originalSlots = owner.readItemSlots(key.entityKey)!;
    const original = owner.readGeneratedImages();
    const wholeReads = [
      vi.spyOn(owner, "readTurn"),
      vi.spyOn(owner, "readTurnSlice"),
      vi.spyOn(owner, "readCanonicalTurn"),
    ];
    try {
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "item-slots",
            key,
            slots: {
              ...originalSlots,
              entries: originalSlots.entries.filter((slot) => slot.itemId !== "first"),
            },
          },
        ],
      });
      expect(owner.readGeneratedImages().map((image) => image.item.id)).toEqual(["second"]);
      owner.applyEvent({
        type: "changes",
        changes: [{ type: "item-slots", key, slots: originalSlots }],
      });
      expect(owner.readGeneratedImages().map((image) => [image.item.id, image.itemIndex])).toEqual([
        ["first", 0],
        ["second", 2],
      ]);
      expect(owner.readGeneratedImages()[0]?.item).toBe(original[0]?.item);
      owner.applyEvent({ type: "changes", changes: [{ type: "remove-turn", key }] });
      expect(owner.readGeneratedImages()).toEqual([]);
      wholeReads.forEach((read) => expect(read).not.toHaveBeenCalled());
    } finally {
      wholeReads.forEach((read) => read.mockRestore());
      release();
    }
  });

  test("a long Turn appends ordinary slots without replacing its image aggregate", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({
      type: "plan" as const,
      id: `plan-${index}`,
      text: "work",
    }));
    const { owner } = timelineOwnerFixture(page, [nativeGeneratedImage("first"), ...items]);
    const notify = vi.fn();
    const release = owner.subscribeGeneratedImages(notify);
    const before = owner.readGeneratedImages();
    try {
      const count = 100;
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "item-slots-append",
            key,
            previousLength: items.length + 1,
            length: items.length + 1 + count,
            entries: Array.from({ length: count }, (_, index) => ({
              itemId: `appended-${index}`,
              index: items.length + 1 + index,
            })),
          },
          ...Array.from({ length: count }, (_, index) => ({
            type: "item" as const,
            key: { ...key, itemId: `appended-${index}` },
            value: { type: "plan" as const, id: `appended-${index}`, text: "new work" },
          })),
        ],
      });
      expect(owner.readGeneratedImages()).toBe(before);
      expect(notify).not.toHaveBeenCalled();
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "item",
            key: { ...key, itemId: "first" },
            value: { ...nativeGeneratedImage("first", "completed", src), src },
          },
        ],
      });
      expect(owner.readGeneratedImages()[0]).toMatchObject({
        itemIndex: 0,
        item: { id: "first", src },
      });
      expect(notify).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  test("image reads commit atomically with staged resets and rejected item batches", () => {
    const { owner } = fixture();
    const notify = vi.fn();
    const release = owner.subscribeGeneratedImages(notify);
    const initial = owner.readGeneratedImages();
    const next = timelineOwnerFixture(page, [
      nativeGeneratedImage("replacement", "completed", src),
    ]);
    const snapshot = projectCodexTranscript(next.state);
    try {
      expect(() =>
        owner.applyEvent({
          type: "changes",
          changes: [
            { type: "item", key: { ...key, itemId: "first" }, value: null },
            { type: "item", key: { ...key, hostId: "another", itemId: "second" }, value: null },
          ],
        }),
      ).toThrow("different conversation");
      expect(owner.readGeneratedImages()).toBe(initial);
      expect(notify).not.toHaveBeenCalled();
      owner.applyEvent({ type: "reset-start", value: snapshot });
      owner.applyEvent({
        type: "reset-part",
        turnsByKey: snapshot.turnsByKey,
        itemsByKey: {},
        realtimeItems: {},
      });
      expect(owner.readGeneratedImages()).toBe(initial);
      owner.applyEvent({
        type: "reset-part",
        turnsByKey: {},
        itemsByKey: snapshot.itemsByKey,
        realtimeItems: snapshot.realtimeItems,
      });
      owner.applyEvent({ type: "reset-commit" });
      expect(owner.readGeneratedImages().map((image) => image.item.id)).toEqual(["replacement"]);
      expect(notify).toHaveBeenCalledOnce();
      owner.dispose();
      expect(owner.readGeneratedImages()).toEqual([]);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      release();
      next.owner.dispose();
    }
  });
});
