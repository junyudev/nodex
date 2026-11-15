const { app, BrowserWindow, session, dialog } = require("electron");
const path = require("node:path");

// CommonJS mirror of BrowserPageDialogAdapter's internal Electron seam.
const pageDialogs = { requests: [], nativeBoxCalls: 0, accept: false, pending: null };
globalThis.browserPlatformPageDialogs = pageDialogs;
dialog.showMessageBox = async () => {
  pageDialogs.nativeBoxCalls += 1;
  return { response: 1, checkboxChecked: false };
};

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
        // Without this Chromium drops the request before the window-open handler.
        disablePopups: false,
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
  const windowOpenRequests = [];
  globalThis.browserPlatformWindowOpenRequests = windowOpenRequests;
  window.webContents.on("did-attach-webview", (_event, guest) => {
    guest.removeAllListeners("-run-dialog");
    guest.on("-run-dialog", (info, callback) => {
      pageDialogs.requests.push({
        dialogType: info.dialogType,
        messageText: info.messageText,
        frameUrl: info.frame.url,
        mainFrame: info.frame === guest.mainFrame,
      });
      pageDialogs.pending = callback;
      if (typeof pageDialogs.accept !== "boolean") return;
      pageDialogs.pending = null;
      callback(pageDialogs.accept, "");
    });
    const settle = () => { pageDialogs.pending = null; };
    guest.on("-cancel-dialogs", settle);
    guest.debugger.on("message", (_event, method) => {
      if (method === "Page.javascriptDialogClosed") settle();
    });
    guest.setWindowOpenHandler(({ url, disposition }) => {
      windowOpenRequests.push({ url, disposition });
      return { action: "deny" };
    });
  });
  await window.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
