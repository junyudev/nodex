import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import type { ReactNode } from "react";
import type { Member } from "../../shared/work-graph";
import { followMemberDirectory, useMemberDirectory } from "./members-runtime";
import { rendererSpaceId } from "./renderer-space";

test("the directory marks the requesting Member and refreshes after a change in its Space", async () => {
  const previousApi = window.api;
  const ada: Member = {
    id: "member:ada",
    display_name: "Ada Lovelace",
    library_id: rendererSpaceId(),
    role: "owner",
    lifecycle: "active",
    revision: 1,
  };
  const grace: Member = {
    ...ada,
    id: "member:grace",
    display_name: "Grace Hopper",
    role: "member",
  };
  let people = [ada, grace];
  const listeners = new Set<(...args: unknown[]) => void>();
  window.api = {
    invoke: async (channel, ...args) => {
      if (channel !== "library-module:read") throw new Error(`Unexpected read ${channel}`);
      const { mode } = (args[1] as { read: { mode: string } }).read;
      const value =
        mode === "members"
          ? { kind: "members", items: people }
          : { kind: "local_member", value: people[0] };
      return { ok: true, value: { value } };
    },
    on: (event, listener) => {
      if (event !== "space-members-changed") throw new Error(`Unexpected event ${event}`);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = followMemberDirectory(client);
  try {
    const { result } = renderHook(useMemberDirectory, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() =>
      expect(result.current.data).toMatchObject([
        {
          id: ada.id,
          displayName: "Ada Lovelace",
          initials: "AL",
          role: "owner",
          isCurrentMember: true,
        },
        { id: grace.id, displayName: "Grace Hopper", role: "member", isCurrentMember: false },
      ]),
    );

    const color = result.current.data?.[0]?.color;
    people = [
      { ...ada, display_name: "Ada Byron", revision: 2 },
      { ...grace, lifecycle: "removed", revision: 2 },
    ];
    for (const listener of listeners) listener("another-space");
    expect(client.isFetching()).toBe(0);

    await act(async () => {
      for (const listener of listeners) listener(rendererSpaceId());
    });
    await waitFor(() =>
      expect(result.current.data).toMatchObject([
        { id: ada.id, displayName: "Ada Byron", initials: "AB", color, isCurrentMember: true },
        { id: grace.id, displayName: "Grace Hopper", lifecycle: "removed", isCurrentMember: false },
      ]),
    );
  } finally {
    stop?.();
    window.api = previousApi;
  }
});
