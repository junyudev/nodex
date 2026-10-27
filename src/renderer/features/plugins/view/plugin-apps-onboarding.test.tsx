import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openExternalUrl } from "@/lib/file-system-operations";
import {
  pluginInterface,
  pluginRow,
  pluginSummary,
} from "../../../../shared/test-fixtures/plugins";
import type { CustomizeNavigation } from "../customize-navigation";
import { closePluginAppsOnboarding, showPluginAppsOnboarding } from "../model/install-sessions";
import { usePluginApps, usePluginManagement } from "../plugin-management";
import { PluginAppsOnboarding } from "./plugin-apps-onboarding";

vi.mock("@/lib/file-system-operations", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../plugin-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-management")>()),
  usePluginApps: vi.fn(),
  usePluginManagement: vi.fn(),
}));

const context = { hostId: "local", projectId: null } as const;
const linear = pluginRow({
  summary: pluginSummary({
    id: "linear@codex-official",
    name: "linear",
    interface: pluginInterface({ displayName: "Linear" }),
  }),
  nativeId: "linear@codex-official",
  stableIdentity: "linear@codex-official",
});
const navigation: CustomizeNavigation = {
  path: "/plugins",
  projectId: null,
  onNavigate: vi.fn(),
  onStartChat: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenHooksSettings: vi.fn(),
};

const appsQuery = (connected: boolean) =>
  ({
    data: {
      apps: [
        {
          id: "connector_linear",
          name: "Linear",
          accessible: connected,
          connectionState: connected ? "connected" : "authentication_required",
          logoUrl: null,
          logoDarkUrl: null,
        },
      ],
    },
  }) as never;

// The apps query as the account's links change, re-rendering whoever reads it.
const pending = appsQuery(false);
const linked = appsQuery(true);
let connected = false;
const listeners = new Set<() => void>();
function setConnected(next: boolean) {
  connected = next;
  for (const listener of listeners) listener();
}

beforeEach(() => {
  setConnected(false);
  vi.mocked(usePluginApps).mockImplementation(() =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => (connected ? linked : pending),
    ),
  );
  vi.mocked(usePluginManagement).mockReturnValue({} as never);
});

afterEach(() => {
  act(() => closePluginAppsOnboarding());
  cleanup();
  vi.clearAllMocks();
});

it("offers to connect a new plugin's apps and closes once they are connected", async () => {
  render(<PluginAppsOnboarding context={context} navigation={navigation} />);
  act(() =>
    showPluginAppsOnboarding({
      row: linear,
      apps: [
        {
          id: "connector_linear",
          name: "Linear",
          description: "Issues",
          installUrl: "https://example.com/connect",
          category: null,
        },
      ],
    }),
  );

  expect(await screen.findByText("Connect your apps to Linear")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await Promise.resolve();
  });
  expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/connect");
  expect(
    screen.getByRole("button", { name: "Continue connecting app" }).hasAttribute("disabled"),
  ).toBe(true);

  act(() => setConnected(true));
  await waitFor(() => expect(screen.queryByText("Connect your apps to Linear")).toBeNull());
});
