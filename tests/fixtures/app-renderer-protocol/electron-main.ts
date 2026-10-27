import path from "node:path";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  app,
  BrowserWindow,
  protocol,
  session,
} from "electron";
import { registerAppProtocol } from "../../../src/main/app-protocol";
import { registerNodexPrivilegedSchemes } from "../../../src/main/privileged-schemes";
import { APP_RENDERER_URL } from "../../../src/shared/app-renderer-policy";

const diagnosticsScheme: Electron.CustomScheme = {
  scheme: "nodex-test-diagnostics",
  privileges: {
    corsEnabled: true,
    secure: true,
    supportFetchAPI: true,
  },
};

// Diagnostics SDKs can register their own privileged protocol before wrapping
// later application registrations. The production origin must remain secure in
// the combined registration, not only when tested in isolation.
protocol.registerSchemesAsPrivileged([diagnosticsScheme]);
registerNodexPrivilegedSchemes((schemes) => {
  protocol.registerSchemesAsPrivileged([...schemes, diagnosticsScheme]);
});

void app.whenReady().then(async () => {
  const developmentRendererUrl = process.env.NODEX_TEST_RENDERER_URL?.trim() || null;
  const disposeProtocol = registerAppProtocol(session.defaultSession, {
    rendererRoot: path.join(__dirname, "renderer"),
    getDevelopmentRendererUrl: () => developmentRendererUrl,
    protocol,
    // Keep the long audio fixture partially buffered so seeking must request another range.
    ...(process.env.NODEX_TEST_SLOW_MEDIA === "1" ? {
      createStream: (filePath, options) => Readable.from((async function* () {
        const stream = createReadStream(filePath, { ...options, highWaterMark: 16_384 });
        for await (const bytes of stream) {
          if (filePath.endsWith(".wav")) await delay(10);
          yield bytes;
        }
      })()),
    } : {}),
  });
  app.once("before-quit", disposeProtocol);
  const window = new BrowserWindow({
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(developmentRendererUrl ?? APP_RENDERER_URL);
});
