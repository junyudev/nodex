import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { render } from "../../../../test/dom";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import type {
  ConversationBackgroundTask,
  ConversationBackgroundTasks,
} from "../../thread-stage-types";
import {
  formatBackgroundTaskAge,
  ThreadSummaryBackgroundSection,
} from "./thread-summary-background-section";

const task = (id: string, overrides: Partial<ConversationBackgroundTask> = {}) => ({
  id,
  kind: "command" as const,
  label: id,
  command: null,
  owner: null,
  startedAtMs: null,
  stopping: false,
  ...overrides,
});

function renderSection(background: ConversationBackgroundTasks, onErrorMessage = vi.fn()) {
  return render(
    <NodexTooltipProvider>
      <ThreadSummaryBackgroundSection
        background={background}
        autoCollapse={false}
        onErrorMessage={onErrorMessage}
      />
    </NodexTooltipProvider>,
  );
}

describe("ThreadSummaryBackgroundSection", () => {
  test("stops one task from its row and every task from the section", async () => {
    const stop = vi.fn(async () => {});
    const view = renderSection({
      tasks: [task("Serve docs preview"), task("Watch build output")],
      stop,
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Stop Serve docs preview" }));
      await Promise.resolve();
    });
    expect(stop).toHaveBeenLastCalledWith("Serve docs preview");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Stop all" }));
      await Promise.resolve();
    });
    expect(stop).toHaveBeenLastCalledWith(undefined);
  });

  test("a stopping task offers no second Stop and says it is stopping", () => {
    const view = renderSection({
      tasks: [task("Dev server", { stopping: true })],
      stop: vi.fn(async () => {}),
    });
    expect(view.queryByRole("button", { name: "Stop Dev server" })).toBeNull();
    expect(view.getByText("Stopping…")).toBeTruthy();
  });

  test("shows a task's command and the end of its output while it is open", async () => {
    const readOutput = vi.fn(async () => ({ text: "ready on :4321\n", truncated: true }));
    const view = renderSection({
      tasks: [task("Serve docs preview", { command: "pnpm docs:dev" })],
      stop: vi.fn(async () => {}),
      readOutput,
    });
    const row = view.getByRole("button", { name: "Serve docs preview, Shell command" });
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    expect(await view.findByText("ready on :4321")).toBeTruthy();
    expect(view.getByText("$ pnpm docs:dev")).toBeTruthy();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(readOutput).toHaveBeenCalledWith("Serve docs preview");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    expect(view.queryByText("ready on :4321")).toBeNull();
  });

  test("explains output the Agent cannot show", async () => {
    const view = renderSection({
      tasks: [task("Watch CI", { kind: "monitor" })],
      stop: vi.fn(async () => {}),
      readOutput: vi.fn(async () => null),
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Watch CI, Monitor" }));
      await Promise.resolve();
    });
    expect(await view.findByText("Output isn't available for this task")).toBeTruthy();
  });

  test("reports a Stop the Agent refused", async () => {
    const onErrorMessage = vi.fn();
    const view = renderSection(
      {
        tasks: [task("Dev server")],
        stop: vi.fn(async () => {
          throw new Error("Agent execution is unavailable");
        }),
      },
      onErrorMessage,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Stop Dev server" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(onErrorMessage).toHaveBeenLastCalledWith("Agent execution is unavailable"),
    );
  });
});

describe("formatBackgroundTaskAge", () => {
  test("reads like the sidebar once a task has run a minute", () => {
    const start = Date.parse("2026-10-28T10:00:00Z");
    expect(formatBackgroundTaskAge(start, start + 20_000)).toBe("<1m");
    expect(formatBackgroundTaskAge(start, start + 12 * 60_000)).toBe("12m");
    expect(formatBackgroundTaskAge(start, start + 3 * 3_600_000)).toBe("3h");
  });
});
