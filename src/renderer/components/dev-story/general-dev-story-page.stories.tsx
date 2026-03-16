import type { Meta, StoryObj } from "@storybook/react-vite";
import { GeneralDevStoryPage } from "./general-dev-story-page";
import { GENERAL_DEV_STORY_DENSITY_OPTIONS } from "./general-dev-story-page";

const meta = {
  title: "Workbench/General UI",
  component: GeneralDevStoryPage,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A production-backed gallery for shared renderer primitives and recurring Nodex interaction patterns, now hosted directly in Storybook.",
      },
    },
  },
  args: {
    density: "balanced",
    permissionMode: "sandbox",
  },
  argTypes: {
    density: {
      control: "inline-radio",
      options: [...GENERAL_DEV_STORY_DENSITY_OPTIONS],
    },
    permissionMode: {
      control: "inline-radio",
      options: ["sandbox", "full-access", "custom"],
    },
  },
} satisfies Meta<typeof GeneralDevStoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};
