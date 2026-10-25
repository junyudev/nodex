import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CodexHomeSettingsSnapshot } from "../../../shared/codex-home-settings";
import { CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY } from "../../lib/codex-service-tier-settings";
import { CodexServiceTierSettingsProvider } from "../../lib/use-codex-service-tier-settings";
import { render } from "../../test/dom";
import { openSection } from "./agent-instance-settings.test-fixtures";
import {
  CodexAgentSettingsSection,
  codexHomeSummary,
  type CodexHomeSettingsRuntime,
} from "./codex-home-settings-control";
import type { CodexSetupImportRuntime } from "./codex-setup-import-control";

const nativeHome: CodexHomeSettingsSnapshot = {
  homePath: "",
  resolvedHomePath: "/user/.codex",
  source: "default",
  activeHomePath: "/user/.codex",
  accountHomePath: "",
  resolvedAccountHomePath: null,
  activeAccountHomePath: null,
  restartRequired: false,
};

const importRuntime: CodexSetupImportRuntime = {
  scan: vi.fn(),
  scanPickedHome: vi.fn(),
  apply: vi.fn(),
};

const renderSection = (runtime: CodexHomeSettingsRuntime) =>
  render(
    <CodexServiceTierSettingsProvider>
      <CodexAgentSettingsSection
        open
        disclosure={openSection}
        runtime={runtime}
        importRuntime={importRuntime}
      />
    </CodexServiceTierSettingsProvider>,
  );

it("shows the speed new Codex chats start with and saves a new one for later chats", async () => {
  localStorage.setItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY, "fast");
  try {
    const view = renderSection({ read: async () => nativeHome, update: vi.fn() });
    const speed = within(await view.findByRole("group", { name: "Codex speed" }));
    expect(speed.getByRole("button", { name: "Fast" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(speed.getByRole("button", { name: "Standard" }));
      await Promise.resolve();
    });
    expect(localStorage.getItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY)).toBeNull();
    expect(speed.getByRole("button", { name: "Standard" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await act(async () => {
      fireEvent.click(speed.getByRole("button", { name: "Fast" }));
      await Promise.resolve();
    });
    expect(localStorage.getItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY)).toBe("fast");
    // The folder rows stay unchanged: speed applies at once, with no Save or restart.
    expect(view.queryByRole("button", { name: "Save" })).toBeNull();
  } finally {
    localStorage.removeItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY);
  }
});

it("saves a home as pending until restart and clears the override to return to the native home", async () => {
  const update = vi.fn<CodexHomeSettingsRuntime["update"]>(async ({ homePath }) => ({
    ...nativeHome,
    homePath,
    resolvedHomePath: homePath || nativeHome.resolvedHomePath,
    source: homePath ? "settings" : "default",
    restartRequired: Boolean(homePath),
  }));
  const view = renderSection({ read: async () => nativeHome, update });
  await waitFor(() =>
    expect((view.getByLabelText("Codex home") as HTMLInputElement).disabled).toBe(false),
  );
  await act(async () => {
    fireEvent.change(view.getByLabelText("Codex home"), { target: { value: "/user/work-codex" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  await view.findByRole("status");
  expect(update).toHaveBeenCalledWith({ homePath: "/user/work-codex", accountHomePath: "" });
  expect(view.getByRole("status").textContent).toBe(
    "Restart Nodex to apply the saved directories.",
  );
  expect(view.getByText(nativeHome.activeHomePath)).toBeTruthy();
  await act(async () => {
    fireEvent.change(view.getByLabelText("Codex home"), { target: { value: "" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  await waitFor(() => expect(view.queryByRole("status")).toBeNull());
  expect(update).toHaveBeenLastCalledWith({ homePath: "", accountHomePath: "" });
});

it("selects an independent account while retaining the shared conversation home", async () => {
  const update = vi.fn<CodexHomeSettingsRuntime["update"]>(async (input) => ({
    ...nativeHome,
    accountHomePath: input.accountHomePath ?? "",
    resolvedAccountHomePath: input.accountHomePath || null,
    restartRequired: Boolean(input.accountHomePath),
  }));
  const view = renderSection({ read: async () => nativeHome, update });
  await waitFor(() =>
    expect((view.getByLabelText("Codex account directory") as HTMLInputElement).disabled).toBe(
      false,
    ),
  );
  await act(async () => {
    fireEvent.change(view.getByLabelText("Codex account directory"), {
      target: { value: "/user/personal-codex" },
    });
    fireEvent.keyDown(view.getByLabelText("Codex account directory"), { key: "Enter" });
    await Promise.resolve();
  });
  await view.findByRole("status");
  expect(update).toHaveBeenCalledWith({ homePath: "", accountHomePath: "/user/personal-codex" });
  expect(view.getByText(nativeHome.activeHomePath)).toBeTruthy();
});

it("retains the edited home when saving fails", async () => {
  const update = vi.fn<CodexHomeSettingsRuntime["update"]>(async () => {
    throw new Error("Codex home must be absolute or start with ~/.");
  });
  const view = renderSection({ read: async () => nativeHome, update });
  await waitFor(() =>
    expect((view.getByLabelText("Codex home") as HTMLInputElement).disabled).toBe(false),
  );
  await act(async () => {
    fireEvent.change(view.getByLabelText("Codex home"), { target: { value: "relative/path" } });
    fireEvent.keyDown(view.getByLabelText("Codex home"), { key: "Enter" });
  });
  await view.findByRole("alert");
  expect((view.getByLabelText("Codex home") as HTMLInputElement).value).toBe("relative/path");
  expect(update).toHaveBeenCalledTimes(1);
});

it("keeps the folders locked until they load, and loads them again on request", async () => {
  const read = vi
    .fn<CodexHomeSettingsRuntime["read"]>()
    .mockRejectedValueOnce(new Error("Settings unavailable"))
    .mockResolvedValue(nativeHome);
  const update = vi.fn<CodexHomeSettingsRuntime["update"]>();
  const view = renderSection({ read, update });
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't load the Codex folders. Settings unavailable",
  );
  expect((view.getByLabelText("Codex home") as HTMLInputElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect((view.getByLabelText("Codex home") as HTMLInputElement).disabled).toBe(false),
  );
  expect(view.queryByRole("alert")).toBeNull();
  expect(update).not.toHaveBeenCalled();
});

describe("codexHomeSummary", () => {
  it("names the folders Codex runs from in a few words", () => {
    expect(codexHomeSummary(null)).toBeNull();
    expect(codexHomeSummary(nativeHome)).toBe("Default setup");
    expect(codexHomeSummary({ ...nativeHome, source: "settings" })).toBe("Custom home");
    expect(codexHomeSummary({ ...nativeHome, activeAccountHomePath: "/user/personal" })).toBe(
      "Separate account",
    );
    expect(
      codexHomeSummary({
        ...nativeHome,
        source: "environment",
        activeAccountHomePath: "/user/personal",
      }),
    ).toBe("Custom home · separate account");
    expect(codexHomeSummary({ ...nativeHome, source: "settings", restartRequired: true })).toBe(
      "Restart to apply",
    );
  });
});
