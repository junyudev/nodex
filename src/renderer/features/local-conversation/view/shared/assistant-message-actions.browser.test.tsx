import { act, render, screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import type { ThreadAssistantMessageActionsModel } from "../../thread-stage-types";
import { AssistantMessageActionsRow } from "./assistant-message-actions";
import { formatThreadMessageTimestamp } from "./thread-message-timestamp";

installRendererThemeFixture();

const sentAtMs = new Date(2026, 9, 28, 19, 46).getTime();

function Reply({ text, alwaysVisible }: { text: string; alwaysVisible: boolean }) {
  const actions: ThreadAssistantMessageActionsModel = {
    copyText: text,
    sentAtMs,
    canFork: false,
    ...(alwaysVisible ? { alwaysVisible: true } : {}),
  };
  return (
    <div className="group flex min-w-0 flex-col" data-testid={text}>
      <p>{text}</p>
      <AssistantMessageActionsRow actions={actions} threadId="thread" turnId="turn" isLatestTurn />
    </div>
  );
}

/** How visible an element is, through every faded ancestor within its reply. */
const shownOpacity = (element: Element) => {
  let opacity = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    opacity *= Number(getComputedStyle(node).opacity);
    if (node.classList.contains("group")) break;
  }
  return opacity;
};

const within = (reply: string) => screen.getByTestId(reply);
const copyIn = (reply: string) =>
  within(reply).querySelector("button[aria-label='Copy']") as HTMLElement;
const timestampIn = (reply: string) =>
  [...within(reply).querySelectorAll("span")].find(
    (span) => span.textContent === formatThreadMessageTimestamp(sentAtMs),
  ) as HTMLElement;

test("the latest reply keeps its actions in view while its timestamp waits for hover", async () => {
  render(
    <NodexTooltipProvider>
      <Reply text="Earlier reply" alwaysVisible={false} />
      <Reply text="Latest reply" alwaysVisible />
    </NodexTooltipProvider>,
  );

  expect(shownOpacity(copyIn("Latest reply"))).toBe(1);
  expect(shownOpacity(timestampIn("Latest reply"))).toBe(0);
  expect(shownOpacity(copyIn("Earlier reply"))).toBe(0);
  expect(shownOpacity(timestampIn("Earlier reply"))).toBe(0);

  await act(async () => {
    await userEvent.hover(screen.getByText("Latest reply"));
  });
  await expect.poll(() => shownOpacity(timestampIn("Latest reply"))).toBe(1);
  expect(shownOpacity(copyIn("Earlier reply"))).toBe(0);

  await act(async () => {
    await userEvent.hover(screen.getByText("Earlier reply"));
  });
  await expect.poll(() => shownOpacity(copyIn("Earlier reply"))).toBe(1);
  expect(shownOpacity(timestampIn("Earlier reply"))).toBe(1);
  expect(shownOpacity(timestampIn("Latest reply"))).toBe(0);
  expect(shownOpacity(copyIn("Latest reply"))).toBe(1);
});
