import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { toast } from "@/components/ui/toast";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { useThreadExecutionLocation } from "@/lib/use-thread-execution-location";
import { render, openNodexMenu } from "@/test/dom";
import { buildThreadHandoffOperation } from "@/test/thread-handoff-fixture";
import { ThreadExecutionLocationSelector } from "./thread-execution-location-selector";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));
vi.mock("@/lib/use-thread-execution-location", () => ({ useThreadExecutionLocation: vi.fn() }));
const move = vi.fn(async () => {});
const selector = (
  <NodexTooltipProvider>
    <ThreadExecutionLocationSelector
      model={{ threadId: "thread", kind: "local", canMove: true }}
      disabled={false}
      worktreeAvailable
    />
  </NodexTooltipProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useThreadExecutionLocation).mockReturnValue({
    operation: null,
    busy: false,
    blocked: false,
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
  expect(move).toHaveBeenCalledWith("worktree");
});

test("reports a failed observed move once across unrelated renders", () => {
  vi.mocked(useThreadExecutionLocation).mockReturnValue({
    operation: buildThreadHandoffOperation({ status: "error", message: "Branch checkout failed" }),
    busy: false,
    blocked: false,
    move,
  });
  const view = render(selector);
  view.rerender(
    <NodexTooltipProvider>
      <ThreadExecutionLocationSelector
        model={{ threadId: "thread", kind: "local", canMove: true }}
        disabled
        worktreeAvailable
      />
    </NodexTooltipProvider>,
  );
  expect(toast.danger).toHaveBeenCalledExactlyOnceWith("Couldn’t move the chat", {
    description: "Branch checkout failed",
  });
});
