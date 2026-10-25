import "./workbench-testkit/workbench-shell-harness";
import { expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { settleAsyncRender } from "@/test/dom";
import type { ThreadStageActions } from "@/features/local-conversation/thread-stage-types";
import { makeProject } from "./workbench-testkit/workbench-shell-fixtures";
import {
  invokeCalls,
  mockInvokeImpl,
  renderWorkbench,
  rendererCommandPayload,
  setMockInvokeImpl,
  waitForLastThreadStageActions,
} from "./workbench-testkit/workbench-shell-harness";

const lastStage = () =>
  (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
    .__lastConnectedThreadStageProps;

test("Open folder focuses an existing Project draft without replacing its content", async () => {
  const project = makeProject("alpha", "Alpha", "/repo/alpha");
  const view = renderWorkbench({ projects: [project], sessionsByProject: { alpha: [] } });
  await settleAsyncRender();
  await act(async () => {
    fireEvent.keyDown(document, { key: "n", metaKey: true, ctrlKey: true });
    await Promise.resolve();
  });
  await waitFor(() => expect(lastStage()?.newThreadTarget).toMatchObject({ projectId: "alpha" }));
  const sessionId = (lastStage()?.newThreadTarget as { sessionId: string }).sessionId;
  expect(lastStage()?.newThreadComposerIntent).toBeNull();
  const prefill = (await waitForLastThreadStageActions()).onStartNewChatWithPrompt as NonNullable<
    ThreadStageActions["onStartNewChatWithPrompt"]
  >;
  await act(async () => {
    await prefill({ projectId: "alpha", prompt: "Keep this draft" });
  });
  await waitFor(() =>
    expect((view.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Keep this draft"),
  );

  const previousInvoke = mockInvokeImpl;
  setMockInvokeImpl(async (channel, ...args) => {
    if (channel === "workspace:pick-directory") return "/repo/alpha";
    if (channel === "projects:list")
      return {
        items: [project],
        nextCursor: null,
        hasMore: false,
        storeEpoch: "test",
        projectionRevision: 1,
      };
    return previousInvoke?.(channel, ...args);
  });
  await act(async () => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    fireEvent.keyDown(window, { key: "o", code: "KeyO", metaKey: isMac, ctrlKey: !isMac });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(lastStage()?.newThreadComposerIntent).toEqual({
      prompt: "",
      attachmentMode: "append",
      focusNonce: expect.any(Number),
    }),
  );
  expect(lastStage()?.newThreadTarget).toMatchObject({ projectId: "alpha", sessionId });
  expect((view.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(invokeCalls.filter(([channel]) => channel === "projects:create")).toHaveLength(0);
  expect(
    invokeCalls.filter(([channel]) => channel === "project-sessions:ensure-default-draft"),
  ).toHaveLength(3);
  expect(
    rendererCommandPayload(
      invokeCalls.find(([channel]) => channel === "project-sessions:ensure-default-draft"),
    )?.projectId,
  ).toBe("alpha");
});
