import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: label }));
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

  test("shows a reauthentication action with one session message and a safe transport failure", async () => {
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
    await screen.findByRole("button", { name: "Sign in again" });
    expect(screen.getByRole("status").textContent).toBe(
      "Session ended. Sign in again to continue.",
    );
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
