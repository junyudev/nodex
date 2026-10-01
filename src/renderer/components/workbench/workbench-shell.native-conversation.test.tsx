import "./workbench-testkit/workbench-shell-harness";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { agentBackendRuntime } from "@/lib/agent-backend-runtime";
import { settleAsyncRender } from "../../test/dom";
import { makeAttachedSession, makeProject } from "./workbench-testkit/workbench-shell-fixtures";
import { renderWorkbench } from "./workbench-testkit/workbench-shell-harness";

test("native discovery and permission reads follow the attached chat when switching Projects", async () => {
  const discovery = vi.spyOn(agentBackendRuntime, "claudeDiscovery").mockResolvedValue({
    models: [],
    intelligence: { model: null, effort: null, fast: null, thinking: null },
    commands: [],
    skills: [],
    health: { status: "unknown", executable: null, version: null, account: null, error: null },
    revision: "test",
  });
  const permission = vi.spyOn(agentBackendRuntime, "readPermissionMode").mockResolvedValue("auto");
  vi.spyOn(agentBackendRuntime, "subscribe").mockResolvedValue(() => {});
  vi.spyOn(agentBackendRuntime, "open").mockRejectedValue(new Error("Test backend unavailable"));
  const nativeSession = (projectId: string, title: string) => {
    const session = makeAttachedSession({
      id: `session:${projectId}:native`,
      projectId,
      threadId: `thread-${projectId}`,
      title,
      tabs: [],
    });
    if (!session.thread) throw new Error("Expected an attached native Session");
    return {
      ...session,
      thread: {
        ...session.thread,
        backendBinding: { kind: "claude" as const, instanceConfigId: "work" },
      },
    };
  };
  const alpha = nativeSession("alpha", "Alpha native chat");
  const beta = nativeSession("beta", "Beta native chat");
  const screen = renderWorkbench({
    projects: [
      makeProject("alpha", "Alpha", "/tmp/alpha"),
      makeProject("beta", "Beta", "/tmp/beta"),
    ],
    sessionsByProject: { alpha: [alpha], beta: [beta] },
    initialSelectedSessionId: alpha.id,
    sidebar: { collapsed: false, width: 300 },
  });
  await waitFor(() => {
    expect(discovery).toHaveBeenCalledWith(
      { scope: { kind: "thread", threadId: "thread-alpha" } },
      expect.any(AbortSignal),
    );
    expect(permission).toHaveBeenCalledWith("alpha");
  });
  const betaRow = screen.container.querySelector('[data-app-action-sidebar-project-id="beta"]');
  if (!(betaRow instanceof HTMLElement)) throw new Error("Expected the Beta Project row");
  await act(async () => {
    fireEvent.click(within(betaRow).getByRole("button", { name: "Expand project" }));
    await Promise.resolve();
  });
  const betaChat = await screen.findByText("Beta native chat");
  await act(async () => {
    fireEvent.click(betaChat);
    await Promise.resolve();
  });
  await settleAsyncRender();
  await waitFor(() => {
    expect(discovery).toHaveBeenCalledWith(
      { scope: { kind: "thread", threadId: "thread-beta" } },
      expect.any(AbortSignal),
    );
    expect(permission).toHaveBeenCalledWith("beta");
  });
});
