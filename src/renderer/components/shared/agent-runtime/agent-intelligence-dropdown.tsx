import { useDeferredValue, useMemo, useState, type Ref } from "react";
import { FastModeIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownSearchInput,
  NodexDropdownSection,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
  NodexDropdownSummarySubmenuItem,
  NodexDropdownTitle,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
  resolveCodexReasoningEffortOptions,
} from "@/lib/codex-thread-settings";
import type { CodexExecutionProfileChange } from "../../../../shared/codex-execution-profile";
import { isClaudeEffortLevel, type ClaudeEffortLevel } from "../../../../shared/claude-models";
import type {
  AgentModelOption,
  CodexReasoningEffort,
  CodexServiceTier,
} from "../../../../shared/types";
import {
  IntelligenceSelectorTrigger,
  INTELLIGENCE_SELECTOR_SIDE_OFFSET_PX,
  type IntelligenceSelectorLabelCandidate,
  useIntelligenceSelectorTriggerGeometry,
} from "./intelligence-selector-trigger";

export interface AgentIntelligenceSelection {
  readonly kind: "codex" | "claude" | "acp";
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier: CodexServiceTier;
}

export type AgentIntelligenceInheritance = "explicit" | "inherited";

/** Null clears an override; omitted fields keep the current native choice. */
export interface AgentNativeIntelligencePatch {
  readonly effort?: ClaudeEffortLevel;
  readonly fast?: boolean | null;
  readonly thinking?: boolean | null;
  readonly context?: string | null;
}

export interface AgentNativeIntelligencePresentation {
  readonly selected: {
    readonly fast?: boolean | null;
    readonly thinking?: boolean | null;
    readonly context?: string | null;
    readonly contextInherited?: boolean;
  };
  readonly capabilities: {
    readonly fastMode?: boolean;
    readonly disableThinking?: boolean;
    readonly contextWindows?: readonly string[];
  };
  readonly change: (patch: AgentNativeIntelligencePatch) => Promise<void>;
}

export interface AgentIntelligenceDropdownProps {
  readonly provider?: {
    readonly label: string;
    readonly selection: string;
    readonly options: readonly { value: string; label: string }[];
    readonly select: (value: string) => void;
    readonly nativeIntelligence?: AgentNativeIntelligencePresentation;
  };
  readonly models: readonly AgentModelOption[];
  readonly disabled?: boolean;
  readonly selection: AgentIntelligenceSelection;
  readonly inheritance?: AgentIntelligenceInheritance;
  readonly allowInherit?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onSelectionChange: (
    selection: AgentIntelligenceSelection,
    change: CodexExecutionProfileChange,
  ) => void;
  readonly onInherit?: () => void;
  readonly triggerStyle?: "composer" | "settings";
  readonly triggerRef?: Ref<HTMLButtonElement>;
  readonly shortcut?: { readonly label?: string; readonly ariaKeyShortcuts?: string } | null;
}

const SPEED_OPTIONS = [
  { fast: false, label: "Standard", codexDescription: "Default speed, normal usage" },
  { fast: true, label: "Fast", codexDescription: "1.5x speed · More usage" },
] as const;

const effortLabel = (kind: AgentIntelligenceSelection["kind"], effort: string) =>
  kind === "claude" && effort === "low" ? "Low" : formatCodexReasoningEffortLabel(effort);

export function resolveReasoningEffortForModelChange(input: {
  currentReasoningEffort: CodexReasoningEffort;
  nextModelId: string;
  models: readonly AgentModelOption[];
}): CodexReasoningEffort | null {
  const nextModel = input.models.find(
    (candidate) => candidate.id === input.nextModelId && !candidate.hidden,
  );
  const supportedOptions = resolveCodexReasoningEffortOptions(input.nextModelId, input.models);
  const supportedEfforts = new Set(supportedOptions.map((option) => option.reasoningEffort));
  if (supportedEfforts.has(input.currentReasoningEffort)) return input.currentReasoningEffort;

  const preferredEfforts: Array<CodexReasoningEffort | null | undefined> = [
    nextModel?.defaultReasoningEffort,
    supportedEfforts.has("high") ? "high" : null,
    supportedOptions[0]?.reasoningEffort,
  ];
  return preferredEfforts.find((effort) => effort && supportedEfforts.has(effort)) ?? null;
}

function ModelLabel({
  modelId,
  models,
  fast,
}: {
  modelId: string;
  models: readonly AgentModelOption[];
  fast: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1 tabular-nums">
      {fast ? <FastModeIcon className="icon-2xs shrink-0 text-token-foreground" /> : null}
      <span className="truncate whitespace-nowrap">{formatCodexModelLabel(modelId, models)}</span>
    </span>
  );
}

export function AgentIntelligenceDropdown({
  models,
  disabled = false,
  provider,
  selection,
  inheritance = "explicit",
  allowInherit = false,
  open,
  onOpenChange,
  onSelectionChange,
  onInherit,
  triggerStyle = "composer",
  triggerRef,
  shortcut,
}: AgentIntelligenceDropdownProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [nativePending, setNativePending] = useState(false);
  const menuOpen = open ?? uncontrolledOpen;
  const setMenuOpen = onOpenChange ?? setUncontrolledOpen;
  const normalizedQuery = useDeferredValue(query).trim().toLocaleLowerCase();
  const visibleCatalog = models.filter((candidate) => !candidate.hidden);
  const matchingModels = visibleCatalog.filter(
    (candidate) =>
      !normalizedQuery ||
      `${candidate.displayName} ${candidate.id}`.toLocaleLowerCase().includes(normalizedQuery),
  );
  const visibleModels = matchingModels.slice(0, 50);
  const hiddenMatchCount = matchingModels.length - visibleModels.length;
  const isCodex = selection.kind === "codex";
  const modelLabel =
    selection.kind === "claude" && (!selection.model || selection.model === "default")
      ? (provider?.label ?? "Agent")
      : formatCodexModelLabel(selection.model, models);
  const native = isCodex ? undefined : provider?.nativeIntelligence;
  const selectedFast = isCodex ? selection.serviceTier === "fast" : native?.selected.fast;
  const showFastIndicator = selectedFast === true;
  const speedLabel = selectedFast == null ? "—" : selectedFast ? "Fast" : "Standard";
  const reasoningOptions = isCodex
    ? resolveCodexReasoningEffortOptions(selection.model, models)
    : (models.find(({ id }) => id === selection.model)?.supportedReasoningEfforts ?? []);
  const thinkingOff = native?.selected.thinking === false;
  const reasoningLabel = thinkingOff
    ? "Off"
    : reasoningOptions.length
      ? selection.reasoningEffort === "default" && !isCodex
        ? "—"
        : effortLabel(selection.kind, selection.reasoningEffort)
      : native?.capabilities.disableThinking
        ? native.selected.thinking === true
          ? "On"
          : "—"
        : "";
  const changeNative = async (patch: AgentNativeIntelligencePatch) => {
    if (!native || nativePending) return;
    setNativePending(true);
    try {
      await native.change(patch);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not update model options");
    } finally {
      setNativePending(false);
    }
  };
  const labelCandidates = useMemo<readonly IntelligenceSelectorLabelCandidate[]>(
    () => [
      ...visibleCatalog.flatMap((candidate) => {
        const efforts =
          candidate.supportedReasoningEfforts.length > 0
            ? candidate.supportedReasoningEfforts.map((option) => option.reasoningEffort)
            : [candidate.defaultReasoningEffort ?? selection.reasoningEffort];
        return efforts.map((effort) => ({
          id: `${candidate.id}:${effort}`,
          modelLabel: formatCodexModelLabel(candidate.id, models),
          reasoningLabel:
            isCodex || candidate.supportedReasoningEfforts.length
              ? effortLabel(selection.kind, effort)
              : "",
        }));
      }),
      {
        id: `selected:${selection.model}:${selection.reasoningEffort}`,
        modelLabel,
        reasoningLabel,
      },
    ],
    [
      isCodex,
      modelLabel,
      models,
      reasoningLabel,
      selection.model,
      selection.reasoningEffort,
      selection.kind,
      visibleCatalog,
    ],
  );
  const triggerGeometry = useIntelligenceSelectorTriggerGeometry(labelCandidates);
  const settingsLabel =
    inheritance === "inherited"
      ? "Use current/default"
      : [modelLabel, reasoningLabel].filter(Boolean).join(" · ");

  return (
    <NodexDropdownMenu
      disabled={disabled}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      triggerButton={
        triggerStyle === "settings" ? (
          <NodexSettingsDropdownTrigger
            ref={triggerRef}
            aria-label="Agent intelligence"
            className="w-full min-w-0 justify-between"
          >
            {showFastIndicator && inheritance === "explicit" ? (
              <FastModeIcon className="icon-2xs shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-left">{settingsLabel}</span>
          </NodexSettingsDropdownTrigger>
        ) : (
          <IntelligenceSelectorTrigger
            ref={triggerRef}
            geometry={triggerGeometry}
            isOpen={menuOpen}
            labelCandidates={labelCandidates}
            modelLabel={modelLabel}
            reasoningLabel={reasoningLabel}
            showFastIndicator={showFastIndicator}
            aria-keyshortcuts={shortcut?.ariaKeyShortcuts}
          />
        )
      }
      triggerTooltipContent={triggerStyle === "composer" ? "Select model" : undefined}
      triggerTooltipShortcutLabel={triggerStyle === "composer" ? shortcut?.label : undefined}
      side={triggerStyle === "composer" ? "top" : "bottom"}
      align="end"
      alignOffset={triggerStyle === "composer" ? triggerGeometry.alignOffset : undefined}
      sideOffset={triggerStyle === "composer" ? INTELLIGENCE_SELECTOR_SIDE_OFFSET_PX : undefined}
      contentClassName="w-56"
    >
      {allowInherit ? (
        <>
          <NodexDropdownItem
            onSelect={() => onInherit?.()}
            rightSlot={inheritance === "inherited" ? <NodexDropdownSelectedIcon /> : null}
          >
            Use current/default
          </NodexDropdownItem>
          <NodexDropdownSeparator />
        </>
      ) : null}

      {provider && provider.options.length > 1 ? (
        <NodexDropdownSummarySubmenuItem
          label="Agent"
          value={provider.label}
          ariaLabel={`Agent ${provider.label}`}
        >
          {provider.options.map((option) => (
            <NodexDropdownItem
              key={option.value}
              onSelect={(event) => {
                event.preventDefault();
                provider.select(option.value);
              }}
              rightSlot={provider.selection === option.value ? <NodexDropdownSelectedIcon /> : null}
            >
              {option.label}
            </NodexDropdownItem>
          ))}
        </NodexDropdownSummarySubmenuItem>
      ) : null}

      <NodexDropdownSummarySubmenuItem
        ariaLabel={`Model ${modelLabel}`}
        label="Model"
        value={modelLabel}
        contentClassName="w-[280px]"
      >
        <NodexDropdownSection className="flex w-full min-w-0 flex-col overflow-hidden">
          <NodexDropdownTitle>Model</NodexDropdownTitle>
          {visibleCatalog.length > 8 ? (
            <NodexDropdownSearchInput
              value={query}
              placeholder="Filter models…"
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          <div className="vertical-scroll-fade-mask flex max-h-[250px] flex-col overflow-y-auto">
            {visibleModels.length === 0 ? (
              <NodexDropdownMessage compact centered>
                No matching models
              </NodexDropdownMessage>
            ) : (
              visibleModels.map((candidate) => {
                const selected = candidate.id === selection.model;
                return (
                  <NodexDropdownItem
                    key={candidate.id}
                    onSelect={(event) => {
                      event.preventDefault();
                      const reasoningEffort = isCodex
                        ? resolveReasoningEffortForModelChange({
                            currentReasoningEffort: selection.reasoningEffort,
                            nextModelId: candidate.id,
                            models,
                          })
                        : selection.kind === "claude"
                          ? candidate.supportedReasoningEfforts.some(
                              (option) => option.reasoningEffort === selection.reasoningEffort,
                            )
                            ? selection.reasoningEffort
                            : candidate.defaultReasoningEffort
                          : "none";
                      if (!reasoningEffort) return;
                      onSelectionChange(
                        { ...selection, model: candidate.id, reasoningEffort },
                        "model",
                      );
                    }}
                    rightSlot={selected ? <NodexDropdownSelectedIcon /> : null}
                    tooltipText={
                      selection.kind === "claude" && candidate.id !== "default"
                        ? candidate.id
                        : candidate.description.trim().replace(/\.$/u, "") || undefined
                    }
                    data-model-selected={selected ? "true" : undefined}
                  >
                    <span className="flex min-w-0 flex-col">
                      <ModelLabel modelId={candidate.id} models={models} fast={showFastIndicator} />
                      {selection.kind === "claude" &&
                      candidate.id !== "default" &&
                      candidate.displayName !== candidate.id ? (
                        <span className="truncate text-xs text-token-description-foreground">
                          {candidate.id}
                        </span>
                      ) : null}
                    </span>
                  </NodexDropdownItem>
                );
              })
            )}
            {hiddenMatchCount > 0 ? (
              <NodexDropdownMessage compact centered>
                Refine the search to see {hiddenMatchCount} more models
              </NodexDropdownMessage>
            ) : null}
          </div>
        </NodexDropdownSection>
      </NodexDropdownSummarySubmenuItem>

      {reasoningOptions.length > 0 || native?.capabilities.disableThinking ? (
        <NodexDropdownSummarySubmenuItem
          ariaLabel={`Effort ${reasoningLabel}`}
          label="Effort"
          value={reasoningLabel}
          contentClassName="min-w-[180px]"
        >
          <NodexDropdownSection className="flex min-w-[180px] flex-col overflow-hidden">
            <NodexDropdownTitle>Effort</NodexDropdownTitle>
            {native?.capabilities.disableThinking ? (
              <NodexDropdownItem
                disabled={nativePending}
                onSelect={(event) => {
                  event.preventDefault();
                  void changeNative({ thinking: false });
                }}
                rightSlot={thinkingOff ? <NodexDropdownSelectedIcon /> : null}
              >
                Off
              </NodexDropdownItem>
            ) : null}
            {native?.capabilities.disableThinking && reasoningOptions.length === 0 ? (
              <NodexDropdownItem
                disabled={nativePending}
                onSelect={(event) => {
                  event.preventDefault();
                  void changeNative({ thinking: true });
                }}
                rightSlot={native.selected.thinking === true ? <NodexDropdownSelectedIcon /> : null}
              >
                On
              </NodexDropdownItem>
            ) : null}
            {reasoningOptions.map((option) => (
              <NodexDropdownItem
                key={option.reasoningEffort}
                disabled={nativePending}
                onSelect={(event) => {
                  event.preventDefault();
                  if (native && selection.kind === "claude") {
                    if (!isClaudeEffortLevel(option.reasoningEffort)) return;
                    void changeNative({
                      effort: option.reasoningEffort,
                      thinking: true,
                    });
                    return;
                  }
                  onSelectionChange(
                    { ...selection, reasoningEffort: option.reasoningEffort },
                    "reasoningEffort",
                  );
                }}
                rightSlot={
                  !thinkingOff && option.reasoningEffort === selection.reasoningEffort ? (
                    <NodexDropdownSelectedIcon />
                  ) : null
                }
                tooltipText={option.description || undefined}
                subText={
                  option.reasoningEffort === "ultra" ? "Consumes usage limits faster" : undefined
                }
                allowWrap={option.reasoningEffort === "ultra"}
                data-intelligence-option={option.reasoningEffort}
              >
                {effortLabel(selection.kind, option.reasoningEffort)}
              </NodexDropdownItem>
            ))}
          </NodexDropdownSection>
        </NodexDropdownSummarySubmenuItem>
      ) : null}

      {isCodex || native?.capabilities.fastMode ? (
        <NodexDropdownSummarySubmenuItem
          ariaLabel={`Speed ${speedLabel}`}
          label="Speed"
          value={speedLabel}
          contentClassName={isCodex ? "w-[233px]" : undefined}
        >
          <NodexDropdownSection className="flex w-full min-w-0 flex-col overflow-hidden">
            <NodexDropdownTitle>Speed</NodexDropdownTitle>
            {SPEED_OPTIONS.map((option) => (
              <NodexDropdownItem
                key={option.label}
                disabled={nativePending}
                onSelect={(event) => {
                  event.preventDefault();
                  if (native) {
                    void changeNative({ fast: option.fast });
                    return;
                  }
                  onSelectionChange(
                    { ...selection, serviceTier: option.fast ? "fast" : null },
                    "serviceTier",
                  );
                }}
                rightSlot={selectedFast === option.fast ? <NodexDropdownSelectedIcon /> : null}
                subText={isCodex ? option.codexDescription : undefined}
                allowWrap
              >
                {option.label}
              </NodexDropdownItem>
            ))}
          </NodexDropdownSection>
        </NodexDropdownSummarySubmenuItem>
      ) : null}

      {native ? (
        <NativeContextOptions native={native} pending={nativePending} change={changeNative} />
      ) : null}
    </NodexDropdownMenu>
  );
}

function NativeContextOptions({
  native,
  pending,
  change,
}: {
  native: AgentNativeIntelligencePresentation;
  pending: boolean;
  change: (patch: AgentNativeIntelligencePatch) => Promise<void>;
}) {
  const contextWindows = [...new Set(native.capabilities.contextWindows ?? [])];
  return (
    <>
      {contextWindows.length > 1 ? (
        <NodexDropdownSummarySubmenuItem
          label="Context"
          value={native.selected.context ?? "—"}
          ariaLabel={`Context ${native.selected.context ?? "—"}`}
        >
          <NodexDropdownItem
            disabled={pending}
            onSelect={(event) => {
              event.preventDefault();
              void change({ context: null });
            }}
            rightSlot={native.selected.contextInherited ? <NodexDropdownSelectedIcon /> : null}
          >
            Default
          </NodexDropdownItem>
          {contextWindows.map((value) => (
            <NodexDropdownItem
              key={value}
              disabled={pending}
              onSelect={(event) => {
                event.preventDefault();
                void change({ context: value });
              }}
              rightSlot={
                !native.selected.contextInherited && native.selected.context === value ? (
                  <NodexDropdownSelectedIcon />
                ) : null
              }
            >
              {value}
            </NodexDropdownItem>
          ))}
        </NodexDropdownSummarySubmenuItem>
      ) : null}
    </>
  );
}
