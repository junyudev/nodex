import { render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { LocalConversationTestQueryProvider } from "../local-conversation-test-query.test-fixtures";
import { ThreadSummaryPanelHeaderAction } from "./thread-summary-panel-header-action";

const mocks = vi.hoisted(() => ({
  readOverview: vi.fn(async () => ({ rows: [] })),
}));
vi.mock("../../local-conversation-store", () => ({
  useCodexAppServerManagerForConversationId: () => ({
    getHostId: () => "local",
    readSubagentOverview: mocks.readOverview,
  }),
  useConversationBackgroundTerminalRows: () => [],
  useConversationCwd: () => null,
  useConversationSummaryFields: () => ({}),
  useConversationTurns: () => [],
}));
vi.mock("@/lib/api", () => ({ subscribeCodexEvents: () => () => {} }));
vi.mock("./thread-floating-summary-panel", () => ({ ThreadSummaryPanelPopover: () => null }));
vi.mock("./thread-summary-panel-toggle", () => ({ ThreadSummaryPanelToggle: () => null }));

const mount = (executionKind: "native" | "runtime") =>
  render(
    <LocalConversationTestQueryProvider>
      <ThreadSummaryPanelHeaderAction
        activeThreadId="root"
        executionKind={executionKind}
        projectWorkspacePath={null}
        mode="popover"
        pinnedOpen={false}
      />
    </LocalConversationTestQueryProvider>,
  );

test("a Runtime chat's summary never asks the native host for its subagents", async () => {
  mocks.readOverview.mockClear();
  mount("native").unmount();
  await waitFor(() => expect(mocks.readOverview).toHaveBeenCalledTimes(1));
  mocks.readOverview.mockClear();
  const runtime = mount("runtime");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.readOverview).not.toHaveBeenCalled();
  runtime.unmount();
});
