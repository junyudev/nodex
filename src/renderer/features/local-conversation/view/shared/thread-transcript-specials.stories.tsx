import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CodexConversationItem } from "@/lib/types";
import { THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS } from "../thread-stage-story-fixtures";
import { LOCAL_CONVERSATION_CONTENT_CLASS_NAME } from "./local-conversation-view-constants";
import { AutomaticApprovalReviewSurface } from "./automatic-approval-review-surface";
import { MarkdownRenderer } from "./markdown/markdown-renderer";
import { MultiAgentActionSurface } from "./multi-agent-action-surface";
import { ReasoningSurface } from "./reasoning-surface";
import { TodoListSurface } from "./todo-list-surface";
import {
  ThreadAssistantBodyBlock,
  ThreadContextCompactionBlock,
  ThreadGeneratedImageGalleryBlock,
  ThreadImageViewBlock,
  ThreadMcpServerElicitationBlock,
  ThreadPlanCardBlock,
  ThreadSubagentActivityInlineGroupBlock,
  ThreadStreamErrorBlock,
  ThreadSystemErrorBlock,
  ThreadSystemBannerBlock,
  ThreadUserBubbleBlock,
} from "../blocks/local-conversation-block-leaves";
import { buildRendererItemStream } from "../../projection/build-renderer-item-stream";
import type { ThreadTranscriptBlockModel } from "../../thread-stage-types";
import { ThreadLiveActivityFallback } from "../local-conversation-thread-turn";

function StorySurface({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-[320px] rounded-[24px] border border-(--border) bg-(--background) p-5 shadow-[0_18px_48px_rgba(0,0,0,0.16)]">
      <div className="mb-4 max-w-2xl">
        <div className="text-sm font-semibold text-(--foreground)">{title}</div>
        <div className="mt-1 text-sm/relaxed text-(--foreground-secondary)">{description}</div>
      </div>
      <div className="max-w-3xl">{children}</div>
    </div>
  );
}

function ConversationStorySurface({ children }: { children: ReactNode }) {
  return (
    <div data-thread-find-target="conversation" className={LOCAL_CONVERSATION_CONTENT_CLASS_NAME}>
      {children}
    </div>
  );
}

function ElectronDarkThreadStorySurface({ children }: { children: ReactNode }) {
  return (
    <div data-codex-window-type="electron" className="dark electron-dark">
      <ConversationStorySurface>{children}</ConversationStorySurface>
    </div>
  );
}

function AutoOpenSurface({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const toggle = containerRef.current?.querySelector<HTMLElement>(
      'button[aria-expanded="false"]',
    );
    toggle?.click();
  }, []);

  return <div ref={containerRef}>{children}</div>;
}

function openStoryAgentThread(threadId: string) {
  void threadId;
}

const STREAMING_ASSISTANT_SEGMENTS =
  "Investigating the Storybook regression while comparing the streaming transcript against the Codex Electron bundle, verifying tooltip sizing, dropdown chrome, shell command expansion, and per-word prose animation as new text arrives.".match(
    /\S+\s*/g,
  ) ?? [];

function StreamingAssistantMarkdownPreview() {
  const [visibleSegmentCount, setVisibleSegmentCount] = useState(1);
  const isComplete = visibleSegmentCount >= STREAMING_ASSISTANT_SEGMENTS.length;
  const content = STREAMING_ASSISTANT_SEGMENTS.slice(0, visibleSegmentCount).join("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        if (isComplete) {
          setVisibleSegmentCount(1);
          return;
        }

        setVisibleSegmentCount((current) =>
          Math.min(current + 1, STREAMING_ASSISTANT_SEGMENTS.length),
        );
      },
      isComplete ? 1200 : 110,
    );

    return () => {
      window.clearTimeout(timer);
    };
  }, [isComplete, visibleSegmentCount]);

  return (
    <div className="max-w-3xl rounded-2xl bg-token-main-surface-primary px-5 py-4 text-token-foreground">
      <MarkdownRenderer
        className="text-size-chat"
        content={content}
        parseIncompleteMarkdown={!isComplete}
        animateStreamingText={!isComplete}
      />
    </div>
  );
}

function buildSpecialTranscriptBlock(entry: CodexConversationItem): ThreadTranscriptBlockModel {
  const block = buildRendererItemStream({
    entries: [entry],
    requests: [],
  })[0];

  if (!block || !("entry" in block)) {
    throw new Error("Expected transcript-special story entry to project into a transcript block.");
  }

  return block;
}

function buildSubagentActivityStoryBlock(): ThreadTranscriptBlockModel {
  const entries = [
    ["scout", "Scout", "active"],
    ["reviewer", "Reviewer", "updated"],
    ["builder", "Builder", "active"],
    ["tester", "Tester", "interrupted"],
  ].map(([id, displayName, displayStatus], index): CodexConversationItem => ({
    threadId: "thread_story",
    turnId: "turn_subagent_activity",
    itemId: `subagent_activity_${id}`,
    entryId: `subagent_activity_${id}`,
    type: "subAgentActivity",
    kind: "systemEvent",
    semanticKind: "subAgentActivity",
    status: "completed",
    subagentActivity: {
      agentThreadId: `thread_${id}`,
      displayName,
      displayStatus: displayStatus as "active" | "updated" | "interrupted",
    },
    rawItem: {
      id: `subagent_activity_${id}`,
      type: "subAgentActivity",
      kind:
        displayStatus === "interrupted"
          ? "interrupted"
          : displayStatus === "updated"
            ? "interacted"
            : "started",
      agentThreadId: `thread_${id}`,
      agentPath: `agents/${displayName}`,
    },
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  const block = buildRendererItemStream({ entries, requests: [] })[0];
  if (!block || !("entry" in block)) {
    throw new Error("Expected consecutive subagent activity to project into an inline group.");
  }
  return block;
}

const meta = {
  title: "Workbench/Threads/Transcript Specials",
  component: StorySurface,
  parameters: {
    docs: {
      description: {
        component:
          "Focused parity coverage for Codex-style transcript-special surfaces such as reasoning, todo lists, automatic approval review, and multi-agent activity.",
      },
    },
  },
  args: {
    title: "Transcript special",
    description: "Focused transcript renderer surface.",
    children: null,
  },
} satisfies Meta<typeof StorySurface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ReasoningStreaming: Story = {
  render: () => (
    <StorySurface
      title="Reasoning Streaming"
      description="The streaming reasoning renderer keeps the preview body open and uses the Codex Thinking shimmer summary."
    >
      <ConversationStorySurface>
        <ReasoningSurface
          item={{
            markdownText:
              "**Investigating**\n\nChecking the failing story state.\n\n- comparing bundle behavior\n- checking transcript buckets",
            status: "inProgress",
          }}
          parseIncompleteMarkdown
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const LiveReasoningSummaryFallback: Story = {
  render: () => (
    <StorySurface
      title="Live reasoning summary fallback"
      description="A hidden in-progress reasoning item projects its latest Markdown summary into the same standalone shimmering row used by the live turn renderer."
    >
      <ConversationStorySurface>
        <ThreadLiveActivityFallback message="Checking the patch stream." />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const AssistantStreamingWordFade: Story = {
  render: () => (
    <StorySurface
      title="Assistant Streaming Word Fade"
      description="This harness appends one word segment at a time so the Streamdown word fade can be inspected in the current Storybook theme without forcing an electron-dark surface."
    >
      <ConversationStorySurface>
        <StreamingAssistantMarkdownPreview />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const CompletedLatestAssistantStatic: Story = {
  render: () => (
    <StorySurface
      title="Completed Latest Assistant Static"
      description="The assistant item has completed while the containing turn is still active, so the markdown stays in the static completed-message path instead of replaying the Streamdown word fade."
    >
      <ConversationStorySurface>
        <ThreadAssistantBodyBlock
          block={buildSpecialTranscriptBlock({
            threadId: "thread_story",
            turnId: "turn_story_completed_latest",
            itemId: "assistant_story_completed_latest",
            type: "assistant_message",
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            status: "completed",
            role: "assistant",
            assistantPhase: "final_answer",
            markdownText:
              "Completed assistant prose remains static even while the latest turn is waiting on trailing lifecycle rows.",
            createdAt: 1,
            updatedAt: 1,
          })}
          isLatestTurn
          isStreamingTurn
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const WritingPlanStreaming: Story = {
  render: () => (
    <StorySurface
      title="Writing Plan Streaming"
      description="In-progress proposed plans should replace Thinking, render the Writing plan header, and start in the collapsed preview state."
    >
      <ElectronDarkThreadStorySurface>
        <ThreadPlanCardBlock
          block={{
            id: "plan_story_streaming",
            turnId: "turn_story_streaming",
            createdAt: 1,
            updatedAt: 2,
            searchableText: "plan",
            type: "proposedPlan",
            entry: {
              threadId: "thread_story",
              turnId: "turn_story_streaming",
              itemId: "plan_story_streaming",
              type: "proposedPlan",
              kind: "plan",
              semanticKind: "proposedPlan",
              status: "inProgress",
              createdAt: 1,
              updatedAt: 2,
              markdownText: `# Implementation plan

1. Audit the current transcript state derivation.
2. Align the shell header with Codex Electron.
3. Verify that in-progress plans stay collapsed by default.`,
            },
          }}
          isLatestTurn
          isStreamingTurn
        />
      </ElectronDarkThreadStorySurface>
    </StorySurface>
  ),
};

export const ProposedPlanCompletedPreview: Story = {
  render: () => (
    <StorySurface
      title="Proposed Plan Completed Preview"
      description="Completed proposed-plan cards show the 200px preview with the side-panel open action."
    >
      <ElectronDarkThreadStorySurface>
        <ThreadPlanCardBlock
          block={{
            id: "plan_story_completed",
            turnId: "turn_story_completed",
            createdAt: 1,
            updatedAt: 2,
            searchableText: "plan",
            type: "proposedPlan",
            entry: {
              threadId: "thread_story",
              turnId: "turn_story_completed",
              itemId: "plan_story_completed",
              type: "proposedPlan",
              kind: "plan",
              semanticKind: "proposedPlan",
              status: "completed",
              createdAt: 1,
              updatedAt: 2,
              markdownText: `# Implementation plan

1. Audit the proposed-plan transcript item.
2. Open the side-panel tab with full markdown.
3. Keep todo-list progress separate from the proposed-plan card.
4. Verify download, copy, rating, and close affordances.`,
            },
          }}
          isLatestTurn
          isStreamingTurn={false}
          planSidePanelState={{
            rightPanelEnabled: true,
            activePlanKey: null,
            activeRightPanelTabId: null,
          }}
          onOpenPlanInSidePanel={() => undefined}
        />
      </ElectronDarkThreadStorySurface>
    </StorySurface>
  ),
};

export const ProposedPlanActiveSidePanel: Story = {
  render: () => (
    <StorySurface
      title="Proposed Plan Active Side Panel"
      description="When the right-panel Plan tab is active, the card body remains mounted but inert and collapsed."
    >
      <ElectronDarkThreadStorySurface>
        <ThreadPlanCardBlock
          block={{
            id: "plan_story_active",
            turnId: "turn_story_active",
            createdAt: 1,
            updatedAt: 2,
            searchableText: "plan",
            type: "proposedPlan",
            entry: {
              threadId: "thread_story",
              turnId: "turn_story_active",
              itemId: "plan_story_active",
              type: "proposedPlan",
              kind: "plan",
              semanticKind: "proposedPlan",
              status: "completed",
              createdAt: 1,
              updatedAt: 2,
              markdownText: `# Implementation plan

1. Audit the proposed-plan transcript item.
2. Open the side-panel tab with full markdown.
3. Keep todo-list progress separate from the proposed-plan card.`,
            },
          }}
          isLatestTurn
          isStreamingTurn={false}
          planSidePanelState={{
            rightPanelEnabled: true,
            activePlanKey: "turn_story_active",
            activeRightPanelTabId: "plan",
          }}
          onClosePlanSidePanel={() => undefined}
        />
      </ElectronDarkThreadStorySurface>
    </StorySurface>
  ),
};

export const PlanSidePanelMarkdown: Story = {
  render: () => (
    <StorySurface
      title="Right Panel Plan Tab Markdown"
      description="The renderer-local Plan tab uses the same full markdown renderer inside the right-panel scroll container."
    >
      <div data-codex-window-type="electron" className="dark electron-dark">
        <div className="h-[420px] w-[420px] overflow-hidden border border-token-border bg-token-main-surface-primary text-token-text-primary">
          <div className="h-full min-h-0 overflow-y-auto px-1">
            <div className="px-4 py-3">
              <MarkdownRenderer
                content={`# Implementation plan

## Scope

- Render the full proposed-plan markdown in the right panel.
- Preserve code blocks and lists without the thread preview mask.

\`\`\`ts
const tabId = "plan";
\`\`\`

## Validation

1. Open the completed plan card.
2. Confirm the thread preview collapses.
3. Close the side-panel tab and confirm the preview returns.`}
                className="codex-markdown-plan text-size-chat"
              />
            </div>
          </div>
        </div>
      </div>
    </StorySurface>
  ),
};

export const ReasoningCompleted: Story = {
  render: () => (
    <StorySurface
      title="Reasoning Completed"
      description="Completed reasoning collapses back to the Codex Thought summary and can be reopened on demand."
    >
      <ConversationStorySurface>
        <ReasoningSurface
          item={{
            markdownText:
              "**Investigating**\n\nChecking the failing story state.\n\n- comparing bundle behavior\n- checking transcript buckets",
            status: "completed",
          }}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const ReasoningCompletedExpanded: Story = {
  render: () => (
    <StorySurface
      title="Reasoning Completed Expanded"
      description="Completed reasoning should reopen with the same measured accordion motion contract used by Codex Electron."
    >
      <ConversationStorySurface>
        <AutoOpenSurface>
          <ReasoningSurface
            item={{
              markdownText:
                "**Investigating**\n\nChecking the failing story state.\n\n- comparing bundle behavior\n- checking transcript buckets",
              status: "completed",
            }}
          />
        </AutoOpenSurface>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TodoList: Story = {
  render: () => (
    <StorySurface
      title="Todo List"
      description="The full Codex-style todo card shows completion progress, current-step emphasis, and the measured expandable body."
    >
      <ConversationStorySurface>
        <TodoListSurface
          item={{
            markdownText: [
              "- [x] Audit the bundle",
              "- [ ] Port the todo shell",
              "- [ ] Update stories and tests",
            ].join("\n"),
            status: "inProgress",
            rawItem: undefined,
          }}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TodoListCompleted: Story = {
  render: () => (
    <StorySurface
      title="Todo List Completed"
      description="Completed todo plans can also render from structured raw plan payloads when available."
    >
      <ConversationStorySurface>
        <TodoListSurface
          item={{
            markdownText: "",
            status: "completed",
            rawItem: {
              plan: [
                { step: "Audit the bundle", status: "completed" },
                { step: "Port the todo shell", status: "completed" },
                { step: "Update stories and tests", status: "completed" },
              ],
            },
          }}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TodoListCollapsed: Story = {
  render: () => (
    <StorySurface
      title="Todo List Collapsed"
      description="Completed todo plans should collapse back to the same measured transcript accordion used by Codex Electron."
    >
      <ConversationStorySurface>
        <AutoOpenSurface>
          <TodoListSurface
            item={{
              markdownText: "",
              status: "completed",
              rawItem: {
                plan: [
                  { step: "Audit the bundle", status: "completed" },
                  { step: "Port the todo shell", status: "completed" },
                  { step: "Update stories and tests", status: "completed" },
                ],
              },
            }}
          />
        </AutoOpenSurface>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const AutomaticApprovalReviewDenied: Story = {
  render: () => (
    <StorySurface
      title="Automatic Approval Review Denied"
      description="Denied automatic approval reviews show the reviewed action and explain why explicit authorization is required."
    >
      <ConversationStorySurface>
        <AutomaticApprovalReviewSurface
          item={THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.automaticApprovalReviewDenied}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const ContextCompactionCompleted: Story = {
  render: () => (
    <StorySurface
      title="Context Compaction Completed"
      description="Completed context compaction renders as the Codex divider row instead of a generic system banner."
    >
      <ConversationStorySurface>
        <ThreadContextCompactionBlock
          block={buildSpecialTranscriptBlock(
            THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.contextCompactionCompleted,
          )}
          isLatestTurn
          isStreamingTurn={false}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const StreamErrorReconnecting: Story = {
  render: () => (
    <StorySurface
      title="Stream Error Reconnecting"
      description="Poor-network retry is rendered as a dedicated thread-body stream error row instead of a shell reconnect overlay."
    >
      <ConversationStorySurface>
        <ThreadStreamErrorBlock
          block={buildSpecialTranscriptBlock(
            THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.streamErrorReconnecting,
          )}
          isLatestTurn
          isStreamingTurn
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const SystemErrorFailed: Story = {
  render: () => (
    <StorySurface
      title="System Error Failed"
      description="Terminal non-retryable turn errors render as the dedicated Codex body row without the generic system banner shell."
    >
      <ConversationStorySurface>
        <ThreadSystemErrorBlock
          block={buildSpecialTranscriptBlock(
            THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.systemErrorFailed,
          )}
          isLatestTurn={false}
          isStreamingTurn={false}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const ContextCompactionInProgress: Story = {
  render: () => (
    <StorySurface
      title="Context Compaction In Progress"
      description="The in-progress compacting row keeps the same divider shell and swaps to the shimmer label."
    >
      <ConversationStorySurface>
        <ThreadContextCompactionBlock
          block={buildSpecialTranscriptBlock(
            THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.contextCompactionInProgress,
          )}
          isLatestTurn
          isStreamingTurn
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const ContextCompactionInProgressElectronDark: Story = {
  render: () => (
    <StorySurface
      title="Context Compaction In Progress Electron Dark"
      description="Electron dark-mode thread shimmer keeps the Codex-style white highlight instead of switching to the dark override."
    >
      <ElectronDarkThreadStorySurface>
        <ThreadContextCompactionBlock
          block={buildSpecialTranscriptBlock(
            THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.contextCompactionInProgress,
          )}
          isLatestTurn
          isStreamingTurn
        />
      </ElectronDarkThreadStorySurface>
    </StorySurface>
  ),
};

export const AutomaticApprovalReviewInProgress: Story = {
  render: () => (
    <StorySurface
      title="Automatic Approval Review In Progress"
      description="The groupable in-progress review leaf keeps the reviewed action in the activity header and nests the reviewing row in the body."
    >
      <ConversationStorySurface>
        <AutomaticApprovalReviewSurface
          item={THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.automaticApprovalReviewInProgress}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const AutoReviewInterruptionWarning: Story = {
  render: () => (
    <StorySurface
      title="Auto Review Interruption Warning"
      description="Guardian too-many-denials warnings render as a dedicated auto-review interruption transcript row."
    >
      <ConversationStorySurface>
        <ThreadSystemBannerBlock
          block={buildSpecialTranscriptBlock(
            THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.autoReviewInterruptionWarning,
          )}
          isLatestTurn
          isStreamingTurn={false}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const MultiAgentActionCompleted: Story = {
  render: () => (
    <StorySurface
      title="Multi-Agent Action Completed"
      description="Settled multi-agent activity stays in its dedicated transcript surface and can be expanded to inspect the grouped rows."
    >
      <ConversationStorySurface>
        <MultiAgentActionSurface
          items={THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.multiAgentSettled}
          onOpenThread={openStoryAgentThread}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const MultiAgentActionCompletedExpanded: Story = {
  render: () => (
    <StorySurface
      title="Multi-Agent Action Completed Expanded"
      description="Completed multi-agent activity should reopen with the same measured accordion timing as other transcript-special surfaces."
    >
      <ConversationStorySurface>
        <AutoOpenSurface>
          <MultiAgentActionSurface
            items={THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.multiAgentSettled}
            onOpenThread={openStoryAgentThread}
          />
        </AutoOpenSurface>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const MultiAgentActionInProgress: Story = {
  render: () => (
    <StorySurface
      title="Multi-Agent Action In Progress"
      description="Live background agent activity keeps a shimmering collapsed header and remains user-expandable while work is still running."
    >
      <ConversationStorySurface>
        <MultiAgentActionSurface
          items={THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.multiAgentInProgress}
          onOpenThread={openStoryAgentThread}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const MultiAgentActionFailed: Story = {
  render: () => (
    <StorySurface
      title="Multi-Agent Action Failed"
      description="Failed multi-agent activity uses the same Codex header grammar as completed and in-progress grouped actions."
    >
      <ConversationStorySurface>
        <MultiAgentActionSurface
          items={THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.multiAgentFailed}
          onOpenThread={openStoryAgentThread}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const MultiAgentActionPromptMetadata: Story = {
  render: () => (
    <StorySurface
      title="Multi-Agent Action Prompt Metadata"
      description="Non-inline multi-agent prompts render as body metadata while inline spawn/send prompts stay truncated in-row."
    >
      <ConversationStorySurface>
        <AutoOpenSurface>
          <MultiAgentActionSurface
            items={THREAD_TRANSCRIPT_SPECIAL_STORY_ITEMS.multiAgentPromptMetadata}
            onOpenThread={openStoryAgentThread}
          />
        </AutoOpenSurface>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const SubagentActivityCompactGroup: Story = {
  render: () => (
    <StorySurface
      title="Subagent Activity Compact Group"
      description="Consecutive subagent updates render as at most three inline identicon chips followed by the hidden-agent count and shared status."
    >
      <ConversationStorySurface>
        <ThreadSubagentActivityInlineGroupBlock
          block={buildSubagentActivityStoryBlock()}
          isLatestTurn
          isStreamingTurn={false}
          onOpenThread={openStoryAgentThread}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const HookFeedbackMessage: Story = {
  render: () => (
    <StorySurface
      title="Hook Feedback Message"
      description="A Stop hook follow-up remains a user-message row and carries its dedicated Hook feedback status."
    >
      <ConversationStorySurface>
        <ThreadUserBubbleBlock
          block={buildSpecialTranscriptBlock({
            threadId: "thread-story",
            turnId: "turn-hook-feedback",
            itemId: "hook-feedback-story",
            type: "hookPrompt",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            markdownText: "Please include the failing boundary case in the verification.",
            hookFeedback: true,
            createdAt: 1,
            updatedAt: 1,
          })}
          isLatestTurn
          isStreamingTurn={false}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const InspectedImages: Story = {
  render: () => {
    const firstImage =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='160'%3E%3Crect width='240' height='160' fill='%232b6cb0'/%3E%3C/svg%3E";
    const secondImage =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='160'%3E%3Crect width='240' height='160' fill='%23c05621'/%3E%3C/svg%3E";
    const entry: CodexConversationItem = {
      threadId: "thread-story",
      turnId: "turn-image-view",
      itemId: "image-view-story",
      type: "imageView",
      kind: "systemEvent",
      semanticKind: "imageView",
      status: "completed",
      imageViewPaths: [firstImage, secondImage],
      rawItem: { id: "image-view-story", type: "imageView", path: firstImage },
      createdAt: 1,
      updatedAt: 1,
    };
    const block = buildSpecialTranscriptBlock(entry);
    return (
      <StorySurface
        title="Inspected Images"
        description="One consecutive raw image-view run stays one disclosure and opens its ordered paths as a navigable thumbnail strip."
      >
        <ConversationStorySurface>
          <AutoOpenSurface>
            <ThreadImageViewBlock block={block} isLatestTurn isStreamingTurn={false} />
          </AutoOpenSurface>
        </ConversationStorySurface>
      </StorySurface>
    );
  },
};

export const GeneratedImageOutputs: Story = {
  render: () => {
    const firstImage =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='420'%3E%3Cdefs%3E%3ClinearGradient id='g' x2='1' y2='1'%3E%3Cstop stop-color='%23132238'/%3E%3Cstop offset='1' stop-color='%2350a0a8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='420' fill='url(%23g)'/%3E%3C/svg%3E";
    const secondImage =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='420' height='420'%3E%3Crect width='420' height='420' fill='%23b96238'/%3E%3C/svg%3E";
    return (
      <StorySurface
        title="Generated Image Outputs"
        description="Completed generated images resolve preview/full/download assets independently beside the active turn-output placeholder. Click the first preview to inspect its distinct full asset."
      >
        <ConversationStorySurface>
          <ThreadGeneratedImageGalleryBlock
            block={{
              id: "turn-generated-images:generated-image-gallery",
              turnId: "turn-generated-images",
              createdAt: 1,
              updatedAt: 3,
              searchableText: "",
              type: "generatedImageGallery",
              images: [
                { id: "generated-image-1", previewSrc: firstImage, src: secondImage },
                { id: "generated-image-2", src: secondImage },
              ],
              pendingImageCount: 1,
            }}
            isLatestTurn
            isStreamingTurn
          />
        </ConversationStorySurface>
      </StorySurface>
    );
  },
};

export const CompletedMcpElicitation: Story = {
  render: () => (
    <StorySurface
      title="Completed MCP Elicitation"
      description="Completed MCP permission requests render as the same collapsed question-and-answer activity used in the thread body."
    >
      <ConversationStorySurface>
        <AutoOpenSurface>
          <ThreadMcpServerElicitationBlock
            block={buildSpecialTranscriptBlock({
              threadId: "thread-story",
              turnId: "turn-mcp-elicitation",
              itemId: "mcp-elicitation-story",
              type: "mcpServerElicitation",
              kind: "systemEvent",
              semanticKind: "mcpServerElicitation",
              status: "completed",
              rawItem: {
                type: "mcpServerElicitation",
                completed: true,
                requestId: "mcp-elicitation-request-story",
                action: "accept",
                elicitation: {
                  kind: "mcpToolCall",
                  message: "Allow the connector to read the selected project?",
                },
              },
              createdAt: 1,
              updatedAt: 1,
            })}
            isLatestTurn
            isStreamingTurn={false}
          />
        </AutoOpenSurface>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const UnsupportedMcpElicitationHidden: Story = {
  render: () => (
    <StorySurface
      title="Unsupported MCP Elicitation Hidden"
      description="The exact Pp branch treats a completed unsupported OpenAI form as hidden: this story intentionally has no product transcript row."
    >
      <ConversationStorySurface>
        <ThreadMcpServerElicitationBlock
          block={buildSpecialTranscriptBlock({
            threadId: "thread-story",
            turnId: "turn-mcp-elicitation-unsupported",
            itemId: "mcp-elicitation-unsupported-story",
            type: "mcpServerElicitation",
            kind: "systemEvent",
            semanticKind: "mcpServerElicitation",
            status: "completed",
            rawItem: {
              type: "mcpServerElicitation",
              completed: true,
              requestId: "mcp-elicitation-unsupported-request-story",
              action: "decline",
              elicitation: {
                kind: "unsupportedOpenAIForm",
                serverName: "example-server",
              },
            },
            createdAt: 1,
            updatedAt: 1,
          })}
          isLatestTurn
          isStreamingTurn={false}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};
