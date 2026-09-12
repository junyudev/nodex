import type { DiagnosticsSettings } from "../../shared/types";
import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import {
  scrubSentryBreadcrumb,
  scrubSentryData,
  scrubSentryEvent,
} from "../../shared/diagnostics/sentry-scrub";
import { subscribeToBackendLogs, type BackendLogEntry } from "../logging/logger";

export interface MainSentryAdapter {
  addBreadcrumb: (breadcrumb: Record<string, unknown>) => void;
  captureException: (error: unknown, hint?: unknown) => string | undefined;
  captureMessage: (message: string, hint?: unknown) => string | undefined;
  close: (timeout?: number) => Promise<boolean>;
  init: (options: Record<string, unknown>) => void;
  runTraceSpan?: <A>(
    options: MainTraceSpanOptions,
    callback: (trace: CodexRequestTraceContext | null) => A,
  ) => A;
  setTag: (key: string, value: string) => void;
}

export interface MainTraceSpanOptions {
  readonly name: string;
  readonly op: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly trace?: CodexRequestTraceContext | null;
  readonly links?: readonly CodexRequestTraceContext[];
  readonly root?: boolean;
  readonly startTimeMs?: number;
  readonly endTimeMs?: number;
}

export interface InitializeMainSentryInput {
  appVersion: string;
  arch: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  settings: DiagnosticsSettings;
  adapter?: MainSentryAdapter;
  subscribeToLogs?: typeof subscribeToBackendLogs;
}

interface CaptureContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

let activeAdapter: MainSentryAdapter | null = null;
let backendLogUnsubscribe: (() => void) | null = null;

async function loadDefaultAdapter(): Promise<MainSentryAdapter> {
  const sentry = await import("@sentry/electron/main");
  return {
    addBreadcrumb: (breadcrumb) => sentry.addBreadcrumb(breadcrumb),
    captureException: (error, hint) =>
      sentry.captureException(error, hint as Parameters<typeof sentry.captureException>[1]),
    captureMessage: (message, hint) =>
      sentry.captureMessage(message, hint as Parameters<typeof sentry.captureMessage>[1]),
    close: (timeout) => sentry.close(timeout),
    init: (options) => sentry.init(options),
    setTag: (key, value) => sentry.setTag(key, value),
  };
}

function isTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    process.argv.some((value) => value.toLowerCase().includes("test"))
  );
}

function shouldInitialize(settings: DiagnosticsSettings): boolean {
  if (!settings.enabled) return false;
  if (!settings.dsn.trim()) return false;
  if (isTestRuntime() && process.env.NODEX_SENTRY_FORCE_TEST !== "1") return false;
  return true;
}

function breadcrumbLevel(level: BackendLogEntry["level"]): "info" | "warning" | "error" | "debug" {
  if (level === "warn") return "warning";
  if (level === "error") return "error";
  if (level === "debug") return "debug";
  return "info";
}

function toBackendLogBreadcrumb(entry: BackendLogEntry): Record<string, unknown> | null {
  if (entry.level !== "warn" && entry.level !== "error") return null;
  const { msg, level, ts, pid, ...data } = entry;
  return scrubSentryBreadcrumb({
    category: "backend",
    level: breadcrumbLevel(level),
    message: msg,
    timestamp: Date.parse(ts) / 1000,
    data: {
      pid,
      ...data,
    },
  });
}

export async function initializeMainSentry(input: InitializeMainSentryInput): Promise<boolean> {
  if (activeAdapter) return true;
  if (!shouldInitialize(input.settings)) return false;

  const adapter = input.adapter ?? (await loadDefaultAdapter());
  adapter.init({
    dsn: input.settings.dsn,
    environment: input.settings.environment,
    release: input.settings.release ?? `nodex@${input.appVersion}`,
    dist: input.arch,
    sendDefaultPii: false,
    tracesSampleRate: input.settings.tracesSampleRate,
    attachScreenshot: false,
    beforeSend: (event: unknown) => scrubSentryEvent(event as Record<string, unknown>),
    beforeBreadcrumb: (breadcrumb: { category?: string } & Record<string, unknown>) => {
      if (breadcrumb.category === "console") return null;
      return scrubSentryBreadcrumb(breadcrumb as Record<string, unknown>) as typeof breadcrumb;
    },
  });
  adapter.setTag("process", "main");
  adapter.setTag("platform", input.platform);
  adapter.setTag("arch", input.arch);
  adapter.setTag("packaged", input.isPackaged ? "true" : "false");
  activeAdapter = adapter;

  const subscribe = input.subscribeToLogs ?? subscribeToBackendLogs;
  backendLogUnsubscribe = subscribe((entry) => {
    const breadcrumb = toBackendLogBreadcrumb(entry);
    if (!breadcrumb) return;
    adapter.addBreadcrumb(breadcrumb);
  });

  return true;
}

export function captureMainException(error: unknown, context: CaptureContext = {}): void {
  if (!activeAdapter) return;
  activeAdapter.captureException(error, {
    tags: context.tags,
    extra: scrubSentryData(context.extra ?? {}),
  });
}

export function captureMainMessage(message: string, context: CaptureContext = {}): void {
  if (!activeAdapter) return;
  activeAdapter.captureMessage(message, {
    tags: context.tags,
    extra: scrubSentryData(context.extra ?? {}),
  });
}

/** Runs a Main trace span when diagnostics tracing is active and preserves the incoming trace otherwise. */
export function runMainTraceSpan<A>(
  options: MainTraceSpanOptions,
  callback: (trace: CodexRequestTraceContext | null) => A,
): A {
  const runTraceSpan = activeAdapter?.runTraceSpan;
  if (!runTraceSpan) return callback(options.trace ?? null);
  return runTraceSpan(options, callback);
}

export async function shutdownMainSentry(timeoutMs = 2_000): Promise<void> {
  backendLogUnsubscribe?.();
  backendLogUnsubscribe = null;

  const adapter = activeAdapter;
  activeAdapter = null;
  if (!adapter) return;
  await adapter.close(timeoutMs);
}

export function resetMainSentryForTests(): void {
  backendLogUnsubscribe?.();
  backendLogUnsubscribe = null;
  activeAdapter = null;
}
