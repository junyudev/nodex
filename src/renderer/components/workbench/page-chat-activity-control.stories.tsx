import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { PageChatActivitySummary, PageChatItem } from "@/lib/types";
import {
  PageChatActivityControl,
  type PageChatActivityDetailOverride,
} from "./page-chat-activity-control";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const summary = (
  pageId: string,
  overrides: Partial<PageChatActivitySummary>,
): PageChatActivitySummary => ({
  pageId,
  relatedCount: 1,
  workingCount: 0,
  waitingOnApprovalCount: 0,
  waitingOnUserInputCount: 0,
  errorCount: 0,
  unreadCount: 0,
  soleSessionId: `session-${pageId}`,
  ...overrides,
});

const chat = (overrides: Partial<PageChatItem> = {}): PageChatItem => ({
  sessionId: "session-implementation",
  projectId: "project-nodex",
  projectName: "Nodex",
  displayTitle: "Implement related Chat activity",
  threadId: "thread-implementation",
  threadPreview: "The renderer projection is ready for review",
  threadStatus: { statusType: "idle", activeFlags: [] },
  threadArchived: false,
  unread: false,
  sessionArchived: false,
  conversationRecencyAt: Date.now(),
  linkedAt: "2026-08-24T00:00:00Z",
  ...overrides,
});

const rows: readonly {
  readonly label: string;
  readonly activity: PageChatActivitySummary;
  readonly detail: PageChatActivityDetailOverride;
}[] = [
  {
    label: "Idle · discoverable on Page hover/focus",
    activity: summary("idle", {}),
    detail: { items: [chat()] },
  },
  {
    label: "Working",
    activity: summary("working", { workingCount: 1 }),
    detail: { items: [chat({ threadStatus: { statusType: "active", activeFlags: [] } })] },
  },
  {
    label: "Unread",
    activity: summary("unread", { unreadCount: 1 }),
    detail: { items: [chat({ unread: true })] },
  },
  {
    label: "Working + unread",
    activity: summary("working-unread", { workingCount: 1, unreadCount: 1 }),
    detail: {
      items: [chat({ unread: true, threadStatus: { statusType: "active", activeFlags: [] } })],
    },
  },
  {
    label: "Awaiting approval",
    activity: summary("approval", { waitingOnApprovalCount: 1 }),
    detail: {
      items: [chat({ threadStatus: { statusType: "active", activeFlags: ["waitingOnApproval"] } })],
    },
  },
  {
    label: "Awaiting input",
    activity: summary("input", { waitingOnUserInputCount: 1 }),
    detail: {
      items: [
        chat({ threadStatus: { statusType: "active", activeFlags: ["waitingOnUserInput"] } }),
      ],
    },
  },
  {
    label: "Error",
    activity: summary("error", { errorCount: 1 }),
    detail: { items: [chat({ threadStatus: { statusType: "systemError", activeFlags: [] } })] },
  },
  {
    label: "Multiple Chats · picker",
    activity: summary("multiple", { relatedCount: 2, soleSessionId: null }),
    detail: {
      items: [
        chat(),
        chat({
          sessionId: "session-research",
          projectId: "project-research",
          projectName: "Research",
          displayTitle: "Compare activity models",
          threadId: "thread-research",
        }),
      ],
    },
  },
  {
    label: "Threadless Chat · picker",
    activity: summary("threadless", { relatedCount: 2, soleSessionId: null }),
    detail: {
      items: [
        chat(),
        chat({
          sessionId: "session-threadless",
          displayTitle: "New chat",
          threadId: null,
          threadPreview: "",
          threadStatus: null,
          conversationRecencyAt: null,
        }),
      ],
    },
  },
  {
    label: "Loading detail · picker",
    activity: summary("loading", { relatedCount: 2, soleSessionId: null }),
    detail: { items: [], loading: true },
  },
  {
    label: "Detail error · picker",
    activity: summary("detail-error", { relatedCount: 2, soleSessionId: null }),
    detail: { items: [], error: "Couldn’t load linked chats" },
  },
];

function ActivityMatrix({ narrow = false }: { readonly narrow?: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <NodexTooltipProvider>
        <main className="min-h-screen bg-token-main-surface-primary p-6 text-token-foreground">
          <div className={narrow ? "w-64" : "w-[520px]"}>
            <h1 className="text-sm font-semibold">Page related Chat activity</h1>
            <p className="mt-1 text-xs text-token-description-foreground">
              Compact title-lane states. Select multi-Chat rows to inspect the bounded picker.
            </p>
            <div className="mt-4 border-y border-token-border">
              {rows.map(({ label, activity, detail }) => (
                <div
                  key={activity.pageId}
                  className="flex h-11 min-w-0 items-center gap-2 border-b border-token-border/60 px-2 last:border-b-0 hover:bg-token-list-hover-background"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                  <PageChatActivityControl
                    pageAccessProjectId="project-nodex"
                    pageId={activity.pageId}
                    summary={activity}
                    onOpenChat={() => undefined}
                    onRemoveRelation={() => undefined}
                    detailOverride={detail}
                  />
                </div>
              ))}
            </div>
          </div>
        </main>
      </NodexTooltipProvider>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Workbench/Page Related Chats/Activity Control",
  component: ActivityMatrix,
} satisfies Meta<typeof ActivityMatrix>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {};

export const NarrowTitleLane: Story = { args: { narrow: true } };
