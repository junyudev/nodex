import { expect, it, vi } from "vite-plus/test";
import type { AcpBackendSessionPresentation } from "../../../shared/agent-backend-api";
import type {
  AcpConversationDelta,
  AcpConversationSnapshot,
} from "../../../shared/acp-conversation";
import type { AcpBackendRuntime } from "../../lib/acp-backend-runtime";
import { AcpConversationOwner } from "./acp-conversation-owner";

const snapshot = (
  revision: number,
  status: AcpConversationSnapshot["status"] = "idle",
): AcpConversationSnapshot => ({
  backend: "acp",
  threadId: "thread-1",
  sessionId: "session-1",
  status,
  error: null,
  turns: [],
  revision,
});

const presentation = (revision: number): AcpBackendSessionPresentation => ({
  snapshot: snapshot(revision),
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
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default", description: null },
      { id: "plan", name: "Plan", description: null },
    ],
  },
  configOptions: [],
});

const delta = (
  baseRevision: number,
  revision: number,
  status: AcpConversationSnapshot["status"] = "idle",
): AcpConversationDelta => ({
  backend: "acp",
  threadId: "thread-1",
  sessionId: "session-1",
  baseRevision,
  revision,
  status,
  error: null,
  removedTurnSequences: [],
  turns: [],
});

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

const createRuntime = () => {
  let publish: ((event: { threadId: string; delta: AcpConversationDelta }) => void) | null = null;
  const runtime: AcpBackendRuntime = {
    startThread: vi.fn(async () => {
      throw new Error("not used by an attached conversation owner");
    }),
    open: vi.fn(async () => presentation(1)),
    read: vi.fn(async () => presentation(2)),
    prompt: vi.fn(async () => ({ stopReason: "end_turn", snapshot: snapshot(5) })),
    cancel: vi.fn(async () => snapshot(4, "running")),
    setMode: vi.fn(async () => snapshot(3)),
    setConfigOption: vi.fn(async () => ({ configOptions: [], snapshot: snapshot(3) })),
    authenticate: vi.fn(async () => ({ snapshot: snapshot(3) })),
    close: vi.fn(async () => undefined),
    subscribe: vi.fn(async (_threadId, listener) => {
      publish = listener;
      return () => {
        publish = null;
      };
    }),
  };
  return {
    runtime,
    publish: (next: AcpConversationDelta) => publish?.({ threadId: "thread-1", delta: next }),
  };
};

it("subscribes before opening and never regresses a newer streamed projection", async () => {
  const opening = deferred<AcpBackendSessionPresentation>();
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.open).mockReturnValue(opening.promise);
  vi.mocked(runtime.read).mockResolvedValue(presentation(1));
  const owner = new AcpConversationOwner("thread-1", runtime);

  const disconnect = owner.connect();
  publish(delta(1, 2, "running"));
  opening.resolve(presentation(1));
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));

  expect(owner.getSnapshot().presentation?.snapshot).toMatchObject({
    revision: 2,
    status: "running",
  });
  expect(runtime.subscribe).toHaveBeenCalledBefore(vi.mocked(runtime.open));

  disconnect();
  publish(delta(2, 3));
  expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2);
});

it("keeps cancellation available while a prompt is awaiting the external Agent", async () => {
  const prompting = deferred<{ stopReason: string; snapshot: AcpConversationSnapshot }>();
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.prompt).mockReturnValue(prompting.promise);
  const owner = new AcpConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));

  const promptResult = owner.prompt("  investigate this  ");
  publish(delta(2, 3, "running"));
  expect(owner.getSnapshot().promptPending).toBe(true);
  expect(await owner.cancel()).toBe(true);
  expect(runtime.cancel).toHaveBeenCalledWith("thread-1");

  prompting.resolve({ stopReason: "cancelled", snapshot: snapshot(5) });
  expect(await promptResult).toBe(true);
  expect(runtime.prompt).toHaveBeenCalledWith({
    threadId: "thread-1",
    prompt: "investigate this",
  });
  expect(owner.getSnapshot().promptPending).toBe(false);
});

it("retains the latest projection while applying returned mode state", async () => {
  const { runtime, publish } = createRuntime();
  const owner = new AcpConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  publish(delta(2, 3));

  expect(await owner.setMode("plan")).toBe(true);
  expect(runtime.setMode).toHaveBeenCalledWith({ threadId: "thread-1", modeId: "plan" });
  expect(owner.getSnapshot().presentation).toMatchObject({
    snapshot: { revision: 3 },
    modes: { currentModeId: "plan" },
  });
});

it("reads a fresh snapshot instead of applying a non-consecutive delta", async () => {
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.read)
    .mockResolvedValueOnce(presentation(2))
    .mockResolvedValueOnce(presentation(5));
  const owner = new AcpConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2));

  publish(delta(4, 5, "running"));

  await vi.waitFor(() => expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(5));
  expect(runtime.read).toHaveBeenCalledTimes(2);
});

it("fails visibly when a revision-gap resync cannot read the authoritative snapshot", async () => {
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.read)
    .mockResolvedValueOnce(presentation(2))
    .mockRejectedValueOnce(new Error("ACP session is no longer available"));
  const owner = new AcpConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2));

  publish(delta(4, 5, "running"));

  await vi.waitFor(() =>
    expect(owner.getSnapshot()).toMatchObject({
      connection: "failed",
      error: "ACP session is no longer available",
      presentation: { snapshot: { revision: 2 } },
    }),
  );
});

it("starts a new projection epoch when retrying a failed durable session", async () => {
  const { runtime, publish } = createRuntime();
  const owner = new AcpConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2));
  publish(delta(2, 3, "failed"));
  expect(owner.getSnapshot().presentation?.snapshot.status).toBe("failed");

  owner.retry();

  expect(owner.getSnapshot()).toMatchObject({ connection: "connecting", presentation: null });
  await vi.waitFor(() =>
    expect(owner.getSnapshot()).toMatchObject({
      connection: "ready",
      presentation: { snapshot: { revision: 2, status: "idle" } },
    }),
  );
});

it("surfaces expected command failures without rejecting the owning interaction", async () => {
  const { runtime } = createRuntime();
  vi.mocked(runtime.authenticate).mockRejectedValue(new Error("Authentication was declined"));
  const owner = new AcpConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));

  expect(await owner.authenticate("claude-login")).toBe(false);
  expect(owner.getSnapshot()).toMatchObject({
    connection: "ready",
    controlPending: null,
    error: "Authentication was declined",
  });
});

it("never forwards prompts while authentication or fatal recovery is required", async () => {
  const { runtime, publish } = createRuntime();
  const owner = new AcpConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));

  publish(delta(2, 3, "authentication-required"));
  expect(await owner.prompt("blocked until auth")).toBe(false);
  publish(delta(3, 4, "failed"));
  expect(await owner.prompt("blocked after failure")).toBe(false);
  expect(runtime.prompt).not.toHaveBeenCalled();
});
