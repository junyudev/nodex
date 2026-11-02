const { app, BrowserWindow } = require("electron");
const { BrowserWindow: MainBrowserWindow } = require("electron/main");

app.setPath("userData", process.argv[process.argv.indexOf("--home") + 1]);
app.on("window-all-closed", () => {});
const shows = [];
let focusEvents = 0;
const snapshot = (window) => ({
  visible: window.isVisible(),
  focused: window.isFocused(),
  focusable: window.isFocusable(),
  opacity: window.getOpacity(),
});
app.on("browser-window-focus", () => focusEvents++);
app.on("browser-window-created", (_event, window) => {
  window.on("show", () => shows.push(snapshot(window)));
});

void app.whenReady().then(async () => {
  const automatic = new BrowserWindow({ show: true, opacity: 1, focusable: true });
  const implicit = new MainBrowserWindow();
  const deferred = new BrowserWindow({ show: false });
  globalThis.testWindows = {
    automaticId: automatic.id,
    deferredId: deferred.id,
    facts: () => ({
      windows: BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id).map(snapshot),
      shows,
      focusEvents,
      dockVisible: app.dock?.isVisible(),
    }),
  };
  const html = `<!doctype html><style>body{background:rgb(12,34,56)}</style>
    <input aria-label="Message"><button onclick="document.querySelector('output').value=document.querySelector('input').value">Apply</button><output></output>`;
  await automatic.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  await implicit.loadURL("about:blank");
  await deferred.loadURL("about:blank");
});
