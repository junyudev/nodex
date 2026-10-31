import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, test, vi } from "vite-plus/test";
const modelStatusFixture = {
  models: [],
  topUp: {
    available: true,
    currency: "USD" as const,
    tiers: [
      { amount: 2, credit: 14, available: true },
      { amount: 5, credit: 35, available: false },
    ],
  },
};
import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import { WorkbenchRailAccountControls } from "@/components/workbench/workbench-rail-account-controls";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installWindowApi } from "@/test/browser-globals";
import { openNodexMenu } from "@/test/dom";
import { AccountSettingsPage } from "./account-settings-page";
import { describeCreditGauge, nextCreditGauge } from "./nodex-credit-meter";

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
      channel === "nodex-account:refresh-models"
        ? Promise.resolve(observed)
        : invoke(channel, ...args),
    on: (channel: string, listener: (value: unknown) => void) => {
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
    trigger: () => screen.getByRole("button", { name: "Account and settings" }),
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
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
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
});

test("shows credit in the rail meter and buys tiers from Account settings", async () => {
  const controls = renderAccountControls({
    ...signedIn,
    modelStatus: modelStatusFixture,
    credit: { balance: 7.25, unit: "USD" },
  });
  const meter = await screen.findByRole("button", { name: "Nodex credit, $7.25 left" });
  await act(async () => {
    fireEvent.focus(meter);
    await Promise.resolve();
  });
  const card = await screen.findByRole("dialog", { name: "Nodex credit details" });
  expect(within(card).getByLabelText("Remaining credit").textContent).toBe("$7.25");
  fireEvent.click(within(card).getByRole("button", { name: "Top up" }));
  expect(controls.accountSettings).toHaveBeenCalledTimes(1);
  // Account settings lays the tiers out: price first, credit second.
  expect(
    screen.getByRole("button", { name: "Pay $5 for $35 credit" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Pay $2 for $14 credit" }));
  await waitFor(() => expect(controls.invoke).toHaveBeenCalledWith("nodex-account:open-top-up", 2));
  // The account menu keeps identity and settings; credit lives in the meter.
  await openNodexMenu(controls.trigger());
  expect(within(screen.getByRole("menu")).queryByText(/credit/u)).toBeNull();
});

test("meters only accounts that have held credit", async () => {
  const controls = renderAccountControls({
    ...signedIn,
    modelStatus: modelStatusFixture,
    credit: { balance: 0, unit: "USD" },
  });
  await screen.findByRole("button", { name: "Pay $2 for $14 credit" });
  expect(screen.queryByRole("button", { name: /^Nodex credit/u })).toBeNull();
  await controls.emit({
    ...signedIn,
    revision: 2,
    modelStatus: modelStatusFixture,
    credit: { balance: 14, unit: "USD" },
  });
  await screen.findByRole("button", { name: "Nodex credit, $14.00 left" });
  // Spent down to zero, the meter stays to explain why Nodex models stopped.
  await controls.emit({
    ...signedIn,
    revision: 3,
    modelStatus: modelStatusFixture,
    credit: { balance: 0, unit: "USD" },
  });
  await screen.findByRole("button", { name: "Nodex credit, $0.00 left" });
});

it("refills the credit gauge on top-up and drains it with spending", () => {
  const topUp = nextCreditGauge(null, 30);
  expect(describeCreditGauge(nextCreditGauge(topUp, 24))).toEqual({
    percent: 80,
    severity: "normal",
  });
  expect(describeCreditGauge(nextCreditGauge(topUp, 6)).severity).toBe("low");
  expect(describeCreditGauge(nextCreditGauge(topUp, 0.3)).severity).toBe("critical");
  expect(describeCreditGauge(nextCreditGauge(topUp, 0)).severity).toBe("exhausted");
  const refilled = nextCreditGauge(nextCreditGauge(topUp, 6), 17);
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
    checkoutPending: true,
  };
  const controls = renderAccountControls(state);
  await screen.findByText("Top up is paused.");
  expect(
    screen.getByRole("button", { name: "Pay $2 for $14 credit" }).hasAttribute("disabled"),
  ).toBe(true);
  await controls.emit({
    ...state,
    revision: 2,
    checkoutPending: false,
    credit: { balance: 15, unit: "USD" },
  });
  await waitFor(() =>
    expect(screen.getAllByLabelText("Remaining credit").map((node) => node.textContent)).toContain(
      "$15.00",
    ),
  );
  expect(screen.queryByText("Waiting for payment…")).toBeNull();
});
