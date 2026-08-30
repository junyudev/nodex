import "./workbench-testkit/workbench-shell-harness";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { settleAsyncRender } from "../../test/dom";
import {
  makeAttachedSession,
  makeBlankSession,
  makeProject,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  invokeCalls,
  openPanelMenu,
  renderWorkbench,
  rendererCommandPayload,
  startThreadForSessionCalls,
} from "./workbench-testkit/workbench-shell-harness";
import type { ProjectAgentDockPendingWorktreeEntry } from "@/lib/project-agent-dock-model";

function pendingWorktree(
  overrides: Partial<ProjectAgentDockPendingWorktreeEntry> = {},
): ProjectAgentDockPendingWorktreeEntry {
  return {
    launchMode: "start-conversation",
    id: "pending-1",
    hostId: "host-1",
    clientThreadId: "client-1",
    projectSessionId: "session:alpha:pending",
    label: "Worktree task",
    sourceWorkspaceRoot: "/tmp/project",
    localEnvironmentConfigPath: "/tmp/project/.nodex/environment.json",
    prompt: "Start in a worktree",
    startConversationParamsInput:
      {} as ProjectAgentDockPendingWorktreeEntry["startConversationParamsInput"],
    sourceConversationId: null,
    sourceCollaborationMode: null,
    createdAt: 1,
    attempt: 1,
    phase: "setting-up",
    labelEdited: false,
    worktreeOutputText: "",
    setupOutputText: "",
    errorMessage: null,
    worktreeWorkspaceRoot: "/tmp/worktree",
    worktreeGitRoot: "/tmp/worktree",
    needsAttention: false,
    isPinned: false,
    pinnedBeforeThreadId: null,
    ...overrides,
  };
}

describe("workbench session shell / Project Agent Dock", () => {
  test("keeps surface creation in the Project tab strip instead of the Database toolbar", async () => {
    const screen = renderWorkbench({
      projects: [makeProject()],
      sessionsByProject: { alpha: [] },
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryByRole("button", { name: "Ask agent" })).toBeNull();

    const menu = await openPanelMenu(screen, "Open side panel tab");
    expect(within(menu).queryByText("Side chat")).toBeNull();

    await act(async () => {
      fireEvent.click(within(menu).getByText("Canvas"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.getByRole("tab", { name: "Canvas" })).not.toBeNull();
  });

  test("renders New chat immediately for an empty Project without creating a Session", async () => {
    const screen = renderWorkbench({
      projects: [makeProject()],
      sessionsByProject: { alpha: [] },
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.getByLabelText("Connected chat: New chat") !== null).toBe(true);
    expect(screen.getByLabelText("Project Agent Dock prompt") !== null).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "project-sessions:ensure-default-draft")).toBe(
      false,
    );
  });

  test("selects a real chat without leaving the Project and only navigates on Open chat", async () => {
    const session = makeAttachedSession({
      id: "session:alpha:agent-target",
      threadId: "thread-agent-target",
      title: "Agent target",
    });
    const screen = renderWorkbench({
      projects: [makeProject()],
      sessionsByProject: { alpha: [session] },
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Connected chat: New chat"));
      await Promise.resolve();
    });
    const picker = await screen.findByRole("listbox", { name: "Project chats" });
    await act(async () => {
      fireEvent.click(within(picker).getByRole("option", { name: /Agent target/ }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(screen.queryByTestId("project-database-surface") !== null).toBe(true);
    expect(screen.queryByTestId("session-thread-page")).toBe(null);
    expect(screen.getByLabelText("Connected chat: Agent target") !== null).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.queryByTestId("session-thread-page") !== null).toBe(true);
  });

  test("materializes New chat on first send and stays on the Project surface", async () => {
    const screen = renderWorkbench({
      projects: [makeProject()],
      sessionsByProject: { alpha: [] },
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send from Dock" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        invokeCalls.filter((call) => call[0] === "project-sessions:ensure-default-draft"),
      ).toHaveLength(1);
      expect(startThreadForSessionCalls).toHaveLength(1);
    });
    const defaultDraftId = rendererCommandPayload(
      invokeCalls.find(
        (call) =>
          call[0] === "project-sessions:ensure-default-draft" &&
          rendererCommandPayload(call)?.projectId === "alpha",
      ),
    )?.candidateSessionId;
    expect(defaultDraftId).toEqual(expect.any(String));
    expect(startThreadForSessionCalls[0]).toMatchObject({
      projectId: "alpha",
      sessionId: defaultDraftId,
      prompt: "Start from Project Agent Dock",
      browserUsePresentationOrigin: {
        browserConversationId: defaultDraftId,
        browserViewScopeId: "window-session:test",
      },
    });
    expect(invokeCalls).toContainEqual([
      "browser-sidebar-command",
      {
        type: "capture-browser-use-route",
        browserConversationId: defaultDraftId,
        browserViewScopeId: "window-session:test",
        codexSessionId: defaultDraftId,
        projectId: "alpha",
      },
    ]);
    expect(screen.queryByTestId("project-database-surface") !== null).toBe(true);
    expect(screen.queryByTestId("session-thread-page")).toBe(null);
  });

  test("recovers an exact pending worktree from canonical state and blocks another start", async () => {
    const session = makeBlankSession({
      id: "session:alpha:pending",
      displayTitle: "Worktree task",
      noThreadFallbackTitle: "Worktree task",
    });
    const screen = renderWorkbench({
      projects: [makeProject()],
      sessionsByProject: { alpha: [session] },
      pendingWorktrees: [pendingWorktree()],
      initialSelectedSessionId: null,
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Connected chat: New chat"));
      await Promise.resolve();
    });
    const picker = await screen.findByRole("listbox", { name: "Project chats" });
    await act(async () => {
      fireEvent.click(within(picker).getByRole("option", { name: /Worktree task/ }));
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("button", {
        name: "Running setup… View setup details",
      }),
    ).not.toBeNull();
    await waitFor(() => {
      const props = (
        globalThis as {
          __lastConnectedThreadComposerDockProps?: Record<string, unknown>;
        }
      ).__lastConnectedThreadComposerDockProps;
      expect(props?.newThreadStartBlockedReason).toBe("Worktree setup is already in progress");
    });
  });
});
