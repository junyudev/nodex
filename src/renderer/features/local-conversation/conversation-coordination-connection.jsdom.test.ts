import { MessageChannel } from "node:worker_threads";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationServiceRoot } from "../../../shared/codex-service-root";
import { connectConversationCoordination } from "./conversation-coordination-connection";

const scopes: Disposable[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope[Symbol.dispose]();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function connect() {
  vi.stubGlobal("MessageChannel", MessageChannel);
  const scope = connectConversationCoordination(
    () => ({
      getStreamRole: () => ({ role: "owner" }),
      handleThreadFollowerRequest: async ({ method }) => ({ method, result: null }),
    }),
    () => {},
  );
  scopes.push(scope);
  return scope;
}

it("rejects pending readiness when disposed before the host connects", async () => {
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const scope = connect();
  scope[Symbol.dispose]();
  scope[Symbol.dispose]();
  await expect(scope.ready).rejects.toThrow("disposed");
  expect(post).toHaveBeenCalledOnce();
});

it("closes an established RPC service and rejects further calls", async () => {
  class Host extends RpcTarget {
    async findThreadOwner() {
      return "owner";
    }
  }
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    const { port } = message as { port: globalThis.MessagePort };
    const remote = newMessagePortRpcSession(port, new ConversationServiceRoot(new Host()));
    scopes.push({
      [Symbol.dispose]: () => {
        remote[Symbol.dispose]();
        port.close();
      },
    });
  });
  const scope = connect();
  const host = await scope.ready;
  await expect(host.findThreadOwner({ hostId: "local", conversationId: "thread" })).resolves.toBe(
    "owner",
  );
  scope[Symbol.dispose]();
  await expect(
    host.findThreadOwner({ hostId: "local", conversationId: "thread" }),
  ).rejects.toThrow();
});

it("rejects readiness when transferring the port fails", async () => {
  vi.spyOn(window, "postMessage").mockImplementation(() => {
    throw new Error("transfer failed");
  });
  const scope = connect();
  await expect(scope.ready).rejects.toThrow("transfer failed");
});

it("does not publish a host service that resolves after disposal", async () => {
  let resolveServices!: (services: { clientCoordination: RpcTarget }) => void;
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const services = new Promise<{ clientCoordination: RpcTarget }>((resolve) => {
    resolveServices = resolve;
  });
  class DelayedRoot extends RpcTarget {
    get services() {
      markRequested();
      return services;
    }
  }
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    const { port } = message as { port: globalThis.MessagePort };
    const remote = newMessagePortRpcSession(port, new DelayedRoot());
    scopes.push({
      [Symbol.dispose]: () => {
        remote[Symbol.dispose]();
        port.close();
      },
    });
  });
  const scope = connect();
  await requested;
  scope[Symbol.dispose]();
  resolveServices({ clientCoordination: new RpcTarget() });
  await expect(scope.ready).rejects.toThrow("disposed");
});
