import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { CodexBackgroundProcessRow } from "../../../shared/types";
import { toast } from "@/components/ui/toast";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { openNodexMenu } from "@/test/dom";
import { renderWithQuery } from "@/test/query";
import {
  WorkbenchProcessManagerDialog,
  type WorkbenchProcessManagerControl,
} from "./workbench-process-manager-dialog";

const process: CodexBackgroundProcessRow = {
  id: "process-row",
  threadId: "thread",
  threadTitle: "Build",
  itemId: "command",
  turnId: null,
  command: "vp run dev",
  cwd: "/repo",
  processId: "process",
  osPid: null,
  terminalSessionId: "terminal",
  source: "app-server",
  startedAtMs: 1,
  updatedAtMs: 1,
  status: "running",
  terminal: null,
  terminalSession: null,
};

afterEach(() => vi.restoreAllMocks());

test.each(["Stop", "Restart"] as const)(
  "restores the process action after %s fails and allows a successful retry",
  async (action) => {
    let rejectStop!: (error: Error) => void;
    const stop = vi.fn<WorkbenchProcessManagerControl["stopBackgroundProcess"]>();
    stop.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStop = reject;
        }),
    );
    stop.mockResolvedValue(true);
    const run = vi.fn<WorkbenchProcessManagerControl["runBackgroundProcess"]>();
    run.mockResolvedValue([]);
    const list = vi.fn<WorkbenchProcessManagerControl["listBackgroundProcesses"]>();
    list.mockResolvedValue([process]);
    const danger = vi.spyOn(toast, "danger");
    const success = vi.spyOn(toast, "success");
    const view = renderWithQuery(
      <NodexTooltipProvider>
        <WorkbenchProcessManagerDialog
          open
          activeThreadId="thread"
          threads={[{ threadId: "thread", title: "Build" }]}
          control={{
            listBackgroundProcesses: list,
            runBackgroundProcess: run,
            stopBackgroundProcess: stop,
            terminateBackgroundTerminal: vi.fn(),
          }}
          onOpenChange={vi.fn()}
          onOpenThread={vi.fn()}
        />
      </NodexTooltipProvider>,
    );
    await screen.findByText("vp run dev");

    const selectAction = async () => {
      await openNodexMenu(screen.getByRole("button", { name: "Process actions" }));
      const item = await screen.findByRole("menuitem", { name: action });
      await act(async () => {
        fireEvent.click(item);
        await Promise.resolve();
      });
    };
    await selectAction();
    expect(stop).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread",
      processId: "process",
      terminalSessionId: action === "Stop" ? "terminal" : null,
    });
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Running")).toBeNull();

    await act(async () => {
      rejectStop(new Error("Process control unavailable"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(danger).toHaveBeenCalledWith("Process control unavailable");
      expect(screen.getByLabelText("Running")).toBeTruthy();
    });
    await selectAction();
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith(
        action === "Stop" ? "Process stopped" : "Process restarted",
      );
      expect(screen.getByLabelText("Running")).toBeTruthy();
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(action === "Restart" ? 1 : 0);
    if (action === "Restart") {
      expect(run).toHaveBeenCalledWith({
        threadId: "thread",
        threadTitle: "Build",
        itemId: "command",
        turnId: null,
        command: "vp run dev",
        cwd: "/repo",
        terminalSessionId: "terminal",
      });
    }
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    view.unmount();
  },
);
