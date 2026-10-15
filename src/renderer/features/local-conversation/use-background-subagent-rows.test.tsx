import { act, render, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { expect, test, vi } from "vite-plus/test";
import { projectAgentConversation } from "../../../shared/agent-conversation-presentation";
import type {
  CodexConversationChildMembership,
  CodexConversationSnapshot,
  CodexThreadSummary,
} from "../../../shared/types";
import { ConversationRuntimeContext, type ConversationRuntime } from "./conversation-runtime";
import { useBackgroundSubagentRows } from "./use-background-subagent-rows";
import { LocalConversationTestQueryProvider } from "./view/local-conversation-test-query.test-fixtures";

const mocks = vi.hoisted(() => ({
  readOverview: vi.fn(async () => ({ rows: [] })),
  subscribeEvents: vi.fn(() => () => {}),
}));
vi.mock("./local-conversation-store", () => ({
  useCodexAppServerManagerForConversationId: () => ({
    getHostId: () => "local",
    readSubagentOverview: mocks.readOverview,
  }),
}));
vi.mock("@/lib/api", () => ({ subscribeCodexEvents: mocks.subscribeEvents }));

const summary: CodexThreadSummary = {
  threadId: "parent",
  projectId: "project",
  source: null,
  threadName: "Work",
  threadPreview: "",
  cwd: "/workspace",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  linkedAt: "2026-09-30T00:00:00Z",
};

function conversation(threadId: string, text: string, active = false) {
  return projectAgentConversation(
    {
      snapshot: {
        backend: "claude",
        sessionId: "native",
        threadId,
        revision: active ? 1 : 2,
        status: active ? "running" : "idle",
        error: null,
        turns: [
          {
            sequence: 1,
            clientUserMessageId: "prompt",
            promptText: null,
            stopReason: active ? null : "end_turn",
            updates: [{ kind: "message", key: "reply", role: "agent", messageId: "reply", text }],
          },
        ],
      },
      configOptions: [],
      modes: null,
      capabilities: {
        prompt: {
          text: true,
          image: true,
          audio: false,
          resourceLink: true,
          embeddedContext: false,
        },
        session: {
          load: true,
          list: false,
          delete: false,
          resume: true,
          unstableFork: false,
          close: true,
          additionalDirectories: false,
        },
        authMethods: [],
      },
    },
    { ...summary, threadId },
  );
}

function fixture(kind: ConversationRuntime["kind"] = "claude") {
  const childId = "agent-task:parent:review";
  const membership: CodexConversationChildMembership = {
    threadId: childId,
    parentThreadId: "parent",
    role: "backgroundChild",
    displayName: "Review",
    statusType: "idle",
  };
  let memberships: readonly CodexConversationChildMembership[] = [
    membership,
    {
      ...membership,
      threadId: "agent-task:parent:hidden",
      task: {
        id: "hidden",
        description: "Hidden",
        bornTurnSequence: 1,
        status: "running",
        hidden: true,
      },
    },
  ];
  const observations = new Map<string, CodexConversationSnapshot>([
    ["parent", conversation("parent", "Parent")],
    [childId, conversation(childId, "Review started", true)],
  ]);
  const listeners = new Map<string | null, Set<() => void>>();
  const children = vi.fn(() => memberships);
  const read = vi.fn((id: string | null) => (id ? (observations.get(id) ?? null) : null));
  const runtime: ConversationRuntime = {
    kind,
    hostId: "local",
    read,
    children,
    subscribe: (id, listener) => {
      const bucket = listeners.get(id) ?? new Set();
      bucket.add(listener);
      listeners.set(id, bucket);
      return () => bucket.delete(listener);
    },
    retain: () => () => {},
    resume: vi.fn(async () => {}),
    role: () => "follower",
    attachment: () => ({ status: "attached" }),
    connection: () => ({ status: "connected", retries: 0 }),
    primaryRequest: () => null,
    markRead: async () => {},
    setPresented: async () => {},
  };
  const emit = (id: string) => {
    for (const listener of listeners.get(id) ?? []) listener();
  };
  return {
    runtime,
    childId,
    membership,
    listeners,
    read,
    children,
    emit,
    updateChild: (text: string, active: boolean) => {
      observations.set(childId, conversation(childId, text, active));
      emit(childId);
    },
    removeChild: () => {
      memberships = [];
      emit("parent");
    },
  };
}

function Probe({ onRows }: { readonly onRows: () => void }) {
  const rows = useBackgroundSubagentRows("parent");
  useEffect(onRows, [onRows, rows]);
  return (
    <ul>
      {rows.map((row) => (
        <li key={row.conversationId}>
          <output aria-label="Task status">{row.status}</output>
          <output aria-label="Task reply">{row.lastAssistantMessage}</output>
        </li>
      ))}
    </ul>
  );
}

function mount(runtime: ConversationRuntime, onRows = vi.fn()) {
  return render(
    <StrictMode>
      <LocalConversationTestQueryProvider>
        <ConversationRuntimeContext value={runtime}>
          <Probe onRows={onRows} />
        </ConversationRuntimeContext>
      </LocalConversationTestQueryProvider>
    </StrictMode>,
  );
}

test("background tasks observe child-only publications with stable parent and membership values", async () => {
  mocks.readOverview.mockClear();
  mocks.subscribeEvents.mockClear();
  const source = fixture();
  const parent = source.runtime.read("parent");
  const memberships = source.runtime.children("parent");
  const onRows = vi.fn();
  const view = mount(source.runtime, onRows);
  expect(view.getByLabelText("Task status").textContent).toBe("active");
  expect(view.getByLabelText("Task reply").textContent).toBe("Review started");
  await act(async () => {
    source.updateChild("Review complete", false);
  });
  await waitFor(() =>
    expect(view.getByLabelText("Task reply").textContent).toBe("Review complete"),
  );
  expect(view.getByLabelText("Task status").textContent).toBe("done");
  expect(source.runtime.read("parent")).toBe(parent);
  expect(source.runtime.children("parent")).toBe(memberships);
  expect(source.runtime.children("parent")[0]).toBe(source.membership);
  onRows.mockClear();
  await act(async () => source.emit("parent"));
  expect(onRows).not.toHaveBeenCalled();
  expect(mocks.readOverview).not.toHaveBeenCalled();
  expect(mocks.subscribeEvents).not.toHaveBeenCalled();
  view.unmount();
});

test("background observation subscriptions release removed children and fence late callbacks", async () => {
  const source = fixture();
  const view = mount(source.runtime);
  expect(source.listeners.get("parent")?.size).toBe(1);
  expect(source.listeners.get(source.childId)?.size).toBe(1);
  expect(source.listeners.get("agent-task:parent:hidden")?.size ?? 0).toBe(0);
  expect(source.read.mock.calls.some(([id]) => id === "agent-task:parent:hidden")).toBe(false);
  const childListener = [...(source.listeners.get(source.childId) ?? [])][0];
  await act(async () => source.removeChild());
  expect(view.queryByLabelText("Task reply")).toBeNull();
  expect(source.listeners.get(source.childId)?.size).toBe(0);
  source.read.mockClear();
  source.children.mockClear();
  await act(async () => childListener());
  expect(source.read).not.toHaveBeenCalled();
  expect(source.children).not.toHaveBeenCalled();
  const parentListener = [...(source.listeners.get("parent") ?? [])][0];
  view.unmount();
  expect(source.listeners.get("parent")?.size).toBe(0);
  source.read.mockClear();
  source.children.mockClear();
  parentListener();
  expect(source.read).not.toHaveBeenCalled();
  expect(source.children).not.toHaveBeenCalled();
});

test("Codex background rows retain the host overview query without native observation subscriptions", async () => {
  mocks.readOverview.mockClear();
  mocks.subscribeEvents.mockClear();
  const source = fixture("codex");
  const view = mount(source.runtime);
  await waitFor(() =>
    expect(mocks.readOverview).toHaveBeenCalledExactlyOnceWith({
      rootThreadId: "parent",
      mode: "expanded",
    }),
  );
  expect(source.read).not.toHaveBeenCalled();
  expect(source.children).not.toHaveBeenCalled();
  expect(
    [...source.listeners.values()].reduce((count, listeners) => count + listeners.size, 0),
  ).toBe(0);
  view.unmount();
});

test("app-owned Codex children use runtime observations without opening the legacy overview", async () => {
  mocks.readOverview.mockClear();
  mocks.subscribeEvents.mockClear();
  const source = fixture("codex");
  const view = mount({ ...source.runtime, sessionId: "root-session" });
  await waitFor(() => expect(view.getByLabelText("Task reply").textContent).toBe("Review started"));
  expect(mocks.readOverview).not.toHaveBeenCalled();
  expect(mocks.subscribeEvents).not.toHaveBeenCalled();
  await act(async () => source.updateChild("Review complete", false));
  await waitFor(() => expect(view.getByLabelText("Task status").textContent).toBe("done"));
  view.unmount();
  expect(source.listeners.get("parent")?.size).toBe(0);
  expect(source.listeners.get(source.childId)?.size).toBe(0);
});
