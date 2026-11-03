import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { ComputerUseSettingsPage, ComputerUseSettingsView } from "./computer-use-settings-page";

const readSettings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/computer-use-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/computer-use-settings")>()),
  readComputerUseSettings: readSettings,
}));

const snapshot = {
  alwaysHidePictureInPicture: false,
  approvedApps: [{ bundleIdentifier: "com.apple.Safari", displayName: "Safari" }],
  approvedMessageThreads: [{ chatGuid: "thread-1", displayName: "Family" }],
  available: true,
  lockedUseAllowed: true,
  lockedUseEnabled: false,
  message: null,
  soundMode: "foregroundClicks" as const,
};

describe("ComputerUseSettingsView", () => {
  test("routes native policy controls and approval removals", () => {
    const onRemoveAppApproval = vi.fn();
    const onRemoveMessageApproval = vi.fn();
    const onSetAlwaysHidePictureInPicture = vi.fn();
    const onSetLockedUseEnabled = vi.fn();

    render(
      <ComputerUseSettingsView
        pending={null}
        snapshot={snapshot}
        onRemoveAppApproval={onRemoveAppApproval}
        onRemoveMessageApproval={onRemoveMessageApproval}
        onSetAlwaysHidePictureInPicture={onSetAlwaysHidePictureInPicture}
        onSetLockedUseEnabled={onSetLockedUseEnabled}
        onSetSoundMode={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enable Locked use" }));
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Always hide picture in picture",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Safari" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Family" }));

    expect(onSetLockedUseEnabled).toHaveBeenCalledWith(true);
    expect(onSetAlwaysHidePictureInPicture).toHaveBeenCalledWith(true);
    expect(onRemoveAppApproval).toHaveBeenCalledWith("com.apple.Safari");
    expect(onRemoveMessageApproval).toHaveBeenCalledWith("thread-1");
  });

  test("does not expose locked use when configuration requirements deny it", () => {
    render(
      <ComputerUseSettingsView
        pending={null}
        snapshot={{
          ...snapshot,
          lockedUseAllowed: false,
          lockedUseEnabled: null,
        }}
        onRemoveAppApproval={() => undefined}
        onRemoveMessageApproval={() => undefined}
        onSetAlwaysHidePictureInPicture={() => undefined}
        onSetLockedUseEnabled={() => undefined}
        onSetSoundMode={() => undefined}
      />,
    );

    expect(screen.queryByRole("switch", { name: "Enable Locked use" })).toBeNull();
  });
});

test("clears a failed load when reopening Computer Use settings", async () => {
  readSettings.mockRejectedValueOnce(new Error("Could not reach settings"));
  const view = render(<ComputerUseSettingsPage open />);
  expect(await view.findByText("Could not reach settings")).toBeTruthy();
  view.rerender(<ComputerUseSettingsPage open={false} />);
  readSettings.mockImplementationOnce(() => new Promise(() => undefined));
  await act(async () => {
    view.rerender(<ComputerUseSettingsPage open />);
    await Promise.resolve();
  });
  expect(view.queryByText("Could not reach settings")).toBeNull();
  expect(view.getByText("Loading Computer Use settings…")).toBeTruthy();
  expect(readSettings).toHaveBeenCalledTimes(2);
});
