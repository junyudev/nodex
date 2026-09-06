import path from "node:path";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import { registerAppProtocol } from "../../../src/main/app-protocol";
import { registerNodexPrivilegedSchemes } from "../../../src/main/privileged-schemes";

app.setPath("userData", path.join(__dirname, "profile"));
registerNodexPrivilegedSchemes();
void app.whenReady().then(async () => {
  const socketUrl = process.env.NODEX_TEST_DICTATION_SOCKET_URL;
  if (!socketUrl) throw new Error("Missing fixture WebSocket URL");
  // Trust only this fixture's ephemeral loopback certificate.
  session.defaultSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === "127.0.0.1" ? 0 : -3));
  const dispose = registerAppProtocol(session.defaultSession, {
    rendererRoot: path.join(__dirname, "renderer"), getDevelopmentRendererUrl: () => null, protocol,
  });
  const window = new BrowserWindow({ show: true, webPreferences: {
    preload: path.join(__dirname, "preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  ipcMain.handle("codex:dictation:streaming-connect-info:read", (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted fixture renderer");
    return { websocketUrl: socketUrl, protocols: ["chatgpt-dictation", "openai-bearer.fixture-token", "codex-desktop"] };
  });
  app.on("before-quit", dispose);
  await window.loadURL("app://-/index.html");
});
