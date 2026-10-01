import path from "node:path";
import { app, BrowserWindow, ipcMain, net, protocol, session, type IpcMainEvent } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { registerAppProtocol } from "../../../src/main/app-protocol";
import { registerNodexPrivilegedSchemes } from "../../../src/main/privileged-schemes";
import { ScopedCallbackRuntime, layer as callbacksLayer } from "../../../src/main/app/ScopedCallbackRuntime";
import { connectDictationStreamingRpc } from "../../../src/main/platform/electron/DictationStreamingRpc";
import { openDictationWebSocket } from "../../../src/main/platform/node/DictationWebSocket";
import { DICTATION_STREAM_CONNECT_CHANNEL } from "../../../src/shared/dictation-stream-transport";
import type { CodexMedia } from "../../../src/main/codex-application/CodexMedia";

app.setPath("userData", path.join(__dirname, "profile"));
registerNodexPrivilegedSchemes();
void app.whenReady().then(async () => {
  const socketUrl = process.env.NODEX_TEST_DICTATION_SOCKET_URL;
  if (!socketUrl) throw new Error("Missing fixture WebSocket URL");
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(callbacksLayer, scope));
  const callbacks = Context.get(context, ScopedCallbackRuntime);
  // Trust only this fixture's ephemeral loopback certificate.
  session.defaultSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === "127.0.0.1" ? 0 : -3));
  const dispose = registerAppProtocol(session.defaultSession, {
    rendererRoot: path.join(__dirname, "renderer"), getDevelopmentRendererUrl: () => null, protocol,
  });
  const window = new BrowserWindow({ show: true, webPreferences: {
    preload: path.join(__dirname, "preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  const headers = {
    Authorization: "Bearer fixture-token",
    "ChatGPT-Account-Id": "fixture-account",
    originator: "Codex Desktop",
    "User-Agent": "Codex Desktop/fixture (Mac OS; arm64)",
    "Accept-Language": "en-SG",
  };
  const media: Pick<CodexMedia["Service"], "openStreaming"> = {
    openStreaming: (_surface, onEvent) => Effect.gen(function* () {
      onEvent({ type: "prepared", proxyMode: "direct", headers: {
        originator: headers.originator,
        userAgent: headers["User-Agent"],
        authorizationPresent: true,
        accountHeaderPresent: true,
      } });
      return yield* openDictationWebSocket({ url: socketUrl, headers, signal: yield* Effect.abortSignal, onEvent });
    }),
  };
  let transferredPorts = 0;
  let capabilityReads = 0;
  let forbiddenInvocations = 0;
  Object.defineProperty(globalThis, "dictationFixturePortCount", { get: () => transferredPorts });
  Object.defineProperty(globalThis, "dictationFixtureCapabilityReads", { get: () => capabilityReads });
  Object.defineProperty(globalThis, "dictationFixtureForbiddenInvocations", { get: () => forbiddenInvocations });
  const trusted = (event: Pick<IpcMainEvent, "sender" | "senderFrame">): boolean =>
    event.sender === window.webContents && event.senderFrame === event.sender.mainFrame;
  ipcMain.handle("codex:dictation:state:read", (event) => {
    if (!trusted(event)) throw new Error("Untrusted fixture renderer");
    capabilityReads += 1;
    return { capabilities: { streaming: "available", sounds: true } };
  });
  ipcMain.handle("codex:account:read", () => {
    forbiddenInvocations += 1;
    return "outside the global dictation capability";
  });
  ipcMain.on(DICTATION_STREAM_CONNECT_CHANNEL, (event) => {
    const port = event.ports[0];
    if (!trusted(event) || !port || event.ports.length !== 1) {
      for (const received of event.ports) received.close();
      return;
    }
    transferredPorts += 1;
    callbacks.fork(Effect.gen(function* () {
      const child = yield* Scope.fork(scope, "sequential");
      const connection = connectDictationStreamingRpc(port, media, callbacks, child, "global");
      const close = (): void => {
        connection.dispose();
        callbacks.fork(Scope.close(child, Exit.void));
      };
      port.once("close", close);
      event.sender.once("destroyed", close);
      yield* Scope.addFinalizer(child, Effect.sync(() => {
        port.off("close", close);
        event.sender.off("destroyed", close);
        connection.dispose();
      }));
    }));
  });
  ipcMain.handle("codex:dictation:transcribe", async (event, input: { contentType: string; base64Payload: string; requestId: string }) => {
    if (!trusted(event)) throw new Error("Untrusted fixture renderer");
    const response = await net.fetch(new URL("/transcribe", socketUrl.replace(/^wss:/u, "https:")).toString(), {
      method: "POST", headers: { ...headers, "Content-Type": input.contentType }, body: Buffer.from(input.base64Payload, "base64"),
    });
    const result = await response.json() as { text: string };
    return { text: result.text, diagnostics: {
      operation: "transcription", requestId: input.requestId, endpoint: "/transcribe", outcome: "completed",
      status: response.status, totalMs: 0, attempts: 1,
    } };
  });
  let stopping = false;
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void Effect.runPromise(Scope.close(scope, Exit.void)).finally(() => {
      dispose();
      app.exit(0);
    });
  });
  await window.loadURL("app://-/index.html");
});
