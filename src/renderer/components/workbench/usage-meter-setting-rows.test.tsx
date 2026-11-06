import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "@/test/browser-globals";
import type { UsageMeterSettings } from "../../../shared/usage-meter-settings";
import { UsageMeterSettingRows } from "./usage-meter-setting-rows";
import { WorkbenchRailAccountControls } from "./workbench-rail-account-controls";

// Separate query clients model independent renderer windows sharing Main's Profile preference.
test("switches persist independently and update an already-open rail in another window", async () => {
  let saved: UsageMeterSettings = { claude: true, codex: true, nodexCredit: true };
  const listeners = new Set<(settings: UsageMeterSettings) => void>();
  const invoke = vi.fn(async (channel: string, input?: UsageMeterSettings) => {
    if (channel === "settings:usage-meters:get") return saved;
    if (channel === "settings:usage-meters:update" && input) {
      saved = input;
      listeners.forEach((listener) => listener(saved));
      return saved;
    }
    return {
      revision: 0,
      configured: false,
      status: "signed-out",
      account: null,
      connection: "unavailable",
      persistence: null,
      error: null,
    };
  });
  installWindowApi({
    invoke,
    on: (channel: string, listener: (settings: UsageMeterSettings) => void) => {
      if (channel !== "usage-meter-settings-changed") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const settingsClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const railClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <>
      <QueryClientProvider client={settingsClient}>
        <UsageMeterSettingRows />
      </QueryClientProvider>
      <QueryClientProvider client={railClient}>
        <WorkbenchRailAccountControls
          onOpenSettings={() => {}}
          onOpenAccountSettings={() => {}}
          account={{ status: "ready", account: null, requiresOpenAiAuth: true }}
          claudeUsage={{
            snapshot: { status: "loading", providers: null, reason: null },
            refresh: async () => ({ status: "loading", providers: null, reason: null }),
            logout: async () => ({ status: "loading", providers: null, reason: null }),
          }}
          onStartChatGptLogin={async () => ({
            type: "chatgpt",
            loginId: "login",
            authUrl: "https://example.com",
          })}
          onStartApiKeyLogin={async () => ({ type: "apiKey" })}
          onCancelLogin={async () => {}}
        />
      </QueryClientProvider>
    </>,
  );
  try {
    const section = within(view.getByRole("region", { name: "Usage meters" }));
    await waitFor(() =>
      expect((section.getByRole("switch", { name: "Claude" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(view.getByRole("button", { name: "Loading Claude usage" })).not.toBeNull();
    expect(view.getByRole("button", { name: "Sign in to Codex" })).not.toBeNull();
    for (const label of ["Claude", "Codex", "Nodex credits"]) {
      const control = section.getByRole("switch", { name: label });
      await act(async () => {
        fireEvent.click(control);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(control.getAttribute("aria-checked")).toBe("false");
        expect((control as HTMLButtonElement).disabled).toBe(false);
      });
    }
    expect(saved).toEqual({ claude: false, codex: false, nodexCredit: false });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "Loading Claude usage" })).toBeNull();
      expect(view.queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
    });
    expect(view.getByRole("button", { name: "Account and settings" })).not.toBeNull();
    await act(async () => {
      fireEvent.click(section.getByRole("switch", { name: "Codex" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Sign in to Codex" })).not.toBeNull(),
    );
    expect(saved).toEqual({ claude: false, codex: true, nodexCredit: false });
  } finally {
    view.unmount();
    settingsClient.clear();
    railClient.clear();
  }
});

test("a failed save restores the saved switch and reports the failure", async () => {
  const saved = { claude: true, codex: true, nodexCredit: true };
  installWindowApi({
    invoke: async (channel: string) => {
      if (channel === "settings:usage-meters:get") return saved;
      throw new Error("Disk full");
    },
    on: () => () => {},
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <UsageMeterSettingRows />
    </QueryClientProvider>,
  );
  try {
    const control = view.getByRole("switch", { name: "Claude" });
    await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(control);
      await Promise.resolve();
    });
    expect((await view.findByRole("alert")).textContent).toBe(
      "Could not save usage meter settings.",
    );
    expect(control.getAttribute("aria-checked")).toBe("true");
  } finally {
    view.unmount();
    client.clear();
  }
});
