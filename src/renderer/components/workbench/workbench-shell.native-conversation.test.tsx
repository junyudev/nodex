import "./workbench-testkit/workbench-shell-harness";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { settleAsyncRender } from "../../test/dom";
import { makeAttachedSession, makeProject } from "./workbench-testkit/workbench-shell-fixtures";
import {
  getConnectedThreadStagePropsByThreadId,
  renderWorkbench,
} from "./workbench-testkit/workbench-shell-harness";

test("keeps settled runtime catalog and controls across Project title updates", async () => {
  const catalog = vi.spyOn(agentRuntimeRuntime, "catalog");
  const control = vi.spyOn(agentRuntimeRuntime, "control");
  const project = makeProject("alpha", "Alpha", "/tmp/alpha");
  const attached = makeAttachedSession({ tabs: [] });
  const session = { ...attached, thread: null };
  const screen = renderWorkbench({
    projects: [project],
    sessionsByProject: { alpha: [session] },
    initialSelectedSessionId: session.id,
  });
  await settleAsyncRender();
  await screen.findByText("Thread:thread-alpha");
  expect(catalog).toHaveBeenCalledWith({ refresh: false });
  const catalogCalls = catalog.mock.calls.length;
  const controlCalls = control.mock.calls.length;
  expect(control).toHaveBeenCalledExactlyOnceWith({
    sessionId: session.id,
    threadId: session.executionRef!.threadId,
  });
  await act(async () => {
    screen.replaceProjects([{ ...project, name: "Updated Alpha" }]);
    await Promise.resolve();
  });
  await settleAsyncRender();
  expect(await screen.findByText("Thread:thread-alpha")).not.toBeNull();
  expect(catalog).toHaveBeenCalledTimes(catalogCalls);
  expect(control).toHaveBeenCalledTimes(controlCalls);
});

test("runtime controls follow the attached Session when switching Projects", async () => {
  const control = vi.spyOn(agentRuntimeRuntime, "control");
  const catalog = vi.spyOn(agentRuntimeRuntime, "catalog");
  const runtimeSession = (projectId: string, title: string) => ({
    ...makeAttachedSession({
      id: `session:${projectId}:native`,
      projectId,
      threadId: `thread-${projectId}`,
      title,
      tabs: [],
    }),
    thread: null,
  });
  const alpha = runtimeSession("alpha", "Alpha native chat");
  const beta = runtimeSession("beta", "Beta native chat");
  const screen = renderWorkbench({
    projects: [
      makeProject("alpha", "Alpha", "/tmp/alpha"),
      makeProject("beta", "Beta", "/tmp/beta"),
    ],
    sessionsByProject: { alpha: [alpha], beta: [beta] },
    initialSelectedSessionId: alpha.id,
    sidebar: { collapsed: false, width: 300 },
  });
  await waitFor(() =>
    expect(control).toHaveBeenCalledWith({ sessionId: alpha.id, threadId: "thread-alpha" }),
  );
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
  await waitFor(() =>
    expect(control).toHaveBeenCalledWith({ sessionId: beta.id, threadId: "thread-beta" }),
  );
  await waitFor(() =>
    expect(getConnectedThreadStagePropsByThreadId("thread-beta")?.projectId).toBe("beta"),
  );
  expect(control.mock.calls.map(([input]) => input)).toEqual([
    { sessionId: alpha.id, threadId: "thread-alpha" },
    { sessionId: beta.id, threadId: "thread-beta" },
  ]);
  expect(catalog).toHaveBeenCalled();
});

test("a native import without an execution reference opens its passive history scene", async () => {
  const control = vi.spyOn(agentRuntimeRuntime, "control");
  const attached = makeAttachedSession({ tabs: [] });
  const session = {
    ...attached,
    executionRef: null,
    thread: {
      ...attached.thread!,
      backendBinding: { kind: "claude" as const, instanceConfigId: "native" },
    },
  };
  const screen = renderWorkbench({
    projects: [makeProject("alpha", "Alpha", "/tmp/alpha")],
    sessionsByProject: { alpha: [session] },
    initialSelectedSessionId: session.id,
  });
  await screen.findByText("Thread:thread-alpha");
  const stage = getConnectedThreadStagePropsByThreadId("thread-alpha");
  expect(stage?.sessionId).toBe(session.id);
  expect(stage?.executionAvailable).toBe(false);
  expect(stage?.isNewThreadTab).toBe(false);
  expect(stage?.activeThreadSummary).toMatchObject({ threadId: session.thread.threadId });
  expect(control).not.toHaveBeenCalled();
});
