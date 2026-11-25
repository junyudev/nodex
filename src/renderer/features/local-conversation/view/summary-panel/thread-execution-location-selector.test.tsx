import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { toast } from "@/components/ui/toast";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { useThreadExecutionLocation } from "@/lib/use-thread-execution-location";
import { render, openNodexMenu } from "@/test/dom";
import {
  ThreadExecutionLocationSelector,
  type ThreadExecutionLocationModel,
} from "./thread-execution-location-selector";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));
vi.mock("@/lib/use-thread-execution-location", () => ({ useThreadExecutionLocation: vi.fn() }));
const move = vi.fn(async () => {});
const selectorFor = (model: Partial<ThreadExecutionLocationModel> = {}) => (
  <NodexTooltipProvider>
    <ThreadExecutionLocationSelector
      model={{ threadId: "thread", kind: "local", canMove: true, source: "present", ...model }}
      disabled={false}
      worktreeAvailable
    />
  </NodexTooltipProvider>
);
const selector = selectorFor();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useThreadExecutionLocation).mockReturnValue({
    operation: null,
    busy: false,
    blocked: false,
    completedOperationId: null,
    move,
  });
});

test("reports a rejected move with its reason", async () => {
  move.mockRejectedValueOnce(new Error("Working tree has conflicts"));
  const view = render(selector);
  await openNodexMenu(view.getByRole("button", { name: "Local" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Worktree" }));
    await Promise.resolve();
  });
  const confirm = await view.findByRole("button", { name: "Move to worktree" });
  await act(async () => {
    fireEvent.click(confirm);
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(toast.danger).toHaveBeenCalledExactlyOnceWith("Couldn’t move the chat", {
      description: "Working tree has conflicts",
    }),
  );
  expect(move).toHaveBeenCalledWith("worktree", "present");
});

test("works locally without a worktree, saying what can't come along", async () => {
  const view = render(selectorFor({ kind: "worktree", source: "gone" }));
  await openNodexMenu(view.getByRole("button", { name: "Worktree" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Local" }));
    await Promise.resolve();
  });
  const dialog = await view.findByRole("dialog");
  expect(dialog.textContent).toContain("This chat’s worktree no longer exists.");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Work locally" }));
    await Promise.resolve();
  });
  expect(move).toHaveBeenCalledExactlyOnceWith("local", "missing");
});
