import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageStageDevStoryPage } from "./page-stage-dev-story";
import {
  PAGE_STAGE_STORY_DEFAULT_PRESET,
  PAGE_STAGE_STORY_CHAT_DENSITIES,
  resolvePageStageStoryPreset,
} from "./page-stage-dev-story-data";

const meta = {
  title: "Board/Page Stage",
  component: PageStageDevStoryPage,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Production-backed Page Stage scenarios. Presets are separate stories, and per-scene tuning lives in Storybook Controls instead of an in-canvas sidebar.",
      },
    },
  },
  args: {
    ...PAGE_STAGE_STORY_DEFAULT_PRESET.controls,
  },
  argTypes: {
    chatDensity: {
      control: "inline-radio",
      options: [...PAGE_STAGE_STORY_CHAT_DENSITIES],
    },
    showNewChatAction: {
      control: "boolean",
    },
    enableOpenChat: {
      control: "boolean",
    },
    historyPanelActive: {
      control: "boolean",
    },
    standalone: {
      control: "boolean",
    },
    schemaVariant: {
      control: "inline-radio",
      options: [
        "default",
        "sparse-custom",
        "missing-due-date",
        "missing-assignee",
        "missing-status",
        "status-only-primary",
        "single-schedule-boundary",
        "empty-values",
        "corrupt-property",
      ],
    },
    descriptionVariant: {
      control: "inline-radio",
      options: ["default", "heading-rail", "few-headings"],
    },
    renderPreview: {
      table: {
        disable: true,
      },
    },
  },
} satisfies Meta<typeof PageStageDevStoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

export const DenseChats: Story = {
  args: {
    ...resolvePageStageStoryPreset("dense-chats").controls,
  },
};

export const EmptyChats: Story = {
  args: {
    ...resolvePageStageStoryPreset("empty-chats").controls,
  },
};

export const NestedPageWithoutProperties: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    standalone: true,
    chatDensity: "none",
    showNewChatAction: false,
    enableOpenChat: false,
  },
  parameters: {
    docs: {
      description: {
        story:
          "A nested standalone Page omits the Properties section when no property rows are available.",
      },
    },
  },
};

export const SparseCustomProperties: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    schemaVariant: "sparse-custom",
    chatDensity: "none",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Page Detail remains editable after optional built-in Properties are removed and renders custom number, checkbox, and text Properties from the active Source schema.",
      },
    },
  },
};

export const MissingDueDate: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    schemaVariant: "missing-due-date",
  },
};

export const MissingAssignee: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    schemaVariant: "missing-assignee",
  },
};

export const MissingStatus: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    schemaVariant: "missing-status",
  },
};

export const StatusOnlyPrimary: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    schemaVariant: "status-only-primary",
  },
};

export const SingleScheduleBoundary: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    schemaVariant: "single-schedule-boundary",
  },
};

export const EmptyPropertyValues: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    schemaVariant: "empty-values",
    chatDensity: "none",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Unset Page Properties share one secondary Empty presentation and one value-column alignment while populated Status keeps its focused presenter.",
      },
    },
  },
};

export const CorruptPropertyIsolated: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    schemaVariant: "corrupt-property",
  },
};

export const HeadingRail: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    descriptionVariant: "heading-rail",
  },
};

export const HeadingRailScrub: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    descriptionVariant: "heading-rail",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Drag over the left heading rail to inspect instant scrub navigation and the shared marker states.",
      },
    },
  },
};

export const HeadingRailFewHeadingsHidden: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    descriptionVariant: "few-headings",
  },
};

export const HeadingRailFullWidth: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    descriptionVariant: "heading-rail",
  },
};

export const HeadingRailDark: Story = {
  args: {
    ...resolvePageStageStoryPreset("overview").controls,
    descriptionVariant: "heading-rail",
  },
  parameters: {
    backgrounds: {
      default: "dark",
    },
  },
};
