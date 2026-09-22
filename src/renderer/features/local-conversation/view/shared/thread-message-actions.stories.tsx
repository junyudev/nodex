import type { Meta, StoryObj } from "@storybook/react-vite";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  CopyMessageActionButton,
  EditMessageIcon,
  MessageTimestamp,
  ThreadActionIconButton,
  ThreadMessageActionRow,
} from "./thread-message-actions";

const fixedNowMs = new Date(2026, 6, 10, 12, 0).getTime();
const recentPastSentAtMs = new Date(2026, 6, 9, 9, 35).getTime();

function MessageActionRowStoryFrame() {
  return (
    <NodexTooltipProvider>
      <div className="flex min-h-screen items-start justify-end bg-token-main-surface-primary p-8 text-size-chat">
        <div className="group flex w-full max-w-[32rem] flex-col items-end gap-1">
          <div className="max-w-[28rem] break-words rounded-2xl bg-token-foreground/5 px-3 py-2 text-sm leading-relaxed text-token-foreground">
            Check the action row timestamp parity against a recent prior day.
          </div>
          <ThreadMessageActionRow align="end">
            <MessageTimestamp sentAtMs={recentPastSentAtMs} nowMs={fixedNowMs} />
            <div className="flex items-center gap-1">
              <CopyMessageActionButton
                text="Check the action row timestamp parity against a recent prior day."
                feedbackMs={1500}
              />
              <ThreadActionIconButton label="Edit message" tooltip="Edit" autoFocus>
                <EditMessageIcon />
              </ThreadActionIconButton>
            </div>
          </ThreadMessageActionRow>
        </div>
      </div>
    </NodexTooltipProvider>
  );
}

const meta = {
  title: "Workbench/Threads/Message Actions",
  component: MessageActionRowStoryFrame,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof MessageActionRowStoryFrame>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FocusWithinTimestamp: Story = {};
