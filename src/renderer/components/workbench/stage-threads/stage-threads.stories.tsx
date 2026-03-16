import type { Meta, StoryObj } from "@storybook/react-vite";
import { StageThreadsDevStoryPage } from "./stage-threads-dev-story";
import {
  STAGE_THREADS_STORY_ACCOUNT_MODES,
  STAGE_THREADS_STORY_COLLABORATION_MODES,
  STAGE_THREADS_STORY_CONNECTION_STATUSES,
  STAGE_THREADS_STORY_DEFAULT_PRESET,
  STAGE_THREADS_STORY_PERMISSION_MODES,
  STAGE_THREADS_STORY_THREAD_MODES,
  STAGE_THREADS_STORY_THREAD_START_PROGRESS_MODES,
  resolveStageThreadsStoryPreset,
} from "./stage-threads-dev-story-data";

const meta = {
  title: "Workbench/Threads Panel",
  component: StageThreadsDevStoryPage,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Production-backed Threads Panel scenarios. Presets are defined as story variants, while state toggles live in Storybook Controls instead of a custom in-canvas sidebar.",
      },
    },
  },
  args: {
    ...STAGE_THREADS_STORY_DEFAULT_PRESET.controls,
  },
  argTypes: {
    threadMode: {
      control: "inline-radio",
      options: [...STAGE_THREADS_STORY_THREAD_MODES],
    },
    threadStartProgressMode: {
      control: "select",
      options: [...STAGE_THREADS_STORY_THREAD_START_PROGRESS_MODES],
    },
    connectionStatus: {
      control: "select",
      options: [...STAGE_THREADS_STORY_CONNECTION_STATUSES],
    },
    accountMode: {
      control: "inline-radio",
      options: [...STAGE_THREADS_STORY_ACCOUNT_MODES],
    },
    collaborationMode: {
      control: "inline-radio",
      options: [...STAGE_THREADS_STORY_COLLABORATION_MODES],
    },
    permissionMode: {
      control: "inline-radio",
      options: [...STAGE_THREADS_STORY_PERMISSION_MODES],
    },
    isNewThreadTab: { control: "boolean" },
    hasNewThreadTarget: { control: "boolean" },
    hideThinkingWhenDone: { control: "boolean" },
    showApprovals: { control: "boolean" },
    showUserInput: { control: "boolean" },
    hasCollaborationModes: { control: "boolean" },
  },
} satisfies Meta<typeof StageThreadsDevStoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

export const Running: Story = {
  args: {
    ...resolveStageThreadsStoryPreset("running").controls,
  },
};

export const PlanClarifying: Story = {
  args: {
    ...resolveStageThreadsStoryPreset("plan-clarifying").controls,
  },
};

export const NewThread: Story = {
  args: {
    ...resolveStageThreadsStoryPreset("new-thread").controls,
  },
};

export const NewThreadWorktreeSetup: Story = {
  args: {
    ...resolveStageThreadsStoryPreset("new-thread-worktree-setup").controls,
  },
};

export const NewThreadWorktreeFailed: Story = {
  args: {
    ...resolveStageThreadsStoryPreset("new-thread-worktree-failed").controls,
  },
};

export const AuthLogin: Story = {
  args: {
    ...resolveStageThreadsStoryPreset("auth-login").controls,
  },
};
