const { app, BrowserWindow } = require("electron");
const path = require("node:path");

if (!process.env.NODEX_CLIPBOARD_TEST_HOME) throw new Error("A disposable home is required");
app.setPath("userData", process.env.NODEX_CLIPBOARD_TEST_HOME);
app.clipboardBridge = require(
  path.join(process.cwd(), ".generated", "clipboard-runtime", process.arch, "nodex-clipboard.node"),
);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 640,
    height: 400,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  void window.loadFile(path.join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
