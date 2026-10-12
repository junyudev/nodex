import { describe, expect, test } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  isCodexTimelineTurnEntry,
  isCodexRealtimeTimelineEntry,
  readLatestCodexTimelineTurnEntry,
} from "./normalized-timeline-entries";
import { timelineOwnerFixture } from "./normalized-timeline.test-fixtures";
import {
  imageReceipt,
  nativeGeneratedImage,
  nativeImageTimelineFixture,
} from "./normalized-timeline-image.test-fixtures";
import { resolveTimelineWholeItemPresentation } from "./timeline-whole-item-presentation";

const agent = (id: string): ThreadItem => ({
  type: "agentMessage",
  id,
  text: id,
  phase: "commentary",
  memoryCitation: null,
  delivery: null,
  questions: null,
});

describe("native generated-image presentations", () => {
  test("only specializes a whole-item native image", () => {
    const image = nativeGeneratedImage();
    expect(resolveTimelineWholeItemPresentation(image, { type: "wholeItem" })).toEqual({
      type: "generatedImage",
      itemId: image.id,
    });
    expect(resolveTimelineWholeItemPresentation(image, { type: "inlineMarkdown" })).toBeNull();
    expect(
      resolveTimelineWholeItemPresentation(agent("message"), { type: "wholeItem" }),
    ).toBeNull();
  });

  test("keeps repeated receipt positions out of ordinary work and native Turn ownership", () => {
    const before = agent("before"),
      after = agent("after"),
      image = nativeGeneratedImage();
    const { project } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 0, turnId: "one", item: before },
          { type: "item", position: 1, turnId: "one", item: image },
          imageReceipt("first", image.id, 2),
          imageReceipt("second", image.id, 3),
          { type: "item", position: 4, turnId: "one", item: after },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [before, image, after],
    );
    const rows = project().entries.filter(isCodexTimelineTurnEntry);
    expect(rows.map((row) => row.timelineSlice.itemIds)).toEqual([
      ["before", "after"],
      [image.id],
      [image.id],
    ]);
    expect(rows.slice(1).map((row) => row.turnKey)).toEqual([
      "timeline:presentation:first",
      "timeline:presentation:second",
    ]);
    expect(
      rows
        .slice(1)
        .every((row) => !row.timelineUserActions && !row.timelineSlice.includeTurnExtras),
    ).toBe(true);
    expect(readLatestCodexTimelineTurnEntry(rows)).toBe(rows[0]);
  });

  test("an image receipt ends a consecutive voice transcript group", () => {
    const image = nativeGeneratedImage();
    const voice = (id: string, position: number) => ({
      type: "realtime" as const,
      position,
      item: {
        type: "transcriptSegment" as const,
        id,
        realtimeSessionId: "session",
        role: "assistant" as const,
        text: id,
      },
    });
    const { project } = timelineOwnerFixture(
      {
        data: [voice("before", 0), imageReceipt("image-receipt", image.id, 1), voice("after", 2)],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [image],
    );
    expect(
      project().entries.map((row) => ("segmentIds" in row ? row.segmentIds : row.turnKey)),
    ).toEqual([["before"], "timeline:presentation:image-receipt", ["after"]]);
  });

  test("retains native presentation identities while a raw item is temporarily absent", () => {
    const { owner, project } = nativeImageTimelineFixture();
    const retain = owner.subscribeStructure(() => {});
    try {
      const before = project().entries.filter(isCodexTimelineTurnEntry);
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "item",
            key: { hostId: "local", threadId: "thread", entityKey: "turn:one", itemId: "image" },
            value: null,
          },
        ],
      });
      const after = project().entries.filter(isCodexRealtimeTimelineEntry);
      expect(after.map((row) => row.turnKey)).toEqual(before.map((row) => row.turnKey));
      expect(after.map((row) => row.itemId)).toEqual(["first", "second"]);
      expect(after.every((row) => row.itemType === "bemItemPromoted")).toBe(true);
    } finally {
      retain();
    }
  });
});
