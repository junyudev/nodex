import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AgentBackendSessionPresentation } from "../../shared/agent-conversation";
import { agentBackendRuntime } from "./agent-backend-runtime";

const presentation: AgentBackendSessionPresentation = {
  snapshot: {
    backend: "acp",
    threadId: "thread-1",
    sessionId: "session-1",
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
      close: true,
      additionalDirectories: false,
    },
    authMethods: [],
  },
  modes: null,
  configOptions: [],
};

afterEach(() => vi.unstubAllGlobals());

it("cancels the exact discovery request and rejects locally even while Main finishes cleanup", async () => {
  const controller = new AbortController();
  const invoke = vi.fn((channel: string) =>
    channel === "agent-backend:claude:discover"
      ? new Promise(() => {})
      : Promise.resolve(undefined),
  );
  vi.stubGlobal("window", { api: { invoke, on: vi.fn() } });
  const pending = agentBackendRuntime.claudeDiscovery(
    { scope: { kind: "project", instanceConfigId: "work", projectId: "project" } },
    controller.signal,
  );
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const request = invoke.mock.calls[0] as unknown as [string, { requestId: string }];
  expect(request[0]).toBe("agent-backend:claude:discover");
  controller.abort();
  await rejection;
  expect(invoke).toHaveBeenLastCalledWith("agent-backend:claude:cancel-discovery", {
    requestId: request[1].requestId,
  });
  const alreadyAborted = agentBackendRuntime.claudeDiscovery(
    { scope: { kind: "project", instanceConfigId: "work", projectId: null } },
    controller.signal,
  );
  await expect(alreadyAborted).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("completed discovery unregisters its cancellation consumer", async () => {
  const controller = new AbortController();
  const invoke = vi.fn(async () => ({ models: [] }));
  vi.stubGlobal("window", { api: { invoke, on: vi.fn() } });
  await agentBackendRuntime.claudeDiscovery(
    { scope: { kind: "project", instanceConfigId: "work", projectId: null } },
    controller.signal,
  );
  controller.abort();
  expect(invoke).toHaveBeenCalledOnce();
});

it("routes typed lifecycle commands through the named ACP boundary", async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "agent-backend:session:open") return presentation;
    if (channel === "agent-backend:session:read") return presentation;
    throw new Error(`Unexpected channel: ${channel}`);
  });
  vi.stubGlobal("window", { api: { invoke, on: vi.fn() } });

  await expect(agentBackendRuntime.open({ threadId: "thread-1" })).resolves.toEqual(presentation);
  await expect(agentBackendRuntime.read("thread-1")).resolves.toEqual(presentation);
  expect(invoke).toHaveBeenNthCalledWith(1, "agent-backend:session:open", {
    threadId: "thread-1",
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "agent-backend:session:read", "thread-1");
});

it("observes only the attached thread and releases both delivery paths", async () => {
  let eventListener: ((...args: unknown[]) => void) | null = null;
  const release = vi.fn();
  const on = vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
    eventListener = listener;
    return release;
  });
  const invoke = vi.fn(async () => undefined);
  vi.stubGlobal("window", { api: { invoke, on } });
  const listener = vi.fn();

  const unsubscribe = await agentBackendRuntime.subscribe("thread-1", listener);
  const publish = eventListener as ((...args: unknown[]) => void) | null;
  expect(publish).not.toBeNull();
  const delta = {
    backend: "acp" as const,
    threadId: "thread-1",
    sessionId: "session-1",
    baseRevision: 1,
    revision: 2,
    status: "running" as const,
    error: null,
    removedTurnSequences: [],
    turns: [],
  };
  publish?.({ threadId: "thread-2", delta: { ...delta, threadId: "thread-2" } });
  publish?.({ threadId: "thread-1", delta });

  expect(listener).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledWith({ threadId: "thread-1", delta });
  expect(invoke).toHaveBeenCalledWith("agent-backend:session:observe", "thread-1");
  unsubscribe();
  expect(release).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("agent-backend:session:unobserve", "thread-1");
});
