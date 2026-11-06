import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vite-plus/test";
import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import { installWindowApi } from "@/test/browser-globals";
import { AccountSettingsPage } from "./account-settings-page";

const signedOut: NodexAccountSnapshot = {
  revision: 0,
  configured: true,
  status: "signed-out",
  account: null,
  connection: "available",
  persistence: null,
  error: null,
};

function renderAccount(snapshot: NodexAccountSnapshot) {
  let listener: ((value: unknown) => void) | undefined;
  const invoke = vi
    .fn<(channel: string) => Promise<NodexAccountSnapshot>>()
    .mockResolvedValue(snapshot);
  installWindowApi({
    invoke,
    on: (_channel: string, nextListener: (value: unknown) => void) => {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <AccountSettingsPage open />
    </QueryClientProvider>,
  );
  return { invoke, emit: (value: NodexAccountSnapshot) => listener?.(value) };
}

async function clickAction(label: string) {
  const action = await screen.findByRole("button", { name: label });
  await act(async () => {
    fireEvent.click(action);
    await Promise.resolve();
  });
}

describe("Account settings", () => {
  test("keeps an unconfigured build usable without offering sign-in", async () => {
    const account = renderAccount({ ...signedOut, configured: false });
    await screen.findByText("Not available in this build.");

    expect(screen.queryByRole("button")).toBeNull();
    expect(account.invoke.mock.calls).toEqual([["nodex-account:read"]]);
  });

  test("can cancel browser sign-in and return silently to signed-out", async () => {
    const account = renderAccount(signedOut);
    await screen.findByRole("button", { name: "Sign in" });
    account.invoke.mockResolvedValue({ ...signedOut, revision: 1, status: "signing-in" });
    await clickAction("Sign in");
    await screen.findByText("Signing in through your browser…");

    account.invoke.mockResolvedValue({ ...signedOut, revision: 2 });
    await clickAction("Cancel");
    await screen.findByRole("button", { name: "Sign in" });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(account.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "nodex-account:read",
      "nodex-account:sign-in",
      "nodex-account:cancel-sign-in",
    ]);
  });

  test("allows first sign-in before reachability is known and retry after a network failure", async () => {
    const account = renderAccount({ ...signedOut, connection: "unavailable" });
    const signIn = await screen.findByRole("button", { name: "Sign in" });
    expect(signIn.hasAttribute("disabled")).toBe(false);
    account.invoke.mockResolvedValue({
      ...signedOut,
      revision: 1,
      connection: "unavailable",
      error: "network",
    });
    await clickAction("Sign in");
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();

    account.invoke.mockResolvedValue({ ...signedOut, revision: 2, status: "signing-in" });
    await clickAction("Sign in");
    await screen.findByRole("button", { name: "Cancel" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      account.invoke.mock.calls.filter(([channel]) => channel === "nodex-account:sign-in"),
    ).toHaveLength(2);
  });

  test("retains identity offline and allows local sign-out even if revocation fails", async () => {
    const account = renderAccount({
      ...signedOut,
      status: "signed-in",
      account: {
        issuer: "https://accounts.nodex.test",
        subject: "user_one",
        email: "one@example.com",
        name: "One",
        imageUrl: null,
      },
      connection: "unavailable",
      error: "network",
      persistence: "memory",
    });
    await screen.findByText("one@example.com");
    expect(screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Check again" })).toBeDefined();
    await screen.findByText(
      "Secure storage is unavailable, so this sign-in lasts until Nodex quits.",
    );
    account.invoke.mockResolvedValue({ ...signedOut, revision: 1, error: "revocation-failed" });
    await clickAction("Sign out");

    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByText("one@example.com")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Signed out on this device. Nodex couldn't confirm the server session ended.",
    );
    expect(account.invoke).toHaveBeenLastCalledWith("nodex-account:sign-out");
  });

  test("allows reauthentication without claiming an absent identity and keeps failures safe", async () => {
    const account = renderAccount(signedOut);
    await screen.findByRole("button", { name: "Sign in" });
    await act(async () => {
      account.emit({
        ...signedOut,
        revision: 1,
        status: "reauthentication-required",
        error: "invalid-grant",
      });
      await Promise.resolve();
    });
    const signInAgain = await screen.findByRole("button", { name: "Sign in again" });
    expect(signInAgain.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Signed in")).toBeNull();
    expect(screen.getByText("Nodex Account")).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("Your session ended. Sign in again.");
    expect(screen.queryByRole("alert")).toBeNull();

    account.invoke.mockRejectedValue(new Error("private IPC diagnostic"));
    await clickAction("Sign in again");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not complete the request. Try again.",
      ),
    );
    expect(screen.queryByText("private IPC diagnostic")).toBeNull();
  });
});

test("shows prepaid credit and opens Top up through the account command", async () => {
  const account = renderAccount({
    ...signedOut,
    status: "signed-in",
    account: {
      issuer: "https://clerk.nodex.jyu.app",
      subject: "alice",
      email: "alice@example.com",
      name: "Alice",
      imageUrl: null,
    },
    credit: { balance: 12.5, unit: "USD" },
    creditsPerUsd: 25,
    modelStatus: {
      creditsPerUsd: 25,
      models: [],
      topUp: {
        available: true,
        currency: "USD",
        tiers: [{ amount: 10, credit: 11, available: true }],
      },
    },
  });
  await waitFor(() => expect(screen.getByLabelText("Remaining credits").textContent).toBe("312"));
  expect(screen.getByText("25 credits = $1")).toBeDefined();
  fireEvent.click(await screen.findByRole("button", { name: "Pay $10 for 275 credits" }));
  await waitFor(() => expect(account.invoke).toHaveBeenCalledWith("nodex-account:open-top-up", 10));
  await act(async () => {
    account.emit({ ...signedOut, revision: 1 });
    await Promise.resolve();
  });
  await screen.findByRole("button", { name: "Sign in" });
  expect(screen.queryByRole("button", { name: "Pay $10 for 275 credits" })).toBeNull();
});

const priced = (multiplier: number) => ({
  id: "gpt-6.1-sol",
  label: "GPT-6.1 Sol",
  provider: "openai",
  reference: { input: 5, cacheRead: 0.5, cacheWrite: null, output: 30 },
  effective: {
    input: 5 * multiplier,
    cacheRead: 0.5 * multiplier,
    cacheWrite: null,
    output: 30 * multiplier,
  },
  multiplier,
});

const signedInWith = (pricing: unknown) =>
  ({
    ...signedOut,
    status: "signed-in",
    account: {
      issuer: "https://clerk.nodex.jyu.app",
      subject: "alice",
      email: "alice@example.com",
      name: "Alice",
      imageUrl: null,
    },
    credit: { balance: 12.5, unit: "USD" },
    creditsPerUsd: 25,
    modelStatus: {
      creditsPerUsd: 25,
      pricing,
      models: [{ id: "gpt-6.1-sol", available: true }],
      topUp: {
        available: true,
        currency: "USD",
        tiers: [{ amount: 10, credit: 11, available: true }],
      },
    },
  }) as Parameters<typeof renderAccount>[0];

const pricingWith = (multiplier: number) => ({
  currency: "USD",
  perTokens: 1_000_000,
  notes: ["Note written on the server."],
  groups: [
    {
      id: "nodex",
      label: "Nodex",
      description: null,
      available: true,
      models: [priced(multiplier)],
    },
  ],
});

test("shows the server's model prices in credits at the API list price", async () => {
  renderAccount(signedInWith(pricingWith(1)));
  const prices = await screen.findByRole("region", { name: "Model prices" });
  expect(within(prices).getByText("Credits per 1M tokens")).toBeDefined();
  expect(within(prices).getByText("API list price")).toBeDefined();
  expect(within(prices).getByText("Note written on the server.", { exact: false })).toBeDefined();
  const row = within(prices).getByRole("row", { name: /GPT-6.1 Sol/u });
  expect(
    within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["125", "12.5", "750"]);
  expect(within(prices).queryByRole("columnheader", { name: "Cache write" })).toBeNull();
});

test("marks a discounted rate and crosses out the list price it replaces", async () => {
  renderAccount(signedInWith(pricingWith(0.5)));
  const prices = await screen.findByRole("region", { name: "Model prices" });
  const row = within(prices).getByRole("row", { name: /GPT-6.1 Sol/u });
  expect(within(row).getByText("×0.5")).toBeDefined();
  expect(
    within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["62.5125", "6.2512.5", "375750"]);
  expect(within(prices).queryByText("API list price")).toBeNull();
});

test("leaves Top up working when the server sends no prices", async () => {
  renderAccount(signedInWith(undefined));
  await screen.findByRole("button", { name: "Pay $10 for 275 credits" });
  expect(screen.queryByRole("region", { name: "Model prices" })).toBeNull();
});
