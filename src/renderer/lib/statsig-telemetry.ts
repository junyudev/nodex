import { isTelemetrySettings } from "../../shared/diagnostics/telemetry-settings";
import { invokeRendererQuery as invoke } from "./renderer-command";
import { registerAppCloseFlushHandler } from "./app-close-flush";
import type { TelemetrySettings } from "./types";

type TelemetryMetadataValue = string | number | boolean | null | undefined;
export type TelemetryMetadata = Record<string, TelemetryMetadataValue>;

interface StatsigClientLike {
  initializeAsync: () => Promise<unknown>;
  logEvent: (eventName: string, value?: string | number, metadata?: Record<string, string>) => void;
  shutdown: () => Promise<void>;
}

interface StatsigPluginLike {
  __plugin?: string;
  bind: (client: unknown) => void;
}

interface StatsigTelemetryAdapter {
  createAutoCapturePlugin: (options: StatsigAutoCaptureOptions) => StatsigPluginLike;
  createClient: (
    sdkKey: string,
    user: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => StatsigClientLike;
}

interface InitializeRendererTelemetryInput {
  adapter?: StatsigTelemetryAdapter;
  getSettings?: () => Promise<TelemetrySettings | null>;
}

interface RendererProcessLike {
  env?: Record<string, string | undefined>;
  argv?: string[];
}

interface StatsigAutoCaptureEventLike {
  eventName: string;
  value?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

interface StatsigAutoCaptureOptions {
  captureCopyText: false;
  consoleLogAutoCaptureSettings: { enabled: false };
  eventFilterFunc: (event: StatsigAutoCaptureEventLike) => boolean;
}

const ALLOWED_AUTO_CAPTURE_EVENTS = new Set([
  "auto_capture::performance",
  "auto_capture::session_start",
  "auto_capture::web_vitals",
]);
const AUTO_CAPTURE_CONTENT_KEYS = new Set([
  "current_url",
  "hostname",
  "page_url",
  "pathname",
  "referrer",
  "referrer_domain",
  "referrer_path",
  "searchQuery",
  "selector",
  "title",
]);
const SENSITIVE_METADATA_KEY_PATTERN =
  /(?:prompt|transcript|description|markdown|sql|query|body|content|raw|attachment|clipboard|path|cwd|file|url|token|secret|password|cookie|dsn|key)/i;
const MAX_METADATA_ENTRIES = 40;
const MAX_METADATA_VALUE_LENGTH = 200;

let initializationPromise: Promise<boolean> | null = null;
let activeClient: StatsigClientLike | null = null;
let unregisterCloseFlush: (() => void) | null = null;

function toProcessEnv(value: unknown): Record<string, string | undefined> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => typeof entry === "string" || entry === undefined),
  ) as Record<string, string | undefined>;
}

function getRendererProcess(): RendererProcessLike | null {
  const candidate = (globalThis as { process?: unknown }).process;
  if (typeof candidate !== "object" || candidate === null) return null;
  const processLike = candidate as { env?: unknown; argv?: unknown };
  return {
    env: toProcessEnv(processLike.env),
    argv: Array.isArray(processLike.argv)
      ? processLike.argv.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

function isTestRuntime(): boolean {
  const rendererProcess = getRendererProcess();
  const env = rendererProcess?.env ?? {};
  const argv = rendererProcess?.argv ?? [];
  return (
    import.meta.env.MODE === "test" ||
    env.NODE_ENV === "test" ||
    env.BUN_ENV === "test" ||
    argv.some((value) => value.toLowerCase().includes("test"))
  );
}

function shouldForceTestInitialization(): boolean {
  return getRendererProcess()?.env?.NODEX_TELEMETRY_FORCE_TEST === "1";
}

async function loadTelemetrySettings(): Promise<TelemetrySettings | null> {
  try {
    const result = await invoke("settings:telemetry:get");
    return isTelemetrySettings(result) ? result : null;
  } catch {
    return null;
  }
}

async function loadDefaultAdapter(): Promise<StatsigTelemetryAdapter> {
  const [statsig, webAnalytics] = await Promise.all([
    import("@statsig/js-client"),
    import("@statsig/web-analytics"),
  ]);

  return {
    createAutoCapturePlugin: (options) =>
      new webAnalytics.StatsigAutoCapturePlugin(options) as unknown as StatsigPluginLike,
    createClient: (sdkKey, user, options) =>
      new statsig.StatsigClient(sdkKey, user, options) as StatsigClientLike,
  };
}

function resetActiveClient(): void {
  unregisterCloseFlush?.();
  unregisterCloseFlush = null;
  activeClient = null;
  initializationPromise = null;
}

function clearStatsigAutoCaptureUserMetadata(client: unknown): void {
  if (typeof client !== "object" || client === null || Array.isArray(client)) return;

  const typedClient = client as {
    _possibleFirstTouchMetadata?: unknown;
    _user?: unknown;
  };
  typedClient._possibleFirstTouchMetadata = {};

  if (
    typeof typedClient._user !== "object" ||
    typedClient._user === null ||
    Array.isArray(typedClient._user)
  ) {
    return;
  }

  delete (typedClient._user as Record<string, unknown>).analyticsOnlyMetadata;
}

function createStatsigUser(): Record<string, unknown> {
  return {
    custom: {
      app: "nodex",
      runtime: typeof window !== "undefined" && window.api ? "electron" : "browser",
    },
  };
}

function createFilteredAutoCapturePlugin(adapter: StatsigTelemetryAdapter): StatsigPluginLike {
  return {
    __plugin: "auto-capture",
    bind: (client) => {
      const plugin = adapter.createAutoCapturePlugin({
        captureCopyText: false,
        consoleLogAutoCaptureSettings: { enabled: false },
        eventFilterFunc: (event) => {
          clearStatsigAutoCaptureUserMetadata(client);
          return filterStatsigAutoCaptureEvent(event);
        },
      });

      plugin.bind(client);
      clearStatsigAutoCaptureUserMetadata(client);
    },
  };
}

function createStatsigOptions(settings: TelemetrySettings, adapter: StatsigTelemetryAdapter) {
  const plugins = settings.autoCaptureEnabled ? [createFilteredAutoCapturePlugin(adapter)] : [];

  return {
    environment: { tier: settings.environment },
    includeCurrentPageUrlWithEvents: false,
    plugins,
  };
}

function truncateMetadataValue(value: string): string {
  if (value.length <= MAX_METADATA_VALUE_LENGTH) return value;
  return `${value.slice(0, MAX_METADATA_VALUE_LENGTH - 3)}...`;
}

function scrubTelemetryString(value: string): string {
  return truncateMetadataValue(
    value
      .replace(/\/Users\/[^/\s]+/g, "/Users/[user]")
      .replace(/\/home\/[^/\s]+/g, "/home/[user]")
      .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\[user]")
      .replace(/https?:\/\/[^\s"'<>)]*/g, "[url]"),
  );
}

export function normalizeTelemetryMetadata(
  metadata: TelemetryMetadata | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, MAX_METADATA_ENTRIES)) {
    if (!key || SENSITIVE_METADATA_KEY_PATTERN.test(key)) continue;
    if (value === null || value === undefined) continue;
    normalized[key] = scrubTelemetryString(String(value));
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function filterStatsigAutoCaptureEvent(event: StatsigAutoCaptureEventLike): boolean {
  if (!ALLOWED_AUTO_CAPTURE_EVENTS.has(event.eventName)) return false;

  event.value = "renderer";
  const metadata = event.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    for (const key of AUTO_CAPTURE_CONTENT_KEYS) {
      delete metadata[key];
    }
  }

  return true;
}

export async function initializeRendererTelemetry(
  input: InitializeRendererTelemetryInput = {},
): Promise<boolean> {
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    if (isTestRuntime() && !shouldForceTestInitialization()) return false;
    if (typeof window !== "undefined" && window.__NODEX_STORYBOOK__ === true) return false;

    const settings = await (input.getSettings ?? loadTelemetrySettings)();
    if (!settings?.enabled || !settings.clientKey.trim()) return false;

    try {
      const adapter = input.adapter ?? (await loadDefaultAdapter());
      const client = adapter.createClient(
        settings.clientKey,
        createStatsigUser(),
        createStatsigOptions(settings, adapter),
      );

      await client.initializeAsync();
      activeClient = client;
      unregisterCloseFlush = registerAppCloseFlushHandler(async () => {
        const clientToShutdown = activeClient;
        if (!clientToShutdown) return;
        resetActiveClient();
        await clientToShutdown.shutdown();
      });

      return true;
    } catch {
      resetActiveClient();
      return false;
    }
  })();

  return initializationPromise;
}

export function logTelemetryEvent(
  eventName: string,
  value?: string | number,
  metadata?: TelemetryMetadata,
): boolean {
  const trimmedName = eventName.trim();
  if (!trimmedName || !activeClient) return false;

  activeClient.logEvent(trimmedName, value, normalizeTelemetryMetadata(metadata));
  return true;
}

export function resetRendererTelemetryForTests(): void {
  resetActiveClient();
}
