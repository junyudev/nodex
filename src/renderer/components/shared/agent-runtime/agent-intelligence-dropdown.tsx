import { useDeferredValue, useMemo, useState, type Ref } from "react";
import { FastModeIcon } from "@/components/shared/icons";
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
import type {
  CodexModelOption,
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
  readonly kind: "codex";
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier: CodexServiceTier;
}

export type AgentIntelligenceInheritance = "explicit" | "inherited";

export interface AgentIntelligenceDropdownProps {
  readonly models: readonly CodexModelOption[];
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

const SERVICE_TIER_OPTIONS: readonly {
  readonly value: CodexServiceTier;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: null, label: "Standard", description: "Default speed, normal usage" },
  { value: "fast", label: "Fast", description: "1.5x speed · More usage" },
];

export function resolveReasoningEffortForModelChange(input: {
  currentReasoningEffort: CodexReasoningEffort;
  nextModelId: string;
  models: readonly CodexModelOption[];
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
  models: readonly CodexModelOption[];
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
  const modelLabel = formatCodexModelLabel(selection.model, models);
  const reasoningLabel = formatCodexReasoningEffortLabel(selection.reasoningEffort);
  const reasoningOptions = resolveCodexReasoningEffortOptions(selection.model, models);
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
          reasoningLabel: formatCodexReasoningEffortLabel(effort),
        }));
      }),
      {
        id: `selected:${selection.model}:${selection.reasoningEffort}`,
        modelLabel,
        reasoningLabel,
      },
    ],
    [
      modelLabel,
      models,
      reasoningLabel,
      selection.model,
      selection.reasoningEffort,
      visibleCatalog,
    ],
  );
  const triggerGeometry = useIntelligenceSelectorTriggerGeometry(labelCandidates);
  const settingsLabel =
    inheritance === "inherited" ? "Use current/default" : `${modelLabel} · ${reasoningLabel}`;

  return (
    <NodexDropdownMenu
      open={menuOpen}
      onOpenChange={setMenuOpen}
      triggerButton={
        triggerStyle === "settings" ? (
          <NodexSettingsDropdownTrigger
            ref={triggerRef}
            aria-label="Agent intelligence"
            className="w-full min-w-0 justify-between"
          >
            {selection.serviceTier === "fast" && inheritance === "explicit" ? (
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
            showFastIndicator={selection.serviceTier === "fast"}
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
                      const reasoningEffort = resolveReasoningEffortForModelChange({
                        currentReasoningEffort: selection.reasoningEffort,
                        nextModelId: candidate.id,
                        models,
                      });
                      if (!reasoningEffort) return;
                      onSelectionChange(
                        { ...selection, model: candidate.id, reasoningEffort },
                        "model",
                      );
                    }}
                    rightSlot={selected ? <NodexDropdownSelectedIcon /> : null}
                    tooltipText={candidate.description.trim().replace(/\.$/u, "") || undefined}
                    data-model-selected={selected ? "true" : undefined}
                  >
                    <ModelLabel
                      modelId={candidate.id}
                      models={models}
                      fast={selection.serviceTier === "fast"}
                    />
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

      <NodexDropdownSummarySubmenuItem
        ariaLabel={`Effort ${reasoningLabel}`}
        label="Effort"
        value={reasoningLabel}
        contentClassName="min-w-[180px]"
      >
        <NodexDropdownSection className="flex min-w-[180px] flex-col overflow-hidden">
          <NodexDropdownTitle>Effort</NodexDropdownTitle>
          {reasoningOptions.map((option) => (
            <NodexDropdownItem
              key={option.reasoningEffort}
              onSelect={(event) => {
                event.preventDefault();
                onSelectionChange(
                  { ...selection, reasoningEffort: option.reasoningEffort },
                  "reasoningEffort",
                );
              }}
              rightSlot={
                option.reasoningEffort === selection.reasoningEffort ? (
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
              {formatCodexReasoningEffortLabel(option.reasoningEffort)}
            </NodexDropdownItem>
          ))}
        </NodexDropdownSection>
      </NodexDropdownSummarySubmenuItem>

      <NodexDropdownSummarySubmenuItem
        ariaLabel={`Speed ${selection.serviceTier === "fast" ? "Fast" : "Standard"}`}
        label="Speed"
        value={selection.serviceTier === "fast" ? "Fast" : "Standard"}
        contentClassName="w-[233px]"
      >
        <NodexDropdownSection className="flex w-full min-w-0 flex-col overflow-hidden">
          <NodexDropdownTitle>Speed</NodexDropdownTitle>
          {SERVICE_TIER_OPTIONS.map((option) => (
            <NodexDropdownItem
              key={option.label}
              onSelect={(event) => {
                event.preventDefault();
                onSelectionChange({ ...selection, serviceTier: option.value }, "serviceTier");
              }}
              rightSlot={
                option.value === selection.serviceTier ? <NodexDropdownSelectedIcon /> : null
              }
              subText={option.description}
              allowWrap
            >
              {option.label}
            </NodexDropdownItem>
          ))}
        </NodexDropdownSection>
      </NodexDropdownSummarySubmenuItem>
    </NodexDropdownMenu>
  );
}
