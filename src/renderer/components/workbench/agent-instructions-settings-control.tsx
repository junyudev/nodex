import { defineMessage, getIntl, useIntl, type MessageDescriptor } from "@/lib/i18n";
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
import { NodexSegmentedControl } from "@/components/ui/segmented-control";
import {
  NodexSettingsRevealRow,
  NodexSettingsRow,
  NodexSettingsStackedRow,
  NodexSettingsTextField,
} from "@/components/ui/settings";
import {
  agentRuntimeSettingsQueryOptions,
  updateAgentRuntimeSettings,
} from "@/lib/agent-runtime-settings";
import { toastFailure } from "@/lib/failure-toast";
import { settingsMessages } from "./workbench-settings-search-catalog";

const ARTIFACT_OPENING_OPTIONS: readonly {
  readonly value: ArtifactOpeningPolicy;
  readonly label: MessageDescriptor;
  readonly description: MessageDescriptor;
}[] = [
  {
    value: "when-helpful",
    label: defineMessage({
      id: "settings.agentInstructions.whenHelpful",
      defaultMessage: "When helpful",
    }),
    description: defineMessage({
      id: "settings.agentInstructions.agentsOpenAResultBesideThe",
      defaultMessage: "Agents open a result beside the chat when that helps you see it.",
    }),
  },
  {
    value: "ask-first",
    label: defineMessage({
      id: "settings.agentInstructions.askFirst",
      defaultMessage: "Ask first",
    }),
    description: defineMessage({
      id: "settings.agentInstructions.agentsAskBeforeOpeningAnythingBeside",
      defaultMessage: "Agents ask before opening anything beside the chat.",
    }),
  },
  {
    value: "never",
    label: defineMessage({ id: "settings.agentInstructions.never", defaultMessage: "Never" }),
    description: defineMessage({
      id: "settings.agentInstructions.agentsOnlyTellYouWhereAn",
      defaultMessage: "Agents only say where a result is.",
    }),
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
    onError: (cause) =>
      toastFailure(
        getIntl().formatMessage({
          id: "settings.agentInstructions.couldntSaveYourAgentInstructions",
          defaultMessage: "Couldn’t save your Agent instructions",
        }),
        cause,
      ),
  });
  return {
    value,
    pending: settings.isPending || save.isPending,
    save: save.mutate,
    saveAsync: save.mutateAsync,
  };
}

export function ArtifactOpeningSettingRow() {
  const intl = useIntl();
  const { value, pending, save } = useAgentInstructions();
  const selected = ARTIFACT_OPENING_OPTIONS.find(
    (option) => option.value === value.artifactOpening,
  );
  return (
    <NodexSettingsRow
      label={intl.formatMessage(settingsMessages.chatsOpenResultsBesideTheChat)}
      description={intl.formatMessage(settingsMessages.chatsOpenResultsBesideTheChatDescription)}
    >
      <NodexOptionPicker
        triggerButton={
          <NodexSettingsDropdownTrigger
            aria-label={intl.formatMessage(settingsMessages.chatsOpenResultsBesideTheChat)}
            disabled={pending}
            className="min-w-40 justify-between"
          >
            {selected ? intl.formatMessage(selected.label) : null}
          </NodexSettingsDropdownTrigger>
        }
        value={value.artifactOpening}
        options={ARTIFACT_OPENING_OPTIONS.map((option) => ({
          value: option.value,
          label: intl.formatMessage(option.label),
          subText: intl.formatMessage(option.description),
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

/** The standing text, always open for editing and saved when the field loses focus. */
export function StandingInstructionsRow() {
  const intl = useIntl();
  const { value, pending, saveAsync } = useAgentInstructions();
  const label = intl.formatMessage(settingsMessages.chatsYourInstructions);
  return (
    <NodexSettingsStackedRow
      label={label}
      description={intl.formatMessage({
        id: "settings.agentInstructions.sentWithEveryTurnInEvery",
        defaultMessage:
          "Sent with every turn in every chat. Agents follow these over Nodex’s own guidance where they conflict. Changes apply from the next turn.",
      })}
    >
      <NodexSettingsTextField
        aria-label={label}
        maxLength={AGENT_STANDING_INSTRUCTIONS_MAX_LENGTH}
        disabled={pending}
        value={value.standingInstructions}
        placeholder={intl.formatMessage({
          id: "settings.agentInstructions.forExampleKeepAnswersShortWrite",
          defaultMessage:
            "For example: Keep answers short. Write tests before changing shared code.",
        })}
        onCommit={(standingInstructions) => saveAsync({ standingInstructions })}
      />
    </NodexSettingsStackedRow>
  );
}

type InstructionLayer = "nodex" | "yours" | "codex";

/** Everything the Nodex layer sends, as the Agent reads it, one layer at a time. */
export function EffectiveInstructionsRow() {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  return (
    <NodexSettingsRevealRow
      label={intl.formatMessage(settingsMessages.chatsWhatAgentsReceive)}
      description={intl.formatMessage(settingsMessages.chatsWhatAgentsReceiveDescription)}
      open={open}
      onOpenChange={setOpen}
    >
      <InstructionLayers />
    </NodexSettingsRevealRow>
  );
}

function InstructionLayers() {
  const intl = useIntl();
  const { value } = useAgentInstructions();
  const [layer, setLayer] = useState<InstructionLayer>("nodex");
  const layers: Record<
    InstructionLayer,
    { readonly label: string; readonly text: string; readonly note?: string }
  > = {
    nodex: {
      label: intl.formatMessage({
        id: "settings.agentInstructions.nodexGuidance",
        defaultMessage: "Nodex guidance",
      }),
      text: ORCHESTRATION_INSTRUCTIONS.trim(),
      note: intl.formatMessage({
        id: "settings.agentInstructions.attachedToChatsThatHaveNodex",
        defaultMessage: "Attached to chats that have Nodex tools.",
      }),
    },
    yours: {
      label: intl.formatMessage(settingsMessages.chatsYourInstructions),
      text: renderPersonalInstructions(value),
    },
    codex: {
      label: intl.formatMessage({
        id: "settings.agentInstructions.codexDesktopApp",
        defaultMessage: "Codex desktop app",
      }),
      text: buildCodexDesktopDeveloperInstructions(REPRESENTATIVE_CODEX_THREAD),
      note: intl.formatMessage({
        id: "settings.agentInstructions.shownForARepresentativeCodexApp",
        defaultMessage:
          "Shown for a representative Codex app thread with its tools on and default Git settings. Each thread’s text varies with its tools and workspace.",
      }),
    },
  };
  const shown = layers[layer];
  return (
    <div className="flex flex-col gap-2.5 px-4 pb-4">
      <NodexSegmentedControl<InstructionLayer>
        ariaLabel={intl.formatMessage(settingsMessages.chatsWhatAgentsReceive)}
        value={layer}
        onChange={setLayer}
        options={(Object.keys(layers) as InstructionLayer[]).map((id) => ({
          value: id,
          label: layers[id].label,
        }))}
      />
      <pre className={instructionBlockClass}>{shown.text}</pre>
      <p className="text-xs leading-4 text-token-description-foreground">
        {[
          shown.note,
          intl.formatMessage({
            id: "settings.agentInstructions.eachChatAlsoReceivesItsRuntime",
            defaultMessage:
              "Each chat also receives its runtime details, the Nodex CLI and its work role, if Nodex handed it work, when it starts.",
          }),
        ]
          .filter(Boolean)
          .join(" ")}
      </p>
    </div>
  );
}
