import { describe, expect, it } from "vite-plus/test";
import {
  chatTipFacts,
  chooseTip,
  normalizeSettledTips,
  outgrownTips,
  settleTips,
  timelyTips,
  type TipId,
  type TipMoment,
  type TipsState,
} from "./tips-model";

const INITIAL_TIPS_STATE: TipsState = { on: true, settled: [] };

const rested: TipMoment = {
  started: true,
  working: false,
  finishedRuns: 1,
  pageOpened: false,
  teammate: "Claude Code",
  teamedUp: false,
  canConnectAgent: true,
  notificationsUndecided: true,
  otherChatWorking: false,
};

describe("settled tips", () => {
  it.each([null, 42, "page", { settled: ["page"] }])(
    "reads malformed storage %j as nothing settled",
    (stored) => {
      expect(normalizeSettledTips(stored)).toEqual([]);
    },
  );

  it("keeps only distinct, recognized tips", () => {
    expect(normalizeSettledTips(["page", null, "unknown", "page", "inbox"])).toEqual([
      "page",
      "inbox",
    ]);
  });

  it("settles new tips once, and returns the same list when nothing new settles", () => {
    const settled = normalizeSettledTips(["page"]);
    expect(settleTips(settled, ["page", "notifications", "notifications"])).toEqual([
      "page",
      "notifications",
    ]);
    expect(settleTips(settled, ["page"])).toBe(settled);
  });
});

describe("timelyTips", () => {
  it.each<{ situation: string; facts: Partial<TipMoment>; tips: TipId[] }>([
    {
      situation: "a Page and a teammate are available after a Run",
      facts: { pageOpened: true },
      tips: ["page", "second-opinion", "notifications"],
    },
    {
      situation: "an additional Agent can be connected after a Run",
      facts: { teammate: null, pageOpened: true },
      tips: ["page", "second-agent", "notifications"],
    },
    {
      situation: "no additional Agent can be connected",
      facts: { teammate: null, canConnectAgent: false },
      tips: ["notifications"],
    },
    {
      situation: "the chat has already used a teammate",
      facts: { teamedUp: true, notificationsUndecided: false },
      tips: [],
    },
    {
      situation: "the chat has already used a teammate and no teammate is currently available",
      facts: { teamedUp: true, teammate: null },
      tips: ["notifications"],
    },
    {
      situation: "a started chat has yet to complete its first Run",
      facts: { finishedRuns: 0, otherChatWorking: true },
      tips: [],
    },
    {
      situation: "an unstarted chat sees another chat working",
      facts: { started: false, finishedRuns: 0, otherChatWorking: true },
      tips: ["inbox"],
    },
    {
      situation: "an unstarted chat sees no other work",
      facts: { started: false, finishedRuns: 0 },
      tips: [],
    },
  ])("offers $tips when $situation", ({ facts, tips }) => {
    expect(timelyTips({ ...rested, ...facts })).toEqual(tips);
  });
});

describe("chooseTip", () => {
  it("stays quiet while the Agent works or when tips are off", () => {
    const input = { state: INITIAL_TIPS_STATE, moment: rested, shown: null };
    expect(chooseTip({ ...input, moment: { ...rested, working: true } })).toBeNull();
    expect(chooseTip({ ...input, state: { ...input.state, on: false } })).toBeNull();
  });

  it("keeps the shown tip for its rest and waits until the next rest after dismissal", () => {
    const input = { state: INITIAL_TIPS_STATE, moment: rested, shown: null };
    expect(chooseTip(input)).toBe("second-opinion");
    const shown = { tip: "second-opinion", finishedRuns: 1 } as const;
    expect(chooseTip({ ...input, shown, moment: { ...rested, pageOpened: true } })).toBe(
      "second-opinion",
    );

    const state = { ...input.state, settled: settleTips(input.state.settled, [shown.tip]) };
    expect(chooseTip({ ...input, state, shown })).toBeNull();
    expect(chooseTip({ state, shown, moment: { ...rested, finishedRuns: 2 } })).toBe(
      "notifications",
    );
  });

  it("chooses the most timely tip afresh at a later rest", () => {
    expect(
      chooseTip({
        state: INITIAL_TIPS_STATE,
        moment: { ...rested, finishedRuns: 2, pageOpened: true },
        shown: { tip: "second-opinion", finishedRuns: 1 },
      }),
    ).toBe("page");
  });
});

it("retires both teamwork tips after Agents have worked together", () => {
  expect(outgrownTips({ teamedUp: false })).toEqual([]);
  expect(outgrownTips({ teamedUp: true })).toEqual(["second-opinion", "second-agent"]);
});

type Projection = NonNullable<Parameters<typeof chatTipFacts>[0]>;
type Run = Projection["runs"][number];

const first: Run = {
  id: "first",
  ordinal: 1,
  status: "completed",
  modelSelection: { instanceId: "codex" },
};
const latest: Run = { ...first, id: "latest", ordinal: 2 };

const projection = (overrides: Partial<Projection> = {}): Projection => ({
  runs: [latest, first],
  subagents: [],
  visibleTurnItems: [],
  ...overrides,
});

const toolCall = (
  toolName: string,
  overrides: Partial<Projection["visibleTurnItems"][number]["item"]> = {},
): Projection["visibleTurnItems"][number] => ({
  item: { type: "dynamic_tool", status: "completed", runId: latest.id, toolName, ...overrides },
});

describe("chatTipFacts", () => {
  it.each([
    ["preparing", true, 0],
    ["queued", true, 0],
    ["starting", true, 0],
    ["running", true, 0],
    ["waiting", true, 0],
    ["completed", false, 1],
    ["interrupted", false, 0],
    ["failed", false, 0],
    ["cancelled", false, 0],
    ["rolled_back", false, 0],
  ] as const)("classifies a %s Run", (status, working, finishedRuns) => {
    expect(chatTipFacts(projection({ runs: [first, { ...latest, status }] }))).toEqual({
      working,
      finishedRuns: 1 + finishedRuns,
      pageOpened: false,
      teamedUp: false,
    });
  });

  describe("Pages in the latest completed Run", () => {
    const page = { target: { kind: "page", pageId: "brief" } };

    it.each([
      toolCall("mcp__nodex_app__create_pages"),
      toolCall("nodex_app.create_pages"),
      toolCall("mcp__nodex_app__open_in_nodex", { input: page }),
      toolCall("nodex_app.open_in_nodex", { input: page }),
    ])("recognizes $item.toolName", (call) => {
      expect(chatTipFacts(projection({ visibleTurnItems: [call] })).pageOpened).toBe(true);
    });

    it.each([
      toolCall("mcp__other_app__create_pages"),
      toolCall("other_app.open_in_nodex", { input: page }),
      toolCall("create_pages"),
      toolCall("nodex_app.open_in_nodex", {
        input: { target: { kind: "file", path: "/brief.md" } },
      }),
      toolCall("nodex_app.open_in_nodex"),
      toolCall("nodex_app.read_page", { input: page }),
      toolCall("nodex_app.create_pages", { type: "message" }),
      toolCall("nodex_app.create_pages", { runId: first.id }),
      toolCall("nodex_app.create_pages", { runId: "failed-run" }),
      toolCall("nodex_app.create_pages", { status: "failed" }),
      toolCall("nodex_app.create_pages", { status: "running" }),
    ])("ignores unrelated item %# ($item.toolName)", (call) => {
      const failed = { ...latest, id: "failed-run", ordinal: 3, status: "failed" };
      const input = projection({ runs: [latest, first, failed], visibleTurnItems: [call] });
      expect(chatTipFacts(input).pageOpened).toBe(false);
    });

    it("still recognizes a Page in the latest completed Run after a later failure", () => {
      const failed = { ...latest, id: "failed-run", ordinal: 3, status: "failed" };
      const input = projection({
        runs: [latest, first, failed],
        visibleTurnItems: [toolCall("nodex_app.create_pages")],
      });
      expect(chatTipFacts(input).pageOpened).toBe(true);
    });
  });

  it("leaves the record unread while the chat is working", () => {
    const input = projection({
      runs: [latest, first, { ...latest, id: "next", ordinal: 3, status: "running" }],
      visibleTurnItems: [toolCall("nodex_app.create_pages")],
    });
    expect(chatTipFacts(input)).toMatchObject({ working: true, pageOpened: false });
  });

  it("counts work Nodex handed to an Agent other than the one that asked for it", () => {
    const onClaude: Run = { ...latest, modelSelection: { instanceId: "claude" } };
    const teamedUp = (subagents: Projection["subagents"]) =>
      chatTipFacts(projection({ runs: [first, onClaude], subagents })).teamedUp;

    // An Agent's own subagents, and a helper on the asking Agent itself, cross nothing.
    expect(
      teamedUp([
        { origin: "provider_native", runId: first.id, providerInstanceId: "opencode" },
        { origin: "app_owned", runId: first.id, providerInstanceId: "codex" },
        { origin: "app_owned", runId: null, providerInstanceId: "claude" },
      ]),
    ).toBe(false);
    // The chat later running on Claude itself doesn't undo that Codex once asked Claude.
    expect(teamedUp([{ origin: "app_owned", runId: first.id, providerInstanceId: "claude" }])).toBe(
      true,
    );
  });
});
