import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DiagnosticsSettings } from "../../shared/types";
import {
  captureMainException,
  initializeMainSentry,
  resetMainSentryForTests,
  runMainTraceSpan,
} from "./sentry-main";

function buildSettings(overrides: Partial<DiagnosticsSettings> = {}): DiagnosticsSettings {
  return {
    enabled: true,
    dsn: "https://example.com/1",
    environment: "test",
    release: "nodex@test",
    tracesSampleRate: 0,
    replayEnabled: false,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
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
    ...overrides,
  };
}

describe("main Sentry diagnostics", () => {
  afterEach(() => {
    delete process.env.NODEX_SENTRY_FORCE_TEST;
    resetMainSentryForTests();
  });

  test("does not initialize in test runtime unless explicitly forced", async () => {
    let initCount = 0;
    const initialized = await initializeMainSentry({
      appVersion: "0.1.0",
      arch: "arm64",
      isPackaged: false,
      platform: "darwin",
      settings: buildSettings(),
      adapter: {
        addBreadcrumb: () => {},
        captureException: () => undefined,
        captureMessage: () => undefined,
        close: async () => true,
        init: () => {
          initCount += 1;
        },
        setTag: () => {},
      },
    });

    expect(initialized).toBe(false);
    expect(initCount).toBe(0);
  });

  test("initializes an injected adapter synchronously", async () => {
    process.env.NODEX_SENTRY_FORCE_TEST = "1";
    let initCount = 0;
    const initialized = initializeMainSentry({
      appVersion: "0.1.0",
      arch: "arm64",
      isPackaged: false,
      platform: "darwin",
      settings: buildSettings(),
      adapter: {
        addBreadcrumb: () => {},
        captureException: () => undefined,
        captureMessage: () => undefined,
        close: async () => true,
        init: () => {
          initCount += 1;
        },
        setTag: () => {},
      },
    });

    expect(initCount).toBe(1);
    expect(await initialized).toBe(true);
  });

  test("captures errors with scrubbed context when enabled", async () => {
    process.env.NODEX_SENTRY_FORCE_TEST = "1";
    let capturedHint: unknown = null;
    const initialized = await initializeMainSentry({
      appVersion: "0.1.0",
      arch: "arm64",
      isPackaged: true,
      platform: "darwin",
      settings: buildSettings(),
      adapter: {
        addBreadcrumb: () => {},
        captureException: (_error, hint) => {
          capturedHint = hint;
          return "event-id";
        },
        captureMessage: () => undefined,
        close: async () => true,
        init: () => {},
        setTag: () => {},
      },
    });

    expect(initialized).toBe(true);
    captureMainException(new Error("boom"), {
      tags: { channel: "settings:diagnostics:update" },
      extra: {
        argCount: 1,
        prompt: "private prompt",
        cwd: "/Users/alice/project",
      },
    });

    const hint = capturedHint as { extra?: Record<string, unknown>; tags?: Record<string, string> };
    expect(hint.tags?.channel).toBe("settings:diagnostics:update");
    expect(hint.extra?.prompt).toBe("[REDACTED]");
    expect(hint.extra?.cwd).toBe("/Users/[user]/project");
  });

  test("preserves an incoming W3C trace when tracing is inactive", () => {
    const trace = {
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      tracestate: "vendor=value",
    };
    expect(
      runMainTraceSpan({ name: "test", op: "test", trace }, (activeTrace) => activeTrace),
    ).toEqual(trace);
  });
});
