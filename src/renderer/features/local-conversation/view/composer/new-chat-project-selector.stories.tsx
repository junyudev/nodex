import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import type { NewChatProjectSelectorModel, ThreadStageActions } from "../../thread-stage-types";
import { ComposerContextRail, ComposerContextRailSlot } from "../composer-context-rail";
import { NewChatProjectSelector } from "./new-chat-project-selector";

function buildActions(input: { onSelect: (projectId: string | null) => void }): ThreadStageActions {
  const noopAsync = async () => undefined;
  return {
    onCollaborationModeChange: () => undefined,
    onModelChange: () => undefined,
    onReasoningEffortChange: () => undefined,
    onPermissionModeChange: () => undefined,
    onQueueingEnabledChange: () => undefined,
    onSendPrompt: noopAsync,
    onSteerPrompt: noopAsync,
    onInterruptTurn: noopAsync,
    onRespondApproval: noopAsync,
    onRespondUserInput: noopAsync,
    onRespondMcpElicitation: noopAsync,
    onResolvePlanImplementationRequest: noopAsync,
    onEnqueueQueuedFollowUp: noopAsync,
    onRemoveQueuedFollowUp: noopAsync,
    onReorderQueuedFollowUps: noopAsync,
    onSendQueuedFollowUpNow: noopAsync,
    onEditQueuedFollowUp: noopAsync,
    onEditLastUserTurn: noopAsync,
    onForkFromTurn: noopAsync,
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => undefined,
    onConsumeComposerIntent: () => undefined,
    onOpenThread: () => undefined,
    onCleanBackgroundTerminals: noopAsync,
    onNewThreadProjectChange: input.onSelect,
    onRequestNewChatProjectCreate: () => undefined,
  };
}

function buildModel(input: {
  selectedProjectId: string | null;
  state: "default" | "empty" | "disabled";
}): NewChatProjectSelectorModel {
  const projects: NewChatProjectSelectorModel["projects"] =
    input.state === "empty"
      ? []
      : [
          {
            id: "nodex",
            label: "nodex",
            appearance: { color: "green", marker: { kind: "icon", icon: "plant" } },
            description: "/Users/asc/repo/nodex",
            primaryWorkspaceRoot: "/Users/asc/repo/nodex",
            searchText: "nodex /users/asc/repo/nodex",
          },
          {
            id: "devtools-codex",
            label: "devtools-codex",
            appearance: { color: "blue", marker: { kind: "icon", icon: "function" } },
            description: "/Users/asc/repo/devtools-codex",
            primaryWorkspaceRoot: "/Users/asc/repo/devtools-codex",
            searchText: "devtools-codex /users/asc/repo/devtools-codex",
          },
          {
            id: "get-job",
            label: "get-job",
            appearance: { color: "orange", marker: { kind: "icon", icon: "suitcase" } },
            description: "/Users/asc/repo/get-job",
            primaryWorkspaceRoot: "/Users/asc/repo/get-job",
            searchText: "get-job /users/asc/repo/get-job",
          },
          {
            id: "videos",
            label: "videos",
            appearance: { color: "pink", marker: { kind: "icon", icon: "popcorn" } },
            description: "/Users/asc/repo/videos",
            primaryWorkspaceRoot: "/Users/asc/repo/videos",
            searchText: "videos /users/asc/repo/videos",
          },
          {
            id: "c-kindavim",
            label: "c-kindavim",
            appearance: { color: "purple", marker: { kind: "emoji", emoji: "⌨️" } },
            description: "/Users/asc/repo/c-kindavim",
            primaryWorkspaceRoot: "/Users/asc/repo/c-kindavim",
            searchText: "c-kindavim /users/asc/repo/c-kindavim",
          },
        ];

  return {
    projects,
    selectedProjectId: input.selectedProjectId,
    disabled: input.state === "disabled",
    canAddProject: true,
  };
}

interface StoryArgs {
  selectedProjectId: string | null;
  state: "default" | "empty" | "disabled";
}

function NewChatProjectSelectorStory(args: StoryArgs) {
  const [selectedProjectId, setSelectedProjectId] = useState(args.selectedProjectId);
  return (
    <TooltipProvider>
      <div
        className="min-h-[280px] bg-token-main-surface-primary p-8"
        data-codex-window-type="electron"
      >
        <div className="max-w-3xl">
          <ComposerContextRailSlot visible>
            <ComposerContextRail>
              <NewChatProjectSelector
                model={buildModel({ selectedProjectId, state: args.state })}
                actions={buildActions({ onSelect: setSelectedProjectId })}
              />
            </ComposerContextRail>
          </ComposerContextRailSlot>
          <div className="composer-surface-chrome relative z-10 flex flex-col bg-token-input-background/90 backdrop-blur-lg electron:dark:bg-token-dropdown-background composer-multiline-surface">
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              <div className="mb-1 min-h-16 px-3 pt-3 text-sm text-token-input-placeholder-foreground">
                Do anything
              </div>
              <div className="mb-2 flex items-center gap-1 px-2">
                <span className="inline-flex size-7 rounded-full bg-token-foreground/5" />
                <span className="inline-flex h-7 w-24 rounded-full bg-token-foreground/5" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

const meta = {
  title: "Workbench/Threads/New Chat Project Selector",
  component: NewChatProjectSelectorStory,
  args: {
    selectedProjectId: "devtools-codex",
    state: "default",
  },
  argTypes: {
    selectedProjectId: {
      control: "text",
    },
    state: {
      control: "radio",
      options: ["default", "empty", "disabled"],
    },
  },
  parameters: {
    docs: {
      description: {
        component:
          "Focused product story for the new-chat project selector rendered in the lower composer status row.",
      },
    },
  },
} satisfies Meta<typeof NewChatProjectSelectorStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SelectedProject: Story = {};

export const ProjectlessDefault: Story = {
  args: {
    selectedProjectId: null,
    state: "default",
  },
};

export const EmptyProjects: Story = {
  args: {
    selectedProjectId: null,
    state: "empty",
  },
};

export const DisabledWhileSubmitting: Story = {
  args: {
    selectedProjectId: "nodex",
    state: "disabled",
  },
};
