import { act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { useLayoutEffect } from "react";
import type { ThreadItem, ThreadTimelineListResponse } from "@nodex/codex-app-server-protocol/v2";
import { projectCodexTranscript } from "../../../../shared/codex-transcript-projection";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import {
  CodexTranscriptReadOwnerContext,
  useCodexTranscriptLatestTurnMetadata,
} from "../normalized-transcript-hooks";
import {
  isCodexRealtimeTimelineEntry,
  isCodexTimelineTurnEntry,
} from "../projection/normalized-timeline-entries";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import type { ConversationTurnListEntry } from "../selectors";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import { LocalConversationTurnEntry } from "./local-conversation-turn-entry";

const command: ThreadItem = {
  type: "commandExecution",
  id: "command",
  pluginId: null,
  scriptPath: null,
  command: "pwd",
  cwd: "/workspace",
  processId: null,
  source: "agent",
  status: "completed",
  commandActions: [],
  aggregatedOutput: "observed command",
  exitCode: 0,
  durationMs: 1,
};
const answer: ThreadItem = {
  type: "agentMessage",
  id: "answer",
  text: "Native terminal answer",
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
};
const entries: ThreadTimelineListResponse["data"] = [
  { type: "turnStarted", position: 1, turnId: "one", startedAt: 1 },
  { type: "item", position: 2, turnId: "one", item: command },
  { type: "item", position: 3, turnId: "one", item: answer },
];
function fixture(completed: boolean) {
  return timelineOwnerFixture(
    {
      activeRealtimeSessionAtPageStart: "session",
      nextCursor: null,
      data: completed
        ? [
            ...entries,
            {
              type: "turnCompleted",
              position: 4,
              turnId: "one",
              status: "interrupted",
              error: null,
              startedAt: 1,
              completedAt: 3,
              durationMs: 2000,
            },
          ]
        : entries,
    },
    [command, answer],
    { status: completed ? "interrupted" : "inProgress", completedAt: completed ? 3 : null },
  );
}
function surface(value: ReturnType<typeof fixture>, collapse: (collapsed: boolean) => void) {
  return (
    <LocalConversationTestQueryProvider>
      <CodexTranscriptReadOwnerContext.Provider value={value.owner}>
        {value
          .project()
          .entries.filter(
            (entry): entry is ConversationTurnListEntry => !isCodexRealtimeTimelineEntry(entry),
          )
          .map((entry) => (
            <LocalConversationTurnEntry
              key={entry.turnKey}
              entry={entry}
              conversationId="thread"
              cwd="/workspace"
              threadCwd="/workspace"
              canEditTurnUserPrefix
              canForkTurn
              persistedCollapsed
              onSetCollapsed={collapse}
            />
          ))}
      </CodexTranscriptReadOwnerContext.Provider>
    </LocalConversationTestQueryProvider>
  );
}

test("actual native work reveals terminal assistant without folding or adding Turn actions", async () => {
  const value = fixture(false);
  const fullReads = vi.spyOn(value.owner, "readTurn");
  const collapse = vi.fn();
  const view = render(surface(value, collapse));
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-local-conversation-item-target-ids~="command"]'),
    ).not.toBeNull(),
  );
  const commandOwner = view.container.querySelector(
    '[data-local-conversation-item-target-ids~="command"]',
  );
  expect(screen.queryByText("Native terminal answer")).toBeNull();
  expect(screen.queryByRole("button", { name: /previous message/ })).toBeNull();
  expect(screen.queryByText(/Working for/)).toBeNull();
  const thinking = await screen.findAllByText("Thinking");
  expect(thinking.filter((node) => !node.closest('[aria-hidden="true"]'))).toHaveLength(1);
  expect(fullReads).not.toHaveBeenCalled();
  const next = fixture(true);
  await act(async () => {
    value.owner.applyEvent({ type: "reset", value: projectCodexTranscript(next.state) });
    view.rerender(surface(value, collapse));
    await Promise.resolve();
  });
  await screen.findByText("Native terminal answer");
  await screen.findByText("Stopped for 2s");
  expect(view.container.querySelector('[data-local-conversation-item-target-ids~="command"]')).toBe(
    commandOwner,
  );
  expect(screen.queryByRole("button", { name: /previous message/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Fork/ })).toBeNull();
  expect(collapse).not.toHaveBeenCalled();
  view.unmount();
});

test("ordinary active rows subscribe once and text growth does not materialize the full Turn again", async () => {
  const value = fixture(false);
  value.owner.applyEvent({
    type: "reset",
    value: projectCodexTranscript({ ...value.state, itemTimeline: undefined, realtimeItems: {} }),
  });
  const fullReads = vi.spyOn(value.owner, "readTurn");
  const turnSubscriptions = vi.spyOn(value.owner, "subscribeTurn");
  const view = render(surface(value, vi.fn()));
  await screen.findByText("Native terminal answer");
  expect(fullReads).toHaveBeenCalledTimes(1);
  expect(turnSubscriptions).toHaveBeenCalledTimes(1);
  await act(async () => {
    value.owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "text",
          key: { hostId: "local", threadId: "thread", entityKey: "turn:one", itemId: "answer" },
          target: { field: "text" },
          edits: [{ at: answer.text.length, deleteCount: 0, insert: " appended" }],
        },
      ],
    });
    await Promise.resolve();
  });
  await screen.findByText("Native terminal answer appended");
  expect(fullReads).toHaveBeenCalledTimes(1);
  expect(turnSubscriptions).toHaveBeenCalledTimes(1);
  view.unmount();
});

test("latest-follow observes active native voice presentation rather than later Turn metadata", async () => {
  const older: ThreadItem[] = Array.from({ length: 10_000 }, (_, index) => ({
    type: "plan",
    id: `older-${index}`,
    text: "Older native work",
  }));
  const value = timelineOwnerFixture(
    {
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
      data: [
        entries[0]!,
        ...older.map((item, index) => ({
          type: "item" as const,
          position: index + 2,
          turnId: "one",
          item,
        })),
        {
          type: "realtime",
          position: 10002,
          item: {
            type: "transcriptSegment",
            id: "break",
            realtimeSessionId: "session",
            role: "user",
            text: "Continue",
          },
        },
        { ...entries[1]!, position: 10003 },
        { ...entries[2]!, position: 10004 },
      ],
    },
    [...older, command, answer],
    { status: "completed" },
  );
  const entry = value.project().entries.findLast(isCodexTimelineTurnEntry)!;
  const itemReads = vi.spyOn(value.owner, "readItem");
  const report = vi.fn();
  function Probe() {
    const metadata = useCodexTranscriptLatestTurnMetadata(entry);
    useLayoutEffect(() => {
      report(metadata);
    }, [metadata]);
    return null;
  }
  const view = render(
    <CodexTranscriptReadOwnerContext.Provider value={value.owner}>
      <Probe />
    </CodexTranscriptReadOwnerContext.Provider>,
  );
  await waitFor(() =>
    expect(report).toHaveBeenLastCalledWith({
      isInProgress: true,
      phase: "prework",
      latestSteeringUserMessageKey: null,
    }),
  );
  expect(value.owner.readTurnDetails("turn:one")!.status).toBe("completed");
  expect(itemReads.mock.calls.length).toBeLessThanOrEqual(2);
  view.unmount();
});
