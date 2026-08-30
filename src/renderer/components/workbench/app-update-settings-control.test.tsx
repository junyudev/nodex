import { describe, expect, vi, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { render, settleAsyncRender, textContent } from "../../test/dom";

const mockState = vi.hoisted(() => ({
  invokeCalls: [] as unknown[][],
  subscribeCallback: null as ((status: import("../../lib/types").AppUpdateStatus) => void) | null,
}));

vi.mock("./app-update-settings-control-deps", async (importOriginal) => {
  const invoke = async (...args: unknown[]) => {
    mockState.invokeCalls.push(args);
    const channel = args[0];

    switch (channel) {
      case "settings:app-updates:get":
        return { automaticChecksEnabled: true, channel: "stable" };
      case "app:update:status":
        return {
          status: "idle",
          supported: true,
          currentVersion: "0.1.5",
          availableVersion: null,
          releaseName: null,
          releaseDate: null,
          releaseNotes: null,
          progressPercent: null,
          transferredBytes: null,
          totalBytes: null,
          checkedAt: "2026-03-18T09:10:11.000Z",
          message: "Automatic background checks are ready.",
          channel: "stable",
          buildDefaultChannel: "stable",
          channelChangeAllowed: true,
        };
      case "settings:app-updates:update":
        return {
          automaticChecksEnabled:
            (args[1] as { automaticChecksEnabled?: boolean }).automaticChecksEnabled ?? true,
          channel: (args[1] as { channel?: "stable" | "nightly" }).channel ?? "stable",
        };
      case "app:update:check":
        return {
          status: "checking",
          supported: true,
          currentVersion: "0.1.5",
          availableVersion: null,
          releaseName: null,
          releaseDate: null,
          releaseNotes: null,
          progressPercent: null,
          transferredBytes: null,
          totalBytes: null,
          checkedAt: "2026-03-18T10:00:00.000Z",
          message: "Checking for updates…",
          channel: "stable",
          buildDefaultChannel: "stable",
          channelChangeAllowed: false,
        };
      case "app:update:install":
        return true;
      default:
        return null;
    }
  };
  return {
    ...(await importOriginal<typeof import("./app-update-settings-control-deps")>()),
    readAppUpdateSettings: () => invoke("settings:app-updates:get"),
    readAppUpdateStatus: () => invoke("app:update:status"),
    updateAppUpdateSettings: (input: unknown) => invoke("settings:app-updates:update", input),
    checkForAppUpdate: () => invoke("app:update:check"),
    installAppUpdate: () => invoke("app:update:install"),
    subscribeAppUpdateStatus: (
      callback: (status: import("../../lib/types").AppUpdateStatus) => void,
    ) => {
      mockState.subscribeCallback = callback;
      return () => {
        mockState.subscribeCallback = null;
      };
    },
  };
});

describe("AppUpdateSettingsControl", () => {
  test("loads settings, reacts to update events, and triggers actions", async () => {
    mockState.invokeCalls.length = 0;
    mockState.subscribeCallback = null;

    const { AppUpdateSettingsControl } = await import("./app-update-settings-control");
    const view = render(<AppUpdateSettingsControl open={true} />);

    await settleAsyncRender();

    expect(textContent(view.container).includes("Nodex 0.1.5")).toBe(true);
    expect(textContent(view.container).includes("Automatic background checks are ready.")).toBe(
      true,
    );
    expect(mockState.invokeCalls.some((entry) => entry[0] === "settings:app-updates:get")).toBe(
      true,
    );
    expect(mockState.invokeCalls.some((entry) => entry[0] === "app:update:status")).toBe(true);

    fireEvent.click(view.getByRole("switch"));
    await settleAsyncRender();
    expect(
      mockState.invokeCalls.some(
        (entry) =>
          entry[0] === "settings:app-updates:update" &&
          JSON.stringify(entry[1]) === JSON.stringify({ automaticChecksEnabled: false }),
      ),
    ).toBe(true);

    fireEvent.click(view.getByText("Check now"));
    await settleAsyncRender();
    expect(mockState.invokeCalls.some((entry) => entry[0] === "app:update:check")).toBe(true);
    expect(textContent(view.container).includes("Checking for updates…")).toBe(true);

    await act(async () => {
      mockState.subscribeCallback?.({
        status: "downloaded",
        supported: true,
        currentVersion: "0.1.5",
        availableVersion: "0.1.6",
        releaseName: null,
        releaseDate: null,
        releaseNotes: null,
        progressPercent: 100,
        transferredBytes: 12,
        totalBytes: 12,
        checkedAt: "2026-03-18T10:10:00.000Z",
        message: "Update ready. Restart Nodex to install it.",
        channel: "stable",
        buildDefaultChannel: "stable",
        channelChangeAllowed: false,
      });
    });
    await settleAsyncRender();

    expect(textContent(view.container).includes("Update ready. Restart Nodex to install it.")).toBe(
      true,
    );

    fireEvent.click(view.getByText("Restart to Update"));
    await settleAsyncRender();
    expect(mockState.invokeCalls.some((entry) => entry[0] === "app:update:install")).toBe(true);
  });
});
