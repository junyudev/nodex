import { act, renderHook, waitFor } from "@testing-library/react";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import { installWindowApi } from "@/test/browser-globals";
import { useNodexAccount } from "./use-nodex-account";

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
