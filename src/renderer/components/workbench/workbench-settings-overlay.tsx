import { useForm, useStore } from "@tanstack/react-form";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  ChevronLeft,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Shield,
  Sun,
  Type,
} from "lucide-react";
import { Input } from "../ui/input";
import { invoke } from "../../lib/api";
import { handleFormSubmit, resolveFormErrorMessage } from "../../lib/forms";
import type { CardPropertyPosition } from "../../lib/card-property-position";
import { FILE_LINK_OPENER_ICON_URLS } from "../../lib/file-link-opener-icons";
import {
  CARD_STAGE_COLLAPSIBLE_PROPERTIES,
  CARD_STAGE_COLLAPSIBLE_PROPERTY_LABELS,
  type CardStageCollapsibleProperty,
} from "../../lib/card-stage-collapsed-properties";
import { useCardPropertyPosition } from "../../lib/use-card-property-position";
import { useFileLinkOpener } from "../../lib/use-file-link-opener";
import { useCardStageCollapsedProperties } from "../../lib/use-card-stage-collapsed-properties";
import { DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX } from "../../lib/worktree-branch-prefix";
import {
  DEFAULT_NEXT_PANEL_PEEK_PX,
  MAX_NEXT_PANEL_PEEK_PX,
  MIN_ENABLED_NEXT_PANEL_PEEK_PX,
  MIN_NEXT_PANEL_PEEK_PX,
  NEXT_PANEL_PEEK_STEP_PX,
} from "../../lib/stage-rail-peek";
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
import { useNfmAutolinkSettings } from "../../lib/use-nfm-autolink-settings";
import { AppUpdateSettingsControl } from "./app-update-settings-control";
import {
  DEFAULT_DESCRIPTION_SOFT_LIMIT,
  DEFAULT_TEXT_PROMPT_CHAR_THRESHOLD,
  MAX_DESCRIPTION_SOFT_LIMIT,
  MAX_TEXT_PROMPT_CHAR_THRESHOLD,
  MIN_DESCRIPTION_SOFT_LIMIT,
  MIN_TEXT_PROMPT_CHAR_THRESHOLD,
} from "../../lib/paste-resource-settings";
import { usePasteResourceSettings } from "../../lib/use-paste-resource-settings";
import { useThreadSectionSendSettings } from "../../lib/use-thread-section-send-settings";
import type { StageRailLayoutMode } from "../../lib/stage-rail-layout-mode";
import { useSansFontSize } from "../../lib/use-sans-font-size";
import type { ThreadPromptSubmitShortcut } from "../../lib/thread-panel-prompt-submit-shortcut";
import { useSpellcheck } from "../../lib/use-spellcheck";
import { useTheme } from "../../lib/use-theme";
import type {
  BackupRecord,
  BackupSettings,
  HistorySettings,
  ManagedWorktreeRecord,
  ThreadNotificationSettings,
  WorktreeStartMode,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  FILE_LINK_OPENER_OPTIONS,
  normalizeFileLinkOpenerId,
} from "../../../shared/file-link-openers";
import {
  SIDEBAR_TOP_LEVEL_SECTION_LABELS,
  type SidebarTopLevelSectionId,
  type SidebarTopLevelSectionsPrefs,
} from "../../lib/sidebar-section-prefs";

type SettingsSectionId = "workspace" | "editor" | "card" | "worktrees" | "backups";

const SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
    { id: "workspace", label: "Workspace", icon: Palette },
    { id: "editor", label: "Editor", icon: Type },
    { id: "card", label: "Card", icon: Type },
    { id: "worktrees", label: "Worktrees", icon: Type },
    { id: "backups", label: "Backups", icon: Shield },
  ];

const BACKUP_TRIGGER_LABELS: Record<BackupRecord["trigger"], string> = {
  manual: "Manual",
  auto: "Auto",
  "pre-restore": "Safety",
};

interface SettingRowProps {
  label: string;
  description?: string;
  children: ReactNode;
}

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

interface ToggleGroupOption<T extends string> {
  value: T;
  label: string;
}

interface ToggleGroupProps<T extends string> {
  selectedValues: readonly T[];
  onToggle: (value: T) => void;
  options: ToggleGroupOption<T>[];
}

function SettingRow({
  label,
  description,
  children,
}: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-6 p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="min-w-0 text-sm text-(--foreground)">
          {label}
        </div>
        {description ? (
          <div className="min-w-0 text-sm text-(--foreground-secondary)">
            {description}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function SectionBlock({
  title,
  children,
  sectionRef,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
  sectionRef?: (element: HTMLElement | null) => void;
}) {
  return (
    <section ref={sectionRef} className="flex flex-col">
      <div className="flex h-10 items-center px-0 py-0">
        <div className="text-base font-medium text-(--foreground)">
          {title}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div
          className={cn(
            "flex flex-col rounded-lg border-[calc(var(--spacing)*0.125)]",
            "border-(--border) bg-foreground-2",
            "divide-y-[calc(var(--spacing)*0.125)] divide-(--border)",
          )}
        >
          {children}
        </div>
      </div>
    </section>
  );
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

function ToggleGroup<T extends string>({
  selectedValues,
  onToggle,
  options,
}: ToggleGroupProps<T>) {
  const selected = new Set(selectedValues);

  return (
    <div className="flex max-w-72 flex-wrap justify-end gap-1">
      {options.map((option) => {
        const isSelected = selected.has(option.value);

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onToggle(option.value)}
            aria-pressed={isSelected}
            className={cn(
              "rounded-full border px-2 py-0.5 text-sm/4.5 transition-colors",
              "outline-none focus-visible:ring-2 focus-visible:ring-(--accent-blue)/30",
              isSelected
                ? "border-transparent bg-foreground-5 text-(--foreground)"
                : "border-(--border) text-(--foreground-secondary) hover:bg-foreground-5",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function TogglePill({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  const handleToggle = useCallback(() => {
    if (disabled) return;
    onChange(!value);
  }, [disabled, onChange, value]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={handleToggle}
      disabled={disabled}
      className={cn(
        "flex items-center gap-2 text-sm focus-visible:rounded-full focus-visible:ring-2 focus-visible:ring-(--accent-blue)/50 focus-visible:outline-none",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "relative inline-flex h-5 w-8 shrink-0 items-center rounded-full transition-colors duration-200 ease-out",
          value
            ? "bg-(--accent-blue)"
            : "bg-foreground-10",
        )}
      >
        <span
          className={cn(
            "size-4 rounded-full border border-white bg-white shadow-sm transition-transform duration-200 ease-out",
            value ? "translate-x-3.25" : "translate-x-0.75",
          )}
        />
      </span>
    </button>
  );
}

function ThemeSettingControl() {
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

function ThreadNotificationSettingControl({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<ThreadNotificationSettings>({
    threadCompletionEnabled: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await invoke("settings:thread-notifications:get");
      const nextValue =
        typeof result === "object" &&
          result !== null &&
          typeof (result as ThreadNotificationSettings).threadCompletionEnabled === "boolean"
          ? (result as ThreadNotificationSettings)
          : null;
      if (!nextValue) {
        throw new Error("Could not load thread notification settings.");
      }
      setSettings(nextValue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load thread notification settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  const handleChange = useCallback(
    async (threadCompletionEnabled: boolean) => {
      const previous = settings;
      setSettings({ threadCompletionEnabled });
      setBusy(true);
      setError(null);

      try {
        const result = await invoke("settings:thread-notifications:update", {
          threadCompletionEnabled,
        });
        const nextValue =
          typeof result === "object" &&
            result !== null &&
            typeof (result as ThreadNotificationSettings).threadCompletionEnabled === "boolean"
            ? (result as ThreadNotificationSettings)
            : null;
        if (!nextValue) {
          throw new Error("Could not save thread notification settings.");
        }
        setSettings(nextValue);
      } catch (err) {
        setSettings(previous);
        setError(err instanceof Error ? err.message : "Could not save thread notification settings.");
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <TogglePill
        value={settings.threadCompletionEnabled}
        onChange={(value) => {
          void handleChange(value);
        }}
        disabled={busy}
      />
      {error ? (
        <span className="max-w-48 text-right text-xs text-(--red-text)">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function SidebarSectionVisibilitySettingControl({
  order,
  sections,
  onVisibleChange,
}: {
  order: readonly SidebarTopLevelSectionId[];
  sections: SidebarTopLevelSectionsPrefs;
  onVisibleChange: (sectionId: SidebarTopLevelSectionId, visible: boolean) => void;
}) {
  return (
    <ToggleGroup
      selectedValues={order.filter((sectionId) => sections[sectionId].visible)}
      onToggle={(sectionId) => onVisibleChange(sectionId, !sections[sectionId].visible)}
      options={order.map((sectionId) => ({
        value: sectionId,
        label: SIDEBAR_TOP_LEVEL_SECTION_LABELS[sectionId],
      }))}
    />
  );
}

function SpellcheckSettingControl() {
  const { spellcheck, toggleSpellcheck } = useSpellcheck();

  return <TogglePill value={spellcheck} onChange={() => toggleSpellcheck()} />;
}

function NfmAutolinkTypingSettingControl() {
  const { settings, updateSettings } = useNfmAutolinkSettings();

  return (
    <TogglePill
      value={settings.autoLinkWhileTyping}
      onChange={(value) => updateSettings({ autoLinkWhileTyping: value })}
    />
  );
}

function NfmAutolinkPasteSettingControl() {
  const { settings, updateSettings } = useNfmAutolinkSettings();

  return (
    <TogglePill
      value={settings.autoLinkOnPaste}
      onChange={(value) => updateSettings({ autoLinkOnPaste: value })}
    />
  );
}

function NfmAutolinkBareDomainsSettingControl() {
  const { settings, updateSettings } = useNfmAutolinkSettings();
  const disabled = !settings.autoLinkWhileTyping && !settings.autoLinkOnPaste;

  return (
    <TogglePill
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
        className="h-8 w-28 rounded-md border border-(--border) bg-(--background) px-2 text-sm text-(--foreground)"
      />
      <span className="text-sm text-(--foreground-secondary) tabular-nums">
        Default {defaultValue.toLocaleString()}
      </span>
    </div>
  );
}

function PasteResourceTextThresholdSettingControl() {
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

function PasteResourceDescriptionSoftLimitSettingControl() {
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

function ThreadSectionSendConfirmationSettingControl() {
  const { settings, updateSettings } = useThreadSectionSendSettings();

  return (
    <TogglePill
      value={settings.confirmBeforeSend}
      onChange={(value) => updateSettings({ confirmBeforeSend: value })}
    />
  );
}

function SansFontSizeSettingControl() {
  const { sansFontSize, setSansFontSize } = useSansFontSize();
  const isDefault = sansFontSize === DEFAULT_SANS_FONT_SIZE;

  return (
    <div className="flex items-center gap-3">
      <span className="w-10 text-right text-sm text-(--foreground-secondary) tabular-nums">
        {sansFontSize}px
      </span>
      <input
        type="range"
        min={MIN_SANS_FONT_SIZE}
        max={MAX_SANS_FONT_SIZE}
        step={1}
        value={sansFontSize}
        onChange={(event) => {
          const nextValue = Number.parseInt(event.target.value, 10);
          if (!Number.isFinite(nextValue)) return;
          setSansFontSize(nextValue);
        }}
        aria-label="Sans font size"
        className="w-28 accent-(--accent-blue)"
      />
      <button
        type="button"
        onClick={() => setSansFontSize(DEFAULT_SANS_FONT_SIZE)}
        disabled={isDefault}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full border px-2 py-0.5 text-sm transition-colors",
          isDefault
            ? "border-transparent bg-foreground-5 text-(--foreground-secondary) opacity-60"
            : "border-(--border) text-(--foreground-secondary) hover:bg-foreground-5 hover:text-(--foreground)",
          "disabled:cursor-not-allowed",
        )}
      >
        <RotateCcw className="size-3.5" />
        <span>Default</span>
      </button>
    </div>
  );
}

function CodeFontSizeSettingControl() {
  const { codeFontSize, setCodeFontSize } = useCodeFontSize();
  const isDefault = codeFontSize === DEFAULT_CODE_FONT_SIZE;

  return (
    <div className="flex items-center gap-3">
      <span className="w-10 text-right text-sm text-(--foreground-secondary) tabular-nums">
        {codeFontSize}px
      </span>
      <input
        type="range"
        min={MIN_CODE_FONT_SIZE}
        max={MAX_CODE_FONT_SIZE}
        step={1}
        value={codeFontSize}
        onChange={(event) => {
          const nextValue = Number.parseInt(event.target.value, 10);
          if (!Number.isFinite(nextValue)) return;
          setCodeFontSize(nextValue);
        }}
        aria-label="Code font size"
        className="w-28 accent-(--accent-blue)"
      />
      <button
        type="button"
        onClick={() => setCodeFontSize(DEFAULT_CODE_FONT_SIZE)}
        disabled={isDefault}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-full border px-2 py-0.5 text-sm transition-colors",
          isDefault
            ? "border-transparent bg-foreground-5 text-(--foreground-secondary) opacity-60"
            : "border-(--border) text-(--foreground-secondary) hover:bg-foreground-5 hover:text-(--foreground)",
          "disabled:cursor-not-allowed",
        )}
      >
        <RotateCcw className="size-3.5" />
        <span>Default</span>
      </button>
    </div>
  );
}

function FileLinkOpenerSettingControl() {
  const { opener, setOpener } = useFileLinkOpener();
  const selectedOption = FILE_LINK_OPENER_OPTIONS.find((option) => option.id === opener)
    ?? FILE_LINK_OPENER_OPTIONS[0];

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 min-w-50 items-center justify-between gap-1 rounded-lg border border-transparent px-2 py-0 text-base/4.5",
            "bg-foreground-5 text-(--foreground)",
            "transition-colors hover:bg-foreground-10",
            "outline-hidden focus-visible:ring-2 focus-visible:ring-(--accent-blue)/30",
            "select-none disabled:cursor-not-allowed disabled:opacity-40",
          )}
          aria-label={`Open markdown file links in ${selectedOption.label}`}
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
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          sideOffset={8}
          align="end"
          className={cn(
            "z-50 min-w-48 rounded-lg p-1",
            "bg-(--background) text-(--foreground)",
            "border border-(--border)",
            "shadow-overlay-xl",
            "scrollbar-token max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height,24rem))] overflow-y-auto",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.985]",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.985]",
          )}
        >
          {FILE_LINK_OPENER_OPTIONS.map((option) => {
            const isSelected = option.id === selectedOption.id;

            return (
              <DropdownMenuPrimitive.Item
                key={option.id}
                onSelect={() => setOpener(normalizeFileLinkOpenerId(option.id))}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors outline-none select-none",
                  isSelected
                    ? "bg-(--accent) text-(--foreground)"
                    : "text-(--foreground) hover:bg-(--accent) focus:bg-(--accent)",
                )}
              >
                <img
                  src={FILE_LINK_OPENER_ICON_URLS[option.id]}
                  alt=""
                  className="size-4 shrink-0 object-contain"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </DropdownMenuPrimitive.Item>
            );
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function CardPropertyPositionSettingControl() {
  const { position, setPosition } = useCardPropertyPosition();

  return (
    <SegmentedControl<CardPropertyPosition>
      value={position}
      onChange={setPosition}
      options={[
        { value: "top", label: "Top" },
        { value: "inline", label: "Inline" },
        { value: "bottom", label: "Bottom" },
      ]}
    />
  );
}

function CardStageCollapsedPropertiesSettingControl() {
  const { collapsedProperties, toggleCollapsedProperty } = useCardStageCollapsedProperties();

  return (
    <ToggleGroup<CardStageCollapsibleProperty>
      selectedValues={collapsedProperties}
      onToggle={toggleCollapsedProperty}
      options={CARD_STAGE_COLLAPSIBLE_PROPERTIES.map((property) => ({
        value: property,
        label: CARD_STAGE_COLLAPSIBLE_PROPERTY_LABELS[property],
      }))}
    />
  );
}

function WorktreeStartModeSettingControl({
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

function WorktreeAutoBranchPrefixSettingControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = useCallback(() => {
    onChange(draft);
  }, [draft, onChange]);

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
      autoCapitalize="none"
      autoCorrect="off"
      placeholder={DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX}
      aria-label="Auto branch prefix"
      className="h-8 w-52 rounded-md border border-(--border) bg-(--background) px-2 text-sm text-(--foreground)"
    />
  );
}

function formatWorktreeTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000);
    return `${mins}m ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    return `${hours}h ago`;
  }
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ManagedWorktreesSettingControl({ open }: { open: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<ManagedWorktreeRecord[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke("worktrees:list");
      setRecords(Array.isArray(result) ? (result as ManagedWorktreeRecord[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load managed worktrees.");
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const handleDelete = useCallback(
    async (threadId: string) => {
      setDeletingId(threadId);
      try {
        await invoke("worktrees:delete", threadId);
        setRecords((prev) => prev.filter((r) => r.threadId !== threadId));
      } catch {
        // Reload to get fresh state on failure
        await load();
      } finally {
        setDeletingId(null);
      }
    },
    [load],
  );

  const count = records.length;

  return (
    <div className="flex w-full flex-col gap-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        {count > 0 ? (
          <span className="rounded-full bg-foreground-5 px-1.5 py-0 text-xs text-(--foreground-secondary) tabular-nums">
            {count}
          </span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load()}
          className={cn(
            "rounded-full border px-2 py-0.5 text-xs/4 transition-colors",
            "border-(--border) text-(--foreground-secondary) hover:bg-foreground-5",
          )}
          disabled={loading}
        >
          {loading ? "Refreshing\u2026" : "Refresh"}
        </button>
      </div>

      {/* Error */}
      {error ? (
        <div className="rounded-md bg-(--red-text)/8 px-3 py-2 text-xs text-(--red-text)">
          {error}
        </div>
      ) : null}

      {/* Empty state */}
      {!error && count === 0 && !loading ? (
        <div className="py-6 text-center text-xs text-(--foreground-secondary)">
          No managed worktrees yet
        </div>
      ) : null}

      {/* Card list */}
      {count > 0 ? (
        <div className="flex max-h-64 flex-col overflow-auto">
          {records.map((record) => {
            const isDeleting = deletingId === record.threadId;
            const label =
              record.projectName && record.cardTitle
                ? `${record.projectName} / ${record.cardTitle}`
                : record.projectName ?? record.cardTitle ?? record.cardId;
            return (
              <div
                key={record.threadId}
                className={cn(
                  "group/wt flex items-start gap-3 border-b border-(--border) px-1 py-2.5 last:border-b-0",
                  isDeleting && "pointer-events-none opacity-40",
                )}
              >
                {/* Status dot */}
                <div className="mt-1.5 flex shrink-0">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      record.exists
                        ? "bg-emerald-500"
                        : "bg-amber-500",
                    )}
                    title={record.exists ? "Directory exists" : "Directory missing"}
                  />
                </div>

                {/* Content */}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-xs text-(--foreground-secondary)">
                      {label}
                    </span>
                    <span className="text-[10px] text-(--foreground-secondary)/50">/</span>
                    <span className="shrink-0 text-xs font-medium text-(--foreground)">
                      {record.threadName || record.threadId.slice(0, 8)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="min-w-0 truncate font-mono text-[11px] text-(--foreground-secondary)/70"
                      title={record.path}
                    >
                      {record.path}
                    </span>
                    <span className="shrink-0 text-[10px] text-(--foreground-secondary)/50">
                      {formatWorktreeTime(record.linkedAt)}
                    </span>
                  </div>
                </div>

                {/* Delete button */}
                <button
                  type="button"
                  onClick={() => void handleDelete(record.threadId)}
                  disabled={isDeleting}
                  className={cn(
                    "mt-0.5 shrink-0 rounded-sm p-1 text-(--foreground-secondary)/50 transition-colors",
                    "opacity-0 group-hover/wt:opacity-100 hover:bg-foreground-5 hover:text-(--red-text)",
                    "focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-(--accent-blue) focus-visible:outline-none",
                  )}
                  title="Remove worktree directory"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ThreadThinkingSettingControl({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return <TogglePill value={value} onChange={onChange} />;
}

function SmartPrefixParsingSettingControl({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return <TogglePill value={value} onChange={onChange} />;
}

function StripSmartPrefixFromTitleSettingControl({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return <TogglePill value={value} onChange={onChange} disabled={disabled} />;
}

function ThreadPromptSubmitShortcutControl({
  value,
  onChange,
}: {
  value: ThreadPromptSubmitShortcut;
  onChange: (value: ThreadPromptSubmitShortcut) => void;
}) {
  const modifierLabel = (
    typeof navigator !== "undefined"
    && navigator.platform.toLowerCase().includes("mac")
  )
    ? "Cmd+Enter"
    : "Ctrl+Enter";

  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      options={[
        { value: "enter", label: "Enter" },
        { value: "mod-enter", label: modifierLabel },
      ]}
    />
  );
}

function StageRailPeekSettingControl({
  value,
  onChange,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const isEnabled = value > MIN_NEXT_PANEL_PEEK_PX;
  const lastEnabledValueRef = useRef(
    value > MIN_NEXT_PANEL_PEEK_PX ? value : DEFAULT_NEXT_PANEL_PEEK_PX,
  );

  useEffect(() => {
    if (value <= MIN_NEXT_PANEL_PEEK_PX) return;
    lastEnabledValueRef.current = value;
  }, [value]);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    if (isEnabled) {
      onChange(MIN_NEXT_PANEL_PEEK_PX);
      return;
    }

    onChange(lastEnabledValueRef.current);
  }, [disabled, isEnabled, onChange]);

  const handleRangeChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;
      const parsed = Number.parseInt(event.target.value, 10);
      if (!Number.isFinite(parsed)) return;
      onChange(parsed);
    },
    [disabled, onChange],
  );

  const sliderValue = isEnabled ? value : lastEnabledValueRef.current;

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-(--foreground-secondary) tabular-nums">
        {isEnabled ? `${value}px` : "Hidden"}
      </span>
      <input
        type="range"
        min={MIN_ENABLED_NEXT_PANEL_PEEK_PX}
        max={MAX_NEXT_PANEL_PEEK_PX}
        step={NEXT_PANEL_PEEK_STEP_PX}
        value={sliderValue}
        disabled={disabled || !isEnabled}
        onChange={handleRangeChange}
        aria-label="Next panel peek width"
        className={cn(
          "w-28 accent-(--accent-blue)",
          (disabled || !isEnabled) && "cursor-not-allowed opacity-40",
        )}
      />
      <TogglePill value={isEnabled} onChange={() => handleToggle()} disabled={disabled} />
    </div>
  );
}

function StageRailLayoutModeControl({
  value,
  onChange,
}: {
  value: StageRailLayoutMode;
  onChange: (value: StageRailLayoutMode) => void;
}) {
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      options={[
        { value: "sliding-window", label: "Sliding window" },
        { value: "full-rail", label: "Full rail" },
      ]}
    />
  );
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

function BackupSettingsControl({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [historySettings, setHistorySettings] = useState<HistorySettings | null>(null);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [createSafetyBackup, setCreateSafetyBackup] = useState(true);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"refresh" | "save" | "create" | "restore" | null>(
    null,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scheduleForm = useForm({
    defaultValues: {
      autoEnabled: false,
      intervalHours: "6",
      retentionCount: "28",
    },
    onSubmit: async ({ value }) => {
      if (!settings) return;

      const parsedInterval = Number.parseInt(value.intervalHours.trim(), 10);
      if (
        !settings.envOverrides.intervalHours &&
        (!Number.isInteger(parsedInterval) || parsedInterval < 1)
      ) {
        setError("Frequency must be an integer >= 1 hour.");
        return;
      }

      const parsedRetention = Number.parseInt(value.retentionCount.trim(), 10);
      if (
        !settings.envOverrides.retentionCount &&
        (!Number.isInteger(parsedRetention) || parsedRetention < 0)
      ) {
        setError("Retention must be an integer >= 0.");
        return;
      }

      setBusyAction("save");
      setError(null);
      setStatus(null);

      try {
        const updated = (await invoke("settings:backup:update", {
          autoEnabled: settings.envOverrides.autoEnabled ? settings.autoEnabled : value.autoEnabled,
          intervalHours: settings.envOverrides.intervalHours ? settings.intervalHours : parsedInterval,
          retentionCount: settings.envOverrides.retentionCount
            ? settings.retentionCount
            : parsedRetention,
        })) as BackupSettings;
        setSettings(updated);
        scheduleForm.reset({
          autoEnabled: updated.autoEnabled,
          intervalHours: String(updated.intervalHours),
          retentionCount: String(updated.retentionCount),
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
    defaultValues: {
      retentionCount: "1000",
    },
    onSubmit: async ({ value }) => {
      if (!historySettings) return;

      const parsedRetention = Number.parseInt(value.retentionCount.trim(), 10);
      if (
        !historySettings.envOverrides.retentionCount &&
        (!Number.isInteger(parsedRetention) || parsedRetention < 0)
      ) {
        setError("History retention must be an integer >= 0.");
        return;
      }

      setBusyAction("save");
      setError(null);
      setStatus(null);

      try {
        const updated = (await invoke("settings:history:update", {
          retentionCount: historySettings.envOverrides.retentionCount
            ? historySettings.retentionCount
            : parsedRetention,
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
    defaultValues: {
      label: "",
    },
    onSubmit: async ({ value, formApi }) => {
      setBusyAction("create");
      setError(null);
      setStatus(null);

      try {
        const label = value.label.trim();
        await invoke("backup:create", label ? { label } : {});
        await loadBackups();
        formApi.reset();
        setStatus("Manual backup created.");
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
    });
  }, [scheduleForm]);

  const loadBackups = useCallback(async () => {
    const list = (await invoke("backup:list")) as BackupRecord[];
    setBackups(list);
  }, []);

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
      await Promise.all([loadBackupSettings(), loadHistorySettings(), loadBackups()]);
      setConfirmRestoreId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load backups.");
    } finally {
      setBusyAction(null);
    }
  }, [loadBackupSettings, loadBackups, loadHistorySettings]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (open) return;
    setStatus(null);
    setError(null);
    setConfirmRestoreId(null);
    snapshotForm.reset();
  }, [historyForm, open, snapshotForm]);

  const handleRestoreBackup = useCallback(
    async (backupId: string) => {
      if (confirmRestoreId !== backupId) {
        setConfirmRestoreId(backupId);
        setStatus("Click Restore again to confirm.");
        return;
      }

      setBusyAction("restore");
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
    [confirmRestoreId, createSafetyBackup, loadBackups],
  );

  const hasBackupEnvOverrides =
    settings?.envOverrides.autoEnabled ||
    settings?.envOverrides.intervalHours ||
    settings?.envOverrides.retentionCount;
  const hasHistoryEnvOverride = historySettings?.envOverrides.retentionCount;

  return (
    <div className="flex flex-col gap-3">
      {/* Schedule settings card */}
      <div
        className={cn(
          "flex flex-col rounded-lg border-[calc(var(--spacing)*0.125)]",
          "border-(--border) bg-foreground-2",
          "divide-y-[calc(var(--spacing)*0.125)] divide-(--border)",
        )}
      >
        <SettingRow label="Auto backups" description="Schedule background snapshots for the local store.">
          <TogglePill
            value={scheduleValues.autoEnabled}
            onChange={(value) => scheduleForm.setFieldValue("autoEnabled", value)}
            disabled={Boolean(settings?.envOverrides.autoEnabled)}
          />
        </SettingRow>
        <SettingRow label="Frequency" description="Minimum is one hour.">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={scheduleValues.intervalHours}
              disabled={Boolean(settings?.envOverrides.intervalHours)}
              onChange={(event) => scheduleForm.setFieldValue("intervalHours", event.target.value)}
              className="h-7 w-16 rounded-lg border border-(--border) bg-foreground-5 px-2 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent-blue)/30"
            />
            <span className="text-sm text-(--foreground-secondary)">hours</span>
          </div>
        </SettingRow>
        <SettingRow label="Retention" description="Snapshots kept before pruning.">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              value={scheduleValues.retentionCount}
              disabled={Boolean(settings?.envOverrides.retentionCount)}
              onChange={(event) => scheduleForm.setFieldValue("retentionCount", event.target.value)}
              className="h-7 w-16 rounded-lg border border-(--border) bg-foreground-5 px-2 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent-blue)/30"
            />
            <span className="text-sm text-(--foreground-secondary)">max</span>
          </div>
        </SettingRow>
        {/* Save row inside the card */}
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="text-sm text-(--foreground-secondary)">
            {hasBackupEnvOverrides ? "Some values locked by env vars." : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busyAction !== null}
              className={cn(
                "h-7 rounded-lg bg-foreground-5 px-2.5 text-sm text-(--foreground-secondary) transition-colors",
                "hover:bg-foreground-10 hover:text-(--foreground)",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void scheduleForm.handleSubmit()}
              disabled={busyAction !== null}
              className={cn(
                "h-7 rounded-lg bg-(--accent-blue) px-2.5 text-sm text-white transition-colors",
                "hover:bg-(--accent-blue-hover)",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              Save schedule
            </button>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "flex flex-col rounded-lg border-[calc(var(--spacing)*0.125)]",
          "border-(--border) bg-foreground-2",
          "divide-y-[calc(var(--spacing)*0.125)] divide-(--border)",
        )}
      >
        <SettingRow
          label="History retention"
          description="Per-project history rows kept before pruning. Use 0 for unlimited."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              value={historyValues.retentionCount}
              disabled={Boolean(historySettings?.envOverrides.retentionCount)}
              onChange={(event) => historyForm.setFieldValue("retentionCount", event.target.value)}
              className="h-7 w-20 rounded-lg border border-(--border) bg-foreground-5 px-2 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent-blue)/30"
            />
            <span className="text-sm text-(--foreground-secondary)">rows</span>
          </div>
        </SettingRow>
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="text-sm text-(--foreground-secondary)">
            {hasHistoryEnvOverride ? "Value locked by env var." : "Applied on future writes."}
          </div>
          <button
            type="button"
            onClick={() => void historyForm.handleSubmit()}
            disabled={busyAction !== null}
            className={cn(
              "h-7 rounded-lg bg-(--accent-blue) px-2.5 text-sm text-white transition-colors",
              "hover:bg-(--accent-blue-hover)",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Apply
          </button>
        </div>
      </div>

      {/* Snapshot + restore card */}
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-lg border-[calc(var(--spacing)*0.125)]",
          "border-(--border) bg-foreground-2",
          "divide-y-[calc(var(--spacing)*0.125)] divide-(--border)",
        )}
      >
        {/* Create snapshot row */}
        <form
          className="flex items-center gap-2 p-3"
          onSubmit={(event) => handleFormSubmit(event, snapshotForm.handleSubmit)}
        >
          <Input
            value={snapshotValues.label}
            placeholder="Optional snapshot label"
            onChange={(event) => snapshotForm.setFieldValue("label", event.target.value)}
            className="h-7 min-w-0 flex-1 rounded-lg border border-(--border) bg-foreground-5 px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--accent-blue)/30"
          />
          <button
            type="submit"
            disabled={busyAction !== null}
            className={cn(
              "h-7 shrink-0 rounded-lg bg-foreground-5 px-2.5 text-sm text-(--foreground-secondary) transition-colors",
              "hover:bg-foreground-10 hover:text-(--foreground)",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Create snapshot
          </button>
        </form>
        {/* Restore header */}
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="text-sm text-(--foreground)">
            Restore history
          </div>
          <label className="inline-flex items-center gap-1.5 text-sm text-(--foreground-secondary)">
            <input
              type="checkbox"
              checked={createSafetyBackup}
              onChange={(event) => setCreateSafetyBackup(event.target.checked)}
              className="size-3.5 rounded-sm accent-(--accent-blue)"
            />
            Safety backup
          </label>
        </div>
        {/* Backup list */}
        <div className="scrollbar-token max-h-56 overflow-y-auto">
          {backups.length === 0 ? (
            <div className="px-3 py-3 text-sm text-(--foreground-secondary)">
              No snapshots yet.
            </div>
          ) : (
            backups.map((backup) => (
              <div
                key={backup.id}
                className="flex items-center justify-between gap-3 border-t border-(--border) px-3 py-2.5 first:border-t-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-(--foreground)">
                    {backup.label?.trim() || backup.id}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-(--foreground-secondary)">
                    <span>{formatBackupTimestamp(backup.createdAt)}</span>
                    <span>{formatBackupSize(backup.totalBytes)}</span>
                    <span className="inline-flex items-center rounded-full bg-(--accent) px-1.5 py-px text-xs">
                      {BACKUP_TRIGGER_LABELS[backup.trigger]}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRestoreBackup(backup.id)}
                  disabled={busyAction !== null}
                  className={cn(
                    "h-7 shrink-0 rounded-lg px-2.5 text-sm transition-colors",
                    confirmRestoreId === backup.id
                      ? "bg-red-10 text-(--red-text)"
                      : "bg-foreground-5 text-(--foreground-secondary) hover:bg-foreground-10 hover:text-(--foreground)",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  {confirmRestoreId === backup.id ? "Confirm restore" : "Restore"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {status ? (
        <p className="text-sm text-(--foreground-secondary)">{status}</p>
      ) : null}
      {error ? <p className="text-sm text-(--red-text)">{error}</p> : null}
    </div>
  );
}

interface SettingsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sidebarTopLevelSectionOrder: SidebarTopLevelSectionId[];
  sidebarTopLevelSections: SidebarTopLevelSectionsPrefs;
  onSidebarTopLevelSectionVisibleChange: (sectionId: SidebarTopLevelSectionId, visible: boolean) => void;
  stageRailLayoutMode: StageRailLayoutMode;
  onStageRailLayoutModeChange: (value: StageRailLayoutMode) => void;
  nextPanelPeekPx: number;
  onNextPanelPeekPxChange: (value: number) => void;
  hideThinkingWhenDone: boolean;
  onHideThinkingWhenDoneChange: (value: boolean) => void;
  threadPromptSubmitShortcut: ThreadPromptSubmitShortcut;
  onThreadPromptSubmitShortcutChange: (value: ThreadPromptSubmitShortcut) => void;
  worktreeStartMode: WorktreeStartMode;
  onWorktreeStartModeChange: (value: WorktreeStartMode) => void;
  worktreeAutoBranchPrefix: string;
  onWorktreeAutoBranchPrefixChange: (value: string) => void;
  smartPrefixParsingEnabled: boolean;
  onSmartPrefixParsingEnabledChange: (value: boolean) => void;
  stripSmartPrefixFromTitleEnabled: boolean;
  onStripSmartPrefixFromTitleEnabledChange: (value: boolean) => void;
}

export function SettingsOverlay({
  open,
  onOpenChange,
  sidebarTopLevelSectionOrder,
  sidebarTopLevelSections,
  onSidebarTopLevelSectionVisibleChange,
  stageRailLayoutMode,
  onStageRailLayoutModeChange,
  nextPanelPeekPx,
  onNextPanelPeekPxChange,
  hideThinkingWhenDone,
  onHideThinkingWhenDoneChange,
  threadPromptSubmitShortcut,
  onThreadPromptSubmitShortcutChange,
  worktreeStartMode,
  onWorktreeStartModeChange,
  worktreeAutoBranchPrefix,
  onWorktreeAutoBranchPrefixChange,
  smartPrefixParsingEnabled,
  onSmartPrefixParsingEnabledChange,
  stripSmartPrefixFromTitleEnabled,
  onStripSmartPrefixFromTitleEnabledChange,
}: SettingsOverlayProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("workspace");
  const isMacPlatform = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<SettingsSectionId, HTMLElement | null>>({
    workspace: null,
    editor: null,
    card: null,
    worktrees: null,
    backups: null,
  });

  const scrollToElement = useCallback((element: HTMLElement | null) => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !element) return;
    scrollElement.scrollTo({ top: Math.max(0, element.offsetTop - 24), behavior: "smooth" });
  }, []);

  const scrollToSection = useCallback((id: SettingsSectionId) => {
    scrollToElement(sectionRefs.current[id]);
  }, [scrollToElement]);

  useEffect(() => {
    if (!open) return;
    setActiveSection("workspace");
    const scrollElement = scrollRef.current;
    if (scrollElement) scrollElement.scrollTop = 0;
    shellRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onOpenChange(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    const handleScroll = () => {
      const threshold = scrollElement.scrollTop + 96;
      let current: SettingsSectionId = "workspace";

      for (const section of SETTINGS_SECTIONS) {
        const element = sectionRefs.current[section.id];
        if (!element) continue;
        if (element.offsetTop <= threshold) current = section.id;
      }

      setActiveSection(current);
    };

    handleScroll();
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollElement.removeEventListener("scroll", handleScroll);
  }, [open]);

  if (!open) return null;

  const desktopHeaderPaddingTopClass = isMacPlatform ? "pt-[calc(var(--spacing)*11)]" : "pt-5";

  return (
    <div className="fixed inset-0 z-50 bg-(--background) text-(--foreground)">
      <div
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="flex h-full min-h-0 outline-none"
      >
        <aside
          className={cn(
            "hidden h-full min-h-0 shrink-0 font-sans text-base md:flex md:flex-col",
            "relative overflow-hidden border-r",
            "border-(--sidebar-border)",
          )}
          style={{ width: 280 }}
        >
          <header
            className={cn(
              "relative shrink-0 px-(--sidebar-shell-padding-x) pb-3",
              desktopHeaderPaddingTopClass,
            )}
          >
            {isMacPlatform ? (
              <div
                className="absolute inset-x-0 top-0 h-9"
                style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
              />
            ) : null}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                "mb-2 flex min-h-7.5 w-full items-center gap-2 rounded-lg px-(--sidebar-row-padding-x) py-(--sidebar-row-padding-tight-y)",
                "text-base text-(--sidebar-foreground-secondary) transition-colors",
                "hover:bg-(--sidebar-accent) hover:text-(--sidebar-foreground)",
              )}
            >
              <ChevronLeft className="size-4 shrink-0" />
              <span>Back to app</span>
            </button>
          </header>

          <nav
            className="flex scrollbar-token min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-(--sidebar-shell-padding-x) py-1"
            aria-label="Settings sections"
          >
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon;
              const isActive = activeSection === section.id;

              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => scrollToSection(section.id)}
                  className={cn(
                    "flex min-h-7.5 w-full items-center gap-2 rounded-lg px-(--sidebar-row-padding-x) py-(--sidebar-row-padding-tight-y) text-left transition-colors",
                    isActive
                      ? "bg-(--sidebar-accent) font-normal text-(--sidebar-foreground)"
                      : cn(
                        "text-(--sidebar-foreground-secondary)",
                        "opacity-75 hover:bg-(--sidebar-accent) hover:opacity-100",
                      ),
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate text-base">
                    {section.label}
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className={cn(
              "flex h-10 items-center px-(--spacing-panel) draggable",
              isMacPlatform ? "electron:h-11" : "",
            )}
          />

          <div ref={scrollRef} className="scrollbar-token min-h-0 flex-1 overflow-y-auto p-(--spacing-panel)">
            <div className="mx-auto flex w-full max-w-2xl flex-col">
              <div className="flex items-center justify-between gap-3 pb-(--spacing-panel)">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-(--spacing-panel)">
                  <div className="truncate text-lg font-semibold text-(--foreground)">
                    Settings
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-(--spacing-panel)">
                <SectionBlock
                  title="Workspace"
                  sectionRef={(element) => {
                    sectionRefs.current.workspace = element;
                  }}
                >
                  <SettingRow label="Theme" description="Match system mode or force a fixed theme.">
                    <ThemeSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Stage rail layout"
                    description="Sliding window focuses 1-4 stages. Full rail keeps the whole stage line visible."
                  >
                    <StageRailLayoutModeControl
                      value={stageRailLayoutMode}
                      onChange={onStageRailLayoutModeChange}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Thread finished notifications"
                    description="Show a desktop notification when a Codex thread settles."
                  >
                    <ThreadNotificationSettingControl open={open} />
                  </SettingRow>
                  <SettingRow
                    label="App updates"
                    description="Packaged macOS builds can check, download, and install stable updates in the background."
                  >
                    <AppUpdateSettingsControl open={open} />
                  </SettingRow>
                  <SettingRow
                    label="Sidebar sections"
                    description="Choose which top-level sidebar sections stay visible. Hidden sections can be restored here."
                  >
                    <SidebarSectionVisibilitySettingControl
                      order={sidebarTopLevelSectionOrder}
                      sections={sidebarTopLevelSections}
                      onVisibleChange={onSidebarTopLevelSectionVisibleChange}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Adjacent panel peek"
                    description={
                      stageRailLayoutMode === "sliding-window"
                        ? "Available only in Full rail. Sliding window hides this control."
                        : "Keep a thin sliver of the neighboring stage visible in Full rail."
                    }
                  >
                    <StageRailPeekSettingControl
                      value={nextPanelPeekPx}
                      onChange={onNextPanelPeekPxChange}
                      disabled={stageRailLayoutMode === "sliding-window"}
                    />
                  </SettingRow>
                </SectionBlock>

                <SectionBlock
                  title="Editor"
                  sectionRef={(element) => {
                    sectionRefs.current.editor = element;
                  }}
                >
                  <SettingRow
                    label="Sans font size"
                    description="Scales shared sans typography tokens and chat body text across the app."
                  >
                    <SansFontSizeSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Code font size"
                    description="Sets editor/code typography globally via --vscode-editor-font-size."
                  >
                    <CodeFontSizeSettingControl />
                  </SettingRow>
                  <SettingRow label="Spellcheck" description="Inline text correction for editable writing surfaces.">
                    <SpellcheckSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Auto-link while typing"
                    description="Turn typed URLs into links as you finish the token."
                  >
                    <NfmAutolinkTypingSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Auto-link on paste"
                    description="Recognize links in pasted text, including inline URL spans inside longer content."
                  >
                    <NfmAutolinkPasteSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Recognize bare domains"
                    description="Link plain domains like example.com. Leave off to avoid filename-like text such as .md paths."
                  >
                    <NfmAutolinkBareDomainsSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Large paste text threshold"
                    description="Prompt when pasted plain text reaches this many characters, so you can materialize it instead of inflating the note."
                  >
                    <PasteResourceTextThresholdSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Large paste description soft limit"
                    description="Prompt before pasted plain text pushes the note near its description size ceiling."
                  >
                    <PasteResourceDescriptionSoftLimitSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Markdown file links"
                    description="Choose which desktop app handles absolute local file links in rendered markdown."
                  >
                    <FileLinkOpenerSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Smart parse block prefixes"
                    description="Interpret shorthand like 1XL(tag) during block-to-card import."
                  >
                    <SmartPrefixParsingSettingControl
                      value={smartPrefixParsingEnabled}
                      onChange={onSmartPrefixParsingEnabledChange}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Strip parsed prefix from title"
                    description="Remove matched shorthand from imported card titles after parsing."
                  >
                    <StripSmartPrefixFromTitleSettingControl
                      value={stripSmartPrefixFromTitleEnabled}
                      onChange={onStripSmartPrefixFromTitleEnabledChange}
                      disabled={!smartPrefixParsingEnabled}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Hide thinking when done"
                    description="Show in-progress thread thinking, then collapse it after completion."
                  >
                    <ThreadThinkingSettingControl
                      value={hideThinkingWhenDone}
                      onChange={onHideThinkingWhenDoneChange}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Confirm thread section send"
                    description="Show a preview dialog before sending a notebook section, with an option to stop asking later."
                  >
                    <ThreadSectionSendConfirmationSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Thread send shortcut"
                    description="Use Enter for send, or require a modifier chord to reduce accidental submissions."
                  >
                    <ThreadPromptSubmitShortcutControl
                      value={threadPromptSubmitShortcut}
                      onChange={onThreadPromptSubmitShortcutChange}
                    />
                  </SettingRow>
                </SectionBlock>

                <SectionBlock
                  title="Card"
                  sectionRef={(element) => {
                    sectionRefs.current.card = element;
                  }}
                >
                  <SettingRow
                    label="Kanban card properties"
                    description="Choose whether priority, estimate, tags, assignee, and run-in metadata render above the title, inline with it, or below the card body."
                  >
                    <CardPropertyPositionSettingControl />
                  </SettingRow>
                  <SettingRow
                    label="Card stage collapsed properties"
                    description="Choose which card-stage property rows start behind the more-properties toggle."
                  >
                    <CardStageCollapsedPropertiesSettingControl />
                  </SettingRow>
                </SectionBlock>

                <SectionBlock
                  title="Worktrees"
                  sectionRef={(element) => {
                    sectionRefs.current.worktrees = element;
                  }}
                >
                  <SettingRow
                    label="Worktree start mode"
                    description="Choose whether new worktree threads auto-create a branch or start detached."
                  >
                    <WorktreeStartModeSettingControl
                      value={worktreeStartMode}
                      onChange={onWorktreeStartModeChange}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Auto branch prefix"
                    description="Prefix prepended to auto branch names before the thread slug."
                  >
                    <WorktreeAutoBranchPrefixSettingControl
                      value={worktreeAutoBranchPrefix}
                      onChange={onWorktreeAutoBranchPrefixChange}
                    />
                  </SettingRow>
                  <div className="flex flex-col gap-1 p-3">
                    <div className="text-sm text-(--foreground)">
                      Managed worktrees
                    </div>
                    <div className="text-sm text-(--foreground-secondary)">
                      Worktrees created by card threads. Hover a row to remove.
                    </div>
                    <ManagedWorktreesSettingControl open={open} />
                  </div>
                </SectionBlock>

                <section
                  ref={(element) => {
                    sectionRefs.current.backups = element;
                  }}
                  className="flex flex-col"
                >
                  <div className="flex h-10 items-center">
                    <div className="text-base font-medium text-(--foreground)">
                      Backups
                    </div>
                  </div>
                  <BackupSettingsControl open={open} />
                </section>


              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
