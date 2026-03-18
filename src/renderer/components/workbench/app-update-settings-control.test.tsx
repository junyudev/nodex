import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent } from "@testing-library/react";
import { render, settleAsyncRender, textContent } from "../../test/dom";

let invokeCalls: unknown[][] = [];
let subscribeCallback: ((status: import("../../lib/types").AppUpdateStatus) => void) | null = null;

mock.module("../../lib/api", () => ({
  invoke: async (...args: unknown[]) => {
    invokeCalls.push(args);
    const channel = args[0];

    switch (channel) {
      case "settings:app-updates:get":
        return { automaticChecksEnabled: true };
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
        };
      case "settings:app-updates:update":
        return { automaticChecksEnabled: (args[1] as { automaticChecksEnabled?: boolean }).automaticChecksEnabled };
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
        };
      case "app:update:install":
        return true;
      default:
        return null;
    }
  },
  subscribeAppUpdateStatus: (callback: (status: import("../../lib/types").AppUpdateStatus) => void) => {
    subscribeCallback = callback;
    return () => {
      subscribeCallback = null;
    };
  },
}));

describe("AppUpdateSettingsControl", () => {
  test("loads settings, reacts to update events, and triggers actions", async () => {
    invokeCalls = [];
    subscribeCallback = null;

    const { AppUpdateSettingsControl } = await import("./app-update-settings-control");
    const view = render(<AppUpdateSettingsControl open={true} />);

    await settleAsyncRender();

    expect(textContent(view.container).includes("Nodex 0.1.5")).toBeTrue();
    expect(textContent(view.container).includes("Automatic background checks are ready.")).toBeTrue();
    expect(invokeCalls.some((entry) => entry[0] === "settings:app-updates:get")).toBeTrue();
    expect(invokeCalls.some((entry) => entry[0] === "app:update:status")).toBeTrue();

    fireEvent.click(view.getByRole("switch"));
    await settleAsyncRender();
    expect(
      invokeCalls.some(
        (entry) => entry[0] === "settings:app-updates:update"
          && JSON.stringify(entry[1]) === JSON.stringify({ automaticChecksEnabled: false }),
      ),
    ).toBeTrue();

    fireEvent.click(view.getByText("Check now"));
    await settleAsyncRender();
    expect(invokeCalls.some((entry) => entry[0] === "app:update:check")).toBeTrue();
    expect(textContent(view.container).includes("Checking for updates…")).toBeTrue();

    await act(async () => {
      subscribeCallback?.({
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
      });
    });
    await settleAsyncRender();

    expect(textContent(view.container).includes("Update ready. Restart Nodex to install it.")).toBeTrue();

    fireEvent.click(view.getByText("Restart to Update"));
    await settleAsyncRender();
    expect(invokeCalls.some((entry) => entry[0] === "app:update:install")).toBeTrue();
  });
});
