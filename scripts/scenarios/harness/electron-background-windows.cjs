/**
 * E2E windows paint, run animation frames and take Playwright's input without taking the
 * screen, the Dock or the keyboard from the person using this computer. Playwright drives pages
 * through the DevTools protocol, which needs neither a visible nor an active window. Specs that
 * assert real window focus or native window chrome launch with foreground windows instead.
 */
const { app, BrowserWindow } = require("electron");

if (process.type !== "browser") throw new Error("Background E2E windows apply to Main only");

const showInactive = BrowserWindow.prototype.showInactive;
const conceal = (window) => {
  // Fully transparent and click-through: nothing appears or intercepts the person's pointer.
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
};
BrowserWindow.prototype.showInactive = function () {
  conceal(this);
  showInactive.call(this);
};
BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive;
// Focusing a window activates the app over the person's work; pages keep Playwright's focus
// emulation, so focused editing and keyboard input still behave as in the foreground.
BrowserWindow.prototype.focus = function () {
  if (!this.isVisible()) this.showInactive();
};
app.focus = () => {};
if (process.platform === "darwin")
  void app.whenReady().then(() => app.setActivationPolicy("accessory"));
