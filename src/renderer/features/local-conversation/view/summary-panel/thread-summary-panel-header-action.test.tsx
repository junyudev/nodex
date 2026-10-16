import { render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { ThreadSummaryPanelContentProps } from "./thread-floating-summary-panel";
import { usePublishThreadSummaryContent } from "./thread-summary-content";
import { ThreadSummaryPanelHeaderAction } from "./thread-summary-panel-header-action";

const popover = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock("./thread-floating-summary-panel", () => ({
  ThreadSummaryPanelPopover: (props: Record<string, unknown>) => {
    popover.props.push(props);
    return null;
  },
}));
vi.mock("./thread-summary-panel-toggle", () => ({ ThreadSummaryPanelToggle: () => null }));

const content: ThreadSummaryPanelContentProps = {
  activeThreadId: "root",
  cwd: "/workspace",
  projectWorkspacePath: "/workspace",
  turns: [],
  onErrorMessage: () => undefined,
};

function Stage({ publish }: { publish: boolean }) {
  usePublishThreadSummaryContent("root", content, publish);
  return null;
}

const header = (onOpenSubagentsPanel?: () => void) => (
  <ThreadSummaryPanelHeaderAction
    activeThreadId="root"
    mode="popover"
    pinnedOpen={false}
    actions={onOpenSubagentsPanel ? { onOpenSubagentsPanel } : undefined}
  />
);

test("the narrow-layout summary presents the conversation stage's own summary", () => {
  popover.props = [];
  const openSubagents = vi.fn();
  const view = render(
    <>
      <Stage publish />
      {header(openSubagents)}
    </>,
  );
  const shown = popover.props.at(-1);
  expect(shown).toMatchObject({ activeThreadId: "root", cwd: "/workspace" });
  expect((shown?.actions as { onOpenSubagentsPanel?: unknown }).onOpenSubagentsPanel).toBe(
    openSubagents,
  );
  view.unmount();
});

test("without a stage summary the header shows nothing rather than a second summary", () => {
  popover.props = [];
  const view = render(
    <>
      <Stage publish={false} />
      {header()}
    </>,
  );
  expect(popover.props).toEqual([]);
  view.unmount();
});
