import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ListTree,
  MessageSquare,
  PictureInPicture2,
  Slash,
} from "@/components/shared/icons/generic-icons";
import { MotionConfig } from "motion/react";
import type { CSSProperties } from "react";
import {
  BranchStatusIcon,
  ChevronDownIcon,
  ClockIcon,
  ComposerPlanModeIcon,
  LocalStatusIcon,
  ThreadSummaryChangesIcon,
  ThreadSummaryCommitIcon,
  ThreadSummaryCreatePullRequestIcon,
  GlobeIcon,
  FileIcon,
  OpenInIcon,
  TerminalIcon,
} from "@/components/shared/icons";
import { CODEX_SUMMARY_PANEL_WIDTH } from "@/lib/codex-panel-motion";
import type {
  CodexConversationChildMembership,
  CodexConversationSnapshot,
  CodexConversationTurn,
} from "@/lib/types";
import { ThreadFloatingSummaryPanel } from "./thread-floating-summary-panel";
import { ThreadSummaryBranchSetupDialog } from "./thread-summary-branch-setup-dialog";
import { ThreadSummaryGitActionDialog } from "./thread-summary-git-action-dialog";
import { ThreadSummaryPanelRow } from "./thread-summary-panel-row";
import { ThreadSummaryPanelSection } from "./thread-summary-panel-section";
import {
  ConnectorFallbackIcon,
  ConnectorGlobeIcon,
  PluginCubeIcon,
} from "@/components/shared/icons";
import { ToolActivityIcon } from "../shared/tools/tool-call-icons";

const SUMMARY_PANEL_STORY_CHILD_MEMBERSHIPS: CodexConversationChildMembership[] = [
  {
    threadId: "summary-inline-scout",
    parentThreadId: "thread-story",
    role: "backgroundChild",
    actorName: "Scout",
    displayName: "Scout",
    agentRole: "explorer",
    showInlineActivity: true,
  },
  {
    threadId: "summary-inline-planner",
    parentThreadId: "thread-story",
    role: "backgroundChild",
    actorName: "Planner",
    displayName: "Planner",
    agentRole: null,
    showInlineActivity: true,
  },
  {
    threadId: "summary-inline-finisher",
    parentThreadId: "thread-story",
    role: "backgroundChild",
    actorName: "Finisher",
    displayName: "Finisher",
    agentRole: null,
    showInlineActivity: true,
  },
  {
    threadId: "summary-listed-reviewer",
    parentThreadId: "thread-story",
    role: "backgroundChild",
    actorName: "Reviewer",
    displayName: "Reviewer",
    agentRole: "reviewer",
    showInlineActivity: false,
  },
  {
    threadId: "summary-listed-waiting",
    parentThreadId: "thread-story",
    role: "backgroundChild",
    actorName: "Verifier",
    displayName: "Verifier",
    agentRole: null,
    showInlineActivity: false,
  },
];

function makeSummaryPanelStorySubagentConversation(input: {
  threadId: string;
  name: string;
  statusType: "active" | "idle" | "notLoaded";
  turns?: CodexConversationTurn[];
}): CodexConversationSnapshot {
  return {
    threadId: input.threadId,
    projectId: "project-story",
    projectName: "Story Project",
    title: input.name,
    threadName: input.name,
    threadPreview: input.name,
    agentNickname: input.name,
    agentRole: null,
    statusType: input.statusType,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    resumeState: "resumed",
    turns: input.turns ?? [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canCollapseTurns: true,
      canEditLastUserTurn: true,
      canForkFromTurn: true,
      canSearch: true,
    },
  } as unknown as CodexConversationSnapshot;
}

const SUMMARY_PANEL_STORY_KNOWN_CONVERSATIONS: Record<string, CodexConversationSnapshot> = {
  "summary-inline-scout": makeSummaryPanelStorySubagentConversation({
    threadId: "summary-inline-scout",
    name: "Scout",
    statusType: "active",
  }),
  "summary-inline-planner": makeSummaryPanelStorySubagentConversation({
    threadId: "summary-inline-planner",
    name: "Planner",
    statusType: "notLoaded",
  }),
  "summary-inline-finisher": makeSummaryPanelStorySubagentConversation({
    threadId: "summary-inline-finisher",
    name: "Finisher",
    statusType: "idle",
  }),
  "summary-listed-reviewer": makeSummaryPanelStorySubagentConversation({
    threadId: "summary-listed-reviewer",
    name: "Reviewer",
    statusType: "active",
    turns: [
      {
        turnId: "summary-listed-reviewer-turn",
        status: "inProgress",
        diff: "@@ -1 +1,2 @@\n-old\n+new\n+another",
        items: [],
      },
    ] as unknown as CodexConversationTurn[],
  }),
  "summary-listed-waiting": makeSummaryPanelStorySubagentConversation({
    threadId: "summary-listed-waiting",
    name: "Verifier",
    statusType: "notLoaded",
  }),
};

function StoryCountSuffix({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="text-base text-token-description-foreground opacity-50">{count}</span>;
}

function StorySummaryDropdownRowLabel({ label }: { label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-token-foreground">
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
    </span>
  );
}

function SummaryPanelSurfaceStory({ noGit = false }: { noGit?: boolean }) {
  return (
    <div className="flex min-h-screen items-start justify-end bg-token-main-surface-primary p-10 text-token-text-primary">
      <div
        className="relative flex max-h-full min-h-0 flex-col overflow-hidden rounded-3xl bg-token-dropdown-background pt-3 electron:elevation-prominent extension:border extension:border-token-border-default extension:shadow-md"
        style={{ width: CODEX_SUMMARY_PANEL_WIDTH }}
      >
        <div className="flex h-fit max-h-full min-h-0 flex-col gap-3 overflow-y-auto pb-3">
          <ThreadSummaryPanelSection sectionKey="story-automation" title="Scheduled">
            <ThreadSummaryPanelRow
              aria-label="Open scheduled task"
              icon={<ClockIcon className="icon-xs shrink-0" />}
              label={
                <>
                  <span className="min-w-0 flex-1 truncate">Review release notes</span>
                  <span className="max-w-48 shrink-0 truncate text-size-chat text-token-text-secondary">
                    Every weekday
                  </span>
                </>
              }
              labelClassName="flex min-w-0 flex-1 items-baseline gap-2"
              title="Next run: tomorrow at 9:00 AM"
              interactive
            />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection sectionKey="story-environment" title="Environment">
            <ThreadSummaryPanelRow
              label="Changes"
              icon={<ThreadSummaryChangesIcon className="icon-sm shrink-0" />}
              trailing={
                <span className="text-size-chat text-token-text-tertiary">
                  {noGit ? "No Git" : "+9,212 -4,412"}
                </span>
              }
              trailingVisible
              disabled={noGit}
              interactive={!noGit}
            />
            <ThreadSummaryPanelRow
              label={<StorySummaryDropdownRowLabel label="Local" />}
              labelClassName="flex min-w-0 items-center"
              icon={
                <span className="shrink-0">
                  <LocalStatusIcon className="icon-sm text-token-foreground" />
                </span>
              }
            />
            <ThreadSummaryPanelRow
              label={<StorySummaryDropdownRowLabel label="dev-redesign" />}
              labelClassName="flex min-w-0 items-center"
              icon={<BranchStatusIcon className="icon-sm shrink-0" />}
              disabled={noGit}
              interactive={!noGit}
            />
            <ThreadSummaryPanelRow
              label="Commit or push"
              icon={<ThreadSummaryCommitIcon className="icon-sm shrink-0" />}
              disabled={noGit}
              interactive={!noGit}
            />
            <ThreadSummaryPanelRow
              label="Create pull request"
              icon={
                <ThreadSummaryCreatePullRequestIcon className="icon-sm shrink-0 text-token-text-tertiary" />
              }
              disabled={noGit}
              interactive={!noGit}
            />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection sectionKey="story-plan" title="Plan">
            <ThreadSummaryPanelRow
              icon={<ComposerPlanModeIcon className="icon-xs shrink-0" />}
              label="Summary panel parity"
              labelClassName="min-w-0 truncate"
              title="Summary panel parity"
              interactive
              onClick={() => undefined}
            />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection
            sectionKey="story-outputs"
            title="Outputs"
            titleSuffix={<StoryCountSuffix count={4} />}
          >
            <ThreadSummaryPanelRow
              icon={<FileIcon className="size-3.5" />}
              label="thread-layout.tsx"
              title="src/renderer/features/local-conversation/view/thread-layout.tsx"
            />
            <ThreadSummaryPanelRow
              icon={<ConnectorGlobeIcon className="size-3.5" aria-hidden={true} />}
              label="localhost:5173/preview"
              title="http://localhost:5173/preview"
              interactive
            />
            <ThreadSummaryPanelRow
              icon={<ConnectorFallbackIcon className="size-3.5" aria-hidden={true} />}
              label="Reference Roadmap"
              title="https://docs.google.com/document/d/doc-123/edit"
              interactive
            />
            <ThreadSummaryPanelRow
              icon={<PluginCubeIcon className="size-3.5" aria-hidden={true} />}
              label={
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate">Story app</span>
                  <OpenInIcon
                    className="icon-xs shrink-0 opacity-0 group-hover/summary-panel-row:opacity-100"
                    aria-hidden={true}
                  />
                </span>
              }
              labelClassName="min-w-0"
              title="https://story-app.example.com"
              interactive
            />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection
            sectionKey="story-side-chats"
            title="Side chats"
            titleSuffix={<StoryCountSuffix count={1} />}
          >
            <ThreadSummaryPanelRow
              label="Investigate header edge"
              icon={<MessageSquare className="icon-sm shrink-0" />}
              interactive
            />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection
            sectionKey="story-background-subagents"
            title="Subagents"
            titleSuffix={<StoryCountSuffix count={1} />}
          >
            <ThreadSummaryPanelRow label="Layout parity agent" />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection
            sectionKey="story-background-tasks"
            title="Tasks"
            titleSuffix={<StoryCountSuffix count={1} />}
            after={
              <button
                type="button"
                aria-label="View all processes"
                className="ms-auto inline-flex size-6 cursor-interaction items-center justify-center rounded-sm border-0 bg-transparent text-token-text-tertiary hover:text-token-foreground"
              >
                <ListTree className="icon-xs" aria-hidden="true" />
              </button>
            }
          >
            <ThreadSummaryPanelRow
              label="bun test"
              icon={<TerminalIcon className="icon-sm shrink-0" />}
              trailing={<span className="text-size-chat text-token-text-tertiary">3 pass</span>}
              trailingVisible
            />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection
            sectionKey="story-computer-use-pip"
            mode="headerless"
            title="Computer Use"
          >
            <ThreadSummaryPanelRow
              aria-label="Show PiP"
              icon={
                <ToolActivityIcon
                  descriptor={{ kind: "semantic", icon: "computer-use" }}
                  className="icon-xs shrink-0"
                />
              }
              label="Computer Use"
              title="Show PiP"
              interactive
              trailing={
                <span className="relative flex size-5 shrink-0 items-center justify-center text-token-text-tertiary">
                  <PictureInPicture2 className="size-5" aria-hidden="true" />
                  <Slash className="absolute size-5" aria-hidden="true" />
                </span>
              }
              trailingVisible
            />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection
            sectionKey="story-browser-tabs"
            title="Browser"
            titleSuffix={<StoryCountSuffix count={1} />}
          >
            <ThreadSummaryPanelRow
              label="Release notes"
              icon={<GlobeIcon className="icon-xs shrink-0" />}
              trailing={
                <span className="text-size-chat text-token-text-tertiary">Right panel</span>
              }
              trailingVisible
              interactive
            />
          </ThreadSummaryPanelSection>
          <ThreadSummaryPanelSection
            sectionKey="story-tool-sources"
            title="Sources"
            titleSuffix={<StoryCountSuffix count={2} />}
          >
            <ul className="-ml-1 flex flex-wrap gap-0.5" aria-label="Sources">
              <li className="flex">
                <span
                  role="img"
                  aria-label="Context7"
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm text-token-text-secondary"
                >
                  <ToolActivityIcon
                    descriptor={{ kind: "semantic", icon: "connector" }}
                    className="icon-xs shrink-0"
                  />
                </span>
              </li>
              <li className="flex">
                <button
                  type="button"
                  aria-label="example.com/docs"
                  className="flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-sm text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground"
                >
                  <ToolActivityIcon
                    descriptor={{ kind: "semantic", icon: "web-search" }}
                    className="icon-xs shrink-0"
                  />
                </button>
              </li>
            </ul>
          </ThreadSummaryPanelSection>
        </div>
      </div>
    </div>
  );
}

function FloatingSummaryPanelStory({
  open = true,
  reducedMotion = false,
  mode = "shift",
  stageWidth = 1180,
  browserWorking = false,
}: {
  open?: boolean;
  reducedMotion?: boolean;
  mode?: "gutter" | "shift" | "overlay";
  stageWidth?: number;
  browserWorking?: boolean;
}) {
  const content = (
    <div className="flex min-h-screen items-start justify-end overflow-x-auto bg-token-main-surface-primary p-10 text-token-text-primary">
      <div
        className="relative h-[640px] w-full max-w-4xl overflow-hidden border border-token-border-default bg-(--background)"
        style={
          {
            "--thread-floating-content-top-inset": "48px",
            "--thread-floating-content-bottom-inset": "16px",
            width: `${stageWidth}px`,
            maxWidth: "100%",
          } as CSSProperties
        }
      >
        {mode === "overlay" ? (
          <div className="absolute top-3 right-3 z-10">
            <button
              type="button"
              className="h-8 rounded-md border border-token-border-default px-2 text-size-chat text-token-text-secondary"
            >
              Toggle summary
            </button>
          </div>
        ) : null}
        <ThreadFloatingSummaryPanel
          mounted
          open={open}
          activeThreadId="thread-story"
          cwd={null}
          projectWorkspacePath={null}
          turns={[]}
          childMemberships={SUMMARY_PANEL_STORY_CHILD_MEMBERSHIPS}
          knownConversationsById={SUMMARY_PANEL_STORY_KNOWN_CONVERSATIONS}
          scheduledAutomation={{
            id: "automation-story",
            name: "Review release notes",
            scheduleSummary: "Every weekday",
            nextRunLabel: "tomorrow at 9:00 AM",
          }}
          sideChatRows={[
            { id: "side-chat", title: "Investigate layout", isResponseInProgress: true },
          ]}
          computerUsePip={{ visible: false }}
          browserRows={[
            {
              id: "browser",
              browserTabId: "browser-runtime",
              workbenchTabId: null,
              title: "Release notes",
              displayUrl: "example.com",
              url: "https://example.com/release-notes",
              faviconUrl: null,
              isAgentWorking: browserWorking,
              isMaterialized: false,
            },
          ]}
          actions={{
            onOpenSummaryBrowserRow: () => undefined,
            onToggleSummaryComputerUsePip: () => undefined,
          }}
          onErrorMessage={() => undefined}
        />
      </div>
    </div>
  );

  if (!reducedMotion) return content;
  return <MotionConfig reducedMotion="always">{content}</MotionConfig>;
}

const meta = {
  title: "Workbench/Threads/Summary Panel",
  component: SummaryPanelSurfaceStory,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof SummaryPanelSurfaceStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ActiveThreadWithSources: Story = {};

export const NoGitRepository: Story = {
  args: {
    noGit: true,
  },
};

export const PinnedOverlaySurface: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story:
          "Surface chrome used by the pinned floating summary overlay while the workbench right panel is collapsed.",
      },
    },
  },
};

export const FloatingPinnedShiftOpen: StoryObj<typeof FloatingSummaryPanelStory> = {
  render: () => <FloatingSummaryPanelStory open />,
  parameters: {
    docs: {
      description: {
        story:
          "Pinned floating summary body in the Codex shift band; Workbench applies the companion -158px body/footer shift while this panel springs in from the right.",
      },
    },
  },
};

export const FloatingPinnedGutterOpen: StoryObj<typeof FloatingSummaryPanelStory> = {
  render: () => <FloatingSummaryPanelStory mode="gutter" open />,
  parameters: {
    viewport: {
      defaultViewport: "desktop",
    },
    docs: {
      description: {
        story:
          "Pinned floating summary body in gutter mode, where the panel is visible without shifting thread content.",
      },
    },
  },
};

export const FloatingBrowserUseWorking: StoryObj<typeof FloatingSummaryPanelStory> = {
  render: () => <FloatingSummaryPanelStory browserWorking open />,
  parameters: {
    docs: {
      description: {
        story:
          "A runtime-only Browser Use page projected into the floating Environment surface while the agent is controlling it.",
      },
    },
  },
};

export const Viewport1902SidebarOpenGutter: StoryObj<typeof FloatingSummaryPanelStory> = {
  render: () => <FloatingSummaryPanelStory mode="gutter" stageWidth={1602} open />,
  parameters: {
    docs: {
      description: {
        story:
          "Acceptance state for a 1902px shell with a 300px left sidebar and no right panel: effective thread width is 1602px, so the summary panel stays pinned in gutter mode.",
      },
    },
  },
};

export const Viewport1801SidebarOpenShift: StoryObj<typeof FloatingSummaryPanelStory> = {
  render: () => <FloatingSummaryPanelStory mode="shift" stageWidth={1501} open />,
  parameters: {
    docs: {
      description: {
        story:
          "Acceptance state for a 1801px shell with a 300px left sidebar and no right panel: effective thread width is 1501px, so the summary panel stays pinned and shifts the body/footer by -158px.",
      },
    },
  },
};

export const Viewport1598SidebarRightPanelOverlay: StoryObj<typeof FloatingSummaryPanelStory> = {
  render: () => <FloatingSummaryPanelStory mode="overlay" stageWidth={950} open={false} />,
  parameters: {
    docs: {
      description: {
        story:
          "Acceptance state for a 1598px shell with the left sidebar and a right panel competing for space: effective thread width falls below 1096px, so the mounted inline panel animates closed while the header trigger controls the popover.",
      },
    },
  },
};

export const FloatingPinnedClosingReducedMotion: StoryObj<typeof FloatingSummaryPanelStory> = {
  render: () => <FloatingSummaryPanelStory open={false} reducedMotion />,
  parameters: {
    docs: {
      description: {
        story:
          "Reduced-motion close state: the Codex summary body snaps to opacity 0, translateX(100%), and scale 0.8 without a spring.",
      },
    },
  },
};

export const CommitWorkflowDialog: StoryObj<typeof ThreadSummaryGitActionDialog> = {
  render: () => (
    <div className="min-h-screen bg-token-main-surface-primary text-token-text-primary">
      <ThreadSummaryGitActionDialog
        open
        cwd="/storybook/project"
        initialMode="commit"
        onOpenChange={() => undefined}
        onCompleted={() => undefined}
        onErrorMessage={() => undefined}
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story: "Native commit/push workflow opened from the floating summary Environment section.",
      },
    },
  },
};

export const BranchSetupDialog: StoryObj<typeof ThreadSummaryBranchSetupDialog> = {
  render: () => (
    <div className="min-h-screen bg-token-main-surface-primary text-token-text-primary">
      <ThreadSummaryBranchSetupDialog
        open
        branches={["main", "release/candidate"]}
        currentBranch={null}
        defaultBranch="main"
        threadTitle="Review detached worktree"
        onCreateBranch={async () => true}
        onCreated={() => undefined}
        onErrorMessage={() => undefined}
        onOpenChange={() => undefined}
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Detached-checkout branch setup dialog opened from the floating summary Environment section before commit/push.",
      },
    },
  },
};

export const ManagedDefaultBranchSetupDialog: StoryObj<typeof ThreadSummaryBranchSetupDialog> = {
  render: () => (
    <div className="min-h-screen bg-token-main-surface-primary text-token-text-primary">
      <ThreadSummaryBranchSetupDialog
        open
        branches={["main", "release/candidate"]}
        currentBranch="main"
        defaultBranch="main"
        threadTitle="Default branch worktree"
        onCreateBranch={async () => true}
        onCreated={() => undefined}
        onErrorMessage={() => undefined}
        onOpenChange={() => undefined}
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Managed-worktree branch setup dialog opened from the floating summary Environment section while the checkout is still on the default branch.",
      },
    },
  },
};
