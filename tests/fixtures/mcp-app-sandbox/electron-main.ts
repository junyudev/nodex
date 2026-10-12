import path from "node:path";
import { readFileSync } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { app, BrowserWindow, protocol, session } from "electron";
import {
  McpAppSandboxRuntime,
  live as mcpAppSandboxRuntimeLive,
} from "../../../src/main/host-runtime/McpAppSandboxRuntime";
import {
  MCP_APP_REQUIRED_GUEST_PORT_NAMES,
  MCP_APP_SANDBOX_SCHEME,
  appendMcpAppSandboxInitId,
  buildMcpAppSandboxPartition,
  buildMcpAppSandboxSourceUrl,
} from "../../../src/shared/mcp-app/mcp-app-sandbox-contract";

const homeArgument = process.argv.indexOf("--home");
const home = homeArgument >= 0 ? process.argv[homeArgument + 1] : null;
if (!home || !path.isAbsolute(home)) throw new Error("Sandbox fixture requires an absolute home");
app.setPath("userData", path.join(home, "user-data"));

protocol.registerSchemesAsPrivileged([{
  scheme: MCP_APP_SANDBOX_SCHEME,
  privileges: {
    secure: true,
    standard: true,
    stream: true,
    supportFetchAPI: true,
    corsEnabled: true,
    allowServiceWorkers: true,
  },
}]);

const SKYBRIDGE_HTML = `<!doctype html>
<html>
  <body>
    <button id="increment">Increment</button><output id="counter">0</output>
    <script>
      const nonce = crypto.randomUUID();
      let counter = 0;
      document.getElementById("increment").addEventListener("click", () => {
        document.getElementById("counter").textContent = String(++counter);
      });
      const names = ${JSON.stringify(MCP_APP_REQUIRED_GUEST_PORT_NAMES)};
      const retainedPorts = [];
      const ports = {};
      const transfer = names.map((name) => {
        const channel = new MessageChannel();
        retainedPorts.push(channel.port1);
        channel.port1.onmessage = event => {
          if (event.data?.type !== "fixture-ping") return;
          channel.port1.postMessage({ type: "fixture-pong", requestId: event.data.requestId, nonce, counter });
        };
        channel.port1.start();
        ports[name] = channel.port2;
        return channel.port2;
      });
      const reply = new MessageChannel();
      retainedPorts.push(reply.port1);
      reply.port1.onmessage = event => {
        if (event.data?.type !== "fixture-ping") return;
        reply.port1.postMessage({ type: "fixture-pong", requestId: event.data.requestId, nonce, counter });
      };
      reply.port1.start();
      transfer.push(reply.port2);
      window.__fixturePorts = retainedPorts;
      window.postMessage({
        type: "init",
        ports,
        replyPort: reply.port2,
      }, location.origin, transfer);
    </script>
  </body>
</html>`;

const FIXTURE_PARTITION = buildMcpAppSandboxPartition("source-0123456789abcdef");

const OWNER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src nodex-mcp-sandbox:; child-src nodex-mcp-sandbox:">
    <style>webview{display:flex;width:600px;height:240px}#fixture-parking{display:none}</style>
    <title>MCP Sandbox Fixture</title>
  </head>
  <body>
    <main id="status">starting</main>
    <div id="fixture-inline"></div><div id="fixture-panel"></div><div id="fixture-parking"></div>
    <script>${readFileSync(path.join(__dirname, "owner-script.js"), "utf8")}</script>
    <script>
      window.fixtureState = {
        didAttachAccepted: null,
        didAttachSessionMatched: null,
        didAttachUrl: null,
        error: null,
        guestId: null,
        handshake: false,
        portCount: 0,
        webviewCount: 0,
      };
      const sandbox = ${JSON.stringify({
        partition: FIXTURE_PARTITION,
        sourceUrl: appendMcpAppSandboxInitId(buildMcpAppSandboxSourceUrl({
          locale: "en-US",
          subdomain: "mcp-calendar-fixture",
        }), "fixture-init"),
      })};
      window.addEventListener("message", (event) => {
        if (event.data?.type !== "init") return;
        window.fixtureState.handshake = true;
        window.fixtureState.portCount = event.ports.length;
        document.querySelector("#status").textContent = "ready";
      });
      function attach(sandbox, repeated) {
        const webview = document.createElement("webview");
        webview.setAttribute("partition", sandbox.partition);
        webview.setAttribute("src", sandbox.sourceUrl);
        webview.addEventListener("dom-ready", () => {
          if (!repeated) window.fixtureState.guestId = webview.getWebContentsId();
        });
        webview.addEventListener("did-fail-load", () => {
          if (!repeated) window.fixtureState.error = "did-fail-load";
        });
        webview.addEventListener("console-message", (event) => {
          window.fixtureState.error = "guest-console:" + event.message;
        });
        webview.addEventListener("preload-error", () => {
          window.fixtureState.error = "preload-error";
        });
        if (repeated) document.body.append(webview);
        else {
          const frame = document.createElement("div");
          frame.id = "fixture-frame";
          frame.append(webview);
          document.getElementById("fixture-inline").append(frame);
        }
        window.fixtureState.webviewCount = document.querySelectorAll("webview").length;
        setTimeout(() => {
          if (window.fixtureState.handshake) return;
          try {
            window.fixtureState.error = "webview-timeout:id=" + webview.getWebContentsId()
              + ";src=" + webview.getAttribute("src")
              + ";partition=" + webview.getAttribute("partition");
          } catch (error) {
            window.fixtureState.error = "webview-timeout:" + String(error?.stack || error);
          }
        }, 5_000);
      }
      window.attachAgain = () => attach(sandbox, true);
      try {
        attach(sandbox, false);
      } catch (error) {
        window.fixtureState.error = String(error?.stack || error);
      }
    </script>
  </body>
</html>`;

const program = Effect.scoped(
  Effect.gen(function* () {
  yield* Effect.promise(() => app.whenReady());
  const ownerWindow = new BrowserWindow({
    width: 720,
    height: 520,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "owner-preload.js"),
      sandbox: true,
      webviewTag: true,
    },
  });
  const sandboxContext = yield* Layer.build(
    mcpAppSandboxRuntimeLive({
      allowLocalDevelopment: false,
      fetch: async () =>
        new Response(SKYBRIDGE_HTML, {
          headers: {
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
            "Content-Type": "text/html; charset=utf-8",
          },
        }),
      guestPreloadPath: path.join(__dirname, "mcp-app-sandbox-guest.js"),
      logger: {
        error: (message: string) => {
          void ownerWindow.webContents.executeJavaScript(
            `window.fixtureState.error = ${JSON.stringify(message)}`,
            false,
          );
        },
        warn: (message: string) => {
          void ownerWindow.webContents.executeJavaScript(
            `window.fixtureState.error = ${JSON.stringify(message)}`,
            false,
          );
        },
      } as never,
      platform: process.platform,
    }),
  );
  const sandbox = Context.get(sandboxContext, McpAppSandboxRuntime);
  const host = sandbox.createHost(ownerWindow.webContents);

  ownerWindow.webContents.on("will-attach-webview", (event, preferences, params) => {
    try {
      if (!host.handlesPartition(params.partition)) {
        event.preventDefault();
        return;
      }
      host.handleWillAttach(event, preferences, params);
    } catch (error) {
      event.preventDefault();
      void ownerWindow.webContents.executeJavaScript(
        `window.fixtureState.error = ${JSON.stringify("will-attach:")} + ${JSON.stringify(String(error))}`,
        false,
      );
    }
  });
  ownerWindow.webContents.on("did-attach-webview", (_event, guest) => {
    const didAttachUrl = guest.getURL();
    const didAttachSessionMatched = guest.session === session.fromPartition(FIXTURE_PARTITION);
    const didAttachAccepted = host.handleDidAttach(guest);
    void ownerWindow.webContents.executeJavaScript(
      `Object.assign(window.fixtureState, ${JSON.stringify({
        didAttachAccepted,
        didAttachSessionMatched,
        didAttachUrl,
      })})`,
      false,
    );
    if (!didAttachAccepted) {
      guest.close();
      return;
    }
    void ownerWindow.webContents.executeJavaScript(
      `window.fixtureState.guestId = ${guest.id}`,
      false,
    );
  });
  yield* Effect.promise(() =>
    ownerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OWNER_HTML)}`),
  );
  yield* Effect.callback<void>((resume) => {
    const onBeforeQuit = () => resume(Effect.void);
    app.once("before-quit", onBeforeQuit);
    return Effect.sync(() => app.removeListener("before-quit", onBeforeQuit));
  });
  }),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
