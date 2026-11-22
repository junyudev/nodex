import type { DiagnosticsSettings } from "./types";
import { createSentryPrivacyOptions } from "../../shared/diagnostics/sentry-options";
import { isDiagnosticsSettings } from "../../shared/diagnostics/diagnostics-settings";
import { installRendererTracing, type RendererTracing } from "./renderer-tracing";

interface RendererSentryAdapter {
  init: (options: Record<string, unknown>) => void;
  replayIntegration: (options: Record<string, unknown>) => unknown;
  readonly tracing?: RendererTracing;
}

interface RendererProcessLike {
  env?: Record<string, string | undefined>;
  argv?: string[];
}

export interface InitializeRendererSentryInput {
  readonly adapter?: RendererSentryAdapter;
  /** The window's diagnostics settings from its bootstrap reply. */
  readonly settings: DiagnosticsSettings | null;
}

let initialized = false;

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
  return env.NODE_ENV === "test" || argv.some((value) => value.toLowerCase().includes("test"));
}

function shouldForceTestInitialization(): boolean {
  return getRendererProcess()?.env?.NODEX_SENTRY_FORCE_TEST === "1";
}

async function loadDefaultAdapter(): Promise<RendererSentryAdapter> {
  const [sentry, react] = await Promise.all([
    import("@sentry/electron/renderer"),
    import("@sentry/react"),
  ]);
  return {
    init: (options) => {
      sentry.init(options, react.init);
    },
    replayIntegration: (options) => sentry.replayIntegration(options),
    tracing: react,
  };
}

export async function initializeRendererSentry(
  input: InitializeRendererSentryInput,
): Promise<boolean> {
  if (initialized) return true;
  if (isTestRuntime() && !shouldForceTestInitialization()) return false;

  const settings = isDiagnosticsSettings(input.settings) ? input.settings : null;
  if (!settings?.active || !settings.dsn.trim()) return false;

  const adapter = input.adapter ?? (await loadDefaultAdapter());
  const privacyOptions = createSentryPrivacyOptions();
  const initOptions: Record<string, unknown> = {
    ...privacyOptions,
    tracesSampleRate: settings.tracesSampleRate,
    attachScreenshot: false,
  };
  if (settings.replayEnabled) {
    initOptions.integrations = [
      ...privacyOptions.integrations,
      adapter.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ];
    initOptions.replaysSessionSampleRate = settings.replaysSessionSampleRate;
    initOptions.replaysOnErrorSampleRate = settings.replaysOnErrorSampleRate;
  }
  // Renderer scope tags merge into Main's shared scope and would relabel Main's own events;
  // the SDK's per-event `event.process` tag already identifies the reporting process.
  adapter.init(initOptions);
  if (adapter.tracing) installRendererTracing(adapter.tracing);
  initialized = true;
  return true;
}

export function resetRendererSentryForTests(): void {
  initialized = false;
  installRendererTracing(null);
}
