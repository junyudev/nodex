import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AcpBackendSessionPresentation } from "../../shared/acp-conversation";
import { acpBackendRuntime } from "./acp-backend-runtime";

const presentation: AcpBackendSessionPresentation = {
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

it("routes typed lifecycle commands through the named ACP boundary", async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "agent-backend:acp:session:open") return presentation;
    if (channel === "agent-backend:acp:session:read") return presentation;
    throw new Error(`Unexpected channel: ${channel}`);
  });
  vi.stubGlobal("window", { api: { invoke, on: vi.fn() } });

  await expect(acpBackendRuntime.open({ threadId: "thread-1" })).resolves.toEqual(presentation);
  await expect(acpBackendRuntime.read("thread-1")).resolves.toEqual(presentation);
  expect(invoke).toHaveBeenNthCalledWith(1, "agent-backend:acp:session:open", {
    threadId: "thread-1",
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "agent-backend:acp:session:read", "thread-1");
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

  const unsubscribe = await acpBackendRuntime.subscribe("thread-1", listener);
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
  expect(invoke).toHaveBeenCalledWith("agent-backend:acp:session:observe", "thread-1");
  unsubscribe();
  expect(release).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("agent-backend:acp:session:unobserve", "thread-1");
});
