import { useRef, useState } from "react";
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
  formatCodexReasoningEffortLabel,
} from "@/lib/codex-thread-settings";
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
import type {
  AgentIntelligenceDropdownProps,
  AgentNativeIntelligencePatch,
} from "./agent-intelligence-dropdown";

export const agentEffortLabel = (kind: AgentBackendBinding["kind"], effort: string): string =>
  kind === "claude" && effort === "low" ? "Low" : formatCodexReasoningEffortLabel(effort);

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
  /** Forces providers to check again, as the Refresh button does. */
  readonly refresh: () => void;
  /** Reads the catalog as it is now without forcing a check; opening the picker calls it. */
  readonly reload?: () => void;
  readonly manage: () => void;
  readonly runtimeOptions?: readonly { binding: ExternalAgentBinding; label: string }[];
  readonly chooseRuntime?: (binding: ExternalAgentBinding) => void;
  readonly configOptions?: readonly AgentSessionConfigOption[];
  readonly changeConfig?: (id: string, value: string | boolean) => Promise<void>;
  readonly modes?: AgentSessionModeState | null;
  readonly changeMode?: (modeId: string) => Promise<void>;
  /** Runtimes whose models become available after setup; each keeps its own entry. */
  readonly setups?: readonly AgentModelSetupPresentation[];
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

export function AgentModelPicker(
  props: AgentIntelligenceDropdownProps & {
    readonly catalog: AgentModelCatalogPresentation;
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
  const reasoningOptions =
    models.find((model) => model.id === selection.model)?.supportedReasoningEfforts ?? [];
  const contextWindows = [...new Set(native?.capabilities.contextWindows ?? [])];
  const visibleEntries = visibleAgentModelPickerEntries(
    catalog.entries,
    catalog.selected,
    showAllModels,
  );
  const hasHiddenModels = visibleEntries.length < catalog.entries.length;
  const options: readonly NodexOptionPickerOption[] = visibleEntries.map((entry) => {
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
  const genericOptions =
    isCodex || selection.kind === "claude"
      ? []
      : (catalog.configOptions?.filter((option) => option.category !== "model") ?? []);
  const disabled = props.disabled === true || pending;
  const runtimeOptions = catalog.runtimeOptions ?? [];
  const hasOptions =
    isCodex || selection.kind === "claude"
      ? reasoningOptions.length > 0 ||
        native?.capabilities.disableThinking ||
        isCodex ||
        native?.capabilities.fastMode ||
        contextWindows.length > 1
      : genericOptions.length > 0 || Boolean(catalog.modes?.availableModes.length);
  return (
    <NodexOptionPicker
      search="filter"
      searchPlaceholder="Search models…"
      searchAriaLabel="Search models"
      searchTrailingContent={
        <span className="-me-1 flex items-center">
          <NodexIconButton
            size="xs"
            ariaLabel="Refresh models"
            icon={RefreshIcon}
            className={cn(catalog.loading && "[&_svg]:animate-spin")}
            disabled={catalog.loading || pending}
            onClick={catalog.refresh}
          />
          <NodexIconButton
            size="xs"
            ariaLabel="Manage providers"
            icon={SettingsGeneralIcon}
            onClick={() => {
              changeOpen(false);
              catalog.manage();
            }}
          />
        </span>
      }
      value={agentModelKey(catalog.selected.binding, catalog.selected.model)}
      options={options}
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
      alignOffset={geometry.alignOffset}
      contentClassName="w-[288px]"
      triggerButton={
        props.triggerStyle === "settings" ? (
          <NodexSettingsDropdownTrigger
            ref={props.triggerRef}
            aria-label="Agent intelligence"
            className="w-full min-w-0 justify-between"
          >
            <span className="truncate">
              {[modelLabel, reasoningLabel].filter(Boolean).join(" · ")}
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
            showFastIndicator={
              isCodex ? selection.serviceTier === "fast" : native?.selected.fast === true
            }
            aria-keyshortcuts={props.shortcut?.ariaKeyShortcuts}
          />
        )
      }
      onValueChange={(value) => {
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
                    ? catalog.manage
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
          {(isCodex || selection.kind === "claude") &&
          (reasoningOptions.length > 0 || native?.capabilities.disableThinking) ? (
            <OptionRow
              label="Effort"
              value={native?.selected.thinking === false ? "off" : selection.reasoningEffort}
              disabled={disabled}
              options={[
                ...(native?.capabilities.disableThinking ? [{ value: "off", label: "Off" }] : []),
                ...(native?.capabilities.disableThinking && reasoningOptions.length === 0
                  ? [{ value: "on", label: "On" }]
                  : []),
                ...reasoningOptions.map((option) => ({
                  value: option.reasoningEffort,
                  label: agentEffortLabel(selection.kind, option.reasoningEffort),
                  tooltipText: option.description,
                })),
              ]}
              onChange={(value) => {
                if (native && value === "off") return changeNative({ thinking: false });
                if (native && value === "on") return changeNative({ thinking: true });
                if (native && isClaudeEffortLevel(value))
                  return changeNative({ effort: value, thinking: true });
                props.onSelectionChange(
                  { ...selection, reasoningEffort: value },
                  "reasoningEffort",
                );
              }}
            />
          ) : null}
          {isCodex || native?.capabilities.fastMode ? (
            <OptionRow
              label="Speed"
              value={
                isCodex
                  ? selection.serviceTier === "fast"
                    ? "fast"
                    : "standard"
                  : native?.selected.fast == null
                    ? ""
                    : native.selected.fast
                      ? "fast"
                      : "standard"
              }
              options={[
                { value: "standard", label: "Standard" },
                { value: "fast", label: "Fast" },
              ]}
              disabled={disabled}
              onChange={(value) => {
                if (native) return changeNative({ fast: value === "fast" });
                props.onSelectionChange(
                  { ...selection, serviceTier: value === "fast" ? "fast" : null },
                  "serviceTier",
                );
              }}
            />
          ) : null}
          {native && contextWindows.length > 1 ? (
            <OptionRow
              label="Context"
              value={native.selected.contextInherited ? "default" : (native.selected.context ?? "")}
              options={[
                { value: "default", label: "Default" },
                ...contextWindows.map((value) => ({ value, label: value })),
              ]}
              disabled={disabled}
              onChange={(value) => changeNative({ context: value === "default" ? null : value })}
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
