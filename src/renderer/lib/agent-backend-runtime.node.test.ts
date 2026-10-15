import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AgentConversationSnapshot } from "../../shared/agent-conversation";
import { agentBackendRuntime } from "./agent-backend-runtime";

const snapshot: AgentConversationSnapshot = {
  backend: "claude",
  threadId: "thread-1",
  sessionId: "native-session-1",
  status: "closed",
  error: null,
  turns: [],
  revision: 1,
  history: { cursor: "older-page", hasOlder: true, oldestSequence: 1 },
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

it("reads an addressed native history page through the query boundary", async () => {
  const invoke = vi.fn(async () => snapshot);
  vi.stubGlobal("window", { api: { invoke } });
  const input = { threadId: "thread-1", before: "older-page", limit: 50 };
  await expect(agentBackendRuntime.history(input)).resolves.toBe(snapshot);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("agent-backend:session:history", input);
});
