import { expect, it, vi } from "vite-plus/test";
import type { AgentBackendSessionPresentation } from "../../../shared/agent-backend-api";
import type {
  AgentConversationDelta,
  AgentConversationSnapshot,
} from "../../../shared/agent-conversation";
import type { AgentBackendRuntime } from "../../lib/agent-backend-runtime";
import { AgentConversationOwner } from "./agent-conversation-owner";

const snapshot = (
  revision: number,
  status: AgentConversationSnapshot["status"] = "idle",
): AgentConversationSnapshot => ({
  backend: "acp",
  threadId: "thread-1",
  sessionId: "session-1",
  status,
  error: null,
  turns: [],
  revision,
});

const presentation = (revision: number): AgentBackendSessionPresentation => ({
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
  status: AgentConversationSnapshot["status"] = "idle",
): AgentConversationDelta => ({
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
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const createRuntime = () => {
  let publish: ((event: { threadId: string; delta: AgentConversationDelta }) => void) | null = null;
  const runtime: AgentBackendRuntime = {
    readPermissionMode: vi.fn(async () => "auto" as const),
    setPermissionMode: vi.fn(async (_projectId, mode) => mode),
    historyImage: vi.fn(async () => "nodex://assets/image.png"),
    toolOutput: vi.fn(async () => ({ text: "", originalBytes: 0, truncated: false })),
    claudeDiscovery: vi.fn(async () => ({
      models: [],
      intelligence: { model: null, effort: null, fast: null, thinking: null },
      commands: [],
      skills: [],
      revision: "1",
      health: {
        status: "unknown" as const,
        executable: null,
        version: null,
        account: null,
        error: null,
      },
    })),
    inspect: vi.fn(async () => ({
      health: {
        status: "unknown" as const,
        executable: null,
        version: null,
        account: null,
        error: null,
      },
      mcpServers: [],
      agents: [],
      capabilities: [],
    })),
    setIntelligence: vi.fn(async () => presentation(3)),
    control: vi.fn(async () => presentation(3)),
    fork: vi.fn(async () => {
      throw new Error("not used");
    }),
    generateTitle: vi.fn(async () => null),
    claudeModels: async () => [],
    respond: vi.fn(async () => {}),
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
    publish: (next: AgentConversationDelta) => publish?.({ threadId: "thread-1", delta: next }),
  };
};

it("ignores a control response from a disconnected observation generation", async () => {
  const { runtime } = createRuntime();
  const pending = deferred<AgentConversationSnapshot>();
  vi.mocked(runtime.setMode).mockReturnValueOnce(pending.promise);
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  const changing = owner.setMode("plan");
  owner.retry();
  await vi.waitFor(() => expect(runtime.open).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  pending.resolve(snapshot(999));
  expect(await changing).toBe(false);
  expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2);
  expect(owner.getSnapshot().controlPending).toBe(null);
});

it("keeps newer streamed metadata when an older full read returns", async () => {
  const { runtime, publish } = createRuntime();
  const reading = deferred<AgentBackendSessionPresentation | null>();
  vi.mocked(runtime.read).mockReturnValueOnce(reading.promise);
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(runtime.read).toHaveBeenCalled());
  const metadata = {
    revision: 1,
    capabilities: presentation(1).capabilities,
    modes: presentation(1).modes,
    configOptions: [],
  };
  publish({
    ...delta(1, 2),
    metadata: { ...metadata, requestedSelection: { model: "gateway/model", effort: "high" } },
  });
  reading.resolve({ ...presentation(1), snapshot: { ...snapshot(1), metadata } });
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  expect(owner.getSnapshot().presentation?.snapshot.metadata?.requestedSelection).toEqual({
    model: "gateway/model",
    effort: "high",
  });
  expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2);
});

it("retains inherited model intent through an atomic intelligence command", async () => {
  const { runtime } = createRuntime();
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  const selection = { model: "default", effort: "high" as const, fast: false };
  await owner.setIntelligence(selection);
  expect(runtime.setIntelligence).toHaveBeenCalledWith({ threadId: "thread-1", selection });
  expect(runtime.setConfigOption).not.toHaveBeenCalled();
});

it("subscribes before opening and never regresses a newer streamed projection", async () => {
  const opening = deferred<AgentBackendSessionPresentation>();
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.open).mockReturnValue(opening.promise);
  vi.mocked(runtime.read).mockResolvedValue(presentation(1));
  const owner = new AgentConversationOwner("thread-1", runtime);

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
  const prompting = deferred<{ stopReason: string; snapshot: AgentConversationSnapshot }>();
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.prompt).mockReturnValue(prompting.promise);
  const owner = new AgentConversationOwner("thread-1", runtime);
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
    clientUserMessageId: expect.any(String),
  });
  expect(owner.getSnapshot().promptPending).toBe(false);
});

it("retains the latest projection while applying returned mode state", async () => {
  const { runtime, publish } = createRuntime();
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  publish(delta(2, 3));
  vi.mocked(runtime.read).mockResolvedValue({
    ...presentation(3),
    modes: { ...presentation(3).modes!, currentModeId: "plan" },
  });

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
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2));

  publish(delta(4, 5, "running"));

  await vi.waitFor(() => expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(5));
  expect(runtime.read).toHaveBeenCalledTimes(2);
});

it("coalesces newer invalidations into one fresh read after an in-flight resync", async () => {
  const { runtime, publish } = createRuntime();
  const captured = deferred<AgentBackendSessionPresentation | null>();
  vi.mocked(runtime.read)
    .mockResolvedValueOnce(presentation(2))
    .mockReturnValueOnce(captured.promise)
    .mockResolvedValueOnce(presentation(4));
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  publish({ ...delta(2, 3), resync: true });
  await vi.waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(2));
  publish({ ...delta(3, 4), resync: true });
  captured.resolve(presentation(3));
  await vi.waitFor(() => expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(4));
  expect(runtime.read).toHaveBeenCalledTimes(3);
});

it("follows a session identity transition during a resync and ignores late retired-session events", async () => {
  const { runtime, publish } = createRuntime();
  const captured = deferred<AgentBackendSessionPresentation | null>();
  const fresh = { ...presentation(1), snapshot: { ...snapshot(1), sessionId: "session-new" } };
  vi.mocked(runtime.read)
    .mockResolvedValueOnce(presentation(2))
    .mockReturnValueOnce(captured.promise)
    .mockResolvedValueOnce(fresh);
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  publish({ ...delta(2, 3), resync: true });
  await vi.waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(2));
  publish({ ...delta(0, 1), sessionId: "session-new", resync: true });
  captured.resolve(presentation(3));
  await vi.waitFor(() =>
    expect(owner.getSnapshot().presentation?.snapshot.sessionId).toBe("session-new"),
  );
  expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(1);
  publish({ ...delta(3, 4), resync: true });
  await Promise.resolve();
  expect(runtime.read).toHaveBeenCalledTimes(3);
});

it("does not follow up a failed resync even when newer invalidations arrived during the read", async () => {
  const { runtime, publish } = createRuntime();
  const captured = deferred<AgentBackendSessionPresentation | null>();
  vi.mocked(runtime.read)
    .mockResolvedValueOnce(presentation(2))
    .mockReturnValueOnce(captured.promise);
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  publish({ ...delta(2, 3), resync: true });
  await vi.waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(2));
  publish({ ...delta(3, 4), resync: true });
  captured.reject(new Error("Session disconnected"));
  await vi.waitFor(() =>
    expect(owner.getSnapshot()).toMatchObject({
      connection: "failed",
      error: "Session disconnected",
    }),
  );
  expect(runtime.read).toHaveBeenCalledTimes(2);
});

it("reports an unavailable authoritative snapshot instead of retaining a ready stale session", async () => {
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.read).mockResolvedValueOnce(presentation(2)).mockResolvedValueOnce(null);
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  publish({ ...delta(2, 3), resync: true });
  await vi.waitFor(() =>
    expect(owner.getSnapshot()).toMatchObject({
      connection: "failed",
      error: "Agent session is not available",
    }),
  );
  expect(runtime.read).toHaveBeenCalledTimes(2);
});

it("releases an in-flight dirty resync when its observation generation disconnects", async () => {
  const { runtime, publish } = createRuntime();
  const captured = deferred<AgentBackendSessionPresentation | null>();
  vi.mocked(runtime.read)
    .mockResolvedValueOnce(presentation(2))
    .mockReturnValueOnce(captured.promise);
  const owner = new AgentConversationOwner("thread-1", runtime);
  const disconnect = owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  publish({ ...delta(2, 3), resync: true });
  await vi.waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(2));
  publish({ ...delta(3, 4), resync: true });
  disconnect();
  captured.resolve(presentation(3));
  await captured.promise;
  await Promise.resolve();
  expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2);
  expect(runtime.read).toHaveBeenCalledTimes(2);
});

it("retires closed observations so captured resync replies cannot reopen the view before an explicit retry", async () => {
  const { runtime, publish } = createRuntime();
  const captured = deferred<AgentBackendSessionPresentation | null>();
  vi.mocked(runtime.read)
    .mockResolvedValueOnce(presentation(2))
    .mockReturnValueOnce(captured.promise);
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  publish({ ...delta(2, 3), resync: true });
  await vi.waitFor(() => expect(runtime.read).toHaveBeenCalledTimes(2));
  await owner.close();
  captured.resolve(presentation(999));
  await captured.promise;
  await Promise.resolve();
  expect(owner.getSnapshot().presentation).toBeNull();
  publish(delta(2, 3));
  expect(owner.getSnapshot().presentation).toBeNull();
  owner.retry();
  await vi.waitFor(() => expect(owner.getSnapshot().presentation?.snapshot.revision).toBe(2));
  expect(runtime.open).toHaveBeenCalledTimes(2);
});

it("fails visibly when a revision-gap resync cannot read the authoritative snapshot", async () => {
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.read)
    .mockResolvedValueOnce(presentation(2))
    .mockRejectedValueOnce(new Error("ACP session is no longer available"));
  const owner = new AgentConversationOwner("thread-1", runtime);
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
  const owner = new AgentConversationOwner("thread-1", runtime);
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
  const owner = new AgentConversationOwner("thread-1", runtime);
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
  const owner = new AgentConversationOwner("thread-1", runtime);
  owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));

  publish(delta(2, 3, "authentication-required"));
  expect(await owner.prompt("blocked until auth")).toBe(false);
  publish(delta(3, 4, "failed"));
  expect(await owner.prompt("blocked after failure")).toBe(false);
  expect(runtime.prompt).not.toHaveBeenCalled();
});

it("releases the composer after admission and retains turn completion and cancellation", async () => {
  const pending = deferred<{ stopReason: string; snapshot: AgentConversationSnapshot }>();
  const { runtime, publish } = createRuntime();
  vi.mocked(runtime.prompt).mockReturnValue(pending.promise);
  const owner = new AgentConversationOwner("thread-1", runtime);
  const disconnect = owner.connect();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  const accepted = owner.submit("Investigate");
  publish(delta(2, 3, "running"));
  expect(await accepted).toBe(true);
  expect(owner.getSnapshot().promptPending).toBe(true);
  expect(await owner.cancel()).toBe(true);
  pending.resolve({ stopReason: "cancelled", snapshot: snapshot(5) });
  await vi.waitFor(() => expect(owner.getSnapshot().promptPending).toBe(false));
  expect(owner.getSnapshot().presentation?.snapshot.status).toBe("idle");
  owner.retry();
  await vi.waitFor(() => expect(owner.getSnapshot().connection).toBe("ready"));
  disconnect();
  publish(delta(2, 3, "running"));
  expect(owner.getSnapshot().presentation?.snapshot.status).toBe("idle");
});
