import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThreadTimestampSeparator } from "./thread-timestamp-separator";

const nowMs = new Date(2026, 6, 10, 12, 0).getTime();

const meta = {
  title: "Workbench/Threads/Timestamp Separator",
  component: ThreadTimestampSeparator,
  args: {
    sentAtMs: new Date(2026, 6, 10, 9, 35).getTime(),
    nowMs,
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-182 px-10 py-12">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ThreadTimestampSeparator>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Today: Story = {};

export const Older: Story = {
  args: {
    sentAtMs: new Date(2026, 5, 18, 18, 45).getTime(),
  },
};
