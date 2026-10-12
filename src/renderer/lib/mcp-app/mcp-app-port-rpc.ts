import {
  MCP_APP_REQUIRED_GUEST_PORT_NAMES,
  appendMcpAppSandboxInitId,
  parseMcpAppSandboxHostInitMessage,
  type McpAppGuestPortName,
} from "../../../shared/mcp-app/mcp-app-sandbox-contract";

const CALL = "CALL";
const GENERATOR_GENERATE = "GENERATOR_GENERATE";
const REJECT = "REJECT";
const RESOLVE = "RESOLVE";
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export interface McpAppHostApiHandlers {
  callMcp: (...args: unknown[]) => unknown | Promise<unknown>;
  callTool: (...args: unknown[]) => unknown | Promise<unknown>;
  notifyBackgroundColor: (...args: unknown[]) => unknown | Promise<unknown>;
  notifyEnvironmentError: (...args: unknown[]) => unknown | Promise<unknown>;
  notifyIntrinsicHeight: (...args: unknown[]) => unknown | Promise<unknown>;
  notifyIntrinsicWidth: (...args: unknown[]) => unknown | Promise<unknown>;
  notifyNavigation: (...args: unknown[]) => unknown | Promise<unknown>;
  notifySecurityPolicyViolation: (...args: unknown[]) => unknown | Promise<unknown>;
  openExternal: (...args: unknown[]) => unknown | Promise<unknown>;
  requestDisplayMode: (...args: unknown[]) => unknown | Promise<unknown>;
  sendFollowUpMessage: (...args: unknown[]) => unknown | Promise<unknown>;
  sendInstrument: (...args: unknown[]) => unknown | Promise<unknown>;
  updateWidgetState: (...args: unknown[]) => unknown | Promise<unknown>;
}

export interface McpAppSkybridgeApi {
  navigate: McpAppPortCall;
  notifyMcpAppsHostContext: McpAppPortCall;
  notifyMcpAppsMcpNotification: McpAppPortCall | null;
  notifyMcpAppsToolCancelled: McpAppPortCall;
  notifyMcpAppsToolInput: McpAppPortCall;
  notifyMcpAppsToolResult: McpAppPortCall;
  requestMcpAppsResourceTeardown: (input: unknown) => Promise<unknown>;
  runWidgetCode: (input: unknown) => AsyncGenerator<unknown, unknown, void>;
  setAdditionalGlobals: McpAppPortCall;
  setSafeArea: McpAppPortCall;
  setTheme: McpAppPortCall;
  setWidgetData: McpAppPortCall;
  setWidgetView: McpAppPortCall;
}

export type McpAppPortCall = (
  input: unknown,
  options?: { signal?: AbortSignal; timeoutMs?: number | null },
) => Promise<unknown>;

export interface ConnectedMcpAppSandbox {
  api: McpAppSkybridgeApi;
  readonly initId?: string;
  dispose(): void;
}

function abortError(): Error {
  const error = new Error("MCP sandbox RPC aborted.");
  error.name = "AbortError";
  return error;
}

function timeoutError(): Error {
  const error = new Error("MCP sandbox RPC timed out.");
  error.name = "TimeoutError";
  return error;
}

function serializeError(value: unknown): Record<string, unknown> {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const message =
    value instanceof Error
      ? value.message || "MCP sandbox host call failed."
      : typeof record?.message === "string" && record.message
        ? record.message
        : "MCP sandbox host call failed.";
  return {
    message,
    ...(typeof record?.code === "number" ? { code: record.code } : {}),
    ...(typeof record?.name === "string" ? { name: record.name } : {}),
  };
}

export function createMcpAppPortCall(
  port: MessagePort,
  defaultSignal?: AbortSignal,
): McpAppPortCall {
  port.start();
  return (input, options = {}) =>
    new Promise((resolve, reject) => {
      const signal = options.signal ?? defaultSignal;
      const timeoutMs =
        options.timeoutMs === undefined ? DEFAULT_RPC_TIMEOUT_MS : options.timeoutMs;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      const channel = new MessageChannel();
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", handleAbort);
        channel.port1.onmessage = null;
        channel.port1.close();
      };
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const handleAbort = () => settle(() => reject(abortError()));

      channel.port1.onmessage = (event) => {
        const payload = event.data;
        if (!Array.isArray(payload)) return;
        if (payload[0] === RESOLVE) {
          settle(() => resolve(payload[1]));
          return;
        }
        settle(() => reject(payload[1]));
      };
      channel.port1.start();
      signal?.addEventListener("abort", handleAbort, { once: true });
      if (timeoutMs !== null) {
        timeout = setTimeout(() => settle(() => reject(timeoutError())), timeoutMs);
      }
      try {
        port.postMessage([CALL, input], [channel.port2]);
      } catch (error) {
        settle(() => reject(error));
      }
    });
}

export function createMcpAppHostHandlerPort(
  handler: (...args: unknown[]) => unknown | Promise<unknown>,
): MessagePort {
  const channel = new MessageChannel();
  channel.port1.onmessage = async (event) => {
    const payload = event.data;
    const replyPort = event.ports[0];
    if (!Array.isArray(payload) || payload[0] !== CALL || !replyPort) return;
    try {
      replyPort.postMessage([RESOLVE, await handler(...payload.slice(1))]);
    } catch (error) {
      replyPort.postMessage([REJECT, serializeError(error)]);
    } finally {
      replyPort.close();
    }
  };
  channel.port1.start();
  return channel.port2;
}

function createHostHandlerPorts(handlers: McpAppHostApiHandlers): {
  ports: Record<keyof McpAppHostApiHandlers, MessagePort>;
  values: MessagePort[];
} {
  const entries = Object.entries(handlers).map(
    ([name, handler]) => [name, createMcpAppHostHandlerPort(handler)] as const,
  );
  return {
    ports: Object.fromEntries(entries) as Record<keyof McpAppHostApiHandlers, MessagePort>,
    values: entries.map(([, port]) => port),
  };
}

function mapNamedPorts(
  names: McpAppGuestPortName[],
  ports: readonly MessagePort[],
): Partial<Record<McpAppGuestPortName, MessagePort>> | null {
  const named: Partial<Record<McpAppGuestPortName, MessagePort>> = {};
  for (const [index, name] of names.entries()) {
    const port = ports[index];
    if (!port || typeof port.postMessage !== "function") return null;
    named[name] = port;
  }
  if (!MCP_APP_REQUIRED_GUEST_PORT_NAMES.every((name) => named[name])) return null;
  return named;
}

function requiredPort(
  ports: Partial<Record<McpAppGuestPortName, MessagePort>>,
  name: (typeof MCP_APP_REQUIRED_GUEST_PORT_NAMES)[number],
): MessagePort {
  const port = ports[name];
  if (!port) throw new Error(`Missing MCP App port: ${name}`);
  return port;
}

function createRunWidgetCode(
  port: MessagePort,
  signal: AbortSignal,
): (input: unknown) => AsyncGenerator<unknown, unknown, void> {
  port.start();
  return async function* runWidgetCode(input: unknown) {
    const asyncDispose = new MessageChannel();
    const next = new MessageChannel();
    const returnChannel = new MessageChannel();
    const throwChannel = new MessageChannel();
    const callDispose = createMcpAppPortCall(asyncDispose.port1, signal);
    const callNext = createMcpAppPortCall(next.port1, signal);
    const callReturn = createMcpAppPortCall(returnChannel.port1, signal);
    const callThrow = createMcpAppPortCall(throwChannel.port1, signal);
    port.postMessage(
      [
        GENERATOR_GENERATE,
        {
          asyncDispose: asyncDispose.port2,
          next: next.port2,
          return: returnChannel.port2,
          throw: throwChannel.port2,
        },
        input,
      ],
      [asyncDispose.port2, next.port2, returnChannel.port2, throwChannel.port2],
    );

    try {
      let result = await callNext(undefined, { timeoutMs: null });
      while (
        typeof result === "object" &&
        result !== null &&
        "done" in result &&
        !(result as IteratorResult<unknown>).done
      ) {
        yield (result as IteratorResult<unknown>).value;
        result = await callNext(undefined, { timeoutMs: null });
      }
      return (result as IteratorResult<unknown>).value;
    } catch (error) {
      if (!signal.aborted) await callThrow(error).catch(() => undefined);
      if (!signal.aborted) throw error;
      return undefined;
    } finally {
      if (!signal.aborted) {
        await Promise.allSettled([callDispose(undefined), callReturn(undefined)]);
      }
      [asyncDispose.port1, next.port1, returnChannel.port1, throwChannel.port1].forEach(
        (messagePort) => messagePort.close(),
      );
    }
  };
}

export async function connectMcpAppSandbox(input: {
  expectedOrigin: string;
  expectedSandboxId: string;
  handlers: McpAppHostApiHandlers;
  onSkybridgeCacheState?(state: "cold" | "warming" | "warm"): void;
  signal: AbortSignal;
  sourceUrl: string;
  timeoutMs?: number;
  webview: HTMLElement;
}): Promise<ConnectedMcpAppSandbox> {
  const timeoutMs = input.timeoutMs ?? 20_000;
  const expectedInitId = crypto.randomUUID();
  const handshake = await new Promise<{
    namedPorts: Partial<Record<McpAppGuestPortName, MessagePort>>;
    replyPort: MessagePort;
  }>((resolve, reject) => {
    if (input.signal.aborted) {
      reject(abortError());
      return;
    }
    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
      input.signal.removeEventListener("abort", handleAbort);
    }
    function handleAbort() {
      cleanup();
      reject(abortError());
    }
    function handleMessage(event: MessageEvent) {
      const init = parseMcpAppSandboxHostInitMessage(event.data);
      if (
        !init ||
        init.origin !== input.expectedOrigin ||
        init.sandboxId !== input.expectedSandboxId ||
        init.initId !== expectedInitId ||
        event.ports.length !== init.portNames.length + 1
      ) {
        return;
      }
      const namedPorts = mapNamedPorts(init.portNames, event.ports);
      const replyPort = event.ports[init.portNames.length];
      if (!namedPorts || !replyPort) return;
      if (init.skybridgeCacheState) {
        input.onSkybridgeCacheState?.(init.skybridgeCacheState);
      }
      cleanup();
      resolve({ namedPorts, replyPort });
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(timeoutError());
    }, timeoutMs);
    window.addEventListener("message", handleMessage);
    input.signal.addEventListener("abort", handleAbort, { once: true });
    const sourceUrl = appendMcpAppSandboxInitId(input.sourceUrl, expectedInitId);
    if (input.webview.getAttribute("src") !== sourceUrl) {
      input.webview.setAttribute("src", sourceUrl);
    }
  });

  const hostPorts = createHostHandlerPorts(input.handlers);
  handshake.replyPort.postMessage(hostPorts.ports, hostPorts.values);
  handshake.replyPort.start();

  const call = (name: (typeof MCP_APP_REQUIRED_GUEST_PORT_NAMES)[number]) =>
    createMcpAppPortCall(requiredPort(handshake.namedPorts, name), input.signal);
  const namedPorts = handshake.namedPorts;
  const api: McpAppSkybridgeApi = {
    navigate: call("navigate"),
    notifyMcpAppsHostContext: call("notifyMcpAppsHostContext"),
    notifyMcpAppsMcpNotification: namedPorts.notifyMcpAppsMcpNotification
      ? createMcpAppPortCall(namedPorts.notifyMcpAppsMcpNotification, input.signal)
      : null,
    notifyMcpAppsToolCancelled: call("notifyMcpAppsToolCancelled"),
    notifyMcpAppsToolInput: call("notifyMcpAppsToolInput"),
    notifyMcpAppsToolResult: call("notifyMcpAppsToolResult"),
    requestMcpAppsResourceTeardown: createMcpAppPortCall(
      requiredPort(namedPorts, "requestMcpAppsResourceTeardown"),
    ),
    runWidgetCode: createRunWidgetCode(requiredPort(namedPorts, "runWidgetCode"), input.signal),
    setAdditionalGlobals: call("setAdditionalGlobals"),
    setSafeArea: call("setSafeArea"),
    setTheme: call("setTheme"),
    setWidgetData: call("setWidgetData"),
    setWidgetView: call("setWidgetView"),
  };

  return {
    api,
    initId: expectedInitId,
    dispose: () => {
      handshake.replyPort.close();
      for (const port of Object.values(handshake.namedPorts)) port?.close();
      for (const port of hostPorts.values) port.close();
    },
  };
}
