import { deferred } from "./agent-instance-settings.test-fixtures";
import { beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { render, settleAsyncRender, textContent } from "../../test/dom";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  mockState.invokeCalls.length = 0;
  mockState.subscribeCallback = null;
  mockState.responseOverrides.clear();
});

const mockState = vi.hoisted(() => ({
  invokeCalls: [] as unknown[][],
  subscribeCallback: null as ((status: import("../../lib/types").AppUpdateStatus) => void) | null,
  responseOverrides: new Map<string, () => Promise<unknown>>(),
}));

vi.mock("./app-update-settings-control-deps", () => {
  const invoke = async (...args: unknown[]) => {
    mockState.invokeCalls.push(args);
    const channel = args[0];
    const override = mockState.responseOverrides.get(String(channel));
    if (override) return override();

    switch (channel) {
      case "settings:app-updates:get":
        return { automaticChecksEnabled: true, channel: "stable" };
      case "app:update:status":
        return {
          status: "idle",
          supported: true,
          currentVersion: "0.1.5 (2523)",
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
          currentVersion: "0.1.5 (2523)",
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
          channelChangeAllowed: false,
        };
      case "app:update:install":
        return true;
      default:
        return null;
    }
  };
  return {
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

test.each(["invalid", "cancelled"])(
  "rolls back an optimistic update preference and clears busy state when the response is %s",
  async (outcome) => {
    const action = deferred<unknown>();
    mockState.responseOverrides.set("settings:app-updates:update", () => action.promise);
    const { AppUpdateSettingRows } = await import("./app-update-settings-control");
    const view = render(<AppUpdateSettingRows open />);
    const toggle = await view.findByRole("switch");
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle).toHaveProperty("disabled", true);

    await act(async () => {
      if (outcome === "cancelled")
        action.reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
      else action.resolve(null);
      await Promise.resolve();
    });
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(view.getByRole("alert").textContent).toBe(
      outcome === "cancelled" ? "Cancelled" : "Could not save app update settings.",
    );
  },
);

test("clears busy state after a failed restart and keeps it pending after an accepted restart", async () => {
  const { AppUpdateSettingRows } = await import("./app-update-settings-control");
  const view = render(<AppUpdateSettingRows open />);
  await settleAsyncRender();
  const status = mockState.subscribeCallback;
  if (!status) throw new Error("Expected the update status subscription");
  await act(async () => {
    status({
      status: "downloaded",
      supported: true,
      currentVersion: "0.1.5 (2523)",
      availableVersion: "0.1.6",
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      progressPercent: 100,
      transferredBytes: 12,
      totalBytes: 12,
      checkedAt: null,
      message: null,
      channel: "stable",
      channelChangeAllowed: false,
    });
    await Promise.resolve();
  });

  const restart = view.getByRole("button", { name: "Restart to update" });
  const failedRestart = deferred<unknown>();
  mockState.responseOverrides.set("app:update:install", () => failedRestart.promise);
  await act(async () => {
    fireEvent.click(restart);
    await Promise.resolve();
  });
  expect(restart).toHaveProperty("disabled", true);
  await act(async () => {
    failedRestart.resolve(false);
    await Promise.resolve();
  });
  await waitFor(() => expect(restart).toHaveProperty("disabled", false));
  expect(view.getByRole("alert").textContent).toBe("Could not restart to install the update.");

  const acceptedRestart = deferred<unknown>();
  mockState.responseOverrides.set("app:update:install", () => acceptedRestart.promise);
  await act(async () => {
    fireEvent.click(restart);
    await Promise.resolve();
  });
  await act(async () => {
    acceptedRestart.resolve(true);
    await Promise.resolve();
  });
  await settleAsyncRender();
  expect(restart).toHaveProperty("disabled", true);
  expect(view.queryByRole("alert")).toBeNull();
});

describe("AppUpdateSettingRows", () => {
  test("loads settings, reacts to update events, and triggers actions", async () => {
    const { AppUpdateSettingRows } = await import("./app-update-settings-control");
    const view = render(<AppUpdateSettingRows open={true} />);

    await settleAsyncRender();

    expect(textContent(view.container).includes("Nodex 0.1.5 (2523)")).toBe(true);
    expect(textContent(view.container).includes("Automatic background checks are ready.")).toBe(
      true,
    );
    expect(mockState.invokeCalls.some((entry) => entry[0] === "settings:app-updates:get")).toBe(
      true,
    );
    expect(mockState.invokeCalls.some((entry) => entry[0] === "app:update:status")).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("switch"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(
      mockState.invokeCalls.some(
        (entry) =>
          entry[0] === "settings:app-updates:update" &&
          JSON.stringify(entry[1]) === JSON.stringify({ automaticChecksEnabled: false }),
      ),
    ).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByText("Check now"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(mockState.invokeCalls.some((entry) => entry[0] === "app:update:check")).toBe(true);
    expect(textContent(view.container).includes("Checking for updates…")).toBe(true);

    await act(async () => {
      mockState.subscribeCallback?.({
        status: "downloaded",
        supported: true,
        currentVersion: "0.1.5 (2523)",
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
        channelChangeAllowed: false,
      });
    });
    await settleAsyncRender();

    expect(textContent(view.container).includes("Update ready. Restart Nodex to install it.")).toBe(
      true,
    );

    await act(async () => {
      fireEvent.click(view.getByText("Restart to update"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(mockState.invokeCalls.some((entry) => entry[0] === "app:update:install")).toBe(true);
  });
});

test("Windows uses the shared update actions and preferences", async () => {
  const root = document.documentElement;
  const previousOs = root.dataset.codexOs;
  root.dataset.codexOs = "win32";
  try {
    const { AppUpdateSettingRows } = await import("./app-update-settings-control");
    const view = render(<AppUpdateSettingRows open />);
    await waitFor(() => expect(view.getByText("Nodex 0.1.5 (2523)")).toBeTruthy());
    const check = await view.findByRole("button", { name: "Check now" });
    expect(view.getByRole("switch", { name: "Check for updates automatically" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(check);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockState.invokeCalls.some((entry) => entry[0] === "app:update:check")).toBe(true),
    );
    view.unmount();
  } finally {
    if (previousOs === undefined) delete root.dataset.codexOs;
    else root.dataset.codexOs = previousOs;
  }
});
