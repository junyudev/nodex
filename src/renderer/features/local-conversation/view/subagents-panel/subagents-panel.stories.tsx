import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  CodexSubagentOverviewRow,
  CodexSubagentOverviewWindow,
} from "../../../../../shared/types";
import { SubagentsPanelDetailHeader, SubagentsPanelOverviewContent } from "./subagents-panel";

const now = Date.now();

function buildRow(
  threadId: string,
  overrides: Partial<CodexSubagentOverviewRow>,
): CodexSubagentOverviewRow {
  return {
    threadId,
    parentThreadId: "thread-root",
    displayName: threadId,
    actorName: threadId,
    agentRole: null,
    spawnModel: null,
    objective: null,
    status: "done",
    statusSummary: null,
    startedAtMs: null,
    lastActivityAtMs: null,
    completedAtMs: null,
    diffStats: null,
    canOpen: true,
    canInteract: false,
    ...overrides,
  };
}

const active = [
  buildRow("Scout", {
    status: "active",
    objective: "Check renderer routes without loading any child transcript",
    startedAtMs: now - 18_000,
    lastActivityAtMs: now,
    canInteract: true,
  }),
  buildRow("Planner with an intentionally long display name", {
    status: "waiting",
    statusSummary: "Queued behind the root agent",
    startedAtMs: now - 62_000,
    lastActivityAtMs: now - 60_000,
    canInteract: true,
  }),
];

const done = [
  buildRow("Reviewer", {
    objective: "Verify API ownership and panel routing",
    lastActivityAtMs: now - 22 * 60_000,
    completedAtMs: now - 22 * 60_000,
  }),
  buildRow("Builder", {
    lastActivityAtMs: now - 34 * 60_000,
    completedAtMs: now - 34 * 60_000,
  }),
];

function buildOverview(
  activeRows: CodexSubagentOverviewRow[],
  doneRows: CodexSubagentOverviewRow[],
): CodexSubagentOverviewWindow {
  return {
    rootThreadId: "thread-root",
    revision: 12,
    generation: 1,
    completeness: "complete",
    active: {
      rows: activeRows,
      knownCount: activeRows.length,
      totalCount: activeRows.length,
      continuation: null,
    },
    done: {
      rows: doneRows,
      knownCount: doneRows.length,
      totalCount: doneRows.length,
      continuation: null,
    },
  };
}

const meta = {
  title: "Local Conversation/Subagents Panel",
  component: SubagentsPanelOverviewContent,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="h-[620px] w-[360px] bg-token-main-surface-primary">
        <Story />
      </div>
    ),
  ],
  args: {
    rootThreadId: "thread-root",
    overview: buildOverview(active, done),
    onSelect: () => undefined,
  },
} satisfies Meta<typeof SubagentsPanelOverviewContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveWaitingAndDone: Story = {};

export const NoActiveSubagents: Story = {
  args: {
    overview: buildOverview([], done),
  },
};

export const UnknownIsNotDone: Story = {
  args: {
    overview: buildOverview(
      [buildRow("Discovering", { status: "unknown", canInteract: false })],
      [],
    ),
  },
};

export const SelectedDetailHeader: Story = {
  render: () => (
    <SubagentsPanelDetailHeader
      displayName="Reviewer"
      threadId="thread-reviewer"
      onBack={() => undefined}
    />
  ),
};
