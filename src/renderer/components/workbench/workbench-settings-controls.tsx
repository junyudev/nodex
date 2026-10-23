import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownInput,
  NodexDropdownMenu,
  NodexDropdownSeparator,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
  NodexOptionPicker,
} from "@/components/ui/dropdown";
import { Input } from "../ui/input";
import { NodexThemeModeSelector } from "../ui/theme-mode-selector";
import {
  readDiagnosticsSettings,
  readTelemetrySettings,
  updateDiagnosticsSettings,
  updateTelemetrySettings,
} from "./workbench-settings-overlay-deps";
import { FILE_LINK_OPENER_ICON_URLS } from "../../lib/file-link-opener-icons";
import { useFileLinkOpener } from "../../lib/use-file-link-opener";
import { DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX } from "../../lib/worktree-branch-prefix";
import { MAX_CODE_FONT_SIZE, MIN_CODE_FONT_SIZE } from "../../lib/code-font-size";
import { MAX_SANS_FONT_SIZE, MIN_SANS_FONT_SIZE } from "../../lib/sans-font-size";
import { useCodeFontSize } from "../../lib/use-code-font-size";
import { useCopyFileReferenceSettings } from "../../lib/use-copy-file-reference-settings";
import { useNfmAutolinkSettings } from "../../lib/use-nfm-autolink-settings";
import {
  DEFAULT_DESCRIPTION_SOFT_LIMIT,
  DEFAULT_TEXT_PROMPT_CHAR_THRESHOLD,
  MAX_DESCRIPTION_SOFT_LIMIT,
  MAX_TEXT_PROMPT_CHAR_THRESHOLD,
  MIN_DESCRIPTION_SOFT_LIMIT,
  MIN_TEXT_PROMPT_CHAR_THRESHOLD,
} from "../../lib/paste-resource-settings";
import { usePasteResourceSettings } from "../../lib/use-paste-resource-settings";
import { useSansFontSize } from "../../lib/use-sans-font-size";
import {
  FONT_SIZE_LIMITS,
  normalizeFontFamily,
  type FontFamilyRole,
} from "../../lib/typography-preferences";
import { useTypographyPreferences } from "../../lib/use-typography-preferences";
import type { ResolvedTheme } from "../../lib/theme-preferences";
import { useReducedMotionPreference } from "../../lib/use-reduced-motion";
import type { ComposerEnterBehavior } from "../../lib/composer-enter-behavior";
import { useSpellcheck } from "../../lib/use-spellcheck";
import { useTheme } from "../../lib/use-theme";
import { useCodexServiceTierSettings } from "../../lib/use-codex-service-tier-settings";
import { useCodexThreadSettings } from "../../lib/use-codex-thread-settings";
import { useDesktopNotificationAuthorization } from "@/lib/desktop-notification-authorization";
import { useThreadNotificationSettings } from "../../lib/use-thread-notification-settings";
import { useComposerPredictionSettings } from "@/features/local-conversation/composer-prediction-settings";
import { useWindowRestoreSettings } from "../../lib/use-window-restore-settings";
import { isDiagnosticsSettings } from "../../../shared/diagnostics/diagnostics-settings";
import { isTelemetrySettings } from "../../../shared/diagnostics/telemetry-settings";
import { formatCodexThreadDetailLevelLabel } from "../../lib/codex-thread-settings";
import type {
  DiagnosticsSettings,
  UpdateDiagnosticsSettingsInput,
  TelemetrySettings,
  UpdateTelemetrySettingsInput,
  WorktreeStartMode,
  CodexThreadDetailLevel,
  ThreadNotificationSettings,
  ThreadNotificationTurnMode,
  WindowRestorePolicy,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  FILE_LINK_OPENER_OPTIONS,
  normalizeFileLinkOpenerId,
} from "../../../shared/file-link-openers";
import { NodexSettingsNumberInput, NodexSettingsRow as SettingRow } from "../ui/settings";

const DEFAULT_DIAGNOSTICS_SETTINGS: DiagnosticsSettings = {
  enabled: false,
  dsn: "",
  environment: "production",
  release: null,
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
};

const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = {
  enabled: false,
  clientKey: "",
  environment: "production",
  autoCaptureEnabled: false,
  envOverrides: {
    enabled: false,
    clientKey: false,
    environment: false,
    autoCaptureEnabled: false,
  },
};

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

interface SegmentedControlProps<T extends string> {
  ariaLabel: string;
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
}

function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  onChange,
  options,
}: SegmentedControlProps<T>) {
  return (
    <div
      className="inline-flex max-w-full flex-wrap items-center gap-0.5"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const isActive = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={isActive}
            className={cn(
              "flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-sm/4.5",
              "outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border/30",
              isActive
                ? "bg-foreground-5 text-(--foreground)"
                : "text-(--foreground-secondary) hover:bg-foreground-5",
            )}
          >
            {Icon ? <Icon className="size-4" /> : null}
            <span className="text-sm">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TogglePill({
  ariaLabel,
  value,
  onChange,
  disabled = false,
}: {
  ariaLabel?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <NodexSwitch
      ariaLabel={ariaLabel}
      checked={value}
      disabled={disabled}
      onCheckedChange={onChange}
    />
  );
}

export { ConfigValueDropdown } from "./config-value-dropdown";

const THREAD_NOTIFICATION_TURN_MODE_OPTIONS: Array<{
  value: ThreadNotificationTurnMode;
  label: string;
}> = [
  { value: "off", label: "Never" },
  { value: "unfocused", label: "Only when unfocused" },
  { value: "always", label: "Always" },
];

function ThreadNotificationTurnModeControl({
  value,
  onChange,
  disabled,
}: {
  value: ThreadNotificationTurnMode;
  onChange: (value: ThreadNotificationTurnMode) => void;
  disabled: boolean;
}) {
  const selectedLabel =
    THREAD_NOTIFICATION_TURN_MODE_OPTIONS.find((option) => option.value === value)?.label ??
    "Only when unfocused";

  return (
    <NodexDropdownMenu
      disabled={disabled}
      contentWidth="menuWide"
      align="end"
      triggerButton={
        <NodexSettingsDropdownTrigger className="min-w-52">
          <span className="truncate">{selectedLabel}</span>
        </NodexSettingsDropdownTrigger>
      }
    >
      {THREAD_NOTIFICATION_TURN_MODE_OPTIONS.map((option) => (
        <NodexDropdownItem
          key={option.value}
          aria-label={option.label}
          onSelect={() => onChange(option.value)}
          rightSlot={option.value === value ? <NodexDropdownSelectedIcon /> : null}
        >
          <span className="truncate">{option.label}</span>
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

export function ThemeSettingControl() {
  const { theme, setTheme } = useTheme();

  return <NodexThemeModeSelector value={theme} onValueChange={setTheme} />;
}

export function ReducedMotionSettingControl() {
  const { preference, setPreference } = useReducedMotionPreference();

  return (
    <NodexOptionPicker
      search="none"
      align="end"
      contentWidth="menu"
      value={preference}
      onValueChange={(next) => {
        if (next === "system" || next === "on" || next === "off") setPreference(next);
      }}
      options={[
        { value: "system", label: "System" },
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ]}
      triggerButton={
        <NodexSettingsDropdownTrigger aria-label="Reduce motion" className="min-w-24">
          {preference === "system" ? "System" : preference === "on" ? "On" : "Off"}
        </NodexSettingsDropdownTrigger>
      }
    />
  );
}

function NativeNotificationPermissionControl({ open }: { open: boolean }) {
  const { query, request, settings } = useDesktopNotificationAuthorization(open);
  const status = query.data;
  const failed = query.isError || request.isError || settings.isError;
  if (!open || status === "unknown") return null;
  const description = failed
    ? "Could not read or update notification permission."
    : status === "denied"
      ? "Notifications are blocked for this app in macOS."
      : status === "not-determined"
        ? "Allow this app to send notifications."
        : status === "unsupported"
          ? "Notifications are unavailable on this system."
          : status === "authorized" || status === "provisional"
            ? "Allowed by macOS."
            : "Checking permission…";
  return (
    <SettingRow label="System permission" description={description}>
      {failed ? (
        <NodexButton
          variant="outline"
          size="sm"
          onClick={() => {
            request.reset();
            settings.reset();
            void query.refetch();
          }}
        >
          Retry
        </NodexButton>
      ) : status === "not-determined" ? (
        <NodexButton
          variant="outline"
          size="sm"
          disabled={request.isPending}
          onClick={() => request.mutate()}
        >
          Allow notifications
        </NodexButton>
      ) : status === "denied" ? (
        <NodexButton
          variant="outline"
          size="sm"
          disabled={settings.isPending}
          onClick={() => settings.mutate()}
        >
          Open System Settings
        </NodexButton>
      ) : null}
    </SettingRow>
  );
}

export function ThreadNotificationSettingControl({ open }: { open: boolean }) {
  const { settings, isLoading, reloadSettings, updateSettings } = useThreadNotificationSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void reloadSettings().catch((err) => {
      setError(err instanceof Error ? err.message : "Could not load thread notification settings.");
    });
  }, [open, reloadSettings]);

  const handleChange = useCallback(
    async (nextSettings: ThreadNotificationSettings) => {
      setBusy(true);
      setError(null);

      try {
        await updateSettings(nextSettings);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not save thread notification settings.",
        );
      } finally {
        setBusy(false);
      }
    },
    [updateSettings],
  );

  return (
    <>
      <NativeNotificationPermissionControl open={open} />
      <SettingRow
        label="Turn completion notifications"
        description="Set when agent alerts you that it's finished"
      >
        <ThreadNotificationTurnModeControl
          value={settings.turnMode}
          onChange={(turnMode) => {
            void handleChange({
              ...settings,
              turnMode,
            });
          }}
          disabled={busy || isLoading}
        />
      </SettingRow>
      <SettingRow
        label="Enable question notifications"
        description="Show alerts when input is needed to continue"
      >
        <TogglePill
          ariaLabel="Enable question notifications"
          value={settings.questionsEnabled}
          onChange={(questionsEnabled) => {
            void handleChange({
              ...settings,
              questionsEnabled,
            });
          }}
          disabled={busy || isLoading}
        />
      </SettingRow>
      {error ? (
        <div role="alert" className="px-4 pb-3 text-xs text-token-error-foreground">
          {error}
        </div>
      ) : null}
    </>
  );
}

export function ServiceTierSettingControl() {
  const { serviceTierSettings, setServiceTier } = useCodexServiceTierSettings();
  const selectedValue = serviceTierSettings.serviceTier === "fast" ? "fast" : "standard";

  return (
    <SegmentedControl<"standard" | "fast">
      ariaLabel="Service tier"
      value={selectedValue}
      onChange={(value) => {
        setServiceTier(value === "fast" ? "fast" : null, "settings");
      }}
      options={[
        { value: "standard", label: "Standard" },
        { value: "fast", label: "Fast" },
      ]}
    />
  );
}

export function ComposerPredictionSettingControl() {
  const {
    settings,
    isLoading,
    isSaving,
    error: loadError,
    updateSettings,
  } = useComposerPredictionSettings();
  const [saveError, setSaveError] = useState<string | null>(null);
  const error = saveError ?? (loadError ? "Could not load prediction settings." : null);
  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span role="alert" className="max-w-72 text-xs text-danger">
          {error}
        </span>
      ) : null}
      <NodexSwitch
        ariaLabel="Show predictions"
        checked={settings.enabled}
        disabled={isLoading || isSaving || Boolean(loadError)}
        onCheckedChange={(enabled) => {
          setSaveError(null);
          void updateSettings({ enabled }).catch(() =>
            setSaveError("Could not save prediction settings."),
          );
        }}
      />
    </div>
  );
}

export function WindowRestoreSettingControl() {
  const { settings, isLoading, updateSettings } = useWindowRestoreSettings();
  const selectedValue = isLoading ? "all" : settings.policy;

  return (
    <SegmentedControl<WindowRestorePolicy>
      ariaLabel="Window restore"
      value={selectedValue}
      onChange={(policy) => {
        void updateSettings({ policy });
      }}
      options={[
        { value: "all", label: "All" },
        { value: "last-window", label: "Last" },
        { value: "none", label: "None" },
      ]}
    />
  );
}

function hasDiagnosticsEnvOverride(settings: DiagnosticsSettings): boolean {
  return (
    settings.envOverrides.enabled ||
    settings.envOverrides.dsn ||
    settings.envOverrides.environment ||
    settings.envOverrides.release ||
    settings.envOverrides.tracesSampleRate ||
    settings.envOverrides.replayEnabled ||
    settings.envOverrides.replaysSessionSampleRate ||
    settings.envOverrides.replaysOnErrorSampleRate
  );
}

function toDiagnosticsUpdateInput(
  settings: DiagnosticsSettings,
  overrides: Partial<UpdateDiagnosticsSettingsInput>,
): UpdateDiagnosticsSettingsInput {
  return {
    enabled: settings.enabled,
    dsn: settings.dsn,
    environment: settings.environment,
    release: settings.release,
    tracesSampleRate: settings.tracesSampleRate,
    replayEnabled: settings.replayEnabled,
    replaysSessionSampleRate: settings.replaysSessionSampleRate,
    replaysOnErrorSampleRate: settings.replaysOnErrorSampleRate,
    ...overrides,
  };
}

export function DiagnosticsSettingControl({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<DiagnosticsSettings>(DEFAULT_DIAGNOSTICS_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await readDiagnosticsSettings();
      if (!isDiagnosticsSettings(result)) {
        throw new Error("Could not load diagnostics settings.");
      }
      setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load diagnostics settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const handleEnabledChange = useCallback(
    async (enabled: boolean) => {
      const previous = settings;
      const nextSettings = { ...settings, enabled };
      setSettings(nextSettings);
      setBusy(true);
      setError(null);

      try {
        const result = await updateDiagnosticsSettings(
          toDiagnosticsUpdateInput(settings, { enabled }),
        );
        if (!isDiagnosticsSettings(result)) {
          throw new Error("Could not save diagnostics settings.");
        }
        setSettings(result);
      } catch (err) {
        setSettings(previous);
        setError(err instanceof Error ? err.message : "Could not save diagnostics settings.");
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const handleReplayEnabledChange = useCallback(
    async (replayEnabled: boolean) => {
      const previous = settings;
      const nextSettings = { ...settings, replayEnabled };
      setSettings(nextSettings);
      setBusy(true);
      setError(null);

      try {
        const result = await updateDiagnosticsSettings(
          toDiagnosticsUpdateInput(settings, { replayEnabled }),
        );
        if (!isDiagnosticsSettings(result)) {
          throw new Error("Could not save diagnostics settings.");
        }
        setSettings(result);
      } catch (err) {
        setSettings(previous);
        setError(err instanceof Error ? err.message : "Could not save diagnostics settings.");
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const hasEnvOverride = hasDiagnosticsEnvOverride(settings);
  const summary = settings.envOverrides.enabled
    ? "Managed by NODEX_SENTRY_ENABLED."
    : settings.enabled
      ? "Crash reports are enabled after restart."
      : "Crash reports are off.";
  const replaySummary = settings.envOverrides.replayEnabled
    ? "Session Replay is managed by NODEX_SENTRY_REPLAY_ENABLED."
    : !settings.enabled
      ? "Session replays require crash reports."
      : settings.replayEnabled
        ? "Session replays are enabled after restart."
        : "Session replays are off.";
  const replayDisabled = busy || !settings.enabled || settings.envOverrides.replayEnabled;

  return (
    <div className="flex max-w-80 flex-col items-end gap-2 text-right">
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-(--foreground-secondary)">Share crash reports</span>
          <TogglePill
            ariaLabel="Share crash reports"
            value={settings.enabled}
            disabled={busy || settings.envOverrides.enabled}
            onChange={(enabled) => {
              void handleEnabledChange(enabled);
            }}
          />
        </div>
        <div className="max-w-72 text-xs text-(--foreground-secondary)">
          {hasEnvOverride ? `${summary} Environment overrides are active.` : summary}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-(--foreground-secondary)">Share session replays</span>
          <TogglePill
            ariaLabel="Share session replays"
            value={settings.replayEnabled && settings.enabled}
            disabled={replayDisabled}
            onChange={(replayEnabled) => {
              void handleReplayEnabledChange(replayEnabled);
            }}
          />
        </div>
        <div className="max-w-72 text-xs text-(--foreground-secondary)">{replaySummary}</div>
      </div>
      {error ? <span className="max-w-72 text-xs text-(--red-text)">{error}</span> : null}
    </div>
  );
}

function hasTelemetryEnvOverride(settings: TelemetrySettings): boolean {
  return (
    settings.envOverrides.enabled ||
    settings.envOverrides.clientKey ||
    settings.envOverrides.environment ||
    settings.envOverrides.autoCaptureEnabled
  );
}

function toTelemetryUpdateInput(
  settings: TelemetrySettings,
  overrides: Partial<UpdateTelemetrySettingsInput>,
): UpdateTelemetrySettingsInput {
  return {
    enabled: settings.enabled,
    clientKey: settings.clientKey,
    environment: settings.environment,
    autoCaptureEnabled: settings.autoCaptureEnabled,
    ...overrides,
  };
}

export function TelemetrySettingControl({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<TelemetrySettings>(DEFAULT_TELEMETRY_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await readTelemetrySettings();
      if (!isTelemetrySettings(result)) {
        throw new Error("Could not load telemetry settings.");
      }
      setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load telemetry settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const handleEnabledChange = useCallback(
    async (enabled: boolean) => {
      const previous = settings;
      const nextSettings = { ...settings, enabled };
      setSettings(nextSettings);
      setBusy(true);
      setError(null);

      try {
        const result = await updateTelemetrySettings(toTelemetryUpdateInput(settings, { enabled }));
        if (!isTelemetrySettings(result)) {
          throw new Error("Could not save telemetry settings.");
        }
        setSettings(result);
      } catch (err) {
        setSettings(previous);
        setError(err instanceof Error ? err.message : "Could not save telemetry settings.");
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const handleAutoCaptureEnabledChange = useCallback(
    async (autoCaptureEnabled: boolean) => {
      const previous = settings;
      const nextSettings = { ...settings, autoCaptureEnabled };
      setSettings(nextSettings);
      setBusy(true);
      setError(null);

      try {
        const result = await updateTelemetrySettings(
          toTelemetryUpdateInput(settings, { autoCaptureEnabled }),
        );
        if (!isTelemetrySettings(result)) {
          throw new Error("Could not save telemetry settings.");
        }
        setSettings(result);
      } catch (err) {
        setSettings(previous);
        setError(err instanceof Error ? err.message : "Could not save telemetry settings.");
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const hasEnvOverride = hasTelemetryEnvOverride(settings);
  const summary = settings.envOverrides.enabled
    ? "Managed by NODEX_TELEMETRY_ENABLED."
    : settings.enabled
      ? "Product telemetry is enabled after restart."
      : "Product telemetry is off.";
  const autoCaptureSummary = settings.envOverrides.autoCaptureEnabled
    ? "Web analytics are managed by NODEX_TELEMETRY_AUTOCAPTURE_ENABLED."
    : !settings.enabled
      ? "Web analytics require product telemetry."
      : settings.autoCaptureEnabled
        ? "Web analytics are enabled after restart."
        : "Web analytics are off.";
  const autoCaptureDisabled = busy || !settings.enabled || settings.envOverrides.autoCaptureEnabled;

  return (
    <div className="flex max-w-80 flex-col items-end gap-2 text-right">
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-(--foreground-secondary)">Share product telemetry</span>
          <TogglePill
            ariaLabel="Share product telemetry"
            value={settings.enabled}
            disabled={busy || settings.envOverrides.enabled}
            onChange={(enabled) => {
              void handleEnabledChange(enabled);
            }}
          />
        </div>
        <div className="max-w-72 text-xs text-(--foreground-secondary)">
          {hasEnvOverride ? `${summary} Environment overrides are active.` : summary}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-(--foreground-secondary)">Share web analytics</span>
          <TogglePill
            ariaLabel="Share web analytics"
            value={settings.autoCaptureEnabled && settings.enabled}
            disabled={autoCaptureDisabled}
            onChange={(autoCaptureEnabled) => {
              void handleAutoCaptureEnabledChange(autoCaptureEnabled);
            }}
          />
        </div>
        <div className="max-w-72 text-xs text-(--foreground-secondary)">{autoCaptureSummary}</div>
      </div>
      {error ? <span className="max-w-72 text-xs text-(--red-text)">{error}</span> : null}
    </div>
  );
}

export function SpellcheckSettingControl() {
  const { spellcheck, toggleSpellcheck } = useSpellcheck();

  return (
    <TogglePill ariaLabel="Spellcheck" value={spellcheck} onChange={() => toggleSpellcheck()} />
  );
}

export function NfmAutolinkTypingSettingControl() {
  const { settings, updateSettings } = useNfmAutolinkSettings();

  return (
    <TogglePill
      ariaLabel="Autolink while typing"
      value={settings.autoLinkWhileTyping}
      onChange={(value) => updateSettings({ autoLinkWhileTyping: value })}
    />
  );
}

export function NfmAutolinkPasteSettingControl() {
  const { settings, updateSettings } = useNfmAutolinkSettings();

  return (
    <TogglePill
      ariaLabel="Autolink on paste"
      value={settings.autoLinkOnPaste}
      onChange={(value) => updateSettings({ autoLinkOnPaste: value })}
    />
  );
}

export function NfmAutolinkBareDomainsSettingControl() {
  const { settings, updateSettings } = useNfmAutolinkSettings();
  const disabled = !settings.autoLinkWhileTyping && !settings.autoLinkOnPaste;

  return (
    <TogglePill
      ariaLabel="Linkify bare domains"
      value={settings.linkifyBareDomains}
      onChange={(value) => updateSettings({ linkifyBareDomains: value })}
      disabled={disabled}
    />
  );
}

function PasteResourceNumberSettingControl({
  value,
  defaultValue,
  min,
  max,
  onChange,
  ariaLabel,
}: {
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = useCallback(() => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }

    const normalized = Math.min(max, Math.max(min, parsed));
    onChange(normalized);
  }, [draft, max, min, onChange, value]);

  return (
    <div className="flex items-center gap-3">
      <Input
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }}
        spellCheck={false}
        inputMode="numeric"
        aria-label={ariaLabel}
        className="h-8 w-28 px-2 text-sm"
      />
      <span className="text-sm text-(--foreground-secondary) tabular-nums">
        Default {defaultValue.toLocaleString()}
      </span>
    </div>
  );
}

export function PasteResourceTextThresholdSettingControl() {
  const { settings, updateSettings } = usePasteResourceSettings();

  return (
    <PasteResourceNumberSettingControl
      value={settings.textPromptCharThreshold}
      defaultValue={DEFAULT_TEXT_PROMPT_CHAR_THRESHOLD}
      min={MIN_TEXT_PROMPT_CHAR_THRESHOLD}
      max={MAX_TEXT_PROMPT_CHAR_THRESHOLD}
      onChange={(value) => updateSettings({ textPromptCharThreshold: value })}
      ariaLabel="Paste resource text threshold"
    />
  );
}

export function PasteResourceDescriptionSoftLimitSettingControl() {
  const { settings, updateSettings } = usePasteResourceSettings();

  return (
    <PasteResourceNumberSettingControl
      value={settings.descriptionSoftLimit}
      defaultValue={DEFAULT_DESCRIPTION_SOFT_LIMIT}
      min={MIN_DESCRIPTION_SOFT_LIMIT}
      max={MAX_DESCRIPTION_SOFT_LIMIT}
      onChange={(value) => updateSettings({ descriptionSoftLimit: value })}
      ariaLabel="Paste resource description soft limit"
    />
  );
}

const THREAD_DETAIL_LEVEL_OPTIONS: Array<{
  value: CodexThreadDetailLevel;
  label: string;
  description: string;
}> = [
  {
    value: "STEPS_PROSE",
    label: "Steps",
    description: "Hide commands and outputs.",
  },
  {
    value: "STEPS_COMMANDS",
    label: "Steps with code commands",
    description: "Show commands, collapse output.",
  },
  {
    value: "STEPS_EXECUTION",
    label: "Steps with code output",
    description: "Show commands and expand output.",
  },
];

export function ThreadDetailLevelSettingControl() {
  const { settings, setThreadDetailLevel } = useCodexThreadSettings();
  const selectedValue = settings.detailLevel ?? "STEPS_COMMANDS";
  const selectedOption =
    THREAD_DETAIL_LEVEL_OPTIONS.find((option) => option.value === selectedValue) ??
    THREAD_DETAIL_LEVEL_OPTIONS[1];

  return (
    <NodexDropdownMenu
      triggerButton={
        <NodexSettingsDropdownTrigger aria-label="Thread detail" className="min-w-56">
          <span className="truncate">
            {formatCodexThreadDetailLevelLabel(selectedOption.value)}
          </span>
        </NodexSettingsDropdownTrigger>
      }
      align="end"
      contentWidth="workspace"
      contentMaxHeight="tall"
    >
      {THREAD_DETAIL_LEVEL_OPTIONS.map((option) => (
        <NodexDropdownItem
          key={option.value}
          onSelect={() => setThreadDetailLevel(option.value)}
          rightSlot={option.value === selectedValue ? <NodexDropdownSelectedIcon /> : null}
          subText={option.description}
          allowWrap
        >
          {option.label}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

function FontSizeSettingControl({
  ariaLabel,
  max,
  min,
  onChangeValue,
  value,
}: {
  ariaLabel: string;
  max: number;
  min: number;
  onChangeValue: (value: number) => void;
  value: number;
}) {
  const [edit, setEdit] = useState({ source: value, draft: String(value) });
  if (edit.source !== value) setEdit({ source: value, draft: String(value) });
  const draft = edit.source === value ? edit.draft : String(value);
  const setDraft = (next: string) => setEdit({ source: value, draft: next });
  const pointerStartValue = useRef<string | null>(null);

  const commit = (input = draft) => {
    const parsed = Number(input);
    if (input.trim() === "" || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      setDraft(String(value));
      return;
    }

    setDraft(String(parsed));
    if (parsed !== value) onChangeValue(parsed);
  };

  return (
    <div className="flex items-center gap-2">
      <NodexSettingsNumberInput
        aria-label={ariaLabel}
        className="w-16"
        max={max}
        min={min}
        onBlur={() => commit()}
        onPointerDown={(event) => {
          pointerStartValue.current = event.currentTarget.value;
        }}
        onPointerUp={(event) => {
          const start = pointerStartValue.current;
          pointerStartValue.current = null;
          if (start === null || start === event.currentTarget.value) return;
          commit(event.currentTarget.value);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
        step={1}
        value={draft}
      />
      <span className="text-sm text-token-text-secondary">px</span>
    </div>
  );
}

export function SansFontSizeSettingControl() {
  const { sansFontSize, setSansFontSize } = useSansFontSize();

  return (
    <FontSizeSettingControl
      ariaLabel="UI font size"
      max={MAX_SANS_FONT_SIZE}
      min={MIN_SANS_FONT_SIZE}
      onChangeValue={setSansFontSize}
      value={sansFontSize}
    />
  );
}

export function CodeFontSizeSettingControl() {
  const { codeFontSize, setCodeFontSize } = useCodeFontSize();

  return (
    <FontSizeSettingControl
      ariaLabel="Code font size"
      max={MAX_CODE_FONT_SIZE}
      min={MIN_CODE_FONT_SIZE}
      onChangeValue={setCodeFontSize}
      value={codeFontSize}
    />
  );
}

export function PageFontSizeSettingControl() {
  const { preferences, setFontSize } = useTypographyPreferences();
  return (
    <FontSizeSettingControl
      ariaLabel="Content font size"
      max={FONT_SIZE_LIMITS.page.max}
      min={FONT_SIZE_LIMITS.page.min}
      onChangeValue={(value) => setFontSize("page", value)}
      value={preferences.pageFontSize}
    />
  );
}

const FONT_FAMILY_LABELS: Record<FontFamilyRole, string> = {
  ui: "UI font",
  content: "Content font",
  code: "Code font",
};

export function FontFamilySettingControl({
  role,
  variant,
}: {
  role: FontFamilyRole;
  variant: ResolvedTheme;
}) {
  const { preferences, setFontFamily } = useTypographyPreferences();
  const family = preferences.fonts[variant][role];
  return (
    <FontFamilyInput
      family={family}
      role={role}
      variant={variant}
      onCommit={(value) => setFontFamily(variant, role, value)}
    />
  );
}

function FontFamilyInput({
  family,
  role,
  variant,
  onCommit,
}: {
  family: string | null;
  role: FontFamilyRole;
  variant: ResolvedTheme;
  onCommit: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(family ?? "");
  const label = `${variant === "light" ? "Light" : "Dark"} ${FONT_FAMILY_LABELS[role]}`;
  const defaultLabel = role === "content" ? "Same as UI font" : "System";
  const normalized = normalizeFontFamily(draft);
  const invalid = draft.trim() !== "" && normalized === null;
  const commit = () => {
    if (invalid) return;
    if (normalized !== family) onCommit(normalized);
    setOpen(false);
  };
  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="menuWide"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(family ?? "");
      }}
      triggerButton={
        <NodexSettingsDropdownTrigger aria-label={label} className="w-36 max-w-full">
          <span className="truncate">{family ?? defaultLabel}</span>
        </NodexSettingsDropdownTrigger>
      }
    >
      <NodexDropdownItem
        onSelect={() => {
          if (family !== null) onCommit(null);
        }}
        rightSlot={family === null ? <NodexDropdownSelectedIcon /> : null}
      >
        {defaultLabel}
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <NodexDropdownInput
        aria-label={`Custom ${label}`}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
        }}
      />
      <NodexDropdownItem disabled={invalid} onSelect={commit}>
        Use custom font value
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

export function FileLinkOpenerSettingControl() {
  const { opener, setOpener } = useFileLinkOpener();
  const selectedOption =
    FILE_LINK_OPENER_OPTIONS.find((option) => option.id === opener) ?? FILE_LINK_OPENER_OPTIONS[0];

  return (
    <NodexDropdownMenu
      triggerButton={
        <NodexSettingsDropdownTrigger
          aria-label={`Open markdown file links in ${selectedOption.label}`}
          className="min-w-50"
        >
          <span className="flex items-center gap-1.5">
            <img
              src={FILE_LINK_OPENER_ICON_URLS[selectedOption.id]}
              alt=""
              className="size-5 shrink-0 object-contain"
              aria-hidden="true"
            />
            <span className="truncate">{selectedOption.label}</span>
          </span>
        </NodexSettingsDropdownTrigger>
      }
      align="end"
      contentWidth="sm"
      contentMaxHeight="tall"
    >
      {FILE_LINK_OPENER_OPTIONS.map((option) => (
        <NodexDropdownItem
          key={option.id}
          onSelect={() => setOpener(normalizeFileLinkOpenerId(option.id))}
          leftSlot={
            <img
              src={FILE_LINK_OPENER_ICON_URLS[option.id]}
              alt=""
              className="size-4 shrink-0 object-contain"
              aria-hidden="true"
            />
          }
          rightSlot={option.id === selectedOption.id ? <NodexDropdownSelectedIcon /> : null}
        >
          {option.label}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

export function CopyFileReferencesAsLocalPathsSettingControl() {
  const { copyAsLocalPaths, setCopyAsLocalPaths } = useCopyFileReferenceSettings();

  return (
    <TogglePill
      ariaLabel="Copy file references as local paths"
      value={copyAsLocalPaths}
      onChange={setCopyAsLocalPaths}
    />
  );
}

export function WorktreeStartModeSettingControl({
  value,
  onChange,
}: {
  value: WorktreeStartMode;
  onChange: (value: WorktreeStartMode) => void;
}) {
  return (
    <SegmentedControl<WorktreeStartMode>
      ariaLabel="New worktree mode"
      value={value}
      onChange={onChange}
      options={[
        { value: "autoBranch", label: "Auto branch" },
        { value: "detachedHead", label: "Detached HEAD" },
      ]}
    />
  );
}

export function WorktreeAutoBranchPrefixSettingControl({
  disabled = false,
  value,
  onChange,
}: {
  disabled?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = useCallback(() => {
    if (disabled) return;
    onChange(draft);
  }, [disabled, draft, onChange]);

  return (
    <Input
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commit();
        event.currentTarget.blur();
      }}
      spellCheck={false}
      disabled={disabled}
      autoCapitalize="none"
      autoCorrect="off"
      placeholder={DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX}
      aria-label="Branch prefix"
      className="h-8 w-52 px-2 text-sm"
    />
  );
}

export function TaskShorthandPagePromotionSettingControl({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <TogglePill ariaLabel="Task shorthand on Block to Page" value={value} onChange={onChange} />
  );
}

export function ComposerEnterBehaviorControl({
  value,
  onChange,
}: {
  value: ComposerEnterBehavior;
  onChange: (value: ComposerEnterBehavior) => void;
}) {
  return (
    <TogglePill
      ariaLabel="Use Cmd/Ctrl+Enter for multiline prompts"
      value={value === "cmdIfMultiline"}
      onChange={(enabled) => onChange(enabled ? "cmdIfMultiline" : "enter")}
    />
  );
}

export function ThreadQueueFollowUpsSettingControl({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return <TogglePill ariaLabel="Queue follow-up prompts" value={value} onChange={onChange} />;
}
