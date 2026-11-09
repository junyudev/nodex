import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeAll, expect, test, vi } from "vite-plus/test";
import { memberEditCapabilities } from "../features/local-conversation/agent-runtime-conversation-owner";
import { installWindowApi } from "../test/browser-globals";
import { invalidateProjectSessionScope } from "./project-session-query-cache";
import { queryKeys } from "./query-keys";
import { hostedChatMemberActionsQueryOptions } from "./query-options";
import { bindRendererSpace } from "./renderer-space";
import { useRunStopCapabilities } from "./use-chat-capabilities";

beforeAll(() => {
  bindRendererSpace({
    spaceId: "team",
    kind: "team",
    memberId: "bob",
    deviceId: "desktop",
    name: "Crew",
    availability: "ready",
  });
});

/** The messages the adapter offers to edit, by their Runs: none until Core has said. */
function useEditableRuns(sessionId: string, runIds: readonly string[]) {
  const { data } = useQuery(hostedChatMemberActionsQueryOptions(sessionId, runIds));
  return data
    ? memberEditCapabilities(
        runIds,
        new Map(data.runs.map(({ run_id, edit }) => [run_id, edit] as const)),
      ).editableUserTurnIds
    : [];
}

test("a new hosted chat offers Edit and Stop once Core attributes its first Run", async () => {
  // Bob's first Run is visible before the host binds its opening message to him.
  let attributed = false;
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel === "project-sessions:get") return { id: "chat", canManage: false, canStop: false };
    if (channel !== "agent-runtime:session:member-actions") throw new Error(channel);
    const { runIds } = input as { readonly runIds: readonly string[] };
    return {
      runs: runIds.map((run_id) => ({
        run_id,
        edit: attributed ? "available" : "unavailable",
        can_stop: attributed,
      })),
    };
  });
  installWindowApi({ invoke, on: () => () => undefined });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(
    () => ({
      editable: useEditableRuns("chat", ["run-1"]),
      canStop: useRunStopCapabilities("chat", ["run-1"])("run-1"),
    }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const other = renderHook(() => useEditableRuns("other", ["run-9"]), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    await waitFor(() =>
      expect(client.getQueryData(queryKeys.agentRuntime.memberActions("chat", ["run-1"]))).toEqual({
        runs: [{ run_id: "run-1", edit: "unavailable", can_stop: false }],
      }),
    );
    expect(view.result.current).toEqual({ editable: [], canStop: false });
    const otherReads = () =>
      invoke.mock.calls.filter(
        ([channel, input]) =>
          channel === "agent-runtime:session:member-actions" &&
          (input as { readonly sessionId: string }).sessionId === "other",
      ).length;
    await waitFor(() => expect(otherReads()).toBe(1));

    // The host records the Run's requester, then reports the chat changed as the Run moves on.
    attributed = true;
    await act(async () => {
      await invalidateProjectSessionScope(client, {
        summaryScopes: [],
        detailInvalidation: { kind: "sessions", sessionIds: ["chat"] },
        changeType: "update",
      });
    });
    await waitFor(() =>
      expect(view.result.current).toEqual({ editable: ["run-1"], canStop: true }),
    );
    // Another chat's answer stands until its own chat changes.
    expect(otherReads()).toBe(1);
    expect(other.result.current).toEqual([]);
  } finally {
    view.unmount();
    other.unmount();
    client.clear();
  }
});
