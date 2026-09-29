import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { renderWithMaitai } from "@/test/thread-maitai";
import { renderWithAppMaitai } from "@/test/app-maitai";
import {
  appScope,
  getMaitaiDebugSnapshot,
  scopedAtom,
  useMaitaiStore,
  useScopeHandle,
  useScopedAtomValue,
  type MaitaiStore,
} from "@/lib/maitai";
import {
  ThreadScope,
  WorkbenchSessionScopePath,
  type ThreadScopeDescriptor,
} from "@/lib/workbench-ui-scopes";
import { NodexModalHost, openModal } from "@/lib/modal-registry";
import { projectAgentConversation } from "../../../../shared/agent-conversation-presentation";
import type {
  CodexConversationChildMembership,
  CodexThreadSummary,
} from "../../../../shared/types";
import type { ConversationRuntime } from "../conversation-runtime";
import { ConversationTaskDialog } from "./conversation-task-dialog";

const parentThreadScope: ThreadScopeDescriptor = {
  stableKey: "session:task-owner",
  phase: "attached",
  projectSessionId: "task-owner",
  clientThreadId: null,
  threadId: "parent",
};
const ownerState = scopedAtom(ThreadScope, "", { debugLabel: "task-dialog-test-owner" });

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
const conversation = (threadId: string, revision: number) =>
  projectAgentConversation(
    {
      snapshot: {
        backend: "claude",
        sessionId: "native",
        threadId,
        revision,
        status: "idle",
        error: null,
        turns: [],
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

const fixture = () => {
  let parent = conversation("parent", 1);
  let rows: CodexConversationChildMembership[] = [
    {
      threadId: "agent-task:parent:watch",
      parentThreadId: "parent",
      role: "backgroundChild",
      displayName: "Watch build",
      statusType: "active",
      task: {
        id: "watch",
        description: "Watch build",
        bornTurnSequence: 1,
        status: "running",
        ambient: true,
        hidden: true,
        backgrounded: true,
      },
    },
    {
      threadId: "agent-task:parent:review",
      parentThreadId: "parent",
      role: "backgroundChild",
      displayName: "Review",
      statusType: "idle",
      task: { id: "review", description: "Review", bornTurnSequence: 1, status: "completed" },
    },
  ];
  const listeners = new Set<() => void>();
  const resume = vi.fn(async () => {});
  const runtime: ConversationRuntime = {
    kind: "claude",
    hostId: "local",
    read: (id) => (id === "parent" ? parent : conversation(id ?? "", 1)),
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    children: () => rows,
    resume,
    retain: () => () => {},
    role: () => "follower",
    attachment: () => ({ status: "attached" }),
    connection: () => ({ status: "connected", retries: 0 }),
    primaryRequest: () => null,
    markRead: async () => {},
    setPresented: async () => {},
  };
  return {
    runtime,
    resume,
    finish: () => {
      rows = rows.map((row) => ({ ...row, statusType: "idle" }));
      parent = conversation("parent", 2);
      listeners.forEach((listener) => listener());
    },
    clear: () => {
      rows = [];
      parent = conversation("parent", 3);
      listeners.forEach((listener) => listener());
    },
  };
};

test("native task details select read-only observations and stop the exact live ambient task", async () => {
  const source = fixture();
  const stopTask = vi.fn(async () => {});
  function Dialog() {
    const parentHandle = useScopeHandle(ThreadScope);
    const [open, setOpen] = useState(false);
    if (!open)
      return (
        <button type="button" onClick={() => setOpen(true)}>
          Open tasks
        </button>
      );
    return (
      <ConversationTaskDialog
        runtime={source.runtime}
        parentThreadId="parent"
        parentThreadScope={parentHandle}
        renderDetail={(child) => <output aria-label="Task detail">{child.threadId}</output>}
        stopTask={stopTask}
        onClose={() => {}}
      />
    );
  }
  const view = renderWithMaitai(<Dialog />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Open tasks" }));
    await Promise.resolve();
  });
  expect(view.getByLabelText("Task detail").textContent).toBe("agent-task:parent:watch");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Stop Watch build" }));
    await Promise.resolve();
  });
  expect(stopTask).toHaveBeenCalledExactlyOnceWith("watch");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Review, Completed" }));
    await Promise.resolve();
  });
  expect(view.getByLabelText("Task detail").textContent).toBe("agent-task:parent:review");
  expect(source.resume).not.toHaveBeenCalled();
  await act(async () => {
    source.finish();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(view.queryByRole("button", { name: "Stop Watch build" })).toBeNull();
  });
});

test("the registered task dialog survives its trigger unmount and Escape dismisses it", async () => {
  const source = fixture();
  let ownerPath: string | null = null;
  let ownerStore: MaitaiStore | null = null;
  function ScopedDetail({ threadId }: { readonly threadId: string }) {
    const scope = useScopeHandle(ThreadScope);
    const value = useScopedAtomValue(ownerState);
    return (
      <>
        <output aria-label="Task owner">{value}</output>
        <output aria-label="Task owner path">{scope.path}</output>
        <output aria-label="Task detail">{threadId}</output>
      </>
    );
  }
  function Trigger({ onOpen }: { readonly onOpen: () => void }) {
    const handle = useScopeHandle(appScope);
    const threadHandle = useScopeHandle(ThreadScope);
    ownerStore = useMaitaiStore();
    return (
      <button
        type="button"
        onClick={() => {
          ownerPath = threadHandle.path;
          threadHandle.set(ownerState, "parent ownership");
          openModal(handle, ConversationTaskDialog, {
            runtime: source.runtime,
            parentThreadId: "parent",
            parentThreadScope: threadHandle,
            renderDetail: (child) => <ScopedDetail threadId={child.threadId} />,
          });
          onOpen();
        }}
      >
        Open tasks
      </button>
    );
  }
  function App() {
    const [visible, setVisible] = useState(true);
    return (
      <>
        {visible ? (
          <WorkbenchSessionScopePath
            thread={parentThreadScope}
            route={{ routeKey: "/task-owner", kind: "thread" }}
            selected={false}
          >
            <Trigger onOpen={() => setVisible(false)} />
          </WorkbenchSessionScopePath>
        ) : null}
        <NodexModalHost />
      </>
    );
  }
  const view = renderWithAppMaitai(<App />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Open tasks" }));
    await Promise.resolve();
  });
  expect(view.queryByRole("button", { name: "Open tasks" })).toBeNull();
  const dialog = await view.findByRole("dialog", { name: "Tasks" });
  expect(view.getByLabelText("Task owner").textContent).toBe("parent ownership");
  expect(view.getByLabelText("Task owner path").textContent).toBe(ownerPath);
  expect(view.getByLabelText("Task detail").textContent).toBe("agent-task:parent:watch");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Review, Completed" }));
    await Promise.resolve();
  });
  expect(view.getByLabelText("Task detail").textContent).toBe("agent-task:parent:review");
  expect(view.getByLabelText("Task owner path").textContent).toBe(ownerPath);
  expect(source.resume).not.toHaveBeenCalled();
  await act(async () => {
    source.clear();
    await Promise.resolve();
  });
  expect(view.getByText("No tasks")).toBeTruthy();
  const store = ownerStore as MaitaiStore | null;
  if (!store) throw new Error("Expected owner store");
  expect(getMaitaiDebugSnapshot(store).find((entry) => entry.path === ownerPath)?.eligible).toBe(
    false,
  );
  await act(async () => {
    fireEvent.keyDown(dialog, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(view.queryByRole("dialog", { name: "Tasks" })).toBeNull();
  });
  expect(getMaitaiDebugSnapshot(store).find((entry) => entry.path === ownerPath)?.eligible).toBe(
    true,
  );
});
