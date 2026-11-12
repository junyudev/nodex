import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ORCHESTRATION_INSTRUCTIONS,
  renderPersonalInstructions,
} from "@nodex/agent-runtime/instructions";
import {
  AGENT_STANDING_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_AGENT_INSTRUCTIONS_SETTINGS,
  type AgentInstructionsSettings,
  type ArtifactOpeningPolicy,
} from "../../../shared/agent-instructions-settings";
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from "../../../shared/agent-runtime-settings";
import { buildCodexDesktopDeveloperInstructions } from "../../../shared/codex-developer-instructions";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { NodexSettingsExpandableRow, NodexSettingsRow } from "@/components/ui/settings";
import {
  agentRuntimeSettingsQueryOptions,
  updateAgentRuntimeSettings,
} from "@/lib/agent-runtime-settings";
import { toastFailure } from "@/lib/failure-toast";
import { cn } from "@/lib/utils";

const ARTIFACT_OPENING_OPTIONS: readonly {
  readonly value: ArtifactOpeningPolicy;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: "when-helpful",
    label: "When helpful",
    description: "Agents open a result beside the chat when that helps you see it.",
  },
  {
    value: "ask-first",
    label: "Ask first",
    description: "Agents ask before opening anything beside the chat.",
  },
  {
    value: "never",
    label: "Never",
    description: "Agents only tell you where an artifact is.",
  },
];

/** Reads and saves the Profile's Agent instructions; every save replaces the whole group. */
function useAgentInstructions() {
  const client = useQueryClient();
  const settings = useQuery(agentRuntimeSettingsQueryOptions());
  const value = settings.data?.instructions ?? DEFAULT_AGENT_INSTRUCTIONS_SETTINGS;
  const save = useMutation({
    mutationFn: (patch: Partial<AgentInstructionsSettings>) =>
      updateAgentRuntimeSettings(client, {
        ...(settings.data ?? DEFAULT_AGENT_RUNTIME_SETTINGS),
        instructions: { ...value, ...patch },
      }),
    onError: (cause) => toastFailure("Couldn’t save your Agent instructions", cause),
  });
  return { value, pending: settings.isPending || save.isPending, save: save.mutate };
}

export function ArtifactOpeningSettingRow() {
  const { value, pending, save } = useAgentInstructions();
  const selected = ARTIFACT_OPENING_OPTIONS.find(
    (option) => option.value === value.artifactOpening,
  );
  return (
    <NodexSettingsRow
      label="Artifact opening"
      description="Whether Agents open artifacts beside the chat with open_in_nodex."
    >
      <NodexOptionPicker
        triggerButton={
          <NodexSettingsDropdownTrigger
            aria-label="Artifact opening"
            disabled={pending}
            className="min-w-40 justify-between"
          >
            {selected?.label}
          </NodexSettingsDropdownTrigger>
        }
        value={value.artifactOpening}
        options={ARTIFACT_OPENING_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
          subText: option.description,
        }))}
        onValueChange={(artifactOpening) => {
          if (artifactOpening !== value.artifactOpening)
            save({ artifactOpening: artifactOpening as ArtifactOpeningPolicy });
        }}
      />
    </NodexSettingsRow>
  );
}

/**
 * A representative Codex desktop thread with every app tool on and default Git settings. Each
 * thread's text varies with its own tools and workspace, so this is a view, not a fixed payload.
 */
const REPRESENTATIVE_CODEX_THREAD = {
  threadToolsEnabled: true,
  sidebarSectionToolsEnabled: true,
  workspaceDependenciesEnabled: true,
  heartbeatEnabled: true,
  includeProseDetailLevelInstructions: false,
  isNonGitWorkspace: false,
} as const;

const instructionBlockClass =
  "max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border-[0.5px] border-token-border bg-token-input-background px-3 py-2.5 font-mono text-xs leading-relaxed text-token-text-secondary";

/** The standing text, opened for editing and saved when the field loses focus. */
export function StandingInstructionsRow() {
  const { value, pending, save } = useAgentInstructions();
  const [expanded, setExpanded] = useState(false);
  // Null means no edit is pending, so the field always shows what is saved.
  const [draft, setDraft] = useState<string | null>(null);
  const firstLine = value.standingInstructions.trim().split("\n")[0] ?? "";
  return (
    <NodexSettingsExpandableRow
      label="Your instructions"
      detail={firstLine === "" ? "None yet" : firstLine}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <div className="flex flex-col gap-2 px-4 pt-1 pb-4">
        <textarea
          aria-label="Your instructions"
          rows={8}
          maxLength={AGENT_STANDING_INSTRUCTIONS_MAX_LENGTH}
          disabled={pending}
          value={draft ?? value.standingInstructions}
          placeholder="For example: Keep answers short. Write tests before changing shared code."
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft === null || draft === value.standingInstructions) return setDraft(null);
            save({ standingInstructions: draft }, { onSettled: () => setDraft(null) });
          }}
          className={cn(
            "w-full resize-y rounded-lg border-[0.5px] border-token-border bg-token-input-background px-3 py-2.5",
            "text-sm text-token-text-primary outline-hidden placeholder:text-token-text-secondary/60",
            "focus-visible:ring-2 focus-visible:ring-token-focus-border",
          )}
        />
        <p className="text-xs text-token-description-foreground">
          Sent with every turn in every chat. Agents follow these over Nodex’s own guidance where
          they conflict. Changes apply from the next turn.
        </p>
      </div>
    </NodexSettingsExpandableRow>
  );
}

/** Everything the Nodex layer sends, as the Agent reads it. */
export function EffectiveInstructionsRow() {
  const { value } = useAgentInstructions();
  const [expanded, setExpanded] = useState(false);
  return (
    <NodexSettingsExpandableRow
      label="Full Nodex instructions"
      detail="What Agents read from Nodex in every turn"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-token-text-primary">Nodex guidance</h3>
          <pre className={instructionBlockClass}>{ORCHESTRATION_INSTRUCTIONS.trim()}</pre>
          <p className="text-xs text-token-description-foreground">
            Attached to chats that have Nodex tools.
          </p>
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-token-text-primary">Your instructions</h3>
          <pre className={instructionBlockClass}>{renderPersonalInstructions(value)}</pre>
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-token-text-primary">Codex desktop app</h3>
          <pre className={instructionBlockClass}>
            {buildCodexDesktopDeveloperInstructions(REPRESENTATIVE_CODEX_THREAD)}
          </pre>
          <p className="text-xs text-token-description-foreground">
            Shown for a representative Codex app thread with its tools on and default Git settings.
            Each thread’s text varies with its tools and workspace.
          </p>
        </section>
        <p className="text-xs text-token-description-foreground">
          Each chat also receives its runtime details, the Nodex CLI and any coordinator or managed
          session role when it starts.
        </p>
      </div>
    </NodexSettingsExpandableRow>
  );
}
