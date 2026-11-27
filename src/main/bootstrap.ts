import { createRequire, enableCompileCache, flushCompileCache } from "node:module";
import { app } from "electron";
import { mainCompileCacheDirectory } from "./main-compile-cache";

if (process.argv.includes("--nodex-visual-worker")) {
  // A Visual check runs in a short-lived worker that never starts the desktop application.
  createRequire(__filename)("./visual-worker.js");
} else {
  // Once Nodex has run, Node compiles its Main code from the cache instead of from source. The
  // cache applies only to code loaded after it is enabled, so the application is required here
  // rather than imported: a static import would load it first.
  const directory = mainCompileCacheDirectory({
    isPackaged: app.isPackaged,
    platform: process.platform,
    home: app.getPath("home"),
    environment: process.env,
    appName: app.getName(),
  });
  if (directory) {
    enableCompileCache(directory);
    // Persist what startup compiled even if the process later ends without a clean exit.
    void app.whenReady().then(() => setTimeout(() => flushCompileCache(), 30_000).unref());
  }
  createRequire(__filename)("./main-process.js");
}
