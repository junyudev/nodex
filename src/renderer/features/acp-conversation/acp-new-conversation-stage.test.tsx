import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import type { AcpBackendRuntime } from "../../lib/acp-backend-runtime";
import { render } from "../../test/dom";
import { AcpNewConversationStage } from "./acp-new-conversation-stage";

it("starts the selected ACP Agent and hands the durable thread identity back to the workbench", async () => {
  const started = {
    thread: {
      sessionId: "session-1",
      projectId: "project-1",
      threadId: "thread-acp-1",
      threadPreview: "",
      backendBinding: {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "instance-1",
      },
      executionHostId: "local",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      linkedAt: "2026-09-02T00:00:00.000Z",
    },
    presentation: {
      snapshot: {
        backend: "acp",
        threadId: "thread-acp-1",
        sessionId: "acp-session-1",
        status: "idle",
        error: null,
        turns: [],
        revision: 1,
      },
      capabilities: {
        prompt: {
          text: true,
          resourceLink: true,
          image: false,
          audio: false,
          embeddedContext: false,
        },
        session: {
          load: true,
          list: false,
          delete: false,
          resume: false,
          unstableFork: false,
          close: false,
          additionalDirectories: false,
        },
        authMethods: [],
      },
      modes: null,
      configOptions: [],
    },
  } satisfies Awaited<ReturnType<AcpBackendRuntime["startThread"]>>;
  const startThread = vi.fn<Pick<AcpBackendRuntime, "startThread">["startThread"]>();
  startThread.mockResolvedValue(started);
  const onStarted = vi.fn(async () => undefined);
  const view = render(
    <AcpNewConversationStage
      sessionId="session-1"
      instanceConfigId="instance-1"
      agentLabel="Claude Agent"
      projectName="Nodex"
      onStarted={onStarted}
      runtime={{ startThread }}
    />,
  );

  const composer = view.getByRole("textbox", { name: "Message Claude Agent" });
  await act(async () => {
    fireEvent.change(composer, { target: { value: "  Inspect this workspace.  " } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await Promise.resolve();
  });

  await waitFor(() =>
    expect(startThread).toHaveBeenCalledWith({
      sessionId: "session-1",
      instanceConfigId: "instance-1",
      prompt: "Inspect this workspace.",
    }),
  );
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("thread-acp-1"));
});
