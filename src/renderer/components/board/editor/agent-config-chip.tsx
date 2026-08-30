import { useMemo, useState, type ReactNode } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { AlertTriangle, Gauge } from "@/components/shared/icons/generic-icons";
import { NodexLogoMarkIcon, ResetIcon, SettingsGeneralIcon } from "@/components/shared/icons";
import {
  NodexDropdownButtonTrigger,
  NodexOptionPicker,
  NodexDropdownSeparator,
  type NodexOptionPickerOption,
} from "@/components/ui/dropdown";
import {
  NodexPopover,
  NodexPopoverContent,
  NodexPopoverTitle,
  NodexPopoverTrigger,
} from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  inlineTintedChipIconClassName,
  inlineTintedChipLabelClassName,
  inlineTintedChipVariants,
} from "@/components/ui/inline-tinted-chip";
import { useCodexAvailableModels } from "@/features/local-conversation/local-conversation-store";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
  resolveCodexReasoningEffortOptions,
} from "@/lib/codex-thread-settings";
import type {
  CodexModelOption,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { agentConfigInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import {
  CodexCollaborationModeKindSchema,
  CodexReasoningEffortSchema,
} from "../../../../shared/schemas/codex";

export interface AgentConfigProps {
  mode: string;
  model: string;
  reasoning: string;
  unknownAttributes: string;
  rawAttributes: string;
}

export interface AgentConfigInlineContentUpdate {
  type: "agentConfig";
  props: AgentConfigProps;
}

type AgentConfigFieldPatch = Partial<Pick<AgentConfigProps, "mode" | "model" | "reasoning">>;

const ALL_REASONING_EFFORTS: CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Inherit" },
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan" },
];

export function normalizeAgentConfigProps(
  input: Partial<AgentConfigProps> | undefined,
): AgentConfigProps {
  return {
    mode: typeof input?.mode === "string" ? input.mode : "",
    model: typeof input?.model === "string" ? input.model : "",
    reasoning: typeof input?.reasoning === "string" ? input.reasoning : "",
    unknownAttributes: typeof input?.unknownAttributes === "string" ? input.unknownAttributes : "",
    rawAttributes: typeof input?.rawAttributes === "string" ? input.rawAttributes : "",
  };
}

function formatReasoningLabel(value: string): string {
  if (!value) return "";
  const parsed = parseReasoningEffort(value);
  return parsed ? formatCodexReasoningEffortLabel(parsed) : value;
}

function parseReasoningEffort(value: string): CodexReasoningEffort | null {
  const parsed = CodexReasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isKnownAgentConfigMode(value: string): boolean {
  return value === "" || CodexCollaborationModeKindSchema.safeParse(value).success;
}

function isKnownAgentConfigReasoning(value: string): boolean {
  return value === "" || CodexReasoningEffortSchema.safeParse(value).success;
}

export function resolveAgentConfigChip(
  input: Partial<AgentConfigProps> | undefined,
  models: CodexModelOption[] = [],
): {
  label: string;
  detail: string;
  invalid: boolean;
} {
  const props = normalizeAgentConfigProps(input);
  const invalid =
    props.unknownAttributes.trim().length > 0 ||
    !isKnownAgentConfigMode(props.mode) ||
    !isKnownAgentConfigReasoning(props.reasoning);
  const label =
    props.mode === "plan"
      ? "Plan mode"
      : props.mode === "default"
        ? "Default mode"
        : "Agent config";
  const modelLabel = props.model ? formatCodexModelLabel(props.model, models) : "";
  const detail = [modelLabel, formatReasoningLabel(props.reasoning)]
    .filter((value) => value.trim().length > 0)
    .join(" · ");

  return {
    label: invalid ? "Invalid config" : label,
    detail,
    invalid,
  };
}

export function buildAgentConfigUpdate(
  current: Partial<AgentConfigProps> | undefined,
  patch: AgentConfigFieldPatch,
): AgentConfigInlineContentUpdate {
  const props = normalizeAgentConfigProps(current);
  return {
    type: "agentConfig",
    props: {
      ...props,
      ...patch,
      unknownAttributes: "",
      rawAttributes: "",
    },
  };
}

export function buildAgentConfigResetUpdate(): AgentConfigInlineContentUpdate {
  return {
    type: "agentConfig",
    props: {
      mode: "plan",
      model: "",
      reasoning: "",
      unknownAttributes: "",
      rawAttributes: "",
    },
  };
}

function getVisibleModels(models: CodexModelOption[]): CodexModelOption[] {
  return models.filter((model) => !model.hidden);
}

function getReasoningOptions(
  modelId: string,
  models: CodexModelOption[],
): CodexReasoningEffortOption[] {
  if (!modelId) {
    return ALL_REASONING_EFFORTS.map((reasoningEffort) => ({
      reasoningEffort,
      description: formatCodexReasoningEffortLabel(reasoningEffort),
    }));
  }

  const selectedModel = models.find((model) => model.id === modelId && !model.hidden);
  if (!selectedModel || selectedModel.supportedReasoningEfforts.length === 0) {
    return ALL_REASONING_EFFORTS.map((reasoningEffort) => ({
      reasoningEffort,
      description: formatCodexReasoningEffortLabel(reasoningEffort),
    }));
  }

  return resolveCodexReasoningEffortOptions(modelId, models);
}

function AgentConfigControlRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 px-2 py-1.5">
      <div className="text-xs text-token-description-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ModeSegmentedControl({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div
      className="grid grid-cols-3 gap-0.5 rounded-lg bg-token-foreground/5 p-0.5"
      role="group"
      aria-label="Agent config mode"
    >
      {MODE_OPTIONS.map((option) => (
        <button
          key={option.value || "inherit"}
          type="button"
          aria-pressed={value === option.value}
          className={cn(
            "h-6 rounded-md px-2 text-xs text-token-description-foreground outline-hidden",
            "hover:bg-token-foreground/5 hover:text-token-foreground",
            "focus-visible:ring-token-focus focus-visible:ring-2",
            value === option.value &&
              "bg-token-bg text-token-foreground shadow-[0_0_0_0.5px_color-mix(in_srgb,var(--foreground)_10%,transparent)]",
          )}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function AgentConfigPopoverBody({
  props,
  chip,
  availableModels,
  onPatch,
  onReset,
}: {
  props: AgentConfigProps;
  chip: ReturnType<typeof resolveAgentConfigChip>;
  availableModels: CodexModelOption[];
  onPatch: (patch: AgentConfigFieldPatch) => void;
  onReset: () => void;
}) {
  const visibleModels = useMemo(() => getVisibleModels(availableModels), [availableModels]);
  const modelIsVisible = props.model
    ? visibleModels.some((model) => model.id === props.model)
    : true;
  const modelOptions = useMemo(() => {
    const options: NodexOptionPickerOption[] = [
      {
        value: "",
        label: "Use current/default",
        subText: "No one-send model override",
      },
    ];

    if (props.model && !modelIsVisible) {
      options.push({
        value: props.model,
        label: "Unavailable model",
        subText: props.model,
        disabled: true,
      });
    }

    for (const model of visibleModels) {
      options.push({
        value: model.id,
        label: formatCodexModelLabel(model.id, availableModels),
        subText: model.id,
      });
    }

    return options;
  }, [availableModels, modelIsVisible, props.model, visibleModels]);
  const reasoningOptions = useMemo(() => {
    const supportedOptions = getReasoningOptions(props.model, availableModels);
    const options: NodexOptionPickerOption[] = [
      {
        value: "",
        label: "Use current/default",
        subText: "No one-send reasoning override",
      },
    ];
    const supportedValues = new Set(supportedOptions.map((option) => option.reasoningEffort));
    const selectedReasoning = parseReasoningEffort(props.reasoning);

    if (props.reasoning && (!selectedReasoning || !supportedValues.has(selectedReasoning))) {
      options.push({
        value: props.reasoning,
        label: "Unsupported reasoning",
        subText: props.reasoning,
        disabled: true,
      });
    }

    for (const option of supportedOptions) {
      options.push({
        value: option.reasoningEffort,
        label: formatCodexReasoningEffortLabel(option.reasoningEffort),
        subText: option.description,
      });
    }

    return options;
  }, [availableModels, props.model, props.reasoning]);
  const modelLabel = props.model
    ? formatCodexModelLabel(props.model, availableModels)
    : "Use current/default";
  const reasoningLabel = props.reasoning
    ? formatReasoningLabel(props.reasoning)
    : "Use current/default";
  const modelHelp =
    visibleModels.length === 0
      ? "Model list unavailable. Existing values are preserved until changed."
      : props.model && !modelIsVisible
        ? "This model is not currently available in Nodex."
        : null;

  return (
    <div className="w-[min(22rem,calc(100vw-2rem))] p-1 text-sm">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <div
          className={cn(
            "mt-0.5 rounded-lg p-1.5",
            chip.invalid
              ? "bg-token-foreground/8 text-token-description-foreground"
              : "bg-token-charts-blue/10 text-token-charts-blue",
          )}
        >
          {chip.invalid ? (
            <AlertTriangle className="size-3.5" />
          ) : (
            <SettingsGeneralIcon className="size-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <NodexPopoverTitle className="truncate text-sm font-medium text-token-foreground">
            {chip.label}
          </NodexPopoverTitle>
          <div className="mt-0.5 text-xs text-token-description-foreground">
            {chip.invalid
              ? "Fix this chip before sending the prompt."
              : "Applies only to this prompt send."}
          </div>
        </div>
        {chip.invalid ? (
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onReset();
            }}
          >
            <ResetIcon className="size-3" />
            <span>Reset</span>
          </button>
        ) : null}
      </div>

      <NodexDropdownSeparator paddingClassName="py-1" />

      <AgentConfigControlRow label="Mode">
        <ModeSegmentedControl
          value={isKnownAgentConfigMode(props.mode) ? props.mode : ""}
          onValueChange={(mode) => onPatch({ mode })}
        />
      </AgentConfigControlRow>

      <AgentConfigControlRow label="Model">
        <NodexOptionPicker
          value={props.model}
          options={modelOptions}
          search="filter"
          searchPlaceholder="Search models…"
          searchAriaLabel="Search agent models"
          onValueChange={(model) => onPatch({ model })}
          contentWidth="menu"
          triggerButton={
            <NodexDropdownButtonTrigger
              size="xs"
              aria-label="Agent config model"
              className="w-full justify-between"
              muted={!props.model}
            >
              <span className="min-w-0 truncate">{modelLabel}</span>
            </NodexDropdownButtonTrigger>
          }
        />
        {modelHelp ? (
          <div className="mt-1 text-[11px] leading-4 text-token-description-foreground">
            {modelHelp}
          </div>
        ) : null}
      </AgentConfigControlRow>

      <AgentConfigControlRow label="Reasoning">
        <NodexOptionPicker
          value={props.reasoning}
          options={reasoningOptions}
          onValueChange={(reasoning) => onPatch({ reasoning })}
          contentWidth="menu"
          triggerButton={
            <NodexDropdownButtonTrigger
              size="xs"
              aria-label="Agent config reasoning"
              className="w-full justify-between"
              muted={!props.reasoning}
            >
              <span className="min-w-0 truncate">{reasoningLabel}</span>
            </NodexDropdownButtonTrigger>
          }
        />
      </AgentConfigControlRow>
    </div>
  );
}

export function AgentConfigInlineContentView({
  inlineContent,
  updateInlineContent,
  availableModels,
  defaultOpen = false,
}: {
  inlineContent: { props: Partial<AgentConfigProps> };
  updateInlineContent: (update: AgentConfigInlineContentUpdate) => void;
  availableModels: CodexModelOption[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const props = normalizeAgentConfigProps(inlineContent.props);
  const chip = resolveAgentConfigChip(props, availableModels);
  const title = chip.invalid
    ? "This agent config has invalid attributes or values."
    : [chip.label, chip.detail].filter(Boolean).join(" · ");
  const Icon = props.reasoning ? Gauge : props.mode ? NodexLogoMarkIcon : SettingsGeneralIcon;

  const handlePatch = (patch: AgentConfigFieldPatch) => {
    updateInlineContent(buildAgentConfigUpdate(props, patch));
  };

  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <span className="inline align-baseline">
        <NodexTooltip tooltipContent={title}>
          <NodexPopoverTrigger>
            <button
              type="button"
              contentEditable={false}
              className={cn(
                inlineTintedChipVariants({
                  tone: chip.invalid ? "neutral" : "accent",
                  interactive: true,
                }),
                "blend outline-hidden focus-visible:ring-token-focus focus-visible:ring-2",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpen((current) => !current);
              }}
            >
              <Icon
                className={inlineTintedChipIconClassName}
                {...(Icon === NodexLogoMarkIcon ? { monochrome: true } : {})}
              />
              <span className={cn(inlineTintedChipLabelClassName, "blend truncate")}>
                {chip.label}
              </span>
              {chip.detail ? (
                <span
                  className={cn(inlineTintedChipLabelClassName, "blend ml-1 truncate opacity-70")}
                >
                  {chip.detail}
                </span>
              ) : null}
            </button>
          </NodexPopoverTrigger>
        </NodexTooltip>
      </span>

      <NodexPopoverContent side="top" align="start" className="w-full" initialFocus={false}>
        <AgentConfigPopoverBody
          props={props}
          chip={chip}
          availableModels={availableModels}
          onPatch={handlePatch}
          onReset={() => updateInlineContent(buildAgentConfigResetUpdate())}
        />
      </NodexPopoverContent>
    </NodexPopover>
  );
}

function AgentConfigInlineContent({
  inlineContent,
  updateInlineContent,
}: {
  inlineContent: { props: Partial<AgentConfigProps> };
  updateInlineContent: (update: AgentConfigInlineContentUpdate) => void;
}) {
  const availableModels = useCodexAvailableModels();
  return (
    <AgentConfigInlineContentView
      inlineContent={inlineContent}
      updateInlineContent={updateInlineContent}
      availableModels={availableModels}
    />
  );
}

export function createAgentConfigInlineContentSpec() {
  return createReactInlineContentSpec(agentConfigInlineContentConfig, {
    render: ({ inlineContent, updateInlineContent }) => (
      <AgentConfigInlineContent
        inlineContent={inlineContent as { props: Partial<AgentConfigProps> }}
        updateInlineContent={
          updateInlineContent as (update: AgentConfigInlineContentUpdate) => void
        }
      />
    ),
    toExternalHTML: ({ inlineContent }) => {
      const chip = resolveAgentConfigChip(
        (inlineContent as { props: Partial<AgentConfigProps> }).props,
      );
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] px-2 py-0.5 text-xs text-[var(--foreground)]">
          <SettingsGeneralIcon className="size-3" />
          <span>{chip.label}</span>
          {chip.detail ? <span className="opacity-60">({chip.detail})</span> : null}
        </span>
      );
    },
  });
}
