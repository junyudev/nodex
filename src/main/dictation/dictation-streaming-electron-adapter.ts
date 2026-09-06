import type { IpcMain, IpcMainEvent, MessagePortMain, WebContents } from "electron";
import {
  DICTATION_STREAMING_PORT_CHANNEL,
  isDictationStreamingPortHandshake,
  type DictationStreamingClientMessage,
  type DictationStreamingPort,
} from "../../shared/dictation-streaming";
import {
  DictationStreamingSessionService,
  type DictationStreamingSocket,
  type DictationStreamingSocketHandlers,
} from "./dictation-streaming-session-service";

export interface DictationStreamingElectronAdapterDependencies {
  readonly ipcMain: Pick<IpcMain, "on" | "removeListener">;
  readonly readConnectInfo: (signal: AbortSignal) => Promise<{
    readonly websocketUrl: string;
    readonly protocols: readonly string[];
  }>;
  readonly requireTrustedSender: (event: IpcMainEvent) => void;
  readonly logger?: {
    readonly warn: (message: string, metadata?: Record<string, unknown>) => void;
  };
}

const parseClientMessage = (input: unknown): DictationStreamingClientMessage | null => {
  if (!input || typeof input !== "object" || !("type" in input)) return null;
  const value = input as Record<string, unknown>;
  if (value.type === "finish" || value.type === "abort") return { type: value.type };
  if (
    value.type !== "audio-frame" ||
    !Number.isSafeInteger(value.sequence) ||
    !(value.pcm16 instanceof ArrayBuffer)
  ) {
    return null;
  }
  return { type: "audio-frame", sequence: value.sequence as number, pcm16: value.pcm16 };
};

const adaptMessagePort = (port: MessagePortMain): DictationStreamingPort => ({
  postMessage: (message, _transfer = []) => port.postMessage(message),
  onMessage: (listener) => {
    const handleMessage = (event: Electron.MessageEvent): void => {
      const message = parseClientMessage(event.data);
      if (message) listener(message);
      else listener({ type: "audio-frame", sequence: -1, pcm16: new ArrayBuffer(0) });
    };
    port.on("message", handleMessage);
    port.start();
    return () => port.removeListener("message", handleMessage);
  },
  close: () => port.close(),
});

export const createDictationStreamingSocket = (
  websocketUrl: string,
  protocols: readonly string[],
): DictationStreamingSocket => {
  const socket = new WebSocket(websocketUrl, [...protocols]);
  return {
    get protocol() {
      return socket.protocol;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send: (payload) => socket.send(payload),
    close: (code, reason) => socket.close(code, reason),
    listen: (handlers: DictationStreamingSocketHandlers) => {
      const open = (): void => handlers.open();
      const message = (event: MessageEvent): void => handlers.message(event.data);
      const error = (event: Event): void => handlers.error(event);
      const close = (event: CloseEvent): void =>
        handlers.close({ code: event.code, reason: event.reason, wasClean: event.wasClean });
      socket.addEventListener("open", open);
      socket.addEventListener("message", message);
      socket.addEventListener("error", error);
      socket.addEventListener("close", close);
      return () => {
        socket.removeEventListener("open", open);
        socket.removeEventListener("message", message);
        socket.removeEventListener("error", error);
        socket.removeEventListener("close", close);
      };
    },
  };
};

export const registerDictationStreamingElectronAdapter = (
  dependencies: DictationStreamingElectronAdapterDependencies,
): (() => void) => {
  const service = new DictationStreamingSessionService({
    readConnectInfo: ({ signal }) => dependencies.readConnectInfo(signal),
    createWebSocket: createDictationStreamingSocket,
    logger: dependencies.logger,
  });
  const observedOwners = new Set<number>();

  const teardownOwner = (sender: WebContents): void => {
    observedOwners.delete(sender.id);
    service.teardownOwner(String(sender.id));
  };
  const handlePort = (event: IpcMainEvent, input: unknown): void => {
    try {
      dependencies.requireTrustedSender(event);
      if (!isDictationStreamingPortHandshake(input) || event.ports.length !== 1) {
        throw new Error("Invalid dictation streaming port handshake");
      }
      const port = event.ports[0];
      if (!port) throw new Error("Dictation streaming port is missing");
      if (!observedOwners.has(event.sender.id)) {
        observedOwners.add(event.sender.id);
        event.sender.once("destroyed", () => teardownOwner(event.sender));
      }
      service.prepare({
        ownerId: String(event.sender.id),
        sessionId: `${event.sender.id}:${input.sessionId}`,
        sampleRateHz: input.sampleRateHz,
        port: adaptMessagePort(port),
      });
    } catch (error) {
      dependencies.logger?.warn("Rejected dictation streaming port", {
        senderWebContentsId: event.sender.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      event.ports[0]?.close();
    }
  };

  dependencies.ipcMain.on(DICTATION_STREAMING_PORT_CHANNEL, handlePort);
  return () => {
    dependencies.ipcMain.removeListener(DICTATION_STREAMING_PORT_CHANNEL, handlePort);
    service.dispose();
    observedOwners.clear();
  };
};
