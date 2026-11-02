/** Keep test pages paintable and controllable through CDP without interrupting the desktop. */
const electron = require("electron");
const { app, BrowserWindow } = electron;

if (process.type !== "browser") throw new Error("Background test windows apply to Main only");

const conceal = (window) => {
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  window.setFocusable(false);
};
app.on("browser-window-created", (_event, window) => conceal(window));

const showInactive = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.showInactive = function () {
  conceal(this);
  showInactive.call(this);
};
BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.focus = function () {
  if (!this.isVisible()) this.showInactive();
};
app.focus = () => {};

// Native construction with show:true calls AppKit directly, bypassing prototype.show.
// Always construct hidden, then reveal without activation after applying the policy.
const TestBrowserWindow = new Proxy(BrowserWindow, {
  construct(Target, [options = {}], newTarget) {
    const window = Reflect.construct(
      Target,
      [{ ...options, show: false, opacity: 0, focusable: false }],
      newTarget,
    );
    if (options.show !== false) window.showInactive();
    return window;
  },
});
// Electron's API getters are non-configurable. Replace its test-process module facade,
// retaining lazy getters for every other API.
const { Module } = require("node:module");
const descriptors = Object.getOwnPropertyDescriptors(electron);
descriptors.BrowserWindow = { enumerable: true, value: TestBrowserWindow };
const facade = Object.defineProperties({}, descriptors);
for (const id of ["electron", "electron/main", "electron/common"]) {
  const module = new Module(id);
  module.filename = id;
  module.loaded = true;
  module.exports = facade;
  require.cache[id] = module;
}
if (require("electron").BrowserWindow !== TestBrowserWindow)
  throw new Error("Electron did not install the background test constructor");

if (process.platform === "darwin")
  void app.whenReady().then(() => app.setActivationPolicy("accessory"));
