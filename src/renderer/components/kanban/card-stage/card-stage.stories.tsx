import type { Meta, StoryObj } from "@storybook/react-vite";
import { CardStageDevStoryPage } from "./card-stage-dev-story";
import {
  CARD_STAGE_STORY_DEFAULT_PRESET,
  CARD_STAGE_STORY_PREVIEW_MODES,
  CARD_STAGE_STORY_RUN_TARGETS,
  CARD_STAGE_STORY_THREAD_DENSITIES,
  resolveCardStageStoryPreset,
} from "./card-stage-dev-story-data";

const meta = {
  title: "Kanban/Card Stage",
  component: CardStageDevStoryPage,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Production-backed Card Stage scenarios. Presets are separate stories, and per-scene tuning lives in Storybook Controls instead of an in-canvas sidebar.",
      },
    },
  },
  args: {
    ...CARD_STAGE_STORY_DEFAULT_PRESET.controls,
  },
  argTypes: {
    runInTarget: {
      control: "inline-radio",
      options: [...CARD_STAGE_STORY_RUN_TARGETS],
    },
    threadDensity: {
      control: "inline-radio",
      options: [...CARD_STAGE_STORY_THREAD_DENSITIES],
    },
    previewMode: {
      control: "inline-radio",
      options: [...CARD_STAGE_STORY_PREVIEW_MODES],
    },
    existingWorktree: {
      control: "boolean",
    },
    showNewThreadAction: {
      control: "boolean",
    },
    enableOpenThread: {
      control: "boolean",
    },
    collapseThreadsByDefault: {
      control: "boolean",
    },
    collapseSecondaryProperties: {
      control: "boolean",
    },
    historyPanelActive: {
      control: "boolean",
    },
    renderPreview: {
      table: {
        disable: true,
      },
    },
  },
} satisfies Meta<typeof CardStageDevStoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

export const DenseThreads: Story = {
  args: {
    ...resolveCardStageStoryPreset("dense-threads").controls,
  },
};

export const NewWorktreeSetup: Story = {
  args: {
    ...resolveCardStageStoryPreset("new-worktree-setup").controls,
  },
};

export const ExistingWorktree: Story = {
  args: {
    ...resolveCardStageStoryPreset("existing-worktree").controls,
  },
};

export const CloudCollapsed: Story = {
  args: {
    ...resolveCardStageStoryPreset("cloud-collapsed").controls,
  },
};
