import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  renderHook,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vite-plus/test";
import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import { installWindowApi } from "@/test/browser-globals";
import { AccountSettingsPage } from "./account-settings-page";
import type { ReactNode } from "react";
import { useNodexAccount, useNodexCreditRefreshOnFocus } from "./use-nodex-account";

describe("account settings page", () => {
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
    await waitFor(() =>
      expect(account.invoke).toHaveBeenCalledWith("nodex-account:open-top-up", 10),
    );
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
});

describe("use nodex account", () => {
  function useCreditSurface(visible: boolean) {
    const account = useNodexAccount(true);
    useNodexCreditRefreshOnFocus(visible, account.refreshModels);
    return account;
  }

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
    account: {
      issuer: "https://accounts.nodex.test",
      subject: "user_one",
      email: "one@example.com",
      name: "One",
      imageUrl: null,
    },
    persistence: "secure",
  };

  function prepareAccount(read: Promise<NodexAccountSnapshot>) {
    const listeners = new Set<(value: unknown) => void>();
    const unsubscribe = vi.fn();
    const invoke = vi.fn<(channel: string) => Promise<NodexAccountSnapshot>>();
    invoke.mockReturnValue(read);
    installWindowApi({
      invoke,
      on: (channel: string, nextListener: (value: unknown) => void) => {
        if (channel !== "nodex-account:changed") throw new Error(`Unexpected event ${channel}`);
        listeners.add(nextListener);
        return () => {
          listeners.delete(nextListener);
          unsubscribe();
        };
      },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return {
      emit: (value: unknown) => listeners.forEach((listener) => listener(value)),
      invoke,
      unsubscribe,
      wrapper,
    };
  }

  function deferredSnapshot() {
    let resolve!: (snapshot: NodexAccountSnapshot) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<NodexAccountSnapshot>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  describe("Nodex account projection", () => {
    test("reads, signs out and cancels local account login while the renderer is offline", async () => {
      const wasOnline = onlineManager.isOnline();
      onlineManager.setOnline(false);
      try {
        const account = prepareAccount(Promise.resolve(signedIn));
        const { result } = renderHook(() => useNodexAccount(true), { wrapper: account.wrapper });
        await waitFor(() => expect(result.current.snapshot).toEqual(signedIn));
        account.invoke.mockResolvedValue({ ...signedOut, revision: 2 });
        await act(async () => {
          result.current.act("signOut");
          await Promise.resolve();
        });
        await waitFor(() => expect(result.current.snapshot?.status).toBe("signed-out"));
        expect(result.current.pending).toBeNull();
        await act(async () => {
          account.emit({ ...signedOut, revision: 3, status: "signing-in" });
          await Promise.resolve();
        });
        account.invoke.mockResolvedValue({ ...signedOut, revision: 4 });
        await act(async () => {
          result.current.act("cancelSignIn");
          await Promise.resolve();
        });
        await waitFor(() => expect(result.current.snapshot?.status).toBe("signed-out"));
        expect(account.invoke.mock.calls.map(([channel]) => channel)).toEqual([
          "nodex-account:read",
          "nodex-account:sign-out",
          "nodex-account:cancel-sign-in",
        ]);
      } finally {
        await act(async () => {
          onlineManager.setOnline(wasOnline);
          await Promise.resolve();
        });
      }
    });

    test("retains a newer broadcast when the initial read finishes late", async () => {
      const read = deferredSnapshot();
      const account = prepareAccount(read.promise);
      const { result } = renderHook(() => useNodexAccount(true), { wrapper: account.wrapper });

      await act(async () => {
        account.emit(signedIn);
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.snapshot).toEqual(signedIn));

      await act(async () => {
        read.resolve(signedOut);
        account.emit({ ...signedIn, revision: 99, status: "invalid-status" });
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.snapshot).toEqual(signedIn);
    });

    test("does not replace a newer healthy observation with a late read failure", async () => {
      const read = deferredSnapshot();
      const account = prepareAccount(read.promise);
      const { result } = renderHook(
        () => ({
          menu: useNodexAccount(true),
          settings: useNodexAccount(true),
        }),
        { wrapper: account.wrapper },
      );
      await act(async () => {
        account.emit(signedIn);
        read.reject(new Error("obsolete read failed"));
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.menu.retrying).toBe(false));
      expect(result.current.menu.snapshot).toEqual(signedIn);
      expect(result.current.settings.snapshot).toEqual(signedIn);
      expect(result.current.menu.failure).toBeNull();
      expect(result.current.settings.failure).toBeNull();
    });

    test("does not restore an account from a late refresh after another window signs out", async () => {
      const account = prepareAccount(Promise.resolve(signedIn));
      const refresh = deferredSnapshot();
      const { result } = renderHook(() => useNodexAccount(true), { wrapper: account.wrapper });
      await waitFor(() => expect(result.current.snapshot).toEqual(signedIn));
      account.invoke.mockReturnValue(refresh.promise);

      await act(async () => {
        result.current.act("refresh");
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.pending).toBe("refresh"));
      await act(async () => {
        account.emit({ ...signedOut, revision: 3 });
        refresh.resolve({ ...signedIn, revision: 2 });
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current.pending).toBeNull());
      expect(result.current.snapshot).toEqual({ ...signedOut, revision: 3 });
      expect(account.invoke).toHaveBeenLastCalledWith("nodex-account:refresh");
    });

    test("leaving Account settings releases observation without canceling browser sign-in", async () => {
      const account = prepareAccount(Promise.resolve(signedOut));
      const { result, unmount } = renderHook(() => useNodexAccount(true), {
        wrapper: account.wrapper,
      });
      await waitFor(() => expect(result.current.snapshot).toEqual(signedOut));
      account.invoke.mockResolvedValue({ ...signedOut, revision: 1, status: "signing-in" });

      await act(async () => {
        result.current.act("signIn");
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.snapshot?.status).toBe("signing-in"));
      unmount();

      expect(account.unsubscribe).toHaveBeenCalledOnce();
      expect(account.invoke.mock.calls.map(([channel]) => channel)).toEqual([
        "nodex-account:read",
        "nodex-account:sign-in",
      ]);
    });

    test("clears an observed network error when a newer account broadcast recovers", async () => {
      const account = prepareAccount(Promise.resolve(signedIn));
      const { result } = renderHook(() => useNodexAccount(true), { wrapper: account.wrapper });
      await waitFor(() => expect(result.current.snapshot).toEqual(signedIn));

      await act(async () => {
        account.emit({ ...signedIn, revision: 2, connection: "unavailable", error: "network" });
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.failure).toBe("network"));

      await act(async () => {
        account.emit({ ...signedIn, revision: 3 });
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.failure).toBeNull());
      expect(result.current.snapshot?.connection).toBe("available");
    });

    test("shares pending actions, failures and recovery across menu and Settings consumers", async () => {
      const account = prepareAccount(Promise.resolve(signedIn));
      const { result } = renderHook(
        () => ({
          menu: useNodexAccount(true),
          settings: useNodexAccount(true),
        }),
        { wrapper: account.wrapper },
      );
      await waitFor(() => expect(result.current.settings.snapshot).toEqual(signedIn));
      const signOut = deferredSnapshot();
      account.invoke.mockReturnValue(signOut.promise);

      await act(async () => {
        result.current.menu.act("signOut");
        result.current.settings.act("signIn");
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(result.current.menu.pending).toBe("signOut");
        expect(result.current.settings.pending).toBe("signOut");
      });
      expect(account.invoke.mock.calls.map(([channel]) => channel)).toEqual([
        "nodex-account:read",
        "nodex-account:sign-out",
      ]);

      await act(async () => {
        signOut.resolve({ ...signedOut, revision: 2, error: "revocation-failed" });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(result.current.menu.failure).toBe("revocation-failed");
        expect(result.current.settings.failure).toBe("revocation-failed");
      });

      await act(async () => {
        account.emit({ ...signedIn, revision: 3 });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(result.current.menu.failure).toBeNull();
        expect(result.current.settings.failure).toBeNull();
      });
      expect(result.current.menu.snapshot).toEqual(result.current.settings.snapshot);

      account.invoke.mockRejectedValue(new Error("private transport diagnostic"));
      await act(async () => {
        result.current.menu.act("refresh");
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(result.current.menu.failure).toBe("transport");
        expect(result.current.settings.failure).toBe("transport");
      });
      await act(async () => {
        account.emit({ ...signedIn, revision: 4 });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(result.current.menu.failure).toBeNull();
        expect(result.current.settings.failure).toBeNull();
      });
    });
  });

  test("observes new credit on focus and accepts Main's pending-checkout completion without a manual refresh", async () => {
    const account = prepareAccount(
      Promise.resolve({ ...signedIn, checkoutPending: true, credit: { balance: 1, unit: "USD" } }),
    );
    const { result } = renderHook(() => useCreditSurface(true), {
      wrapper: account.wrapper,
    });
    await waitFor(() => expect(result.current.snapshot?.checkoutPending).toBe(true));
    account.invoke.mockResolvedValue({
      ...signedIn,
      revision: 2,
      checkoutPending: false,
      credit: { balance: 15, unit: "USD" },
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.snapshot?.credit?.balance).toBe(15));
    expect(account.invoke).toHaveBeenCalledWith("nodex-account:refresh-models");
    expect(result.current.snapshot?.checkoutPending).toBe(false);
  });

  test("ordinary account consumers never refresh credit on focus", async () => {
    const account = prepareAccount(Promise.resolve(signedIn));
    const view = renderHook(({ showsCredit }) => useCreditSurface(showsCredit), {
      wrapper: account.wrapper,
      initialProps: { showsCredit: false },
    });
    await waitFor(() => expect(view.result.current.snapshot).toEqual(signedIn));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(account.invoke).not.toHaveBeenCalledWith("nodex-account:refresh-models");
    view.rerender({ showsCredit: true });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(account.invoke).toHaveBeenCalledWith("nodex-account:refresh-models"),
    );
    account.invoke.mockClear();
    view.rerender({ showsCredit: false });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(account.invoke).not.toHaveBeenCalled();
  });
});
