import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import type {
  AcpBackendSessionPresentation,
  AcpConversationDelta,
} from "../../../shared/acp-conversation";
import type { AcpBackendRuntime } from "../../lib/acp-backend-runtime";
import { render, settleAsyncRender } from "../../test/dom";
import { AcpConversationOwner } from "./acp-conversation-owner";
import { AcpConversationStageView } from "./acp-conversation-stage";

vi.mock("../local-conversation/view/shared/markdown/budgeted-markdown-renderer", () => ({
  BudgetedMarkdownRenderer: ({ content }: { readonly content: string }) => <div>{content}</div>,
}));

const buildPresentation = (
  revision = 1,
  status: AcpBackendSessionPresentation["snapshot"]["status"] = "idle",
): AcpBackendSessionPresentation => ({
  snapshot: {
    backend: "acp",
    threadId: "thread-1",
    sessionId: "acp-session-1",
    status,
    error: null,
    revision,
    turns: [
      {
        sequence: 1,
        promptText: "Inspect the current workspace.",
        stopReason: status === "idle" ? "end_turn" : null,
        updates: [
          {
            kind: "message",
            key: "message:agent:1",
            role: "agent",
            messageId: "message-1",
            text: "The workspace is ready.",
          },
          {
            kind: "tool-call",
            key: "tool:1",
            toolCallId: "tool-1",
            title: "Read project files",
            name: "read",
            toolKind: "read",
            status: "completed",
            detail: "3 files read",
            locations: ["/tmp/project"],
          },
        ],
      },
    ],
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
      close: true,
      additionalDirectories: false,
    },
    authMethods: [],
  },
  modes: null,
  configOptions: [
    {
      id: "extended-thinking",
      name: "Extended thinking",
      description: null,
      category: null,
      type: "boolean",
      currentValue: false,
    },
  ],
});

const createRuntime = () => {
  let listener:
    | ((event: { readonly threadId: string; readonly delta: AcpConversationDelta }) => void)
    | null = null;
  const runtime: AcpBackendRuntime = {
    startThread: vi.fn(async () => {
      throw new Error("not used by an attached conversation owner");
    }),
    open: vi.fn(async () => buildPresentation()),
    read: vi.fn(async () => buildPresentation()),
    prompt: vi.fn(async () => ({
      stopReason: "end_turn",
      snapshot: buildPresentation(3).snapshot,
    })),
    cancel: vi.fn(async () => buildPresentation(3).snapshot),
    setMode: vi.fn(async () => buildPresentation(3).snapshot),
    setConfigOption: vi.fn(async () => ({
      configOptions: [
        {
          id: "extended-thinking",
          name: "Extended thinking",
          description: null,
          category: null,
          type: "boolean" as const,
          currentValue: true,
        },
      ],
      snapshot: buildPresentation(3).snapshot,
    })),
    authenticate: vi.fn(async () => ({ snapshot: buildPresentation(3).snapshot })),
    close: vi.fn(async () => undefined),
    subscribe: vi.fn(async (_threadId, callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }),
  };
  return {
    runtime,
    publish: (baseRevision: number, revision: number, status: AcpConversationDelta["status"]) =>
      listener?.({
        threadId: "thread-1",
        delta: {
          backend: "acp",
          threadId: "thread-1",
          sessionId: "acp-session-1",
          baseRevision,
          revision,
          status,
          error: null,
          removedTurnSequences: [],
          turns: [],
        },
      }),
  };
};

it("opens, reads, and renders the canonical transcript before submitting a prompt", async () => {
  const { runtime } = createRuntime();
  const owner = new AcpConversationOwner("thread-1", runtime);
  const view = render(<AcpConversationStageView agentLabel="Claude" owner={owner} />);
  await settleAsyncRender();

  expect(runtime.open).toHaveBeenCalledWith({ threadId: "thread-1" });
  expect(runtime.read).toHaveBeenCalledWith("thread-1");
  expect(view.getByText("Inspect the current workspace.")).toBeTruthy();
  expect(view.getByText("The workspace is ready.")).toBeTruthy();
  expect(view.getByText("Read project files")).toBeTruthy();
  expect(view.getByLabelText("Agent capabilities").textContent).toBe("Text · Links · History");

  const composer = view.getByRole("textbox", { name: "Message Claude" });
  await act(async () => {
    fireEvent.change(composer, { target: { value: "Continue with the audit" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(runtime.prompt).toHaveBeenCalledWith({
      threadId: "thread-1",
      prompt: "Continue with the audit",
    }),
  );
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
});

it("keeps cancel and negotiated boolean configuration wired to the session owner", async () => {
  const { runtime, publish } = createRuntime();
  const owner = new AcpConversationOwner("thread-1", runtime);
  const view = render(<AcpConversationStageView agentLabel="Claude" owner={owner} />);
  await settleAsyncRender();

  await act(async () => {
    fireEvent.click(view.getByRole("switch", { name: "Extended thinking" }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(runtime.setConfigOption).toHaveBeenCalledWith({
      threadId: "thread-1",
      configId: "extended-thinking",
      value: true,
    }),
  );

  await act(async () => {
    publish(3, 4, "running");
    await Promise.resolve();
  });
  const stop = view.getByRole("button", { name: "Stop Agent" });
  await act(async () => {
    fireEvent.click(stop);
    await Promise.resolve();
  });
  await waitFor(() => expect(runtime.cancel).toHaveBeenCalledWith("thread-1"));
});

it("renders negotiated authentication as a recoverable session phase", async () => {
  const { runtime } = createRuntime();
  const initial = buildPresentation(1, "authentication-required");
  const authPresentation: AcpBackendSessionPresentation = {
    ...initial,
    capabilities: {
      ...initial.capabilities,
      authMethods: [
        {
          id: "claude-account",
          name: "Claude account",
          description: null,
          kind: "agent",
        },
      ],
    },
  };
  vi.mocked(runtime.open).mockResolvedValue(authPresentation);
  vi.mocked(runtime.read).mockResolvedValue(authPresentation);
  const owner = new AcpConversationOwner("thread-1", runtime);
  const view = render(<AcpConversationStageView agentLabel="Claude" owner={owner} />);
  await settleAsyncRender();

  expect(view.getByRole("status").textContent).toBe("Authentication required");
  expect(
    (view.getByRole("textbox", { name: "Message Claude" }) as HTMLTextAreaElement).disabled,
  ).toBe(true);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Claude account" }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(runtime.authenticate).toHaveBeenCalledWith({
      threadId: "thread-1",
      methodId: "claude-account",
    }),
  );
});

it("lets an attached failed session reopen its durable protocol identity", async () => {
  const { runtime, publish } = createRuntime();
  const owner = new AcpConversationOwner("thread-1", runtime);
  const view = render(<AcpConversationStageView agentLabel="Claude" owner={owner} />);
  await settleAsyncRender();

  await act(async () => {
    publish(1, 2, "failed");
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await Promise.resolve();
  });

  await waitFor(() => expect(runtime.open).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.getByRole("status").textContent).toBe("Ready"));
});
