import { act, renderHook, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { useRemoteHostedPipSummaryControl } from "@/features/local-conversation/view/use-remote-hosted-pip-summary-control";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import { bindRendererSpace } from "./renderer-space";
import {
  codexComposerSkillsListQueryOptions,
  gitRepositoryIdentityQueryOptions,
  localPathPresentationContextQueryOptions,
  projectSessionDetailQueryOptions,
} from "./query-options";
import { useClaudeUsage } from "./use-claude-usage";
import { useMcpServerStatuses } from "./use-mcp-queries";
import { useSidebarThreadSyncModel } from "./use-sidebar-thread-sync-model";
import { searchChatMessages, searchChats } from "./chat-search";

// The desktop's own Agents, accounts and native chats, which a team window never reads.
const DESKTOP_EXECUTION = [
  "codex:sidebar:snapshot",
  "codex:sidebar:sync",
  "codex:pending-worktrees:list",
  "codex:composer-skills:list",
  "codex:mcp-server-statuses:list",
  "shell:path-context:get",
  "agent-runtime:claude-usage:read",
  "remote-hosted-pip:snapshot",
  "git:repository:identity",
];

let calls: string[] = [];

beforeAll(() => {
  bindRendererSpace({
    spaceId: "team",
    kind: "team",
    memberId: "alice",
    deviceId: "desktop",
    name: "Crew",
    availability: "ready",
  });
});

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installWindowApi({
    invoke: vi.fn(async (channel: string) => {
      calls.push(channel);
      return null;
    }),
    on: () => () => undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "api");
});

const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <TestQueryProvider>{children}</TestQueryProvider>
);

describe("a team Space window", () => {
  test("never asks its host for this desktop's own Agents, accounts or native chats", async () => {
    renderHook(
      () => {
        useSidebarThreadSyncModel({ projects: [] });
        useClaudeUsage();
        useMcpServerStatuses();
        useQuery(codexComposerSkillsListQueryOptions(["/srv/repo"]));
        useQuery(localPathPresentationContextQueryOptions());
        useQuery(gitRepositoryIdentityQueryOptions("/srv/repo"));
        useRemoteHostedPipSummaryControl("thread");
        // Content the Space serves is still read, through the same transport.
        useQuery(projectSessionDetailQueryOptions("session"));
      },
      { wrapper },
    );
    await waitFor(() => expect(calls).toContain("project-sessions:get"));
    // Past the native sync's mount delay and its heartbeat.
    await act(async () => {
      vi.advanceTimersByTime(61_000);
      await Promise.resolve();
    });
    expect(calls.filter((channel) => DESKTOP_EXECUTION.includes(channel))).toEqual([]);
  });

  test("refreshes its sidebar after archiving or restoring a chat without a native sync", async () => {
    const { result } = renderHook(() => useSidebarThreadSyncModel({ projects: [] }), { wrapper });
    // Archive, its undo and the sidebar's other actions all refresh through this one owner.
    await act(async () => {
      await result.current.refresh();
    });
    expect(calls.filter((channel) => DESKTOP_EXECUTION.includes(channel))).toEqual([]);
  });

  test("searches its chats through its Space, whose host reads them for the Member", async () => {
    installWindowApi({
      invoke: vi.fn(async (channel: string) => {
        calls.push(channel);
        return channel === "chats:search"
          ? { matches: [], complete: true }
          : { matches: [], sources: [{ source: "runtime", state: "complete" }] };
      }),
      on: () => () => undefined,
    });
    await searchChats({ query: "launch", limit: 5 });
    await searchChatMessages({ query: "launch", limit: 5 });
    expect(calls).toEqual(["chats:search", "chats:search-messages"]);
  });

  test("has no Claude usage, even while this desktop publishes its own", async () => {
    const subscribed: string[] = [];
    installWindowApi({
      invoke: vi.fn(async (channel: string) => {
        calls.push(channel);
        return null;
      }),
      on: (event: string, callback: (...args: unknown[]) => void) => {
        subscribed.push(event);
        callback({ status: "loading", providers: null });
        return () => undefined;
      },
    });
    const { result } = renderHook(() => useClaudeUsage(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    // The rail draws no Claude usage, not even a passing placeholder, in a team window.
    expect(result.current).toBeNull();
    expect(subscribed).not.toContain("agent-runtime:claude-usage-changed");
    expect(calls).toEqual([]);
  });
});
