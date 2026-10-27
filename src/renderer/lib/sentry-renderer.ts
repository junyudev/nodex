import type { DiagnosticsSettings } from "./types";
import { invokeRendererQuery as invoke } from "./renderer-command";
import { createSentryPrivacyOptions } from "../../shared/diagnostics/sentry-options";
import { isDiagnosticsSettings } from "../../shared/diagnostics/diagnostics-settings";

interface RendererSentryAdapter {
  init: (options: Record<string, unknown>) => void;
  replayIntegration: (options: Record<string, unknown>) => unknown;
  setTag: (key: string, value: string) => void;
}

interface RendererProcessLike {
  env?: Record<string, string | undefined>;
  argv?: string[];
}

export interface InitializeRendererSentryInput {
  adapter?: RendererSentryAdapter;
  getSettings?: () => Promise<DiagnosticsSettings | null>;
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

async function loadDiagnosticsSettings(): Promise<DiagnosticsSettings | null> {
  try {
    const result = await invoke("settings:diagnostics:get");
    return isDiagnosticsSettings(result) ? result : null;
  } catch {
    return null;
  }
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
    setTag: (key, value) => {
      sentry.setTag(key, value);
      sentry.setAttribute(key, value);
    },
  };
}

export async function initializeRendererSentry(
  input: InitializeRendererSentryInput = {},
): Promise<boolean> {
  if (initialized) return true;
  if (isTestRuntime() && !shouldForceTestInitialization()) return false;

  const settings = await (input.getSettings ?? loadDiagnosticsSettings)();
  if (!settings?.enabled || !settings.dsn.trim()) return false;

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
  adapter.init(initOptions);
  adapter.setTag("process", "renderer");
  initialized = true;
  return true;
}

export function resetRendererSentryForTests(): void {
  initialized = false;
}
