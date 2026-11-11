import path from "node:path";
import { createReadStream, mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { format } from "node:util";
import {
  app,
  BrowserWindow,
  protocol,
  session,
} from "electron";
import { registerAppProtocol } from "../../../src/main/app-protocol";
import { registerNodexPrivilegedSchemes } from "../../../src/main/privileged-schemes";
import { APP_RENDERER_URL } from "../../../src/shared/app-renderer-policy";

export interface ProtocolImageFixtureControl {
  readonly requested: Promise<void>;
  readonly consoleErrors: readonly string[];
  readonly fileReads: readonly string[];
  readonly failures: readonly {
    readonly url: string;
    readonly error: string;
    readonly initiatorOrigin?: string;
    readonly frameUrl?: string;
  }[];
  release(): void;
}

function createSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Chromium's caches and session files belong to this disposable application.
if (!app.commandLine.hasSwitch("user-data-dir")) {
  const userData = mkdtempSync(path.join(__dirname, "profile-"));
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
}

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
  const holdImages = process.env.NODEX_TEST_HOLD_PROTOCOL_IMAGES === "1";
  const imageRequested = createSignal();
  const imageReleased = createSignal();
  const fileReads: string[] = [];
  if (holdImages) {
    const consoleErrors: string[] = [];
    const logError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(format(...args));
      logError(...args);
    };
    const failures: ProtocolImageFixtureControl["failures"][number][] = [];
    session.defaultSession.webRequest.onErrorOccurred({ urls: ["app://fs/*"] }, (details) => {
      failures.push({
        url: details.url,
        error: details.error,
        initiatorOrigin: details.initiatorOrigin,
        frameUrl: details.frame?.url,
      });
    });
    const control: ProtocolImageFixtureControl = {
      requested: imageRequested.promise,
      consoleErrors,
      fileReads,
      failures,
      release: () => imageReleased.resolve(),
    };
    Reflect.set(globalThis, "nodexProtocolImages", control);
    app.once("before-quit", control.release);
  }
  const disposeProtocol = registerAppProtocol(session.defaultSession, {
    rendererRoot: path.join(__dirname, "renderer"),
    getDevelopmentRendererUrl: () => developmentRendererUrl,
    protocol,
    ...(holdImages ? {
      stat: async (filePath) => {
        fileReads.push(filePath);
        if (filePath.endsWith(".png")) {
          imageRequested.resolve();
          await imageReleased.promise;
        }
        return await stat(filePath);
      },
    } : {}),
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
