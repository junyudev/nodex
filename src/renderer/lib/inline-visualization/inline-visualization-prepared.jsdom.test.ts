import { waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  MCP_APP_REQUIRED_GUEST_PORT_NAMES,
  parseMcpAppSandboxSourceUrl,
} from "../../../shared/mcp-app/mcp-app-sandbox-contract";
import { createInlineVisualizationPreparedLease } from "./inline-visualization-prepared";
import { createInlineVisualizationHostHandlers } from "./inline-visualization-runtime";
import { createMcpAppHostHandlerPort } from "../mcp-app/mcp-app-port-rpc";

const boundary = vi.hoisted(() => ({
  control: vi.fn(async (_key: string, _input: unknown) => true),
}));
vi.mock("../renderer-command", async (original) => ({
  ...(await original<typeof import("../renderer-command")>()),
  invokeRendererControl: boundary.control,
}));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});

function nativeHostMessage(data: unknown, ports: MessagePort[]) {
  window.dispatchEvent(new MessageEvent("message", { data, ports }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
function callHostTool(port: MessagePort, name: string) {
  return new Promise<unknown>((resolve, reject) => {
    const reply = new MessageChannel();
    reply.port1.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => {
        const payload = event.data;
        if (!Array.isArray(payload)) return;
        reply.port1.close();
        if (payload[0] === "RESOLVE") resolve(payload[1]);
        else reject(payload[1]);
      },
      { once: true },
    );
    reply.port1.start();
    port.postMessage(["CALL", name], [reply.port2]);
  });
}

test("prepared readiness uses the real nonce/origin/named-port handshake and host callbacks stay revocable", async () => {
  const paused = deferred<boolean>();
  boundary.control
    .mockReset()
    .mockImplementation(async (key) =>
      key === "codex:visualization:set-presentation" ? paused.promise : true,
    );
  const container = document.createElement("div");
  document.body.append(container);
  cleanup.push(() => container.remove());
  const lease = createInlineVisualizationPreparedLease("en-US", vi.fn());
  cleanup.push(() => lease.dispose());
  const preparing = lease.prepare(container);
  await waitFor(() => expect(lease.element.getAttribute("src")).toBeTruthy());
  const source = parseMcpAppSandboxSourceUrl(lease.element.getAttribute("src")!);
  if (!source?.initId) throw new Error("Expected the public strict connection nonce");
  const guestPorts = MCP_APP_REQUIRED_GUEST_PORT_NAMES.map(() =>
    createMcpAppHostHandlerPort(async () => undefined),
  );
  cleanup.push(() => guestPorts.forEach((port) => port.close()));
  const reply = new MessageChannel();
  cleanup.push(() => {
    reply.port1.close();
    reply.port2.close();
  });
  const hostPorts = deferred<Record<string, MessagePort>>();
  reply.port1.addEventListener(
    "message",
    (event: MessageEvent<Record<string, MessagePort>>) => hostPorts.resolve(event.data),
    { once: true },
  );
  reply.port1.start();
  const valid = {
    type: "init",
    origin: source.origin,
    sandboxId: lease.identity.sandboxId,
    initId: source.initId,
    portNames: [...MCP_APP_REQUIRED_GUEST_PORT_NAMES],
    skybridgeCacheState: "warm",
  };
  // None of these can cause pause, readiness, or delivery of the host capability ports.
  nativeHostMessage({ ...valid, initId: crypto.randomUUID() }, [...guestPorts, reply.port2]);
  nativeHostMessage({ ...valid, origin: "https://foreign.example" }, [...guestPorts, reply.port2]);
  nativeHostMessage({ ...valid, portNames: [...valid.portNames.slice(1)] }, [
    ...guestPorts.slice(1),
    reply.port2,
  ]);
  nativeHostMessage(valid, [...guestPorts]);
  await Promise.resolve();
  expect(lease.isReady).toBe(false);
  expect(boundary.control).not.toHaveBeenCalled();
  nativeHostMessage(valid, [...guestPorts, reply.port2]);
  const ports = await hostPorts.promise;
  cleanup.push(() => Object.values(ports).forEach((port) => port.close()));
  expect(Object.keys(ports)).toHaveLength(13);
  await waitFor(() =>
    expect(boundary.control).toHaveBeenCalledWith("codex:visualization:set-presentation", {
      sandboxId: lease.identity.sandboxId,
      initId: source.initId,
      active: false,
      revision: 1,
    }),
  );
  expect(lease.isReady).toBe(false);
  await expect(
    callHostTool(ports.callTool!, "__codex_inline_visualization_ready__"),
  ).rejects.toMatchObject({ message: expect.stringContaining("inactive") });
  paused.resolve(true);
  await preparing;
  const ready = vi.fn();
  const signal = new AbortController();
  const connected = await lease.activate({
    signal: signal.signal,
    handlers: createInlineVisualizationHostHandlers({
      ready,
      fail: vi.fn(),
      height: vi.fn(),
      interact: vi.fn(),
      mode: () => "inline",
      openExternal: async () => undefined,
    }),
  });
  expect(connected.initId).toBe(source.initId);
  await callHostTool(ports.callTool!, "__codex_inline_visualization_ready__");
  expect(ready).toHaveBeenCalledOnce();
  signal.abort();
  expect(lease.isReady).toBe(false);
  expect(lease.element.isConnected).toBe(false);
  await lease.dispose();
  expect(boundary.control).toHaveBeenCalledWith("codex:visualization:release", {
    sandboxId: lease.identity.sandboxId,
    initId: source.initId,
  });
});
