import { useRef, useState, type ReactElement } from "react";
import type { AgentBackendBinding } from "../../../../shared/agent-backend";
import type { AgentModelSelection } from "../../../../shared/agent-model-catalog";
import type { ExternalAgentBinding } from "../../../../shared/agent-model-catalog";
import type {
  AgentSessionConfigOption,
  AgentSessionModeState,
} from "../../../../shared/agent-conversation";
import type { AgentModelOption } from "../../../../shared/types";
import { isClaudeEffortLevel } from "../../../../shared/claude-models";
import {
  agentModelKey,
  agentRuntimeQualifier,
  flattenAgentConfigOptions,
  visibleAgentModelPickerEntries,
} from "@/lib/agent-model-selection";
import {
  formatCodexModelLabel,
  resolveCodexReasoningEffortOptions,
} from "@/lib/codex-thread-settings";
import { agentEffortLabel } from "@/lib/agent-runtime-model-selection";
import {
  AgentProviderIcon,
  ChevronDownIcon,
  RefreshIcon,
  SettingsGeneralIcon,
} from "@/components/shared/icons";
import { NodexIconButton } from "@/components/ui/button";
import {
  NodexDropdownActionRow,
  NodexDropdownButtonTrigger,
  NodexDropdownSeparator,
  NodexDropdownMessage,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
  type NodexOptionPickerOption,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import {
  IntelligenceSelectorTrigger,
  INTELLIGENCE_SELECTOR_SIDE_OFFSET_PX,
  useIntelligenceSelectorTriggerGeometry,
} from "./intelligence-selector-trigger";
import {
  IntelligenceControlsHeader,
  IntelligenceEffortSlider,
  IntelligenceModeIndicatorIcon,
  IntelligenceModeToggle,
  type IntelligenceModeIndicator,
} from "./intelligence-controls";
import {
  resolveIntelligenceEffortPosition,
  resolveIntelligenceEffortStops,
  THINKING_OFF_EFFORT_STOP,
} from "@/lib/intelligence-effort";
import type {
  AgentIntelligenceDropdownProps,
  AgentNativeIntelligencePatch,
} from "./agent-intelligence-dropdown";

export interface AgentModelPickerEntry {
  readonly binding: AgentBackendBinding;
  readonly label: string;
  readonly model: AgentModelOption;
  readonly selection: AgentModelSelection;
  /** Why this chat cannot use the model now; the model stays listed but cannot be chosen. */
  readonly unavailableReason?: string;
}

/** A runtime whose models become available after setup, offered beside the model list. */
export interface AgentModelSetupPresentation {
  readonly kind: AgentBackendBinding["kind"];
  readonly label: string;
  /** The next step or live state, such as `Install` or `42%`. */
  readonly hint: string;
  readonly tone: "default" | "danger";
  /** `open` runs after the menu closes; `settings` routes through `manage`. */
  readonly action:
    | {
        readonly kind: "open";
        readonly open: (port: { readonly showModels: () => void }) => void;
      }
    | { readonly kind: "settings" };
}

/** The composer chooses one complete runtime/model tuple; options belong to the selected runtime. */
export interface AgentModelCatalogPresentation {
  readonly entries: readonly AgentModelPickerEntry[];
  readonly selected: AgentModelSelection;
  readonly loading: boolean;
  readonly error?: string | null;
  readonly choose: (selection: AgentModelSelection) => Promise<void> | void;
  /** Forces providers to check again, as the Refresh button does; without it there is none. */
  readonly refresh?: () => void;
  /** Reads the catalog as it is now without forcing a check; opening the picker calls it. */
  readonly reload?: () => void;
  /** Opens the providers' settings, as the Manage button does; without it there is none. */
  readonly manage?: () => void;
  readonly runtimeOptions?: readonly { binding: ExternalAgentBinding; label: string }[];
  readonly chooseRuntime?: (binding: ExternalAgentBinding) => void;
  readonly configOptions?: readonly AgentSessionConfigOption[];
  readonly changeConfig?: (id: string, value: string | boolean) => Promise<void>;
  readonly modes?: AgentSessionModeState | null;
  readonly changeMode?: (modeId: string) => Promise<void>;
  /** Runtimes whose models become available after setup; each keeps its own entry. */
  readonly setups?: readonly AgentModelSetupPresentation[];
  /** Owner actions about the choice itself, listed last; each closes the menu first. */
  readonly actions?: readonly { readonly label: string; readonly run: () => void }[];
}

function OptionRow({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly NodexOptionPickerOption[];
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value)?.label ?? value;
  return (
    <NodexOptionPicker
      search="none"
      value={value}
      options={options.map((option) => (disabled ? { ...option, disabled: true } : option))}
      open={open}
      onOpenChange={(next) => setOpen(next && !disabled)}
      onValueChange={(value) => {
        // Keep the popup mounted so its dismissal completes while the write is pending.
        setOpen(false);
        onChange(value);
      }}
      side="left"
      align="end"
      triggerButton={
        <NodexDropdownButtonTrigger
          chrome="transparent"
          showChevron={false}
          disabled={disabled}
          className="w-full gap-3 px-[var(--padding-row-x)] hover:bg-token-list-hover-background aria-expanded:bg-token-list-hover-background"
          aria-label={`${label} ${typeof selected === "string" ? selected : value}`}
        >
          <span className="shrink-0">{label}</span>
          <span className="ms-auto min-w-0 truncate text-token-description-foreground">
            {selected || "—"}
          </span>
          <ChevronDownIcon className="icon-2xs text-token-input-placeholder-foreground" />
        </NodexDropdownButtonTrigger>
      }
    />
  );
}

/** Not an `agentModelKey`, which is always a JSON array. */
const INHERIT_OPTION_VALUE = "inherit";
const INHERIT_LABEL = "Use current/default";

export function AgentModelPicker(
  props: AgentIntelligenceDropdownProps & {
    readonly catalog: AgentModelCatalogPresentation;
    /** Replaces the composer or settings trigger, such as a split button's menu half. */
    readonly triggerButton?: ReactElement;
    /** Lists models alone, for a caller that runs every model at its own fixed options. */
    readonly modelOnly?: boolean;
  },
) {
  const { catalog, selection, models, provider } = props;
  const [pending, setPending] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  // A footer action that opens another surface waits until this menu has closed.
  const afterClose = useRef<(() => void) | null>(null);
  const open = props.open ?? uncontrolledOpen;
  const requestOpenChange = props.onOpenChange ?? setUncontrolledOpen;
  // A provider may have become available since the last read, such as once its service is
  // reachable again, so opening shows the catalog as it is now.
  const changeOpen = (next: boolean) => {
    if (next && !open) catalog.reload?.();
    requestOpenChange(next);
  };
  const setups = catalog.setups ?? [];
  const { refresh, manage } = catalog;
  const isCodex = selection.kind === "codex";
  const native = provider?.nativeIntelligence;
  const active = catalog.entries.find(
    (entry) =>
      agentModelKey(entry.binding, entry.model.id) ===
      agentModelKey(catalog.selected.binding, catalog.selected.model),
  );
  const modelLabel =
    active?.model.displayName ??
    (selection.model ? formatCodexModelLabel(selection.model, models) : "Choose model");
  const reasoningLabel =
    native?.selected.thinking === false
      ? "Off"
      : selection.reasoningEffort !== "default" && selection.reasoningEffort !== "none"
        ? agentEffortLabel(selection.kind, selection.reasoningEffort)
        : "";
  const labels = [
    ...catalog.entries.map((entry) => ({
      id: agentModelKey(entry.binding, entry.model.id),
      modelLabel: entry.model.displayName,
      reasoningLabel: "",
    })),
    { id: "selected", modelLabel, reasoningLabel },
  ];
  const geometry = useIntelligenceSelectorTriggerGeometry(labels);
  const run = async (operation: () => Promise<void> | void) => {
    if (pending) return;
    setPending(true);
    try {
      await operation();
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not update model options");
    } finally {
      setPending(false);
    }
  };
  const changeNative = (patch: AgentNativeIntelligencePatch) => {
    if (native) void run(() => native.change(patch));
  };
  const currentModel = models.find((model) => model.id === selection.model);
  // Codex offers its standard levels for a model the catalog does not describe.
  const reasoningOptions = isCodex
    ? resolveCodexReasoningEffortOptions(selection.model, models)
    : (currentModel?.supportedReasoningEfforts ?? []);
  const nativeControls = isCodex || selection.kind === "claude";
  const effortStops = nativeControls
    ? resolveIntelligenceEffortStops({
        efforts: reasoningOptions,
        label: (effort) => agentEffortLabel(selection.kind, effort),
        canDisableThinking: native?.capabilities.disableThinking === true,
      })
    : [];
  const effortPosition = resolveIntelligenceEffortPosition({
    stops: effortStops,
    selected: selection.reasoningEffort,
    modelDefault: currentModel?.defaultReasoningEffort,
    thinkingOff: native?.selected.thinking === false,
  });
  const fastOn = isCodex ? selection.serviceTier === "fast" : native?.selected.fast === true;
  const ultracodeOn = native?.capabilities.ultracode === true && native.selected.ultracode === true;
  const indicators: IntelligenceModeIndicator[] = [
    ...(fastOn ? (["fast"] as const) : []),
    ...(ultracodeOn ? (["ultracode"] as const) : []),
  ];
  // A model with a thinking switch but no effort levels shows that switch as a mode.
  const thinkingSwitch =
    native?.capabilities.disableThinking === true && reasoningOptions.length === 0;
  const contextWindows = [...new Set(native?.capabilities.contextWindows ?? [])];
  const visibleEntries = visibleAgentModelPickerEntries(
    catalog.entries,
    catalog.selected,
    showAllModels,
  );
  const hasHiddenModels = visibleEntries.length < catalog.entries.length;
  const inherited = props.allowInherit === true && props.inheritance === "inherited";
  // An inherited choice names no modes of its own.
  const settingsIndicators = inherited ? [] : indicators;
  const inheritOptions: readonly NodexOptionPickerOption[] = props.allowInherit
    ? [
        {
          value: INHERIT_OPTION_VALUE,
          // Keeps the label in line with the model names beside their provider marks.
          leftSlot: <span aria-hidden="true" className="size-3.5" />,
          label: INHERIT_LABEL,
          disabled: pending,
        },
      ]
    : [];
  const modelOptions: readonly NodexOptionPickerOption[] = visibleEntries.map((entry) => {
    const qualifier = agentRuntimeQualifier(entry.binding, entry.label);
    return {
      value: agentModelKey(entry.binding, entry.model.id),
      leftSlot: <AgentProviderIcon kind={entry.binding.kind} className="size-3.5" />,
      label: qualifier ? (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">{entry.model.displayName}</span>
          <span className="min-w-0 truncate text-xs text-token-description-foreground">
            {qualifier}
          </span>
        </span>
      ) : (
        entry.model.displayName
      ),
      searchText: `${entry.model.displayName} ${entry.model.id} ${entry.label} ${entry.binding.kind}`,
      tooltipText: entry.unavailableReason ?? (entry.model.description || entry.model.id),
      disabled: pending || entry.unavailableReason !== undefined,
    };
  });
  const disabled = props.disabled === true || pending;
  const modeToggleList = [
    thinkingSwitch ? (
      <IntelligenceModeToggle
        key="thinking"
        mode="thinking"
        description="Reason before answering."
        pressed={native?.selected.thinking === true}
        disabled={disabled}
        onPressedChange={(thinking) => changeNative({ thinking })}
      />
    ) : null,
    isCodex || native?.capabilities.fastMode ? (
      <IntelligenceModeToggle
        key="fast"
        mode="fast"
        description={isCodex ? "1.5x speed. Uses more usage." : "Faster output. Uses more usage."}
        pressed={fastOn}
        disabled={disabled}
        onPressedChange={(fast) => {
          if (native) return changeNative({ fast });
          props.onSelectionChange(
            { ...selection, serviceTier: fast ? "fast" : null },
            "serviceTier",
          );
        }}
      />
    ) : null,
    native?.capabilities.ultracode || native?.capabilities.ultracodeUnavailableReason ? (
      <IntelligenceModeToggle
        key="ultracode"
        mode="ultracode"
        description="Plans and runs a multi-agent workflow for each substantive task, at any effort. Uses usage much faster."
        pressed={ultracodeOn}
        disabled={disabled}
        {...(native.capabilities.ultracodeUnavailableReason
          ? { unavailableReason: native.capabilities.ultracodeUnavailableReason }
          : {})}
        onPressedChange={(ultracode) => changeNative({ ultracode })}
      />
    ) : null,
  ].filter(Boolean);
  const modeToggles = modeToggleList.length > 0 ? modeToggleList : null;
  const genericOptions =
    isCodex || selection.kind === "claude"
      ? []
      : (catalog.configOptions?.filter((option) => option.category !== "model") ?? []);
  const runtimeOptions = catalog.runtimeOptions ?? [];
  const hasOptions =
    props.modelOnly !== true &&
    (nativeControls
      ? effortStops.length > 1 ||
        thinkingSwitch ||
        isCodex ||
        native?.capabilities.fastMode ||
        native?.capabilities.ultracode ||
        native?.capabilities.ultracodeUnavailableReason ||
        contextWindows.length > 1
      : genericOptions.length > 0 || Boolean(catalog.modes?.availableModes.length));
  return (
    <NodexOptionPicker
      search="filter"
      searchPlaceholder="Search models…"
      searchAriaLabel="Search models"
      searchTrailingContent={
        refresh || manage ? (
          <span className="-me-1 flex items-center">
            {refresh ? (
              <NodexIconButton
                size="xs"
                ariaLabel="Refresh models"
                icon={RefreshIcon}
                className={cn(catalog.loading && "[&_svg]:animate-spin")}
                disabled={catalog.loading || pending}
                onClick={refresh}
              />
            ) : null}
            {manage ? (
              <NodexIconButton
                size="xs"
                ariaLabel="Manage providers"
                icon={SettingsGeneralIcon}
                onClick={() => {
                  changeOpen(false);
                  manage();
                }}
              />
            ) : null}
          </span>
        ) : undefined
      }
      value={
        inherited
          ? INHERIT_OPTION_VALUE
          : agentModelKey(catalog.selected.binding, catalog.selected.model)
      }
      options={[...inheritOptions, ...modelOptions]}
      emptyMessage={catalog.loading ? "Loading models…" : "No models available"}
      noResultsMessage="No matching models"
      disabled={props.disabled}
      open={open}
      onOpenChange={changeOpen}
      finalFocus={() => {
        const action = afterClose.current;
        afterClose.current = null;
        action?.();
        return true;
      }}
      side={props.triggerStyle === "settings" ? "bottom" : "top"}
      align="end"
      sideOffset={INTELLIGENCE_SELECTOR_SIDE_OFFSET_PX}
      alignOffset={props.triggerButton ? undefined : geometry.alignOffset}
      contentClassName="w-[288px]"
      triggerButton={
        props.triggerButton ??
        (props.triggerStyle === "settings" ? (
          <NodexSettingsDropdownTrigger
            ref={props.triggerRef}
            aria-label="Agent intelligence"
            className="w-full min-w-0 justify-between"
            data-fast-mode-indicator={settingsIndicators.includes("fast") ? "true" : undefined}
            data-ultracode-indicator={settingsIndicators.includes("ultracode") ? "true" : undefined}
          >
            {settingsIndicators.map((mode) => (
              <IntelligenceModeIndicatorIcon key={mode} mode={mode} />
            ))}
            <span className="min-w-0 flex-1 truncate text-start">
              {inherited ? INHERIT_LABEL : [modelLabel, reasoningLabel].filter(Boolean).join(" · ")}
            </span>
          </NodexSettingsDropdownTrigger>
        ) : (
          <IntelligenceSelectorTrigger
            ref={props.triggerRef}
            geometry={geometry}
            isOpen={open}
            labelCandidates={labels}
            modelLabel={modelLabel}
            reasoningLabel={reasoningLabel}
            indicators={indicators}
            aria-keyshortcuts={props.shortcut?.ariaKeyShortcuts}
          />
        ))
      }
      onValueChange={(value) => {
        if (value === INHERIT_OPTION_VALUE) return props.onInherit?.();
        const entry = catalog.entries.find(
          (candidate) => agentModelKey(candidate.binding, candidate.model.id) === value,
        );
        if (!entry) return;
        void run(() => catalog.choose(entry.selection));
      }}
      footer={
        <>
          {hasHiddenModels || setups.length > 0 ? <NodexDropdownSeparator /> : null}
          {hasHiddenModels ? (
            <NodexDropdownActionRow disabled={pending} onClick={() => setShowAllModels(true)}>
              Show all models
            </NodexDropdownActionRow>
          ) : null}
          {setups.map((setup) => (
            <NodexDropdownActionRow
              key={`${setup.kind}:${setup.label}`}
              className="items-center gap-1.5"
              disabled={pending}
              onClick={() => {
                const { action } = setup;
                afterClose.current =
                  action.kind === "settings"
                    ? (manage ?? null)
                    : () =>
                        action.open({
                          // Setup returns to the default free-model view; the choice is unchanged.
                          showModels: () => {
                            setShowAllModels(false);
                            changeOpen(true);
                          },
                        });
                changeOpen(false);
              }}
            >
              <AgentProviderIcon kind={setup.kind} className="size-3.5 text-token-text-secondary" />
              <span className="min-w-0 truncate">{setup.label}</span>{" "}
              <span
                className={cn(
                  "ms-auto shrink-0 ps-2 text-xs tabular-nums",
                  setup.tone === "danger" ? "text-danger" : "text-token-description-foreground",
                )}
              >
                {setup.hint}
              </span>
            </NodexDropdownActionRow>
          ))}
          {hasOptions ? <NodexDropdownSeparator /> : null}
          {props.modelOnly ? null : (
            <>
              {effortStops.length > 1 ? (
                <IntelligenceEffortSlider
                  stops={effortStops}
                  value={effortPosition.value}
                  isDefault={effortPosition.isDefault}
                  disabled={disabled}
                  accessory={modeToggles}
                  onChange={(value) => {
                    if (native && value === THINKING_OFF_EFFORT_STOP)
                      return changeNative({ thinking: false });
                    if (native && isClaudeEffortLevel(value))
                      return changeNative({ effort: value, thinking: true });
                    props.onSelectionChange(
                      { ...selection, reasoningEffort: value },
                      "reasoningEffort",
                    );
                  }}
                />
              ) : modeToggles ? (
                <div className="px-[var(--padding-row-x)]">
                  <IntelligenceControlsHeader label="Modes" accessory={modeToggles} />
                </div>
              ) : null}
              {native && contextWindows.length > 1 ? (
                <OptionRow
                  label="Context"
                  value={
                    native.selected.contextInherited ? "default" : (native.selected.context ?? "")
                  }
                  options={[
                    { value: "default", label: "Default" },
                    ...contextWindows.map((value) => ({ value, label: value })),
                  ]}
                  disabled={disabled}
                  onChange={(value) =>
                    changeNative({ context: value === "default" ? null : value })
                  }
                />
              ) : null}
              {genericOptions.map((option) => (
                <OptionRow
                  key={option.id}
                  label={option.name}
                  value={String(option.currentValue)}
                  disabled={disabled || !catalog.changeConfig}
                  options={
                    option.type === "boolean"
                      ? [
                          { value: "true", label: "On" },
                          { value: "false", label: "Off" },
                        ]
                      : flattenAgentConfigOptions(option).map((entry) => ({
                          value: entry.value,
                          label: entry.name,
                          tooltipText: entry.description,
                        }))
                  }
                  onChange={(value) =>
                    void run(() =>
                      catalog.changeConfig?.(
                        option.id,
                        option.type === "boolean" ? value === "true" : value,
                      ),
                    )
                  }
                />
              ))}
              {catalog.modes && catalog.modes.availableModes.length > 0 && catalog.changeMode ? (
                <OptionRow
                  label="Mode"
                  value={catalog.modes.currentModeId}
                  options={catalog.modes.availableModes.map((mode) => ({
                    value: mode.id,
                    label: mode.name,
                    tooltipText: mode.description,
                  }))}
                  disabled={disabled}
                  onChange={(value) => void run(() => catalog.changeMode?.(value))}
                />
              ) : null}
            </>
          )}
          {catalog.actions?.length ? <NodexDropdownSeparator /> : null}
          {catalog.actions?.map((action) => (
            <NodexDropdownActionRow
              key={action.label}
              disabled={pending}
              onClick={() => {
                afterClose.current = action.run;
                changeOpen(false);
              }}
            >
              {action.label}
            </NodexDropdownActionRow>
          ))}
          {runtimeOptions.length > 0 || catalog.error ? <NodexDropdownSeparator /> : null}
          {runtimeOptions.map((runtime) => (
            <NodexDropdownActionRow
              key={agentModelKey(runtime.binding, "")}
              className="items-center gap-1.5"
              onClick={() => {
                changeOpen(false);
                catalog.chooseRuntime?.(runtime.binding);
              }}
            >
              <AgentProviderIcon
                kind={runtime.binding.kind}
                className="size-3.5 text-token-text-secondary"
              />
              <span className="min-w-0 truncate">Start with {runtime.label}</span>
            </NodexDropdownActionRow>
          ))}
          {catalog.error ? (
            <NodexDropdownMessage compact tone="error">
              {catalog.error}
            </NodexDropdownMessage>
          ) : null}
        </>
      }
    />
  );
}
