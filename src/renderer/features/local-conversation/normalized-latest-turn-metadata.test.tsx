import { act, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { timelineOwnerFixture } from "./projection/normalized-timeline.test-fixtures";
import { selectNormalizedConversationTurnEntries } from "./normalized-transcript-selectors";
import {
  CodexTranscriptReadOwnerContext,
  useCodexTranscriptLatestTurnMetadata,
} from "./normalized-transcript-hooks";

const key = { hostId: "local", threadId: "thread", entityKey: "turn:one" };
const agent: Extract<ThreadItem, { type: "agentMessage" }> = {
  type: "agentMessage",
  id: "answer",
  text: "Working",
  phase: "commentary",
  memoryCitation: null,
  delivery: null,
  questions: null,
};

describe("latest Turn lifecycle metadata", () => {
  test("updates follow phase and steering identity without materializing a Turn or waking for stream text", async () => {
    const { owner } = timelineOwnerFixture(
      { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null },
      [agent],
    );
    const retain = owner.subscribeStructure(() => {});
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key,
          details: { ...owner.readTurnDetails(key.entityKey)!, status: "inProgress" },
          hasSubagentActivity: false,
        },
      ],
    });
    const entry = selectNormalizedConversationTurnEntries({
      owner,
      structure: owner.readStructure()!,
      conversation: null,
    })[0]!;
    const readTurn = vi.spyOn(owner, "readTurn");
    const readSlice = vi.spyOn(owner, "readTurnSlice");
    const metadataReads = vi.spyOn(owner, "readTurnMetadataAtVersion");
    const values: ReturnType<typeof useCodexTranscriptLatestTurnMetadata>[] = [];
    function Metadata() {
      values.push(useCodexTranscriptLatestTurnMetadata(entry));
      return null;
    }
    const view = render(
      <CodexTranscriptReadOwnerContext.Provider value={owner}>
        <Metadata />
      </CodexTranscriptReadOwnerContext.Provider>,
    );
    try {
      expect(values.at(-1)).toEqual({
        phase: "prework",
        isInProgress: true,
        latestSteeringUserMessageKey: null,
      });
      const count = values.length;
      const initialReads = metadataReads.mock.calls.length;
      await act(async () => {
        owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "text",
              key: { ...key, itemId: "answer" },
              target: { field: "text" },
              edits: [{ at: 7, deleteCount: 0, insert: " more" }],
            },
          ],
        });
      });
      expect(values).toHaveLength(count);
      expect(metadataReads).toHaveBeenCalledTimes(initialReads);
      await act(async () => {
        owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item",
              key: { ...key, itemId: "answer" },
              value: { ...agent, phase: "final_answer" },
            },
            {
              type: "item",
              key: { ...key, itemId: "steer-row" },
              value: {
                type: "steeringUserMessage",
                id: "steer-row",
                targetTurnId: "one",
                targetTurnStartedAtMs: 1_000,
                status: "pending",
                clientUserMessageId: "client",
                input: [],
                attachments: [],
                restoreMessage: { id: "restore-message", context: { commentAttachments: [] } },
                compareKey: { rawText: "", imageCount: 0 },
              },
            },
            {
              type: "item-slots-append",
              key,
              previousLength: 1,
              length: 2,
              entries: [{ index: 1, itemId: "steer-row" }],
            },
          ],
        });
      });
      expect(values.at(-1)).toEqual({
        phase: "final_answer",
        isInProgress: true,
        latestSteeringUserMessageKey: "restore-message",
      });
      await act(async () => {
        owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item",
              key: { ...key, itemId: "second-steer" },
              value: {
                type: "steeringUserMessage",
                id: "second-steer",
                targetTurnId: "one",
                targetTurnStartedAtMs: 1_000,
                status: "pending",
                clientUserMessageId: "second-client",
                input: [],
                attachments: [],
                restoreMessage: { id: "second-message", context: { commentAttachments: [] } },
                compareKey: { rawText: "", imageCount: 0 },
              },
            },
            {
              type: "item-slots-append",
              key,
              previousLength: 2,
              length: 3,
              entries: [{ index: 2, itemId: "second-steer" }],
            },
          ],
        });
      });
      expect(values.at(-1)).toEqual({
        phase: "final_answer",
        isInProgress: true,
        latestSteeringUserMessageKey: "second-message",
      });
      expect(readTurn).not.toHaveBeenCalled();
      expect(readSlice).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      retain();
      readTurn.mockRestore();
      readSlice.mockRestore();
      metadataReads.mockRestore();
    }
  });
});
