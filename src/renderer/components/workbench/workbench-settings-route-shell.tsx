import { useForm, useStore } from "@tanstack/react-form";
import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { DeleteIcon, ResetIcon } from "@/components/shared/icons";
import { Monitor, Moon, Sun } from "@/components/shared/icons/generic-icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { Input } from "../ui/input";
import { invoke } from "./workbench-settings-overlay-deps";
import { handleFormSubmit, resolveFormErrorMessage, resolveZodErrorMessage } from "../../lib/forms";
import { FILE_LINK_OPENER_ICON_URLS } from "../../lib/file-link-opener-icons";
import { useFileLinkOpener } from "../../lib/use-file-link-opener";
import { DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX } from "../../lib/worktree-branch-prefix";
import {
  DEFAULT_CODE_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
} from "../../lib/code-font-size";
import {
  DEFAULT_SANS_FONT_SIZE,
  MAX_SANS_FONT_SIZE,
  MIN_SANS_FONT_SIZE,
} from "../../lib/sans-font-size";
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
import { useReducedMotionPreference } from "../../lib/use-reduced-motion";
import type { ComposerEnterBehavior } from "../../lib/composer-enter-behavior";
import { useSpellcheck } from "../../lib/use-spellcheck";
import { useTheme } from "../../lib/use-theme";
import { useCodexServiceTierSettings } from "../../lib/use-codex-service-tier-settings";
import { useCodexThreadSettings } from "../../lib/use-codex-thread-settings";
import { useThreadNotificationSettings } from "../../lib/use-thread-notification-settings";
import { useWindowRestoreSettings } from "../../lib/use-window-restore-settings";
import { useStoreBackupRuntime } from "../../lib/use-store-backup-runtime";
import { isDiagnosticsSettings } from "../../../shared/diagnostics/diagnostics-settings";
import { isTelemetrySettings } from "../../../shared/diagnostics/telemetry-settings";
import { formatCodexThreadDetailLevelLabel } from "../../lib/codex-thread-settings";
import type {
  BackupRecord,
  BackupJobStatus,
  BackupSettings,
  DiagnosticsSettings,
  HistorySettings,
  Project,
  UpdateDiagnosticsSettingsInput,
  TelemetrySettings,
  UpdateTelemetrySettingsInput,
  WorktreeStartMode,
  CodexPermissionState,
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
import {
  BACKUP_SCHEDULE_FORM_DEFAULTS,
  BackupScheduleFormSchema,
  HISTORY_RETENTION_FORM_DEFAULTS,
  HistoryRetentionFormSchema,
  MANUAL_SNAPSHOT_FORM_DEFAULTS,
  ManualSnapshotFormSchema,
} from "./workbench-settings-form-schemas";
import {
  type SettingsSectionDefinition,
  type SettingsSectionId,
} from "./workbench-settings-sections";
import { SETTINGS_PAGE_COMPONENTS } from "./workbench-settings-section-pages";
import {
  CODEX_SETTINGS_SHELL_STYLE,
  NodexSettingsNumberInput,
  NodexSettingsSection as SectionBlock,
  NodexSettingsRow as SettingRow,
  NodexSettingsPageSurface as SettingsPageSurface,
} from "../ui/settings";
import { SettingsSidebar } from "./workbench-settings-sidebar";
import {
  buildBrowserSettingsPath,
  buildSettingsPath,
  resolveSettingsShellState,
} from "./workbench-settings-routes";

const OpenSourceLicensesSettingsPage = lazy(async () => {
  const module = await import("./open-source-licenses-settings-page");
  return { default: module.OpenSourceLicensesSettingsPage };
});

const BACKUP_TRIGGER_LABELS: Record<BackupRecord["trigger"], string> = {
  manual: "Manual",
  auto: "Auto",
  "pre-restore": "Safety",
};

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
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: SegmentedControlProps<T>) {
  return (
    <div className="inline-flex items-center gap-0.5" role="group">
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
              "flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-sm/4.5 transition-colors",
              "outline-none focus-visible:ring-2 focus-visible:ring-(--accent-blue)/30",
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

export function formatApprovalPolicyLabel(value: CodexPermissionState["approvalPolicy"]): string {
  if (typeof value === "string") {
    return value;
  }
  return "granular";
}

export function formatSandboxModeLabel(value: CodexPermissionState["sandboxMode"]): string {
  return value ?? "unset";
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

  return (
    <SegmentedControl
      value={theme}
      onChange={setTheme}
      options={[
        { value: "system", label: "System", icon: Monitor },
        { value: "light", label: "Light", icon: Sun },
        { value: "dark", label: "Dark", icon: Moon },
      ]}
    />
  );
}

export function ReducedMotionSettingControl() {
  const { preference, setPreference } = useReducedMotionPreference();

  return (
    <SegmentedControl
      value={preference}
      onChange={setPreference}
      options={[
        { value: "system", label: "System" },
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ]}
    />
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
        label="Enable permission notifications"
        description="Show alerts when notification permissions are required"
      >
        <TogglePill
          ariaLabel="Enable permission notifications"
          value={settings.permissionsEnabled}
          onChange={(permissionsEnabled) => {
            void handleChange({
              ...settings,
              permissionsEnabled,
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

export function WindowRestoreSettingControl() {
  const { settings, isLoading, updateSettings } = useWindowRestoreSettings();
  const selectedValue = isLoading ? "all" : settings.policy;

  return (
    <SegmentedControl<WindowRestorePolicy>
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
      const result = await invoke("settings:diagnostics:get");
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
        const result = await invoke(
          "settings:diagnostics:update",
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
        const result = await invoke(
          "settings:diagnostics:update",
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
      const result = await invoke("settings:telemetry:get");
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
        const result = await invoke(
          "settings:telemetry:update",
          toTelemetryUpdateInput(settings, { enabled }),
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

  const handleAutoCaptureEnabledChange = useCallback(
    async (autoCaptureEnabled: boolean) => {
      const previous = settings;
      const nextSettings = { ...settings, autoCaptureEnabled };
      setSettings(nextSettings);
      setBusy(true);
      setError(null);

      try {
        const result = await invoke(
          "settings:telemetry:update",
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
        <NodexSettingsDropdownTrigger aria-label="Thread detail" className="min-w-56 text-base/4.5">
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
  defaultValue,
  max,
  min,
  onChangeValue,
  value,
}: {
  ariaLabel: string;
  defaultValue: number;
  max: number;
  min: number;
  onChangeValue: (value: number) => void;
  value: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const isDefault = value === defaultValue;

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = useCallback(() => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }

    onChangeValue(parsed);
  }, [draft, onChangeValue, value]);

  return (
    <div className="flex items-center gap-2.5">
      <NodexSettingsNumberInput
        aria-label={ariaLabel}
        className="w-16"
        max={max}
        min={min}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }}
        step={1}
        value={draft}
      />
      <span className="text-sm text-token-text-secondary">px</span>
      <NodexButton
        variant="ghost"
        size="xs"
        disabled={isDefault}
        onClick={() => onChangeValue(defaultValue)}
        className="gap-1 text-token-text-secondary"
      >
        <ResetIcon className="size-3.5" />
        <span>Default</span>
      </NodexButton>
    </div>
  );
}

export function SansFontSizeSettingControl() {
  const { sansFontSize, setSansFontSize } = useSansFontSize();

  return (
    <FontSizeSettingControl
      ariaLabel="Sans font size"
      defaultValue={DEFAULT_SANS_FONT_SIZE}
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
      defaultValue={DEFAULT_CODE_FONT_SIZE}
      max={MAX_CODE_FONT_SIZE}
      min={MIN_CODE_FONT_SIZE}
      onChangeValue={setCodeFontSize}
      value={codeFontSize}
    />
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
          className="min-w-50 text-base/4.5"
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

function formatBackupSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatBackupTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BackupSettingsControl({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [historySettings, setHistorySettings] = useState<HistorySettings | null>(null);
  const backupRuntime = useStoreBackupRuntime({ invoke, open });
  const {
    backups,
    cancelJob: cancelBackupJob,
    cancelPending,
    capacity: backupCapacity,
    clearNotice: clearBackupNotice,
    installJob: setBackupJob,
    job: backupJob,
    notice: backupNotice,
    presentation: backupJobPresentation,
    refresh: refreshBackupRuntime,
    reloadInventory: loadBackups,
    storageOptimization,
  } = backupRuntime;
  const [createSafetyBackup, setCreateSafetyBackup] = useState(true);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    "refresh" | "save" | "create" | "restore" | "delete" | null
  >(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scheduleForm = useForm({
    defaultValues: BACKUP_SCHEDULE_FORM_DEFAULTS,
    validators: {
      onSubmit: BackupScheduleFormSchema,
    },
    onSubmitInvalid: ({ value }) => {
      const parsed = BackupScheduleFormSchema.safeParse(value);
      setError(resolveZodErrorMessage(parsed.error) ?? "Could not save backup schedule.");
      setStatus(null);
    },
    onSubmit: async ({ value }) => {
      if (!settings) return;
      const parsed = BackupScheduleFormSchema.parse(value);

      setBusyAction("save");
      setError(null);
      setStatus(null);

      try {
        const updated = (await invoke("settings:backup:update", {
          autoEnabled: settings.envOverrides.autoEnabled
            ? settings.autoEnabled
            : parsed.autoEnabled,
          intervalHours: settings.envOverrides.intervalHours
            ? settings.intervalHours
            : parsed.intervalHours,
          retentionCount: settings.envOverrides.retentionCount
            ? settings.retentionCount
            : parsed.retentionCount,
          retentionGiB: settings.envOverrides.retentionGiB
            ? settings.retentionGiB
            : parsed.retentionGiB,
        })) as BackupSettings;
        setSettings(updated);
        scheduleForm.reset({
          autoEnabled: updated.autoEnabled,
          intervalHours: String(updated.intervalHours),
          retentionCount: String(updated.retentionCount),
          retentionGiB: String(updated.retentionGiB),
        });
        setStatus("Backup schedule saved.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not save backup schedule.");
      } finally {
        setBusyAction(null);
      }
    },
  });
  const historyForm = useForm({
    defaultValues: HISTORY_RETENTION_FORM_DEFAULTS,
    validators: {
      onSubmit: HistoryRetentionFormSchema,
    },
    onSubmitInvalid: ({ value }) => {
      const parsed = HistoryRetentionFormSchema.safeParse(value);
      setError(resolveZodErrorMessage(parsed.error) ?? "Could not save history retention.");
      setStatus(null);
    },
    onSubmit: async ({ value }) => {
      if (!historySettings) return;
      const parsed = HistoryRetentionFormSchema.parse(value);

      setBusyAction("save");
      setError(null);
      setStatus(null);

      try {
        const updated = (await invoke("settings:history:update", {
          retentionCount: historySettings.envOverrides.retentionCount
            ? historySettings.retentionCount
            : parsed.retentionCount,
        })) as HistorySettings;
        setHistorySettings(updated);
        historyForm.reset({
          retentionCount: String(updated.retentionCount),
        });
        setStatus("History retention saved.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not save history retention.");
      } finally {
        setBusyAction(null);
      }
    },
  });
  const snapshotForm = useForm({
    defaultValues: MANUAL_SNAPSHOT_FORM_DEFAULTS,
    validators: {
      onSubmit: ManualSnapshotFormSchema,
    },
    onSubmit: async ({ value, formApi }) => {
      const parsed = ManualSnapshotFormSchema.parse(value);
      setBusyAction("create");
      clearBackupNotice();
      setError(null);
      setStatus(null);

      try {
        const job = (await invoke(
          "backup:create",
          parsed.label ? { label: parsed.label } : {},
        )) as BackupJobStatus;
        setBackupJob(job);
        formApi.reset();
        setStatus("Snapshot started in the background.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not create backup.");
      } finally {
        setBusyAction(null);
      }
    },
  });
  const scheduleValues = useStore(scheduleForm.store, (state) => state.values);
  const historyValues = useStore(historyForm.store, (state) => state.values);
  const snapshotValues = useStore(snapshotForm.store, (state) => state.values);

  const loadBackupSettings = useCallback(async () => {
    const data = (await invoke("settings:backup:get")) as BackupSettings;
    setSettings(data);
    scheduleForm.reset({
      autoEnabled: data.autoEnabled,
      intervalHours: String(data.intervalHours),
      retentionCount: String(data.retentionCount),
      retentionGiB: String(data.retentionGiB),
    });
  }, [scheduleForm]);

  const loadHistorySettings = useCallback(async () => {
    const data = (await invoke("settings:history:get")) as HistorySettings;
    setHistorySettings(data);
    historyForm.reset({
      retentionCount: String(data.retentionCount),
    });
  }, [historyForm]);

  const refresh = useCallback(async () => {
    setBusyAction("refresh");
    setError(null);
    setStatus(null);

    try {
      await Promise.all([loadBackupSettings(), loadHistorySettings(), refreshBackupRuntime()]);
      setConfirmRestoreId(null);
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load backups.");
    } finally {
      setBusyAction(null);
    }
  }, [loadBackupSettings, loadHistorySettings, refreshBackupRuntime]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (open) return;
    clearBackupNotice();
    setStatus(null);
    setError(null);
    setConfirmRestoreId(null);
    setConfirmDeleteId(null);
    snapshotForm.reset();
  }, [clearBackupNotice, historyForm, open, snapshotForm]);

  const handleRestoreBackup = useCallback(
    async (backupId: string) => {
      if (confirmRestoreId !== backupId) {
        setConfirmDeleteId(null);
        setConfirmRestoreId(backupId);
        setStatus("Click Restore again to confirm.");
        return;
      }

      setBusyAction("restore");
      clearBackupNotice();
      setError(null);
      setStatus(null);

      try {
        await invoke("backup:restore", {
          backupId,
          confirm: true,
          createSafetyBackup,
        });
        await loadBackups();
        setConfirmRestoreId(null);
        setStatus("Backup restored.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not restore backup.");
      } finally {
        setBusyAction(null);
      }
    },
    [clearBackupNotice, confirmRestoreId, createSafetyBackup, loadBackups],
  );

  const handleDeleteBackup = useCallback(
    async (backupId: string) => {
      if (confirmDeleteId !== backupId) {
        setConfirmRestoreId(null);
        setConfirmDeleteId(backupId);
        setStatus(null);
        setError(null);
        return;
      }

      setBusyAction("delete");
      clearBackupNotice();
      setError(null);
      setStatus(null);

      try {
        await invoke("backup:delete", backupId);
        await loadBackups();
        setConfirmDeleteId(null);
        setStatus("Snapshot deleted.");
      } catch (err) {
        setError(resolveFormErrorMessage(err) ?? "Could not delete backup.");
      } finally {
        setBusyAction(null);
      }
    },
    [clearBackupNotice, confirmDeleteId, loadBackups],
  );

  const hasBackupEnvOverrides =
    settings?.envOverrides.autoEnabled ||
    settings?.envOverrides.intervalHours ||
    settings?.envOverrides.retentionCount ||
    settings?.envOverrides.retentionGiB;
  const hasHistoryEnvOverride = historySettings?.envOverrides.retentionCount;
  const backupProgressUnits = backupJobPresentation?.progressUnits ?? 0;
  const backupProgressTotal = backupJobPresentation?.progressTotal ?? 1;
  const isBackupBusy = busyAction !== null || cancelPending;

  return (
    <div className="flex flex-col gap-[var(--padding-panel)]">
      <SectionBlock title="Automatic snapshots">
        <SettingRow
          label="Auto backups"
          description="Schedule background snapshots for the local store."
        >
          <TogglePill
            ariaLabel="Auto backups"
            value={scheduleValues.autoEnabled}
            onChange={(value) => scheduleForm.setFieldValue("autoEnabled", value)}
            disabled={Boolean(settings?.envOverrides.autoEnabled)}
          />
        </SettingRow>
        <SettingRow label="Frequency" description="Minimum is one hour.">
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-16"
              min={1}
              value={scheduleValues.intervalHours}
              disabled={Boolean(settings?.envOverrides.intervalHours)}
              onChange={(event) => scheduleForm.setFieldValue("intervalHours", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">hours</span>
          </div>
        </SettingRow>
        <SettingRow label="Retention" description="Snapshots kept before pruning.">
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-16"
              min={0}
              value={scheduleValues.retentionCount}
              disabled={Boolean(settings?.envOverrides.retentionCount)}
              onChange={(event) => scheduleForm.setFieldValue("retentionCount", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">max</span>
          </div>
        </SettingRow>
        <SettingRow
          label="Storage budget"
          description="Automatic snapshots share this limit; manual snapshots are never removed."
        >
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-20"
              min={0}
              max={8192}
              value={scheduleValues.retentionGiB}
              disabled={Boolean(settings?.envOverrides.retentionGiB)}
              onChange={(event) => scheduleForm.setFieldValue("retentionGiB", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">GiB</span>
          </div>
        </SettingRow>
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="text-sm text-token-text-secondary">
            {hasBackupEnvOverrides ? "Some values locked by env vars." : null}
          </div>
          <div className="flex items-center gap-2">
            <NodexButton
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
              disabled={isBackupBusy}
            >
              Refresh
            </NodexButton>
            <NodexButton
              variant="primary"
              size="sm"
              onClick={() => void scheduleForm.handleSubmit()}
              disabled={isBackupBusy}
            >
              Save schedule
            </NodexButton>
          </div>
        </div>
      </SectionBlock>

      <SectionBlock title="History retention">
        <SettingRow
          label="History retention"
          description="Newest deleted Block records kept per Project before safe collection. Use 0 to collect every unreferenced tombstone."
        >
          <div className="flex items-center gap-2">
            <NodexSettingsNumberInput
              className="w-20"
              min={0}
              value={historyValues.retentionCount}
              disabled={Boolean(historySettings?.envOverrides.retentionCount)}
              onChange={(event) => historyForm.setFieldValue("retentionCount", event.target.value)}
            />
            <span className="text-sm text-token-text-secondary">records</span>
          </div>
        </SettingRow>
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="text-sm text-token-text-secondary">
            {hasHistoryEnvOverride
              ? "Value locked by env var."
              : "Applied by background maintenance."}
          </div>
          <NodexButton
            variant="primary"
            size="sm"
            onClick={() => void historyForm.handleSubmit()}
            disabled={isBackupBusy}
          >
            Apply
          </NodexButton>
        </div>
      </SectionBlock>

      <SectionBlock title="Snapshots">
        {storageOptimization ? (
          <div className="flex items-start justify-between gap-3 px-3 pt-3 text-xs text-token-text-secondary">
            <div>
              <div className="text-token-text-primary">
                {storageOptimization.optimizing
                  ? "Optimizing snapshot storage"
                  : "Snapshot storage is optimized"}
              </div>
              <div className="mt-0.5">
                {storageOptimization.optimizing
                  ? storageOptimization.pendingCommitMetadata +
                      storageOptimization.pendingReceiptMetadata >
                    0
                    ? `${(
                        storageOptimization.pendingCommitMetadata +
                        storageOptimization.pendingReceiptMetadata
                      ).toLocaleString()} historical records remain to be measured before safe trimming.`
                    : "Old delivery history is being trimmed in short background slices."
                  : "Operational history stays inside a bounded retention window."}
              </div>
            </div>
            <span className="shrink-0 tabular-nums">
              {formatBackupSize(
                storageOptimization.retainedDeliveryBytes +
                  storageOptimization.retainedReceiptBytes,
              )}
            </span>
          </div>
        ) : null}
        {backupCapacity ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-3 text-xs text-token-text-secondary">
            <span>{formatBackupSize(backupCapacity.totalReadyBytes)} stored</span>
            <span aria-hidden="true">·</span>
            <span>{formatBackupSize(backupCapacity.availableBytes)} available</span>
            <span aria-hidden="true">·</span>
            <span>Next snapshot ≈ {formatBackupSize(backupCapacity.estimatedNextBackupBytes)}</span>
            {!backupCapacity.canCreate ? (
              <span className="text-danger">More free space is required for a safe snapshot.</span>
            ) : null}
          </div>
        ) : null}
        <form
          className="flex items-center gap-2 p-3"
          onSubmit={(event) => handleFormSubmit(event, snapshotForm.handleSubmit)}
        >
          <Input
            value={snapshotValues.label}
            placeholder="Optional snapshot label"
            onChange={(event) => snapshotForm.setFieldValue("label", event.target.value)}
            className="min-w-0 flex-1"
          />
          <NodexButton
            type="submit"
            variant="secondary"
            size="sm"
            disabled={
              isBackupBusy || backupJobPresentation?.active || backupCapacity?.canCreate === false
            }
          >
            {backupJobPresentation?.active ? "Creating…" : "Create snapshot"}
          </NodexButton>
        </form>
        {backupJob && backupJobPresentation?.active ? (
          <div
            className="semantic-text-secondary flex flex-col gap-1.5 px-3 pb-3 text-xs"
            aria-live="polite"
          >
            <div className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-text-info" aria-hidden="true" />
              <span className="text-info">{backupJobPresentation.phaseLabel}</span>
              <span aria-hidden="true">·</span>
              <span>The app remains available while the snapshot is verified.</span>
              <button
                type="button"
                className="ms-auto cursor-interaction text-foreground underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50"
                disabled={cancelPending || !backupJobPresentation.cancellable}
                onClick={() => void cancelBackupJob()}
              >
                {cancelPending ? "Cancelling…" : "Cancel"}
              </button>
            </div>
            <div
              className="h-1 overflow-hidden rounded-full bg-text/10"
              role="progressbar"
              aria-label="Snapshot progress"
              aria-valuemin={0}
              aria-valuemax={backupProgressTotal}
              aria-valuenow={backupProgressUnits}
            >
              <div
                className="h-full rounded-full bg-text-info transition-[width] duration-300"
                style={{
                  width: `${Math.min(100, (backupProgressUnits / backupProgressTotal) * 100)}%`,
                }}
              />
            </div>
            {backupJob.progress.databaseTotalPages > 0 ? (
              <div>
                {backupJob.progress.databaseCopiedPages.toLocaleString()} of{" "}
                {backupJob.progress.databaseTotalPages.toLocaleString()} database pages copied
                {backupJob.progress.databaseBusyRetries > 0
                  ? ` · ${backupJob.progress.databaseBusyRetries.toLocaleString()} transient retries`
                  : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <SettingRow
          label="Safety backup"
          description="Create a fresh snapshot before restoring an older one."
        >
          <NodexSwitch
            ariaLabel="Safety backup"
            checked={createSafetyBackup}
            onCheckedChange={setCreateSafetyBackup}
          />
        </SettingRow>
        <div className="flex flex-col">
          {backups.length === 0 ? (
            <div className="px-3 py-3 text-sm text-token-text-secondary">No snapshots yet.</div>
          ) : (
            backups.map((backup) => (
              <div key={backup.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-token-text-primary">
                    {backup.label?.trim() || backup.id}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-token-text-secondary">
                    <span>{formatBackupTimestamp(backup.createdAt)}</span>
                    <span>{formatBackupSize(backup.totalBytes)}</span>
                    <span className="inline-flex items-center rounded-full bg-token-foreground/5 px-1.5 py-px text-xs text-token-text-secondary">
                      {BACKUP_TRIGGER_LABELS[backup.trigger]}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {confirmDeleteId === backup.id ? (
                    <>
                      <NodexButton
                        variant="destructive"
                        size="sm"
                        onClick={() => void handleDeleteBackup(backup.id)}
                        disabled={isBackupBusy}
                      >
                        Confirm delete
                      </NodexButton>
                      <NodexButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={isBackupBusy}
                      >
                        Cancel
                      </NodexButton>
                    </>
                  ) : (
                    <>
                      <NodexButton
                        variant={confirmRestoreId === backup.id ? "destructive" : "secondary"}
                        size="sm"
                        onClick={() => void handleRestoreBackup(backup.id)}
                        disabled={isBackupBusy}
                      >
                        {confirmRestoreId === backup.id ? "Confirm restore" : "Restore"}
                      </NodexButton>
                      <NodexTooltip tooltipContent="Delete snapshot">
                        <NodexButton
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void handleDeleteBackup(backup.id)}
                          disabled={isBackupBusy}
                          aria-label={`Delete snapshot ${backup.label?.trim() || backup.id}`}
                        >
                          <DeleteIcon className="size-3.5" />
                        </NodexButton>
                      </NodexTooltip>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </SectionBlock>

      {status ? <p className="text-sm text-token-text-secondary">{status}</p> : null}
      {error ? <p className="text-sm text-token-error-foreground">{error}</p> : null}
      {backupNotice ? (
        <p
          className={cn(
            "text-sm",
            backupNotice.tone === "error"
              ? "text-token-error-foreground"
              : "text-token-text-secondary",
          )}
        >
          {backupNotice.message}
        </p>
      ) : null}
    </div>
  );
}

export interface SettingsRouteShellProps {
  path: string;
  onPathChange: (path: string) => void;
  onBackToApp: () => void;
  onRequestProjectPickerOpen: () => void;
  onOpenThread?: (threadId: string) => void | Promise<void>;
  projects: Project[];
  activeProjectId: string | null;
  initialLocalEnvironmentProjectId?: string | null;
  initialLocalEnvironmentConfigPath?: string | null;
  initialSettingsSearchQuery?: string;
  initialSettingsSearchHighlightIndex?: number;
  threadQueueFollowUpsEnabled: boolean;
  onThreadQueueFollowUpsEnabledChange: (value: boolean) => void;
  composerEnterBehavior: ComposerEnterBehavior;
  onComposerEnterBehaviorChange: (value: ComposerEnterBehavior) => void;
  worktreeStartMode: WorktreeStartMode;
  onWorktreeStartModeChange: (value: WorktreeStartMode) => void;
  worktreeAutoBranchPrefix: string;
  onWorktreeAutoBranchPrefixChange: (value: string) => void;
  taskShorthandPagePromotionEnabled: boolean;
  onTaskShorthandPagePromotionEnabledChange: (value: boolean) => void;
}

function SettingsPlaceholderPage({ label, message }: { label: string; message: string }) {
  return (
    <SettingsPageSurface title={label} subtitle={message}>
      <SectionBlock title={label}>
        <div className="text-token-text-secondary p-3 text-sm">{message}</div>
      </SectionBlock>
    </SettingsPageSurface>
  );
}

function isEditableEscapeElement(element: Element | null): boolean {
  return Boolean(
    element?.closest(
      [
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[contenteditable='']",
        "[role='dialog']",
        "[data-slot='dialog-content']",
        "[data-slot='dropdown-content']",
        "[data-slot='popover-content']",
        "[data-slot='tooltip-positioner']",
      ].join(","),
    ),
  );
}

function isEditableEscapeTarget(target: EventTarget | null): boolean {
  const targetElement = target instanceof Element ? target : null;
  const activeElement =
    targetElement?.ownerDocument.activeElement ??
    (typeof document === "undefined" ? null : document.activeElement);

  return isEditableEscapeElement(targetElement) || isEditableEscapeElement(activeElement);
}

function SettingsMobileHeader({
  activeSectionId,
  sections,
  onBack,
  onSelectSection,
}: {
  activeSectionId: SettingsSectionId;
  sections: SettingsSectionDefinition[];
  onBack: () => void;
  onSelectSection: (sectionId: SettingsSectionId) => void;
}) {
  const activeSection =
    sections.find((section) => section.id === activeSectionId) ?? sections[0] ?? null;

  return (
    <div className="absolute inset-x-0 top-0 z-20 flex h-toolbar items-center justify-between gap-2 border-b border-token-border bg-token-main-surface-primary px-panel md:hidden">
      <button
        type="button"
        onClick={onBack}
        className="cursor-interaction rounded-lg px-2 py-1 text-sm text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:ring-token-focus focus-visible:ring-1 focus-visible:outline-none"
      >
        Back
      </button>
      <NodexDropdownMenu
        align="end"
        triggerButton={
          <NodexDropdownButtonTrigger
            size="sm"
            chrome="transparent"
            style={{ maxWidth: "min(14rem, calc(100vw - 7rem))" }}
          >
            <span className="truncate">{activeSection?.label ?? "Settings"}</span>
          </NodexDropdownButtonTrigger>
        }
      >
        {sections.map((section) => (
          <NodexDropdownItem
            key={section.id}
            disabled={section.disabled}
            onSelect={() => onSelectSection(section.id)}
            rightSlot={section.id === activeSectionId ? <NodexDropdownSelectedIcon /> : null}
          >
            {section.label}
          </NodexDropdownItem>
        ))}
      </NodexDropdownMenu>
    </div>
  );
}

export function SettingsRouteShell({
  path,
  onPathChange,
  onBackToApp,
  onRequestProjectPickerOpen,
  onOpenThread,
  projects,
  activeProjectId,
  initialLocalEnvironmentProjectId,
  initialLocalEnvironmentConfigPath,
  initialSettingsSearchQuery,
  initialSettingsSearchHighlightIndex,
  threadQueueFollowUpsEnabled,
  onThreadQueueFollowUpsEnabledChange,
  composerEnterBehavior,
  onComposerEnterBehaviorChange,
  worktreeStartMode,
  onWorktreeStartModeChange,
  worktreeAutoBranchPrefix,
  onWorktreeAutoBranchPrefixChange,
  taskShorthandPagePromotionEnabled,
  onTaskShorthandPagePromotionEnabledChange,
}: SettingsRouteShellProps) {
  const isMacPlatform =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const shellRef = useRef<HTMLDivElement>(null);
  const {
    activeSectionId,
    browserAnchor,
    browserDetail,
    detailPageId,
    settingsAnchor,
    visibleSections,
  } = resolveSettingsShellState(path);
  const activeSection = visibleSections.find((section) => section.id === activeSectionId) ?? null;
  const settingsSearchContext = useMemo(() => {
    const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;

    return {
      activeProjectName: activeProject?.name ?? null,
      projectNames: projects.map((project) => project.name),
    };
  }, [activeProjectId, projects]);

  useEffect(() => {
    shellRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented || isEditableEscapeTarget(event.target)) return;
      onBackToApp();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBackToApp]);

  useEffect(() => {
    if (!settingsAnchor || settingsAnchor === browserAnchor) return;
    document.getElementById(settingsAnchor)?.scrollIntoView({ block: "start" });
  }, [browserAnchor, path, settingsAnchor]);

  const ActiveSectionComponent = activeSection
    ? SETTINGS_PAGE_COMPONENTS[activeSection.pageKey]
    : null;
  const shouldRenderPlaceholder =
    !ActiveSectionComponent ||
    activeSection?.placeholderKind === "unavailable" ||
    activeSection?.placeholderKind === "external";

  return (
    <div
      data-testid="settings-route-shell"
      className="flex h-full min-h-0 w-full flex-1 text-(--foreground)"
      style={CODEX_SETTINGS_SHELL_STYLE}
    >
      <div
        ref={shellRef}
        aria-label="Settings"
        tabIndex={-1}
        className="flex h-full min-h-0 w-full flex-1 outline-none"
      >
        <SettingsSidebar
          activeSectionId={activeSectionId}
          sections={visibleSections}
          searchContext={settingsSearchContext}
          initialSearchQuery={initialSettingsSearchQuery}
          initialHighlightedSearchIndex={initialSettingsSearchHighlightIndex}
          onBack={onBackToApp}
          onSelectSection={(sectionId) => {
            startTransition(() => {
              onPathChange(buildSettingsPath(sectionId));
            });
          }}
        />

        <div className="relative flex min-w-0 flex-1 overflow-hidden">
          <SettingsMobileHeader
            activeSectionId={activeSectionId}
            sections={visibleSections}
            onBack={onBackToApp}
            onSelectSection={(sectionId) => {
              startTransition(() => {
                onPathChange(buildSettingsPath(sectionId));
              });
            }}
          />
          <Suspense fallback={null}>
            {detailPageId === "open-source-licenses" ? (
              <OpenSourceLicensesSettingsPage
                onBack={() => {
                  startTransition(() => {
                    onPathChange(buildSettingsPath("general-settings"));
                  });
                }}
              />
            ) : shouldRenderPlaceholder ? (
              <SettingsPlaceholderPage
                label={activeSection?.label ?? "Settings"}
                message={
                  activeSection?.placeholderKind === "external"
                    ? "This settings page opens outside the app."
                    : "This settings page is not available yet."
                }
              />
            ) : (
              <ActiveSectionComponent
                open={true}
                path={path}
                onPathChange={onPathChange}
                browserAnchor={browserAnchor}
                browserDetail={browserDetail}
                onOpenBrowserDetail={(destination, anchor) => {
                  startTransition(() => {
                    onPathChange(
                      destination === "browser"
                        ? buildBrowserSettingsPath(undefined, anchor)
                        : buildBrowserSettingsPath(destination),
                    );
                  });
                }}
                isMacPlatform={isMacPlatform}
                projects={projects}
                activeProjectId={activeProjectId}
                initialLocalEnvironmentProjectId={initialLocalEnvironmentProjectId}
                initialLocalEnvironmentConfigPath={initialLocalEnvironmentConfigPath}
                onRequestProjectPickerOpen={onRequestProjectPickerOpen}
                onOpenThread={onOpenThread}
                threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
                onThreadQueueFollowUpsEnabledChange={onThreadQueueFollowUpsEnabledChange}
                composerEnterBehavior={composerEnterBehavior}
                onComposerEnterBehaviorChange={onComposerEnterBehaviorChange}
                worktreeStartMode={worktreeStartMode}
                onWorktreeStartModeChange={onWorktreeStartModeChange}
                worktreeAutoBranchPrefix={worktreeAutoBranchPrefix}
                onWorktreeAutoBranchPrefixChange={onWorktreeAutoBranchPrefixChange}
                taskShorthandPagePromotionEnabled={taskShorthandPagePromotionEnabled}
                onTaskShorthandPagePromotionEnabledChange={
                  onTaskShorthandPagePromotionEnabledChange
                }
              />
            )}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
