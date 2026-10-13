import { afterEach, describe, expect, test } from "vite-plus/test";
import { appCloseFlushTestHelpers } from "./app-close-flush";
import type { TelemetrySettings } from "./types";
import {
  filterStatsigAutoCaptureEvent,
  initializeRendererTelemetry,
  logTelemetryEvent,
  normalizeTelemetryMetadata,
  resetRendererTelemetryForTests,
} from "./statsig-telemetry";

type InitializeTelemetryInput = NonNullable<Parameters<typeof initializeRendererTelemetry>[0]>;
type TestStatsigAdapter = NonNullable<InitializeTelemetryInput["adapter"]>;
type TestStatsigAutoCaptureOptions = Parameters<TestStatsigAdapter["createAutoCapturePlugin"]>[0];

function buildSettings(
  enabled: boolean,
  overrides: Partial<TelemetrySettings> = {},
): TelemetrySettings {
  return {
    enabled,
    clientKey: enabled ? "client-test" : "",
    environment: "test",
    autoCaptureEnabled: false,
    envOverrides: {
      enabled: false,
      clientKey: false,
      environment: false,
      autoCaptureEnabled: false,
    },
    ...overrides,
  };
}

function buildAdapter() {
  const state = {
    autoCaptureOptions: [] as Record<string, unknown>[],
    boundAutoCaptureClient: null as unknown,
    createClientCalls: [] as Array<{
      sdkKey: string;
      user: Record<string, unknown>;
      options: Record<string, unknown>;
    }>,
    initializeCount: 0,
    loggedEvents: [] as Array<{
      eventName: string;
      value?: string | number;
      metadata?: Record<string, string>;
    }>,
    shutdownCount: 0,
  };

  const client = {
    _possibleFirstTouchMetadata: {},
    _user: {},
    initializeAsync: async () => {
      state.initializeCount += 1;
      const options = state.createClientCalls[state.createClientCalls.length - 1]?.options;
      const plugins = options?.plugins as Array<{ bind?: (client: unknown) => void }> | undefined;
      for (const plugin of plugins ?? []) {
        plugin.bind?.(client);
      }
    },
    logEvent: (eventName: string, value?: string | number, metadata?: Record<string, string>) => {
      state.loggedEvents.push({ eventName, value, metadata });
    },
    shutdown: async () => {
      state.shutdownCount += 1;
    },
  };

  return {
    state,
    adapter: {
      createAutoCapturePlugin: (options: TestStatsigAutoCaptureOptions) => {
        state.autoCaptureOptions.push(options as unknown as Record<string, unknown>);
        return {
          __plugin: "auto-capture",
          bind: (client: unknown) => {
            state.boundAutoCaptureClient = client;
          },
        };
      },
      createClient: (
        sdkKey: string,
        user: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        state.createClientCalls.push({ sdkKey, user, options });
        return client;
      },
    },
  };
}

describe("Statsig renderer telemetry", () => {
  afterEach(() => {
    delete process.env.NODEX_TELEMETRY_FORCE_TEST;
    resetRendererTelemetryForTests();
  });

  test("does not create telemetry clients in tests without explicit initialization", async () => {
    const { adapter, state } = buildAdapter();
    let settingsRead = false;
    const initialized = await initializeRendererTelemetry({
      getSettings: async () => {
        settingsRead = true;
        return buildSettings(true);
      },
      adapter,
    });

    expect(initialized).toBe(false);
    expect(settingsRead).toBe(false);
    expect(state.createClientCalls).toHaveLength(0);
  });

  test("does not initialize when telemetry is disabled", async () => {
    process.env.NODEX_TELEMETRY_FORCE_TEST = "1";
    const { adapter, state } = buildAdapter();

    const initialized = await initializeRendererTelemetry({
      getSettings: async () => buildSettings(false),
      adapter,
    });

    expect(initialized).toBe(false);
    expect(state.initializeCount).toBe(0);
    expect(state.createClientCalls.length).toBe(0);
    expect(state.autoCaptureOptions.length).toBe(0);
  });

  test("creates an anonymous Statsig client with privacy-safe AutoCapture options", async () => {
    process.env.NODEX_TELEMETRY_FORCE_TEST = "1";
    const { adapter, state } = buildAdapter();

    const initialized = await initializeRendererTelemetry({
      getSettings: async () =>
        buildSettings(true, {
          clientKey: "client-custom",
          environment: "staging",
          autoCaptureEnabled: true,
        }),
      adapter,
    });

    expect(initialized).toBe(true);
    expect(state.initializeCount).toBe(1);
    expect(state.createClientCalls.length).toBe(1);
    expect(state.createClientCalls[0]?.sdkKey).toBe("client-custom");

    const user = state.createClientCalls[0]?.user ?? {};
    expect("userID" in user).toBe(false);
    expect("email" in user).toBe(false);
    expect("customIDs" in user).toBe(false);
    expect((user.custom as Record<string, unknown> | undefined)?.app).toBe("nodex");

    const options = state.createClientCalls[0]?.options ?? {};
    expect((options.environment as Record<string, unknown> | undefined)?.tier).toBe("staging");
    expect(options.includeCurrentPageUrlWithEvents).toBe(false);
    const plugins = options.plugins as unknown[] | undefined;
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins?.length).toBe(1);

    const autoCaptureOptions = state.autoCaptureOptions[0] ?? {};
    expect(autoCaptureOptions.captureCopyText).toBe(false);
    expect(
      (autoCaptureOptions.consoleLogAutoCaptureSettings as Record<string, unknown> | undefined)
        ?.enabled,
    ).toBe(false);
    expect(typeof autoCaptureOptions.eventFilterFunc).toBe("function");

    const boundClient = state.boundAutoCaptureClient as {
      _possibleFirstTouchMetadata?: Record<string, unknown>;
      _user?: Record<string, unknown>;
    };
    boundClient._possibleFirstTouchMetadata = { referrer: "https://example.test/private" };
    boundClient._user = { analyticsOnlyMetadata: { searchQuery: "private" } };
    const eventFilter = autoCaptureOptions.eventFilterFunc as (event: {
      eventName: string;
      metadata?: Record<string, unknown>;
    }) => boolean;
    expect(eventFilter({ eventName: "auto_capture::session_start", metadata: {} })).toBe(true);
    expect(Object.keys(boundClient._possibleFirstTouchMetadata ?? {}).length).toBe(0);
    expect("analyticsOnlyMetadata" in (boundClient._user ?? {})).toBe(false);
  });

  test("filters AutoCapture to technical events and removes page metadata", () => {
    const allowedEvent = {
      eventName: "auto_capture::web_vitals",
      value: "LCP",
      metadata: {
        current_url: "https://example.test/?q=secret",
        hostname: "example.test",
        pathname: "/thread/abc",
        selector: "button[data-value='secret']",
        title: "Thread with private prompt",
        user_agent: "Browser",
      },
    };

    expect(filterStatsigAutoCaptureEvent(allowedEvent)).toBe(true);
    expect(allowedEvent.value).toBe("renderer");
    expect("current_url" in allowedEvent.metadata).toBe(false);
    expect("hostname" in allowedEvent.metadata).toBe(false);
    expect("pathname" in allowedEvent.metadata).toBe(false);
    expect("selector" in allowedEvent.metadata).toBe(false);
    expect("title" in allowedEvent.metadata).toBe(false);
    expect(allowedEvent.metadata.user_agent).toBe("Browser");

    expect(filterStatsigAutoCaptureEvent({ eventName: "auto_capture::click" })).toBe(false);
    expect(filterStatsigAutoCaptureEvent({ eventName: "auto_capture::copy" })).toBe(false);
    expect(filterStatsigAutoCaptureEvent({ eventName: "auto_capture::form_submit" })).toBe(false);
    expect(filterStatsigAutoCaptureEvent({ eventName: "auto_capture::dead_click" })).toBe(false);
    expect(filterStatsigAutoCaptureEvent({ eventName: "auto_capture::rage_click" })).toBe(false);
    expect(filterStatsigAutoCaptureEvent({ eventName: "auto_capture::error" })).toBe(false);
    expect(filterStatsigAutoCaptureEvent({ eventName: "auto_capture::page_view" })).toBe(false);
    expect(filterStatsigAutoCaptureEvent({ eventName: "auto_capture::page_view_end" })).toBe(false);
  });

  test("normalizes manual telemetry metadata before logging", async () => {
    process.env.NODEX_TELEMETRY_FORCE_TEST = "1";
    const { adapter, state } = buildAdapter();

    await initializeRendererTelemetry({
      getSettings: async () => buildSettings(true),
      adapter,
    });

    const logged = logTelemetryEvent(" nodex:test_event ", 12, {
      kind: "page",
      prompt: "private prompt",
      cwd: "/Users/alice/project",
      notes: "Open https://example.test/private from /home/alice/repo",
      durationMs: 42,
    });

    expect(logged).toBe(true);
    expect(state.loggedEvents.length).toBe(1);
    expect(state.loggedEvents[0]?.eventName).toBe("nodex:test_event");
    expect(state.loggedEvents[0]?.value).toBe(12);
    const metadata = state.loggedEvents[0]?.metadata ?? {};
    expect(metadata.kind).toBe("page");
    expect(metadata.durationMs).toBe("42");
    expect(metadata.notes).toBe("Open [url] from /home/[user]/repo");
    expect("prompt" in metadata).toBe(false);
    expect("cwd" in metadata).toBe(false);

    expect(logTelemetryEvent("  ")).toBe(false);
  });

  test("exposes metadata normalization as a pure helper", () => {
    const normalized =
      normalizeTelemetryMetadata({
        action: "create",
        attachmentPath: "/Users/alice/secret.png",
        url: "https://example.test/secret",
        message: "x".repeat(250),
      }) ?? {};

    expect(normalized.action).toBe("create");
    expect("attachmentPath" in normalized).toBe(false);
    expect("url" in normalized).toBe(false);
    expect(normalized.message.length).toBe(200);
    expect(normalized.message.endsWith("...")).toBe(true);
  });

  test("flushes Statsig on app close and disables later logging", async () => {
    process.env.NODEX_TELEMETRY_FORCE_TEST = "1";
    const { adapter, state } = buildAdapter();

    const initialized = await initializeRendererTelemetry({
      getSettings: async () => buildSettings(true),
      adapter,
    });

    expect(initialized).toBe(true);
    expect(logTelemetryEvent("nodex:before_close")).toBe(true);

    await appCloseFlushTestHelpers.flushHandlers();

    expect(state.shutdownCount).toBe(1);
    expect(logTelemetryEvent("nodex:after_close")).toBe(false);
  });
});
