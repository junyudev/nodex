import type { Meta, StoryObj } from "@storybook/react-vite";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
} from "./local-conversation-thread-scroll-controller";
import { ThreadUserMessageNavigationRail } from "./thread-user-message-navigation-rail";

function buildStoryItems(): ThreadUserMessageNavigationItem[] {
  return Array.from({ length: 24 }, (_, index) => {
    const ordinal = index + 1;
    return {
      id: `turn_story_${ordinal}:user:0`,
      turnId: `turn_story_${ordinal}`,
      turnKey: `turn_story_${ordinal}`,
      ordinal,
      label:
        ordinal === 3
          ? "Yes, implement this plan"
          : ordinal === 7
            ? "(No content)"
            : `Review turn ${ordinal} and keep the implementation scoped`,
      responsePreview:
        "I traced the renderer path, kept the state local to the thread body, and verified the projection contract before touching UI.",
      outputs:
        ordinal === 4
          ? [
              { id: "app:calendar", type: "app", label: "calendar" },
              { id: "website:docs", type: "website", label: "docs.example.com" },
              { id: "file:thread", type: "file", label: "thread.tsx" },
              { id: "commit:commit", type: "commit", label: "Commit" },
            ]
          : ordinal === 9
            ? [
                { id: "review:review", type: "review", label: "Review" },
                { id: "pr:pr", type: "pull-request", label: "Pull request" },
              ]
            : [],
      isHeartbeat: false,
    };
  });
}

function RailStoryFrame() {
  const items = buildStoryItems();

  return (
    <NodexTooltipProvider>
      <div className="h-[640px] bg-token-main-surface-primary text-token-foreground">
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationThreadScrollLayout>
            <div data-thread-find-target="conversation" className="flex flex-col gap-3 py-10">
              {items.map((item, index) => (
                <div
                  key={item.id}
                  data-turn-key={item.turnKey}
                  data-content-search-turn-key={item.turnKey}
                  className="flex justify-end"
                >
                  <div data-content-search-unit-key={item.id} className="contents">
                    <div
                      data-user-message-bubble="true"
                      className="max-w-[min(42rem,80%)] rounded-2xl bg-background-user-message px-3 py-2 text-sm leading-6 text-text-user-message"
                    >
                      {item.label}
                      {index % 5 === 0 ? (
                        <span className="mt-2 block text-token-description-foreground">
                          Include the previous investigation notes, the failing scenario, and the
                          validation steps in the next pass.
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <ThreadUserMessageNavigationRail items={items} />
          </LocalConversationThreadScrollLayout>
        </EnsureLocalConversationThreadScrollController>
      </div>
    </NodexTooltipProvider>
  );
}

const meta = {
  title: "Workbench/Threads/User Message Navigation Rail",
  component: RailStoryFrame,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Manual visual parity fixture for the left-side user-message navigation rail: long thread, mounted and missing-target reveal, hover tooltip, output pills, current marker, reduced-motion checks, and drag scrub affordance.",
      },
    },
  },
} satisfies Meta<typeof RailStoryFrame>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LongThreadRail: Story = {};

export const NarrowThreadRail: Story = {
  parameters: {
    chromatic: {
      viewports: [390],
    },
  },
};
