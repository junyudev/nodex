import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { RpcSession, RpcTarget, type RpcStub } from "capnweb";
import { afterEach, expect, it, vi } from "vitest";
import type { DictationSurface } from "../../../shared/dictation";
import {
  DICTATION_STREAM_CONNECT_MESSAGE,
  type DictationStreamTransportEvent,
} from "../../../shared/dictation-stream-transport";
import { ConversationServicePortTransport } from "../../../shared/codex-service-port";
import { emptyDictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";
import {
  DICTATION_STREAM_CLOSED,
  DICTATION_STREAM_OPEN,
  DictationStreamConnection,
  type OpenDictationStreamRpc,
} from "./dictation-stream-connection";
import { DictationWebSocketClient } from "./dictation-websocket-client";

const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};
const createFixture = () => {
  let emit!: (event: DictationStreamTransportEvent) => void;
  let broken!: () => void;
  class Capability extends RpcTarget {
    send = vi.fn();
    [Symbol.dispose] = vi.fn();
  }
  let accept!: (connection: Capability) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<Capability>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  const disposeScope = vi.fn();
  const capability = new Capability();
  const open: OpenDictationStreamRpc = (_surface, onEvent, onBroken) => {
    emit = onEvent;
    broken = onBroken;
    return { ready, [Symbol.dispose]: disposeScope };
  };
  const socket = new DictationStreamConnection("composer", open);
  return { socket, emit, broken, accept, reject, capability, disposeScope };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("replays Main events in order after acquiring the connection capability", async () => {
  const f = createFixture();
  const observed: string[] = [];
  f.socket.addEventListener("open", () => {
    observed.push("open");
    f.socket.send("session.start");
  });
  f.socket.addEventListener("message", (event) => observed.push((event as MessageEvent).data));
  f.emit({
    type: "prepared",
    headers: {
      originator: "Codex Desktop",
      userAgent: "desktop",
      authorizationPresent: true,
      accountHeaderPresent: true,
    },
    proxyMode: "http",
  });
  f.emit({ type: "open", protocol: "chatgpt-dictation" });
  f.emit({ type: "message", data: "session.started" });
  expect(observed).toEqual([]);
  f.accept(f.capability);
  await flush();
  expect(observed).toEqual(["open", "session.started"]);
  expect(f.capability.send).toHaveBeenCalledWith("session.start");
  expect(f.socket.readyState).toBe(DICTATION_STREAM_OPEN);
  expect(f.socket.protocol).toBe("chatgpt-dictation");
  expect(f.socket.diagnostics).toMatchObject({
    proxyMode: "http",
    headers: { accountHeaderPresent: true },
  });
  f.socket.close();
});

it("cancels pending RPC and disposes a capability that arrives after cancellation", async () => {
  const f = createFixture();
  const onOpen = vi.fn();
  const onMessage = vi.fn();
  f.socket.addEventListener("open", onOpen);
  f.socket.addEventListener("message", onMessage);
  f.emit({ type: "open", protocol: "chatgpt-dictation" });
  f.socket.close();
  f.socket.close();
  expect(f.disposeScope).toHaveBeenCalledTimes(1);
  f.accept(f.capability);
  await flush();
  f.emit({ type: "message", data: "late" });
  f.socket.send("late");
  expect(f.capability[Symbol.dispose]).toHaveBeenCalledTimes(1);
  expect(f.capability.send).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(onMessage).not.toHaveBeenCalled();
});

it.each([
  { protocol: "chatgpt-dictation", category: "chatgpt-dictation" },
  { protocol: "codex-desktop", category: "codex-desktop" },
  { protocol: "", category: "none" },
  { protocol: "unexpected-private-protocol", category: "other" },
])(
  "records only the protocol category before capability acquisition ($category)",
  ({ protocol, category }) => {
    const f = createFixture();
    const opened = vi.fn();
    f.socket.addEventListener("open", opened);
    f.emit({ type: "open", protocol });
    expect(f.socket.diagnostics).toEqual({ opened: true, selectedProtocol: category });
    expect(f.socket.readyState).not.toBe(DICTATION_STREAM_OPEN);
    expect(opened).not.toHaveBeenCalled();
    f.socket.close();
  },
);

it.each(["broken", "rejected", "send"] as const)("closes once on RPC %s failure", async (kind) => {
  const f = createFixture();
  const errors = vi.fn();
  const closes = vi.fn();
  f.socket.addEventListener("error", errors);
  f.socket.addEventListener("close", closes);
  if (kind === "rejected") f.reject(new Error("unavailable"));
  else {
    f.accept(f.capability);
    await flush();
    if (kind === "broken") f.broken();
    else {
      f.emit({ type: "open", protocol: "chatgpt-dictation" });
      f.capability.send.mockImplementation(() => {
        throw new Error("lost RPC");
      });
      f.socket.send("frame");
    }
  }
  await flush();
  f.broken();
  f.emit({ type: "close", code: 1006 });
  expect(f.socket.readyState).toBe(DICTATION_STREAM_CLOSED);
  expect(errors).toHaveBeenCalledTimes(1);
  expect(closes).toHaveBeenCalledTimes(1);
  expect(f.disposeScope).toHaveBeenCalledTimes(1);
});

it("preserves bounded Main failure evidence and observed close codes", async () => {
  const f = createFixture();
  f.accept(f.capability);
  await flush();
  const onClose = vi.fn();
  f.socket.addEventListener("close", (event) => onClose((event as CloseEvent).code));
  f.emit({
    type: "error",
    failureCode: "edge-challenge",
    httpStatus: 403,
    edgeChallenge: "cloudflare",
  });
  f.emit({ type: "close", code: 1006 });
  expect(f.socket.diagnostics).toMatchObject({
    failureCode: "edge-challenge",
    httpStatus: 403,
    edgeChallenge: "cloudflare",
  });
  expect(onClose).toHaveBeenCalledWith(1006);
  expect(f.capability[Symbol.dispose]).toHaveBeenCalledTimes(1);
});

it.each(["broken", "rejected"] as const)(
  "retains preparation and early close evidence when pending RPC is %s",
  async (kind) => {
    const f = createFixture();
    const opened = vi.fn();
    const messages = vi.fn();
    const errors = vi.fn();
    const closes = vi.fn();
    f.socket.addEventListener("open", opened);
    f.socket.addEventListener("message", messages);
    f.socket.addEventListener("error", errors);
    f.socket.addEventListener("close", (event) => closes((event as CloseEvent).code));
    f.emit({
      type: "prepared",
      headers: {
        originator: "Codex Desktop",
        userAgent: "desktop",
        authorizationPresent: true,
        accountHeaderPresent: true,
      },
      proxyMode: "http",
    });
    f.emit({ type: "open", protocol: "chatgpt-dictation" });
    f.emit({ type: "message", data: "session.started" });
    f.emit({
      type: "error",
      failureCode: "http-rejected",
      httpStatus: 407,
      networkError: "proxy",
    });
    f.emit({ type: "close", code: 1006 });
    expect(f.socket.diagnostics).toMatchObject({
      headers: { accountHeaderPresent: true },
      proxyMode: "http",
      opened: true,
      selectedProtocol: "chatgpt-dictation",
      failureCode: "http-rejected",
      httpStatus: 407,
      networkError: "proxy",
      closeCode: 1006,
    });
    if (kind === "broken") f.broken();
    else f.reject(new Error("Dictation stream operation failed"));
    await flush();
    expect(errors).toHaveBeenCalledOnce();
    expect(closes).toHaveBeenCalledWith(1006);
    expect(opened).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(f.disposeScope).toHaveBeenCalledOnce();
    expect(f.socket.diagnostics.failureCode).toBe("http-rejected");
    if (kind === "broken") {
      f.accept(f.capability);
      await flush();
      expect(f.capability[Symbol.dispose]).toHaveBeenCalledOnce();
      expect(f.capability.send).not.toHaveBeenCalled();
    }
  },
);

it("ignores late failure evidence after cancellation while waiting for the capability", async () => {
  const f = createFixture();
  f.socket.close();
  f.emit({ type: "error", failureCode: "edge-challenge", httpStatus: 403 });
  f.emit({ type: "close", code: 1006 });
  f.reject(new Error("cancelled"));
  await flush();
  expect(f.socket.diagnostics).toEqual({});
  expect(f.disposeScope).toHaveBeenCalledOnce();
});

it("acquires and releases Main's authenticated capability through the dedicated MessagePort", async () => {
  vi.stubGlobal("MessageChannel", NodeMessageChannel);
  vi.stubGlobal("window", { location: { origin: "http://renderer.test" }, postMessage: vi.fn() });
  const sent = vi.fn();
  const disposed = vi.fn();
  class Connection extends RpcTarget {
    send(data: string): void {
      sent(data);
    }
    [Symbol.dispose](): void {
      disposed();
    }
  }
  let surface: DictationSurface | undefined;
  let hostTransport: ConversationServicePortTransport | undefined;
  class Service extends RpcTarget {
    connect(
      nextSurface: DictationSurface,
      onEvent: (event: DictationStreamTransportEvent) => void,
    ): Connection {
      surface = nextSurface;
      onEvent({ type: "open", protocol: "chatgpt-dictation" });
      return new Connection();
    }
  }
  vi.spyOn(window, "postMessage").mockImplementation((message) => {
    const { type, port } = message as {
      type: string;
      port: InstanceType<typeof NodeMessageChannel>["port1"];
    };
    expect(type).toBe(DICTATION_STREAM_CONNECT_MESSAGE);
    hostTransport = new ConversationServicePortTransport({
      start: () => port.start(),
      postMessage: (data) => port.postMessage(data),
      close: () => port.close(),
      on: (event, listener) =>
        event === "message"
          ? port.on("message", (data) => listener({ data }))
          : port.on("close", listener),
    });
    const hostSession = new RpcSession(hostTransport, new Service());
    hostSession.getRemoteMain();
  });
  const socket = new DictationStreamConnection("global");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("RPC connect failed")), {
        once: true,
      });
    });
    expect(surface).toBe("global");
    socket.send("session.start");
    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith("session.start"));
    socket.close();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
  } finally {
    socket.close();
    hostTransport?.abort(new Error("Test completed"));
  }
});

it.each([false, true])(
  "keeps early Main rejection evidence through real RPC without session activation (opened=%s)",
  async (opened) => {
    vi.stubGlobal("MessageChannel", NodeMessageChannel);
    vi.stubGlobal("window", { location: { origin: "http://renderer.test" }, postMessage: vi.fn() });
    let hostTransport: ConversationServicePortTransport | undefined;
    class Service extends RpcTarget {
      connect(
        _surface: DictationSurface,
        onEvent: RpcStub<(event: DictationStreamTransportEvent) => void>,
      ): never {
        const events: DictationStreamTransportEvent[] = [
          {
            type: "prepared",
            headers: {
              originator: "Codex Desktop",
              userAgent: "desktop",
              authorizationPresent: true,
              accountHeaderPresent: true,
            },
            proxyMode: "http",
          },
          {
            type: "error",
            failureCode: "edge-challenge",
            httpStatus: 403,
            edgeChallenge: "cloudflare",
          },
          { type: "close", code: 1006 },
        ];
        if (opened) {
          events.splice(
            1,
            0,
            { type: "open", protocol: "codex-desktop" },
            { type: "message", data: '{"type":"session.started"}' },
          );
        }
        for (const event of events) onEvent(event)[Symbol.dispose]();
        throw new Error("private backend detail");
      }
    }
    vi.spyOn(window, "postMessage").mockImplementation((message) => {
      const { port } = message as { port: InstanceType<typeof NodeMessageChannel>["port1"] };
      hostTransport = new ConversationServicePortTransport({
        start: () => port.start(),
        postMessage: (data) => port.postMessage(data),
        close: () => port.close(),
        on: (event, listener) =>
          event === "message"
            ? port.on("message", (data) => listener({ data }))
            : port.on("close", listener),
      });
      new RpcSession(hostTransport, new Service(), {
        onSendError: () => new Error("Dictation stream operation failed"),
      }).getRemoteMain();
    });
    const diagnostics = emptyDictationStreamDiagnostics();
    const onEvent = vi.fn();
    const client = new DictationWebSocketClient(
      async () => () => new DictationStreamConnection("global"),
      onEvent,
      diagnostics,
    );
    try {
      await expect(client.connect(24_000)).rejects.toMatchObject({ code: "edge-challenge" });
      expect(diagnostics).toMatchObject({
        attempted: true,
        opened,
        started: false,
        sentAudioBytes: 0,
        sentAudioFrames: 0,
        headers: { authorizationPresent: true, accountHeaderPresent: true },
        proxyMode: "http",
        failureCode: "edge-challenge",
        httpStatus: 403,
        edgeChallenge: "cloudflare",
        closeCode: 1006,
      });
      expect(diagnostics.selectedProtocol).toBe(opened ? "codex-desktop" : undefined);
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      client.close();
      hostTransport?.abort(new Error("Test completed"));
    }
  },
);
