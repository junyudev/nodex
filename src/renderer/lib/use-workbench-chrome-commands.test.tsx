import { createRef } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { motionValue } from "motion/react";
import { expect, test, vi } from "vite-plus/test";
import { makeTestWorkbenchSession } from "@/components/workbench/workbench-testkit/panel-fixtures";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import { useWorkbenchChromeCommands } from "./use-workbench-chrome-commands";

const mocks = vi.hoisted(() => ({ danger: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: { danger: mocks.danger } }));

test("keeps the full-width override through persistence and clears it on failure", async () => {
  let reject!: (error: Error) => void;
  const updateActivePanel = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  let overrides: Record<string, boolean> = {};
  const updatePanelCollapsedOverrides: WorkbenchPanelController["updatePanelCollapsedOverrides"] = (
    update,
  ) => {
    overrides = typeof update === "function" ? update(overrides) : update;
  };
  const controller = { updatePanelCollapsedOverrides } as WorkbenchPanelController;
  const view = renderHook(() =>
    useWorkbenchChromeCommands({
      activePanelOwner: { key: "session", panels: makeTestWorkbenchSession().panels },
      controller,
      lifecycle: { updateActivePanel, setActivePanelCollapsed: vi.fn(async () => undefined) },
      navigateBack: vi.fn(),
      navigateForward: vi.fn(),
      workbenchRootRef: createRef<HTMLDivElement>(),
      shellMainContentWidth: motionValue(1000),
      shellBodyHeight: motionValue(800),
      regularRightPanelWidth: motionValue(600),
      rightPanelRequestedWidth: motionValue(600),
      bottomPanelHeight: motionValue(280),
      bottomPanelRequestedHeight: motionValue(280),
      rightPanelSide: "right",
    }),
  );
  await act(async () => {
    view.result.current.setActiveRightPanelFullWidth(true);
  });
  expect(Object.values(overrides)).toEqual([false]);
  expect(updateActivePanel).toHaveBeenCalledWith(
    "right",
    expect.objectContaining({
      collapsed: false,
      size: expect.objectContaining({ fullWidth: true }),
    }),
  );
  await act(async () => {
    reject(new Error("write failed"));
    await Promise.resolve();
  });
  await waitFor(() => expect(overrides).toEqual({}));
  expect(mocks.danger).toHaveBeenCalledWith("write failed");
});
