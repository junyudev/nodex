import { act, render, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { CodexTranscriptEntry } from "../../../../../shared/types";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import { ConversationRecoverySurface } from "./conversation-recovery-surface";
import "../../../../globals.css";

installRendererThemeFixture();

test("supports keyboard diagnostics without clipping the action in a narrow chat", async () => {
  await page.viewport(390, 330);
  const entry: CodexTranscriptEntry = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "error-1",
    type: "error",
    kind: "systemEvent",
    markdownText: "Request stream closed",
    additionalDetails: `Request ID: ${"0123456789abcdef".repeat(30)}`,
    recovery: {
      state: "failed",
      reason: "connection",
      attempt: 5,
      maxAttempts: 5,
      retryAt: null,
      updatedAt: null,
    },
    createdAt: 0,
    updatedAt: 0,
  };
  const view = render(
    <NodexTooltipProvider>
      <div style={{ width: 320, margin: 24 }}>
        <ConversationRecoverySurface entry={entry} isLatestTurn isStreamingTurn={false} />
      </div>
    </NodexTooltipProvider>,
  );
  const disclosure = view.getByRole("button", { name: "Connection could not be restored" });
  await act(async () => {
    disclosure.focus();
    await userEvent.keyboard("{Enter}");
  });
  const copy = await view.findByRole("button", { name: "Copy diagnostics" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    await userEvent.keyboard("{Tab}");
  });
  expect(document.activeElement).toBe(view.getByRole("region", { name: "Recovery diagnostics" }));
  await act(async () => {
    await userEvent.keyboard("{Tab}");
  });
  expect(document.activeElement).toBe(copy);
  const surface = view.container.firstElementChild as HTMLElement;
  expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);
  expect(copy.getBoundingClientRect().right).toBeLessThanOrEqual(
    surface.getBoundingClientRect().right,
  );
  await act(async () => {
    await userEvent.keyboard("{Shift>}{Tab}{Tab}{/Shift}");
    await userEvent.keyboard(" ");
  });
  await waitFor(() => expect(view.queryByRole("button", { name: "Copy diagnostics" })).toBeNull());
  expect(document.activeElement).toBe(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
});
