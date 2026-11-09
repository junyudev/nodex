import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, test, vi } from "vite-plus/test";
const modelStatusFixture = {
  creditsPerUsd: 25,
  models: [],
  topUp: {
    available: true,
    currency: "USD" as const,
    tiers: [
      { amount: 5, credit: 5, available: true },
      { amount: 10, credit: 11, available: true },
      { amount: 25, credit: 30, available: false },
    ],
  },
};
import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import {
  DEFAULT_USAGE_METER_SETTINGS,
  USAGE_METER_SETTINGS_CHANGED_CHANNEL,
} from "../../../shared/usage-meter-settings";
import { WorkbenchRailAccountControls } from "@/components/workbench/workbench-rail-account-controls";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installWindowApi } from "@/test/browser-globals";
import { hoverWithMouse, openNodexMenu } from "@/test/dom";
import type { SpaceConnectionSummary } from "../../../shared/space-connection";
import { AccountSettingsPage } from "./account-settings-page";
import { describeCreditGauge, nextCreditGauge } from "./nodex-credit-meter";

const spaces = vi.hoisted(() => {
  const personal = {
    spaceId: "personal",
    kind: "personal",
    name: "Personal",
    memberId: null,
    deviceId: null,
    availability: "ready",
  } as const;
  const team = {
    spaceId: "team",
    kind: "team",
    name: "Final Crew",
    memberId: "member",
    deviceId: "device",
    availability: "ready",
  } as const;
  return {
    personal,
    team,
    switch: vi.fn<(spaceId: string) => Promise<void>>(),
    openJoin: vi.fn<() => void>(),
    state: {
      spaces: [personal] as readonly SpaceConnectionSummary[],
      current: personal as SpaceConnectionSummary,
    },
  };
});
vi.mock("@/features/spaces/spaces-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/spaces/spaces-runtime")>()),
  useSpaces: () => spaces.state,
  switchSpace: spaces.switch,
}));
vi.mock("@/features/spaces/join-space-dialog", () => ({
  useOpenJoinSpace: () => spaces.openJoin,
}));
beforeEach(() => {
  spaces.switch.mockReset().mockResolvedValue(undefined);
  spaces.openJoin.mockReset();
  spaces.state = { spaces: [spaces.personal], current: spaces.personal };
});

const signedOut: NodexAccountSnapshot = {
  revision: 0,
  configured: true,
  status: "signed-out",
  account: null,
  connection: "available",
  persistence: null,
  error: null,
};

const signedIn: NodexAccountSnapshot = {
  ...signedOut,
  revision: 1,
  status: "signed-in",
  persistence: "secure",
  account: {
    issuer: "https://accounts.nodex.test",
    subject: "menu-review",
    name: "Nodex Scenario",
    email: "account@nodex.invalid",
    imageUrl: "https://images.nodex.test/account.svg",
  },
};

function renderAccountControls(snapshot: NodexAccountSnapshot, settingsShortcutLabel?: string) {
  const listeners = new Set<(value: unknown) => void>();
  let observed = snapshot;
  const invoke = vi
    .fn<(channel: string, ...args: unknown[]) => Promise<NodexAccountSnapshot>>()
    .mockResolvedValue(snapshot);
  const nativeAction = vi.fn();
  const settings = vi.fn();
  const accountSettings = vi.fn();
  installWindowApi({
    invoke: (channel: string, ...args: unknown[]) =>
      channel === "settings:usage-meters:get"
        ? Promise.resolve(DEFAULT_USAGE_METER_SETTINGS)
        : channel === "nodex-account:refresh-models"
          ? Promise.resolve(observed)
          : invoke(channel, ...args),
    on: (channel: string, listener: (value: unknown) => void) => {
      if (channel === USAGE_METER_SETTINGS_CHANGED_CHANNEL) return () => undefined;
      if (channel !== "nodex-account:changed") throw new Error(`Unexpected event ${channel}`);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={settings}
          onOpenAccountSettings={accountSettings}
          settingsShortcutLabel={settingsShortcutLabel}
          account={{
            status: "ready",
            account: null,
            requiresOpenAiAuth: true,
            pendingLogin: null,
            rateLimits: null,
          }}
          connection={{ status: "connected", retries: 0 }}
          onStartChatGptLogin={nativeAction}
          onStartApiKeyLogin={nativeAction}
          onCancelLogin={nativeAction}
          onLogout={nativeAction}
        />
        <AccountSettingsPage open />
      </NodexTooltipProvider>
    </QueryClientProvider>,
  );
  return {
    ...view,
    invoke,
    nativeAction,
    settings,
    accountSettings,
    emit: async (next: NodexAccountSnapshot) => {
      observed = next;
      await act(async () => {
        listeners.forEach((listener) => listener(next));
        await Promise.resolve();
      });
    },
    trigger: () => screen.getByRole("button", { name: "Spaces and settings" }),
  };
}

async function selectMenuItem(name: string | RegExp) {
  const item = await screen.findByRole("menuitem", { name });
  await act(async () => {
    fireEvent.click(item);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

describe("Nodex account menu", () => {
  test("keeps Settings available locally and routes signed-in identity to Account", async () => {
    const controls = renderAccountControls({ ...signedOut, configured: false }, "⇧⌘,");
    await screen.findByText("Not available in this build.");
    await openNodexMenu(controls.trigger());
    // With only the personal Space there is nothing to switch to, only a Space to join.
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "Join a Space" })).toBeDefined();
    const settings = screen.getByRole("menuitem", { name: "Settings" });
    expect(within(settings).getByText("⇧⌘,")).toBeDefined();
    await selectMenuItem("Settings");
    expect(controls.settings).toHaveBeenCalledOnce();

    await controls.emit(signedIn);
    await screen.findByText("account@nodex.invalid");
    await openNodexMenu(controls.trigger());
    await selectMenuItem(/Nodex Scenario/);
    expect(controls.accountSettings).toHaveBeenCalledOnce();
    expect(controls.nativeAction).not.toHaveBeenCalled();
  });

  test("shares browser sign-in and cancellation with the Account page without invoking native login", async () => {
    const controls = renderAccountControls(signedOut);
    await screen.findByText("Not signed in");
    controls.invoke.mockResolvedValue({ ...signedOut, revision: 1, status: "signing-in" });
    await openNodexMenu(controls.trigger());
    await selectMenuItem("Sign in");
    await screen.findByRole("button", { name: "Cancel" });
    await openNodexMenu(controls.trigger());
    controls.invoke.mockResolvedValue({ ...signedOut, revision: 2 });
    await selectMenuItem("Cancel sign-in");
    await screen.findByText("Not signed in");
    expect(
      controls.invoke.mock.calls
        .map(([channel]) => channel)
        .filter((channel) => channel !== "nodex-account:refresh-models"),
    ).toEqual(["nodex-account:read", "nodex-account:sign-in", "nodex-account:cancel-sign-in"]);
    expect(controls.nativeAction).not.toHaveBeenCalled();
  });

  test("falls back from a failed avatar and clears every identity when the menu signs out", async () => {
    const controls = renderAccountControls(signedOut);
    await screen.findByText("Not signed in");
    await controls.emit(signedIn);
    await screen.findByText("account@nodex.invalid");
    const image = controls.trigger().querySelector("img");
    expect(image?.getAttribute("src")).toBe(signedIn.account?.imageUrl);
    if (!image) throw new Error("Expected account image");
    await act(async () => {
      fireEvent.error(image);
      await Promise.resolve();
    });
    await waitFor(() => expect(controls.trigger().querySelector("img")).toBeNull());
    expect(within(controls.trigger()).getByText("NS")).toBeDefined();

    await controls.emit({
      ...signedIn,
      revision: 2,
      account: { ...signedIn.account!, imageUrl: null },
    });
    await waitFor(() => expect(controls.container.querySelectorAll("img")).toHaveLength(0));
    expect(within(controls.trigger()).getByText("NS")).toBeDefined();
    await openNodexMenu(controls.trigger());
    controls.invoke.mockResolvedValue({ ...signedOut, revision: 3 });
    await selectMenuItem("Sign out");
    await screen.findByText("Not signed in");
    expect(screen.queryByText("account@nodex.invalid")).toBeNull();
    expect(within(controls.trigger()).queryByText("NS")).toBeNull();
    expect(controls.container.querySelector("img")).toBeNull();
    expect(controls.invoke).toHaveBeenLastCalledWith("nodex-account:sign-out");
    expect(controls.nativeAction).not.toHaveBeenCalled();
  });

  test("lists every Space once there is a choice, switches, and joins after the menu closes", async () => {
    spaces.state = {
      spaces: [spaces.personal, { ...spaces.team, availability: "reconnecting" }],
      current: spaces.personal,
    };
    const controls = renderAccountControls(signedOut);
    await screen.findByText("Not signed in");
    // Another Space reconnecting is its own business; this window's face stays quiet.
    expect(controls.trigger().querySelector("[data-attention]")).toBeNull();
    await openNodexMenu(controls.trigger());
    expect(screen.getByRole("menuitem", { name: /^Personal/ }).getAttribute("aria-current")).toBe(
      "true",
    );
    const team = screen.getByRole("menuitem", { name: /^Final Crew/ });
    expect(team.hasAttribute("aria-current")).toBe(false);
    expect(within(team).getByText("Reconnecting…")).toBeDefined();
    // Dismissing the menu returns focus to its control.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.activeElement).toBe(controls.trigger()));
    await openNodexMenu(controls.trigger());
    await selectMenuItem(/^Final Crew/);
    await waitFor(() => expect(spaces.switch).toHaveBeenCalledWith("team"));

    await openNodexMenu(controls.trigger());
    await selectMenuItem("Join a Space");
    // The dialog opens once the menu has closed, so it never mounts inside the menu.
    await waitFor(() => expect(spaces.openJoin).toHaveBeenCalledOnce());
    expect(controls.settings).not.toHaveBeenCalled();
  });

  test("wears a team Space's face, whose availability outranks the account's attention", async () => {
    const revoked = { ...spaces.team, availability: "access-revoked" } as const;
    spaces.state = { spaces: [spaces.personal, revoked], current: revoked };
    const reauthentication: NodexAccountSnapshot = {
      ...signedIn,
      status: "reauthentication-required",
    };
    const team = renderAccountControls(reauthentication);
    await waitFor(() =>
      expect(team.trigger().getAttribute("data-nodex-account-status")).toBe(
        "reauthentication-required",
      ),
    );
    expect(within(team.trigger()).getByText("FC")).toBeDefined();
    expect(team.trigger().querySelector("img")).toBeNull();
    expect(team.trigger().querySelector("[data-attention]")?.getAttribute("data-attention")).toBe(
      "access-revoked",
    );
    await act(async () => {
      hoverWithMouse(team.trigger());
      await Promise.resolve();
    });
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Final Crew · Access revoked")).toBeDefined();
    expect(within(tooltip).getByText("Nodex Scenario · Session ended")).toBeDefined();
    // Losing a team never strands its window: the personal Space stays one choice away.
    await openNodexMenu(team.trigger());
    await selectMenuItem(/^Personal/);
    await waitFor(() => expect(spaces.switch).toHaveBeenCalledWith("personal"));
    team.unmount();

    spaces.state = { spaces: [spaces.personal, revoked], current: spaces.personal };
    const personal = renderAccountControls(reauthentication);
    await waitFor(() =>
      expect(
        personal.trigger().querySelector("[data-attention]")?.getAttribute("data-attention"),
      ).toBe("account"),
    );
    expect(personal.trigger().querySelector("img")?.getAttribute("src")).toBe(
      signedIn.account?.imageUrl,
    );
  });
});

test("shows credit in the rail meter and buys tiers from Account settings", async () => {
  const controls = renderAccountControls({
    ...signedIn,
    creditsPerUsd: 25,
    modelStatus: modelStatusFixture,
    credit: { balance: 7.25, unit: "USD" },
  });
  const meter = await screen.findByRole("button", { name: "Nodex credits, 181 left" });
  await act(async () => {
    fireEvent.focus(meter);
    await Promise.resolve();
  });
  const card = await screen.findByRole("dialog", { name: "Nodex credits details" });
  expect(within(card).getByLabelText("Remaining credits").textContent).toBe("181");
  fireEvent.click(within(card).getByRole("button", { name: "Top up" }));
  expect(controls.accountSettings).toHaveBeenCalledTimes(1);
  // Account settings lays the tiers out: price first, credit second.
  expect(
    screen.getByRole("button", { name: "Pay $25 for 750 credits" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Pay $5 for 125 credits" }));
  await waitFor(() => expect(controls.invoke).toHaveBeenCalledWith("nodex-account:open-top-up", 5));
  // The account menu keeps identity and settings; credit lives in the meter.
  await openNodexMenu(controls.trigger());
  expect(within(screen.getByRole("menu")).queryByText(/credit/u)).toBeNull();
});

test("meters only accounts that have held credit", async () => {
  const controls = renderAccountControls({
    ...signedIn,
    creditsPerUsd: 25,
    modelStatus: modelStatusFixture,
    credit: { balance: 0, unit: "USD" },
  });
  await screen.findByRole("button", { name: "Pay $5 for 125 credits" });
  expect(screen.queryByRole("button", { name: /^Nodex credits/u })).toBeNull();
  await controls.emit({
    ...signedIn,
    revision: 2,
    creditsPerUsd: 25,
    modelStatus: modelStatusFixture,
    credit: { balance: 14, unit: "USD" },
  });
  await screen.findByRole("button", { name: "Nodex credits, 350 left" });
  // Spent down to zero, the meter stays to explain why Nodex models stopped.
  await controls.emit({
    ...signedIn,
    revision: 3,
    creditsPerUsd: 25,
    modelStatus: modelStatusFixture,
    credit: { balance: 0, unit: "USD" },
  });
  await screen.findByRole("button", { name: "Nodex credits, 0 left" });
});

it("refills the credit gauge on top-up and drains it with spending", () => {
  const topUp = nextCreditGauge(null, 750);
  expect(describeCreditGauge(nextCreditGauge(topUp, 600))).toEqual({
    percent: 80,
    severity: "normal",
  });
  expect(describeCreditGauge(nextCreditGauge(topUp, 150)).severity).toBe("low");
  expect(describeCreditGauge(nextCreditGauge(topUp, 8)).severity).toBe("critical");
  // A balance that reads as 0 is exhausted, even with a fraction of a credit left.
  expect(describeCreditGauge(nextCreditGauge(topUp, 0.4)).severity).toBe("exhausted");
  const refilled = nextCreditGauge(nextCreditGauge(topUp, 150), 425);
  expect(describeCreditGauge(refilled)).toEqual({ percent: 100, severity: "normal" });
});

test("disables paused top-ups and reflects payment completion while account settings stay open", async () => {
  const state = {
    ...signedIn,
    modelStatus: {
      ...modelStatusFixture,
      topUp: { ...modelStatusFixture.topUp, available: false },
    },
    credit: { balance: 1, unit: "USD" as const },
    creditsPerUsd: 25,
    checkoutPending: true,
  };
  const controls = renderAccountControls(state);
  await screen.findByText("Top up is paused.");
  expect(
    screen.getByRole("button", { name: "Pay $5 for 125 credits" }).hasAttribute("disabled"),
  ).toBe(true);
  await controls.emit({
    ...state,
    revision: 2,
    checkoutPending: false,
    credit: { balance: 15, unit: "USD" },
  });
  await waitFor(() =>
    expect(screen.getAllByLabelText("Remaining credits").map((node) => node.textContent)).toContain(
      "375",
    ),
  );
  expect(screen.queryByText("Waiting for payment…")).toBeNull();
});
