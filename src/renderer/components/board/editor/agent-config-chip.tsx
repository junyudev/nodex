import { useState, type ReactNode } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import {
  AgentIntelligenceDropdown,
  type AgentIntelligenceSelection,
} from "@/components/shared/agent-runtime/agent-intelligence-dropdown";
import { NodexLogoMarkIcon, ResetIcon } from "@/components/shared/icons";
import { NodexDropdownSeparator, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import {
  inlineTintedChipIconClassName,
  inlineTintedChipLabelClassName,
  inlineTintedChipVariants,
} from "@/components/ui/inline-tinted-chip";
import {
  NodexPopover,
  NodexPopoverContent,
  NodexPopoverTitle,
  NodexPopoverTrigger,
} from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { PermissionModeDropdown } from "@/features/local-conversation/view/shared/permission-mode-dropdown";
import {
  formatCodexModelLabel,
  formatCodexReasoningEffortLabel,
  resolveDefaultCodexModel,
} from "@/lib/codex-thread-settings";
import { cn } from "@/lib/utils";
import { agentConfigInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { normalizeCodexServiceTier } from "../../../../shared/codex-service-tier";
import {
  CodexCollaborationModeKindSchema,
  CodexPermissionModeSchema,
  CodexReasoningEffortSchema,
} from "../../../../shared/schemas/codex";
import type {
  CodexModelOption,
  CodexPermissionMode,
  CodexReasoningEffort,
} from "../../../../shared/types";
import { useAgentConfigRuntime, type AgentConfigRuntimeValue } from "./agent-config-runtime";

const CODEX_PROVIDER_ID = "openai";

export interface AgentConfigProps {
  mode: string;
  provider: string;
  model: string;
  reasoning: string;
  speed: string;
  permission: string;
  unknownAttributes: string;
  rawAttributes: string;
}

export interface AgentConfigInlineContentUpdate {
  type: "agentConfig";
  props: AgentConfigProps;
}

type AgentConfigFieldPatch = Partial<
  Pick<AgentConfigProps, "mode" | "provider" | "model" | "reasoning" | "speed" | "permission">
>;

export type AgentConfigIntelligenceSelection =
  | {
      readonly kind: "ready";
      readonly inheritance: "explicit" | "inherited";
      readonly selection: AgentIntelligenceSelection;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

const MODE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "Inherit" },
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan" },
];

export function normalizeAgentConfigProps(
  input: Partial<AgentConfigProps> | undefined,
): AgentConfigProps {
  return {
    mode: typeof input?.mode === "string" ? input.mode : "",
    provider: typeof input?.provider === "string" ? input.provider : "",
    model: typeof input?.model === "string" ? input.model : "",
    reasoning: typeof input?.reasoning === "string" ? input.reasoning : "",
    speed: typeof input?.speed === "string" ? input.speed : "",
    permission: typeof input?.permission === "string" ? input.permission : "",
    unknownAttributes: typeof input?.unknownAttributes === "string" ? input.unknownAttributes : "",
    rawAttributes: typeof input?.rawAttributes === "string" ? input.rawAttributes : "",
  };
}

function hasExplicitIntelligence(props: AgentConfigProps): boolean {
  return Boolean(props.provider || props.model || props.reasoning || props.speed);
}

function hasExplicitAgentConfig(props: AgentConfigProps): boolean {
  return Boolean(
    props.mode ||
    props.provider ||
    props.model ||
    props.reasoning ||
    props.speed ||
    props.permission ||
    props.unknownAttributes ||
    props.rawAttributes,
  );
}

function findVisibleModel(
  models: readonly CodexModelOption[],
  modelId: string,
): CodexModelOption | null {
  return (
    models.find(
      (candidate) => !candidate.hidden && (candidate.id === modelId || candidate.model === modelId),
    ) ?? null
  );
}

export function resolveDefaultAgentConfigIntelligence(
  models: readonly CodexModelOption[],
): AgentIntelligenceSelection | null {
  const model = resolveDefaultCodexModel(models);
  if (!model) return null;
  const reasoningEffort =
    model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0]?.reasoningEffort;
  if (!reasoningEffort) return null;
  return {
    kind: "codex",
    model: model.id,
    reasoningEffort,
    serviceTier: normalizeCodexServiceTier(model.defaultServiceTier),
  };
}

function parseReasoningEffort(value: string): CodexReasoningEffort | null {
  const parsed = CodexReasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function resolveAgentConfigIntelligenceSelection(input: {
  props: Partial<AgentConfigProps> | undefined;
  models: readonly CodexModelOption[];
  defaultSelection: AgentIntelligenceSelection | null;
}): AgentConfigIntelligenceSelection {
  const props = normalizeAgentConfigProps(input.props);
  if (!input.defaultSelection) {
    return { kind: "unavailable", reason: "Codex model catalog is unavailable." };
  }
  if (props.provider && props.provider !== CODEX_PROVIDER_ID) {
    return { kind: "unavailable", reason: `Provider '${props.provider}' is unavailable.` };
  }
  if (!hasExplicitIntelligence(props)) {
    return { kind: "ready", inheritance: "inherited", selection: input.defaultSelection };
  }

  const model = props.model
    ? findVisibleModel(input.models, props.model)
    : findVisibleModel(input.models, input.defaultSelection.model);
  if (!model) {
    return {
      kind: "unavailable",
      reason: props.model
        ? `Model '${props.model}' is unavailable.`
        : "The current/default Codex model is unavailable.",
    };
  }

  const inheritedReasoning =
    model.id === input.defaultSelection.model ? input.defaultSelection.reasoningEffort : null;
  const reasoningEffort = props.reasoning
    ? parseReasoningEffort(props.reasoning)
    : (inheritedReasoning ??
      model.defaultReasoningEffort ??
      model.supportedReasoningEfforts[0]?.reasoningEffort ??
      null);
  if (
    !reasoningEffort ||
    !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === reasoningEffort)
  ) {
    return {
      kind: "unavailable",
      reason: `Effort '${props.reasoning || reasoningEffort || "default"}' is unavailable for ${model.displayName}.`,
    };
  }

  const inheritedSpeed =
    model.id === input.defaultSelection.model ? input.defaultSelection.serviceTier : null;
  const serviceTier = props.speed
    ? normalizeCodexServiceTier(props.speed)
    : (inheritedSpeed ?? normalizeCodexServiceTier(model.defaultServiceTier));
  if (props.speed && serviceTier !== null && serviceTier !== "fast") {
    return {
      kind: "unavailable",
      reason: `Speed '${props.speed}' is unavailable for ${model.displayName}.`,
    };
  }

  return {
    kind: "ready",
    inheritance: "explicit",
    selection: { kind: "codex", model: model.id, reasoningEffort, serviceTier },
  };
}

function isKnownAgentConfigMode(value: string): boolean {
  return value === "" || CodexCollaborationModeKindSchema.safeParse(value).success;
}

function parsePermissionMode(value: string): CodexPermissionMode | null {
  const parsed = CodexPermissionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function formatPermissionMode(value: string): string {
  switch (value) {
    case "auto":
      return "Ask for approval";
    case "guardian-approvals":
      return "Approve for me";
    case "full-access":
      return "Full access";
    case "custom":
      return "Custom";
    default:
      return value;
  }
}

export function resolveAgentConfigChip(
  input: Partial<AgentConfigProps> | undefined,
  models: readonly CodexModelOption[] = [],
): { label: string; summary: string; detail: string; invalid: boolean } {
  const props = normalizeAgentConfigProps(input);
  const model = props.model ? findVisibleModel(models, props.model) : null;
  const modeLabel = props.mode ? (props.mode === "plan" ? "Plan" : "Default") : "";
  const modelLabel =
    model?.displayName ?? (props.model ? formatCodexModelLabel(props.model, []) : "");
  const reasoningLabel = props.reasoning ? formatCodexReasoningEffortLabel(props.reasoning) : "";
  const speedLabel = props.speed
    ? normalizeCodexServiceTier(props.speed) === null
      ? "Standard"
      : props.speed === "fast"
        ? "Fast"
        : props.speed
    : "";
  const permissionLabel = props.permission ? formatPermissionMode(props.permission) : "";
  const summary = [modeLabel, modelLabel].filter(Boolean).join(" · ");
  const detail = [modeLabel, modelLabel, reasoningLabel, speedLabel, permissionLabel]
    .filter(Boolean)
    .join(" · ");
  const invalid =
    props.unknownAttributes.trim().length > 0 ||
    Boolean(props.rawAttributes.trim()) ||
    !isKnownAgentConfigMode(props.mode) ||
    Boolean(props.provider && props.provider !== CODEX_PROVIDER_ID) ||
    Boolean(props.permission && !parsePermissionMode(props.permission));
  return { label: "Agent config", summary, detail, invalid };
}

export function buildAgentConfigUpdate(
  current: Partial<AgentConfigProps> | undefined,
  patch: AgentConfigFieldPatch,
): AgentConfigInlineContentUpdate {
  return {
    type: "agentConfig",
    props: {
      ...normalizeAgentConfigProps(current),
      ...patch,
      unknownAttributes: "",
      rawAttributes: "",
    },
  };
}

export function buildAgentConfigSelectionPatch(
  selection: AgentIntelligenceSelection,
): AgentConfigFieldPatch {
  return {
    provider: CODEX_PROVIDER_ID,
    model: selection.model,
    reasoning: selection.reasoningEffort,
    speed: selection.serviceTier === null ? "standard" : selection.serviceTier,
  };
}

export function buildAgentConfigResetUpdate(): AgentConfigInlineContentUpdate {
  return {
    type: "agentConfig",
    props: {
      mode: "",
      provider: "",
      model: "",
      reasoning: "",
      speed: "",
      permission: "",
      unknownAttributes: "",
      rawAttributes: "",
    },
  };
}

function AgentConfigControlRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-2 px-2 py-1.5">
      <div className="truncate text-xs text-token-description-foreground">{label}</div>
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
      className="grid grid-cols-3 gap-px rounded-md bg-token-foreground/[0.055] p-px"
      role="group"
      aria-label="Agent config mode"
    >
      {MODE_OPTIONS.map((option) => (
        <button
          key={option.value || "inherit"}
          type="button"
          aria-pressed={value === option.value}
          className={cn(
            "h-6 rounded-[5px] px-2 text-xs text-token-description-foreground outline-hidden transition-colors",
            "hover:bg-token-bg/70 hover:text-token-foreground focus-visible:ring-token-focus focus-visible:ring-2",
            value === option.value &&
              "bg-token-bg text-token-foreground shadow-[0_1px_2px_color-mix(in_srgb,var(--foreground)_8%,transparent)]",
          )}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function UnavailableSettingsTrigger({ label }: { label: string }) {
  return (
    <NodexSettingsDropdownTrigger
      disabled
      aria-label={label}
      className="w-full min-w-0 justify-between"
    >
      <span className="truncate">Unavailable</span>
    </NodexSettingsDropdownTrigger>
  );
}

function AgentConfigPopoverBody({
  props,
  chip,
  runtime,
  models,
  defaultSelection,
  loading,
  onPatch,
  onReset,
}: {
  props: AgentConfigProps;
  chip: ReturnType<typeof resolveAgentConfigChip>;
  runtime: AgentConfigRuntimeValue | null;
  models: readonly CodexModelOption[];
  defaultSelection: AgentIntelligenceSelection | null;
  loading: boolean;
  onPatch: (patch: AgentConfigFieldPatch) => void;
  onReset: () => void;
}) {
  const intelligence = resolveAgentConfigIntelligenceSelection({
    props,
    models,
    defaultSelection,
  });
  const permissionMode = props.permission ? parsePermissionMode(props.permission) : null;
  const invalidReason = chip.invalid
    ? "Unsupported Agent config attributes or values."
    : hasExplicitIntelligence(props) && intelligence.kind === "unavailable"
      ? intelligence.reason
      : null;
  const fullAccessEnabled =
    runtime?.projectId !== null &&
    runtime?.permissionState.mode === "full-access" &&
    runtime.permissionState.effectivePreset === "full-access";

  return (
    <div className="w-[min(21.5rem,calc(100vw-2rem))] p-1 text-sm">
      <div className="flex items-start gap-2 px-2 pt-1.5 pb-2">
        <div className="mt-px flex size-6 shrink-0 items-center justify-center rounded-md border border-token-border/70 text-token-description-foreground">
          <NodexLogoMarkIcon className="icon-2xs" monochrome />
        </div>
        <div className="min-w-0 flex-1">
          <NodexPopoverTitle className="truncate text-sm font-medium text-token-foreground">
            Agent config
          </NodexPopoverTitle>
          <div className="mt-0.5 text-xs leading-4 text-token-description-foreground">
            {invalidReason ?? "Applies only to this prompt send."}
          </div>
        </div>
        {hasExplicitAgentConfig(props) ? (
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onReset();
            }}
          >
            <ResetIcon className="icon-xxs shrink-0" />
            <span>Reset</span>
          </button>
        ) : null}
      </div>

      <NodexDropdownSeparator paddingClassName="py-0" />

      <div className="divide-y divide-token-border/55">
        <AgentConfigControlRow label="Mode">
          <ModeSegmentedControl
            value={isKnownAgentConfigMode(props.mode) ? props.mode : ""}
            onValueChange={(mode) => onPatch({ mode })}
          />
        </AgentConfigControlRow>

        <AgentConfigControlRow label="Model">
          {intelligence.kind === "ready" ? (
            <AgentIntelligenceDropdown
              models={models}
              selection={intelligence.selection}
              inheritance={intelligence.inheritance}
              allowInherit
              triggerStyle="settings"
              onSelectionChange={(selection) => onPatch(buildAgentConfigSelectionPatch(selection))}
              onInherit={() => onPatch({ provider: "", model: "", reasoning: "", speed: "" })}
            />
          ) : (
            <UnavailableSettingsTrigger
              label={loading ? "Codex model catalog loading" : "Agent intelligence"}
            />
          )}
        </AgentConfigControlRow>

        <AgentConfigControlRow label="Permission">
          {runtime ? (
            <PermissionModeDropdown
              selectedMode={permissionMode}
              availableModes={runtime.permissionState.availableModes}
              autoReviewAvailable={runtime.permissionState.autoReviewAvailable}
              triggerStyle="settings"
              triggerClassName="w-full min-w-0"
              allowInherit
              confirmFullAccess={false}
              fullAccessDisabledReason={
                fullAccessEnabled
                  ? undefined
                  : "Enable Full access in Composer or Permissions before using it here"
              }
              onInherit={() => onPatch({ permission: "" })}
              onSelect={(permission) => onPatch({ permission })}
            />
          ) : (
            <UnavailableSettingsTrigger label="Permission mode" />
          )}
        </AgentConfigControlRow>
      </div>
    </div>
  );
}

export function AgentConfigInlineContentView({
  inlineContent,
  updateInlineContent,
  runtime: runtimeOverride,
  availableModels,
  defaultOpen = false,
}: {
  inlineContent: { props: Partial<AgentConfigProps> };
  updateInlineContent: (update: AgentConfigInlineContentUpdate) => void;
  runtime?: AgentConfigRuntimeValue | null;
  availableModels?: readonly CodexModelOption[];
  defaultOpen?: boolean;
}) {
  const runtimeContext = useAgentConfigRuntime();
  const runtime = runtimeOverride === undefined ? runtimeContext : runtimeOverride;
  const models = availableModels ?? runtime?.availableModels ?? [];
  const defaultSelection =
    runtime?.defaultIntelligence ?? resolveDefaultAgentConfigIntelligence(models);
  const [open, setOpen] = useState(defaultOpen);
  const props = normalizeAgentConfigProps(inlineContent.props);
  const chip = resolveAgentConfigChip(props, models);
  const title = chip.invalid
    ? "This Agent config has invalid attributes or values."
    : [chip.label, chip.detail].filter(Boolean).join(" · ");

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
                inlineTintedChipVariants({ tone: "neutral", interactive: true }),
                "blend max-w-[22rem] border border-token-border/55 bg-token-foreground/[0.035] shadow-none outline-hidden focus-visible:ring-token-focus focus-visible:ring-2",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpen((current) => !current);
              }}
            >
              <NodexLogoMarkIcon
                className={cn(
                  inlineTintedChipIconClassName,
                  "shrink-0 text-token-description-foreground",
                )}
                monochrome
              />
              <span
                className={cn(
                  inlineTintedChipLabelClassName,
                  "blend truncate font-medium text-token-foreground",
                )}
              >
                Agent config
              </span>
              {chip.summary ? (
                <>
                  <span aria-hidden className="mx-1 text-token-description-foreground/35">
                    ·
                  </span>
                  <span
                    className={cn(
                      inlineTintedChipLabelClassName,
                      "blend max-w-[10rem] truncate text-token-description-foreground",
                    )}
                  >
                    {chip.summary}
                  </span>
                </>
              ) : null}
            </button>
          </NodexPopoverTrigger>
        </NodexTooltip>
      </span>

      <NodexPopoverContent side="top" align="start" className="w-auto" initialFocus={false}>
        <AgentConfigPopoverBody
          props={props}
          chip={chip}
          runtime={runtime}
          models={models}
          defaultSelection={defaultSelection}
          loading={runtime?.availableModelsLoading ?? false}
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
  return (
    <AgentConfigInlineContentView
      inlineContent={inlineContent}
      updateInlineContent={updateInlineContent}
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
          <NodexLogoMarkIcon className="icon-xxs shrink-0" monochrome />
          <span>Agent config</span>
          {chip.summary ? <span className="opacity-60">({chip.summary})</span> : null}
        </span>
      );
    },
  });
}
