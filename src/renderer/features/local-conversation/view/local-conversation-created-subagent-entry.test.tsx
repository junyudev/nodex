import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ThreadItem, ThreadTimelineEntry } from "@nodex/codex-app-server-protocol/v2";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import { isCodexTimelineTurnEntry } from "../projection/normalized-timeline-entries";
import { LocalConversationTurnEntry } from "./local-conversation-turn-entry";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadStageActions,
} from "../thread-stage-types";

const receipt = (itemId: string): ThreadTimelineEntry => ({
  type: "realtime",
  position: 1,
  item: {
    type: "bemItemPromoted",
    id: "receipt",
    realtimeSessionId: "session",
    itemId,
    turnId: "one",
    presentation: { type: "wholeItem" },
  },
});
function nativeFixture(items: ThreadItem[]) {
  const first = items[0]!;
  const fixture = timelineOwnerFixture(
    {
      data: [
        { type: "item", position: 0, turnId: "one", item: first },
        receipt(first.id),
        ...items.slice(1).map((item, index): ThreadTimelineEntry => ({
          type: "item",
          position: index + 2,
          turnId: "one",
          item,
        })),
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    },
    items,
  );
  const entry = fixture
    .project()
    .entries.find((row) => isCodexTimelineTurnEntry(row) && row.timelineWholeItem);
  if (!entry || !isCodexTimelineTurnEntry(entry)) throw new Error("Missing native presentation");
  return { ...fixture, entry };
}
function surface(
  fixture: ReturnType<typeof nativeFixture>,
  onOpenThread: ThreadStageActions["onOpenThread"],
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[],
) {
  return (
    <LocalConversationTestQueryProvider>
      <NodexTooltipProvider>
        <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
          <LocalConversationTurnEntry
            conversationId="thread"
            entry={fixture.entry}
            cwd="/workspace"
            canEditTurnUserPrefix={false}
            canForkTurn={false}
            onOpenThread={onOpenThread}
            backgroundAgentRows={backgroundAgentRows}
          />
        </CodexTranscriptReadOwnerContext.Provider>
      </NodexTooltipProvider>
    </LocalConversationTestQueryProvider>
  );
}
describe("native dedicated creation and subagent leaves", () => {
  test("creation reads one raw item without Turn/Slice/slot/MCP materialization and preserves its receipt through a target update", async () => {
    const item: ThreadItem = {
      type: "dynamicToolCall",
      id: "created",
      namespace: "codex_app",
      tool: "create_thread",
      status: "completed",
      arguments: {},
      contentItems: [{ type: "inputText", text: '{"threadId":"child","hostId":"remote"}' }],
      success: true,
      durationMs: 1,
    };
    const fixture = nativeFixture([item]);
    const retain = fixture.owner.subscribeStructure(() => {});
    const whole = vi.spyOn(fixture.owner, "readTurn"),
      slice = vi.spyOn(fixture.owner, "readTurnSlice"),
      slots = vi.spyOn(fixture.owner, "readItemSlots");
    const open = vi.fn();
    const view = render(surface(fixture, open));
    try {
      const card = await view.findByRole("button", { name: "Open chat: Created chat" });
      await act(async () => {
        card.focus();
        fixture.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item",
              key: { ...fixture.owner.key, entityKey: "turn:one", itemId: "created" },
              value: {
                ...item,
                contentItems: [
                  {
                    type: "inputText",
                    text: '{"threadId":"child","hostId":"remote","ignored":"updated"}',
                  },
                ],
              },
            },
          ],
        });
        await Promise.resolve();
      });
      const updated = await view.findByRole("button", { name: "Open chat: Created chat" });
      expect(updated).toBe(card);
      expect(document.activeElement).toBe(card);
      await act(async () => {
        fireEvent.click(updated);
        await Promise.resolve();
      });
      expect(open).toHaveBeenCalledExactlyOnceWith("child", {
        createdTarget: { threadId: "child", hostId: "remote" },
        sourceRoot: { hostId: "local", threadId: "thread" },
      });
      expect(
        view.container.querySelector('[data-native-created-thread-item-id="created"]'),
      ).not.toBeNull();
      expect(whole).not.toHaveBeenCalled();
      expect(slice).not.toHaveBeenCalled();
      expect(slots).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      retain();
    }
  });
  test("the real started leaf consumes later lifecycle state and carries the captured source host/root", async () => {
    const start: ThreadItem = {
      type: "subAgentActivity",
      model: null,
      reasoningEffort: null,
      id: "start",
      kind: "started",
      agentThreadId: "child",
      agentPath: "root/reviewer",
    };
    const done: ThreadItem = { ...start, id: "done", kind: "completed" };
    const fixture = nativeFixture([start, done]);
    const retain = fixture.owner.subscribeStructure(() => {});
    const whole = vi.spyOn(fixture.owner, "readTurn"),
      slice = vi.spyOn(fixture.owner, "readTurnSlice"),
      open = vi.fn();
    const view = render(surface(fixture, open));
    try {
      await view.findByRole("status", { name: "Subagents finished" });
      expect(view.queryAllByTestId("subagent-activity-inline-group")).toHaveLength(1);
      await act(async () => {
        fixture.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item",
              key: { ...fixture.owner.key, entityKey: "turn:one", itemId: "done" },
              value: { ...done, kind: "interrupted" },
            },
          ],
        });
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByRole("status", { name: "Subagents was interrupted" })).toBeTruthy(),
      );
      expect(whole).not.toHaveBeenCalled();
      expect(slice).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      retain();
    }
  });
  test("native parent Turn identity selects current directory metadata without borrowing the layout key", async () => {
    const start: ThreadItem = {
      type: "subAgentActivity",
      model: null,
      reasoningEffort: null,
      id: "start",
      kind: "started",
      agentThreadId: "child",
      agentPath: "root/reviewer",
    };
    const fixture = nativeFixture([start]);
    const retain = fixture.owner.subscribeStructure(() => {});
    const row: ThreadComposerShellBackgroundAgentRowModel = {
      conversationId: "child",
      identityThreadId: "child",
      parentConversationId: "thread",
      parentTurnKey: "one",
      displayName: "Verified reviewer",
      actorName: "Reviewer",
      status: "done",
      statusSummary: "Verified completion",
      showInlineActivity: false,
      canInteract: false,
      agentRole: "reviewer",
      spawnModel: null,
      lastAssistantMessage: null,
      lastAssistantMessageAtMs: null,
      recencyAtMs: 2,
      diffStats: null,
      role: "backgroundChild",
    };
    const open = vi.fn();
    const whole = vi.spyOn(fixture.owner, "readTurn");
    const view = render(surface(fixture, open, [row]));
    try {
      await view.findByRole("status", { name: "Subagents finished" });
      const button = await view.findByRole("button", { name: "Verified reviewer" });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(open).toHaveBeenCalledExactlyOnceWith("child", {
        hostId: "local",
        sourceRoot: { hostId: "local", threadId: "thread" },
        subagent: {
          conversationId: "child",
          displayName: "Verified reviewer",
          agentRole: "reviewer",
          spawnModel: null,
          diffStats: null,
          showInlineActivity: true,
          status: "done",
          statusSummary: "Verified completion",
        },
      });
      view.rerender(surface(fixture, open, [{ ...row, canInteract: true }]));
      expect(view.getByRole("button", { name: "Verified reviewer" })).toBe(button);
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(open.mock.calls.at(-1)?.[1]).toMatchObject({ subagent: { canInteract: true } });
      expect(whole).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      retain();
    }
  });
});
