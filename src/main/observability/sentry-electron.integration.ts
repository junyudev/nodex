import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { ElectronApplication } from "playwright";
import { expect, test } from "vite-plus/test";
import { launchTestElectron } from "../../../scripts/testing/launch-electron";
import type { DiagnosticsSettings } from "../../shared/types";

// The script below is a string, so its settings are typed out here for the compiler to check.
const SETTINGS: DiagnosticsSettings = {
  enabled: true,
  active: true,
  blockedBy: null,
  dsn: "https://public@example.invalid/1",
  environment: "test",
  release: null,
  tracesSampleRate: 1,
  replayEnabled: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  envOverrides: {
    enabled: false,
    dsn: false,
    environment: false,
    release: false,
    tracesSampleRate: false,
    replayEnabled: false,
    replaysSessionSampleRate: false,
    replaysOnErrorSampleRate: false,
  },
};

// Exercise the actual Electron SDK and streamed envelope path without a remote transport.
test("keeps crash diagnostics and streamed spans private in Electron", async () => {
  mkdirSync(".generated", { recursive: true });
  const directory = mkdtempSync(path.resolve(".generated/sentry-integration-"));
  let application: ElectronApplication | null = null;
  try {
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
          import { app } from "electron";
          import * as Sentry from "@sentry/electron/main";
          import { electronMainSentryAdapter } from "./src/main/observability/sentry-electron-main-adapter";
          import { initializeMainSentry, captureMainException, runMainTraceSpan, shutdownMainSentry } from "./src/main/observability/sentry-main";
          app.setPath("userData", ${JSON.stringify(path.join(directory, "profile"))});
          const envelopes = [];
          process.env.NODEX_SENTRY_FORCE_TEST = "1";
          globalThis.diagnosticsProbe = (async () => {
            await initializeMainSentry({
              appVersion: "0.0.0", arch: process.arch, platform: process.platform, isPackaged: false,
              settings: ${JSON.stringify(SETTINGS)},
              subscribeToLogs: () => () => {},
              adapter: {
                ...electronMainSentryAdapter,
                init: (options) => Sentry.init({
                  ...options, defaultIntegrations: false, ipcMode: 0,
                  transport: () => ({
                    send: (envelope) => { envelopes.push(envelope); return Promise.resolve({}); },
                    flush: () => Promise.resolve(true),
                  }),
                }),
              },
            });
            captureMainException(new Error("Failed at /Users/alice/private"), {
              extra: { prompt: "private prompt", token: "private token" },
            });
            const trace = runMainTraceSpan({
              name: "Read /Users/alice/private", op: "file.read", root: true,
              attributes: { prompt: "private prompt", "url.full": "https://example.com/read?secret=value" },
            }, (trace) => trace);
            Sentry.logger.info("private log");
            await shutdownMainSentry();
            return { envelopes, trace };
          })();
        `,
      },
      bundle: true,
      packages: "external",
      platform: "node",
      format: "cjs",
      target: "node24",
      outfile: path.join(directory, "main.cjs"),
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
      ),
    ) as Record<string, string>;
    application = await launchTestElectron({
      args: [path.join(directory, "main.cjs")],
      env,
    });
    const result = await application.evaluate(async () => {
      return (
        globalThis as unknown as {
          diagnosticsProbe: Promise<{ envelopes: unknown[]; trace: { traceparent: string } }>;
        }
      ).diagnosticsProbe;
    });
    expect(result.trace.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    const serialized = JSON.stringify(result.envelopes);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("/Users/[user]/private");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private token");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("secret=value");
    expect(serialized).not.toContain("private log");
    const itemTypes = (result.envelopes as [unknown, [{ type: string }, unknown][]][]).flatMap(
      ([, items]) => items.map(([header]) => header.type),
    );
    expect(itemTypes).toContain("event");
    expect(itemTypes).toContain("span");
    expect(itemTypes).not.toContain("log");
    const spanEnvelope = (
      result.envelopes as [
        unknown,
        [{ type: string }, { items?: { attributes: Record<string, { value: unknown }> }[] }][],
      ][]
    )
      .flatMap(([, items]) => items)
      .find(([header]) => header.type === "span");
    expect(spanEnvelope?.[1].items?.[0].attributes).toMatchObject({
      process: { value: "main" },
      platform: { value: process.platform },
      arch: { value: process.arch },
      packaged: { value: "false" },
    });
  } finally {
    await application?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
