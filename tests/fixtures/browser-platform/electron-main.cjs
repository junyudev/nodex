const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");

const browserPartition = "persist:nodex-browser-integration";

if (process.env.NODEX_BROWSER_INTEGRATION_USER_DATA) {
  app.setPath("userData", process.env.NODEX_BROWSER_INTEGRATION_USER_DATA);
}

void app.whenReady().then(async () => {
  const browserSession = session.fromPartition(browserPartition);
  const shouldGrantPermission = (permission, details) =>
    details.isMainFrame === true
    && permission === "clipboard-sanitized-write";
  browserSession.setPermissionCheckHandler(
    (_webContents, permission, _origin, details) =>
      shouldGrantPermission(permission, details),
  );
  browserSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(shouldGrantPermission(permission, details));
    },
  );

  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  window.webContents.on(
    "will-attach-webview",
    (_event, webPreferences, params) => {
      Object.assign(webPreferences, {
        allowRunningInsecureContent: false,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        partition: browserPartition,
        plugins: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      });
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      params.partition = browserPartition;
      delete params.nodeintegration;
      delete params.preload;
      delete params.webpreferences;
    },
  );
  window.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
  });
  await window.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
