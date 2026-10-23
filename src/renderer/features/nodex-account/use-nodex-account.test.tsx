import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  let listener: ((value: unknown) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const invoke = vi.fn<(channel: string) => Promise<NodexAccountSnapshot>>();
  invoke.mockReturnValue(read);
  installWindowApi({
    invoke,
    on: (channel: string, nextListener: (value: unknown) => void) => {
      if (channel !== "nodex-account:changed") throw new Error(`Unexpected event ${channel}`);
      listener = nextListener;
      return unsubscribe;
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { emit: (value: unknown) => listener?.(value), invoke, unsubscribe, wrapper };
}

function deferredSnapshot() {
  let resolve!: (snapshot: NodexAccountSnapshot) => void;
  const promise = new Promise<NodexAccountSnapshot>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Nodex account projection", () => {
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
});
