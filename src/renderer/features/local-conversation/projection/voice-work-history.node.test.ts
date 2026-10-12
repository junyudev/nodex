import { describe, expect, test } from "vite-plus/test";
import type { ThreadItem, ThreadTimelineListResponse } from "@nodex/codex-app-server-protocol/v2";
import type { CodexApprovalRequest, CodexCanonicalItem } from "../../../../shared/types";
import { projectCodexTranscript } from "../../../../shared/codex-transcript-projection";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import { resolveWorkedForLabelText } from "../thread-worked-for-time";
import { buildTurnRenderModel } from "./build-turn-render-model";
import {
  isCodexTimelineTurnEntry,
  projectNormalizedTimelineEntries,
} from "./normalized-timeline-entries";
import { timelineOwnerFixture } from "./normalized-timeline.test-fixtures";

type Receipt = ThreadTimelineListResponse["data"][number];
const assistant = (id: string, text = id): ThreadItem => ({
  type: "agentMessage",
  id,
  text,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const tool = (id: string): ThreadItem => ({
  type: "commandExecution",
  id,
  pluginId: null,
  scriptPath: null,
  command: "pwd",
  cwd: "/workspace",
  processId: null,
  source: "agent",
  status: "completed",
  commandActions: [],
  aggregatedOutput: id,
  exitCode: 0,
  durationMs: 1,
});
const item = (value: ThreadItem, position: number): Receipt => ({
  type: "item",
  turnId: "one",
  item: value,
  position,
});
const start = (position = 1): Extract<Receipt, { type: "turnStarted" }> => ({
  type: "turnStarted",
  turnId: "one",
  position,
  startedAt: 1.125,
});
const complete = (position: number, completedAt: number | null = 4.875): Receipt => ({
  type: "turnCompleted",
  turnId: "one",
  position,
  startedAt: 1.125,
  completedAt,
  status: "interrupted",
  error: null,
  durationMs: 3750,
});
const spoken = (position: number): Receipt => ({
  type: "realtime",
  position,
  item: {
    type: "transcriptSegment",
    id: `spoken-${position}`,
    realtimeSessionId: "session",
    role: "user",
    text: "spoken",
  },
});
const close = (position: number, session = "session"): Receipt => ({
  type: "realtime",
  position,
  item: {
    type: "realtimeSessionClosed",
    id: `close-${position}`,
    realtimeSessionId: session,
    outcome: "ended",
  },
});
const page = (data: Receipt[], session: string | null = "session"): ThreadTimelineListResponse => ({
  data,
  nextCursor: null,
  activeRealtimeSessionAtPageStart: session,
});
const workRows = (fixture: ReturnType<typeof timelineOwnerFixture>) =>
  fixture
    .project()
    .entries.filter(isCodexTimelineTurnEntry)
    .filter((entry) => entry.timelineSlice.work);
const model = (entry: ReturnType<typeof workRows>[number]) =>
  buildTurnRenderModel({
    turn: entry.readTurn()!,
    turnKey: entry.turnKey,
    requests: entry.requests,
    isLatestTurn: entry.isMostRecentTurn,
    isStreamingTurn: entry.turnStatus === "inProgress",
    workSegment: entry.timelineSlice.work,
    endResourcePaths: [],
  });

describe("native voice work history", () => {
  test("breaks close only active segments and completion owns only the current native work", () => {
    const raw = [tool("c1"), assistant("a1"), tool("c2"), tool("c3"), assistant("a3")];
    const fixture = timelineOwnerFixture(
      page([
        start(),
        item(raw[0]!, 2),
        item(raw[1]!, 3),
        spoken(4),
        item(raw[2]!, 5),
        close(6, "stale"),
        close(7),
        item(raw[3]!, 8),
        item(raw[4]!, 9),
        complete(10),
      ]),
      raw,
      { status: "interrupted", startedAt: 1.125, completedAt: 4.875, durationMs: 3750 },
    );
    const rows = workRows(fixture);
    expect(rows.map((row) => row.timelineSlice.work)).toEqual([
      {
        presentation: "voice-work",
        state: "terminal",
        startedAtMs: 1125,
        completedAtMs: null,
        terminalReason: null,
      },
      {
        presentation: "voice-work",
        state: "terminal",
        startedAtMs: 1125,
        completedAtMs: null,
        terminalReason: null,
      },
      {
        presentation: "codex",
        state: "terminal",
        startedAtMs: 1125,
        completedAtMs: 4875,
        terminalReason: "turn",
      },
    ]);
    expect(rows.map((row) => row.timelineSlice.includeTurnExtras)).toEqual([false, false, true]);
    expect(rows[0]!.readTurn()).toMatchObject({
      status: "completed",
      clientUserMessageId: null,
      durationMs: null,
    });
    expect(rows[0]!.readTurn()!.items.some((entry) => entry.rawItemId === "a1")).toBe(true);
    expect(rows[2]!.readTurn()).toMatchObject({
      status: "interrupted",
      durationMs: 3750,
      completedAt: 4875,
    });
    expect(
      fixture.project().entries.some((entry) => "itemId" in entry && entry.itemId === "close-6"),
    ).toBe(false);
    expect(fixture.owner.readTurn("turn:one")!.status).toBe("interrupted");
    expect(fixture.owner.readTurn("turn:one")!.itemIds).toEqual(raw.map((value) => value.id));
  });

  test("active voice hides assistant and child activity while preserving native command leaves", () => {
    const raw = [
      tool("c1"),
      assistant("a1"),
      {
        type: "subAgentActivity",
        id: "child",
        kind: "started",
        agentThreadId: "child-thread",
        agentPath: "child",
      } satisfies ThreadItem,
    ];
    const fixture = timelineOwnerFixture(
      page([start(), ...raw.map((value, index) => item(value, index + 2))]),
      raw,
      { status: "inProgress", completedAt: null, durationMs: null },
    );
    const row = workRows(fixture)[0]!;
    const turn = row.readTurn()!;
    expect(turn.items.map((entry) => entry.rawItemId)).toEqual(["c1"]);
    expect(turn.clientUserMessageId).toBeNull();
    expect(turn.firstTurnWorkItemStartedAtMs).toBeNull();
    const rendered = model(row);
    expect(rendered.voiceWorkActivity).toBe("active");
    expect(rendered.workedForItem).toBeNull();
    expect(rendered.defaultAgentBodyCollapsed).toBe(false);
    expect(fixture.owner.readItem("turn:one", "a1")).toBe(raw[1]);
  });

  test("terminal voice gets a stopped header only with both exact timestamps", () => {
    const raw = [tool("c1"), assistant("a1")];
    const fixture = timelineOwnerFixture(
      page([start(), item(raw[0]!, 2), item(raw[1]!, 3), complete(4, 0.75)]),
      raw,
      { status: "interrupted", startedAt: 1.125, completedAt: 0.75 },
    );
    const row = workRows(fixture)[0]!;
    const rendered = model(row);
    expect(row.readTurn()!.durationMs).toBe(0);
    expect(rendered.workedForTiming).toEqual({
      status: "stopped",
      startedAtMs: 1125,
      completedAtMs: 750,
    });
    expect(resolveWorkedForLabelText({ timing: rendered.workedForTiming, durationMs: 0 })).toBe(
      "Stopped for 0s",
    );
    expect(rendered.leadingBlocks.filter((block) => block.type === "workedFor")).toHaveLength(1);
    expect(rendered.buckets.assistantItem?.assistantMessageActions).toBeUndefined();
    const unknown = timelineOwnerFixture(
      page([start(), item(raw[0]!, 2), complete(3, null)]),
      raw,
      { completedAt: null },
    );
    expect(model(workRows(unknown)[0]!).workedForItem).toBeNull();
  });

  test("keeps actual empty started Turns and appends pending work in the final session", () => {
    const fixture = timelineOwnerFixture(
      page([start(), spoken(2), close(3), { ...start(4), turnId: "unloaded" }]),
      [],
      { status: "inProgress", completedAt: null },
    );
    expect(fixture.owner.readStructure()!.turns).toHaveLength(1);
    expect(workRows(fixture)).toHaveLength(1);
    expect(workRows(fixture)[0]).toMatchObject({
      turnId: "one",
      requests: [],
      timelineSlice: {
        itemIds: [],
        work: { presentation: "codex", state: "active" },
      },
    });
    expect(fixture.project().entries.at(-1)?.turnKey).toBe(workRows(fixture)[0]!.turnKey);
  });

  test("completion after a boundary does not backfill old work and resources have their own receipt row", () => {
    const raw = [assistant("a1", ':codex-file-citation{path="deck.pptx" purpose="output"}')];
    const fixture = timelineOwnerFixture(
      page([start(), item(raw[0]!, 2), spoken(3), complete(4)]),
      raw,
    );
    const entries = fixture.project().entries.filter(isCodexTimelineTurnEntry);
    expect(workRows(fixture)[0]!.timelineSlice.work).toMatchObject({
      completedAtMs: null,
      terminalReason: null,
    });
    expect(workRows(fixture)[0]!.timelineSlice.includeTurnExtras).toBe(false);
    expect(entries.at(-1)).toMatchObject({
      timelineEndResources: true,
      requests: [],
      timelineUserActions: false,
    });
    expect(entries.filter((entry) => entry.timelineEndResources)).toHaveLength(1);
  });

  test("terminal requests use item target before call target; active requests keep the scoped base list", () => {
    const raw = [tool("c1"), tool("c2")];
    const fixture = timelineOwnerFixture(
      page([start(), item(raw[0]!, 2), spoken(3), item(raw[1]!, 4)]),
      raw,
    );
    const requests: CodexApprovalRequest[] = [
      {
        type: "approval",
        kind: "command",
        requestId: 1,
        projectId: null,
        threadId: "thread",
        turnId: "one",
        itemId: "c2",
        callId: "c1",
        createdAt: 1,
      },
      {
        type: "approval",
        kind: "command",
        requestId: 2,
        projectId: null,
        threadId: "thread",
        turnId: "one",
        itemId: "c1",
        createdAt: 1,
      },
    ];
    const structure = fixture.owner.readStructure()!;
    const entries = selectNormalizedConversationTurnEntries({
      owner: fixture.owner,
      structure,
      conversation: null,
    }).map((entry) => ({ ...entry, requests }));
    const rows = projectNormalizedTimelineEntries({
      owner: fixture.owner,
      structure,
      entries,
    }).entries.filter(isCodexTimelineTurnEntry);
    expect(rows[0]!.requests.map((request) => request.requestId)).toEqual([2]);
    expect(rows[1]!.requests.map((request) => request.requestId)).toEqual([1, 2]);
  });

  test("complete realtime handoff input stays hidden, with tail flush excluding its whole Turn", () => {
    const text =
      "<realtime_delegation><input>Continue &lt;work&gt;</input><source>transcript_tail_flush</source></realtime_delegation>";
    const raw: ThreadItem[] = [
      {
        type: "userMessage",
        id: "u",
        clientId: "client",
        content: [{ type: "text", text, text_elements: [] }],
      },
      tool("c1"),
    ];
    const fixture = timelineOwnerFixture(
      page([start(), item(raw[0]!, 2), item(raw[1]!, 3), complete(4)]),
      raw,
    );
    expect(fixture.project().entries).toHaveLength(0);
    const ordinary = timelineOwnerFixture(page([start(), item(raw[0]!, 2), item(raw[1]!, 3)]), raw);
    ordinary.owner.applyEvent({
      type: "reset",
      value: projectCodexTranscript({
        ...ordinary.state,
        turns: ordinary.state.turns.map((turn) => ({
          ...turn,
          params: { ...turn.params, input: [] },
        })),
      }),
    });
    expect(workRows(ordinary)[0]!.timelineSlice.itemIds).toEqual(["c1"]);
  });

  test("an observed steer uses its canonical native identity once instead of the lifecycle echo", () => {
    const echo: ThreadItem = {
      type: "userMessage",
      id: "server-echo",
      clientId: "client-steer",
      content: [{ type: "text", text: "continue", text_elements: [] }],
    };
    const raw = [tool("before"), tool("after")];
    const fixture = timelineOwnerFixture(
      page([start(), item(raw[0]!, 2), item(echo, 3), item(raw[1]!, 4)]),
      raw,
    );
    const steer: CodexCanonicalItem = {
      type: "steeringUserMessage",
      id: "local-steer",
      status: "accepted",
      serverUserMessageId: "server-echo",
      targetTurnId: "one",
      targetTurnStartedAtMs: 1000,
      clientUserMessageId: "client-steer",
      input: echo.content,
      attachments: [],
      restoreMessage: { context: { commentAttachments: [] } },
      compareKey: { rawText: "continue", imageCount: 0 },
    };
    fixture.owner.applyEvent({
      type: "reset",
      value: projectCodexTranscript({
        ...fixture.state,
        turns: fixture.state.turns.map((turn) => ({
          ...turn,
          items: [
            turn.items[0]!,
            steer,
            { type: "steered", id: "server-echo" } satisfies CodexCanonicalItem,
            turn.items[1]!,
          ],
        })),
      }),
    });
    const rows = fixture.project().entries.filter(isCodexTimelineTurnEntry);
    const users = rows.filter((row) => row.timelineSlice.preserveServerUserMessages);
    expect(users).toHaveLength(1);
    expect(users[0]!.timelineSlice.itemIds).toEqual(["local-steer"]);
    expect(
      users[0]!.readTurn()!.items.find((entry) => entry.rawItemId === "local-steer")?.markdownText,
    ).toBe("continue");
    expect(workRows(fixture).map((row) => row.timelineSlice.itemIds)).toEqual([
      ["before"],
      ["after"],
    ]);
  });

  test("ordinary delegated input keeps its owning user occurrence in mixed history", () => {
    const user: ThreadItem = {
      type: "userMessage",
      id: "delegated",
      clientId: "client",
      content: [
        {
          type: "text",
          text: "<codex_delegation><source_thread_id>source</source_thread_id><input>Continue the task</input></codex_delegation>",
          text_elements: [],
        },
      ],
    };
    const command = tool("c1");
    const fixture = timelineOwnerFixture(page([start(), item(user, 2), item(command, 3)], null), [
      user,
      command,
    ]);
    const users = fixture
      .project()
      .entries.filter(isCodexTimelineTurnEntry)
      .filter((entry) => entry.timelineSlice.includeInput);
    expect(users).toHaveLength(1);
    expect(
      users[0]!.readTurn()!.items.filter((entry) => entry.kind === "userMessage"),
    ).toHaveLength(1);
    expect(workRows(fixture)[0]!.timelineSlice.itemIds).toEqual(["c1"]);
  });
});
