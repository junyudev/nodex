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
import { NodexSettingsExpandableRow, NodexSettingsRow } from "@/components/ui/settings";
import {
  agentRuntimeSettingsQueryOptions,
  updateAgentRuntimeSettings,
} from "@/lib/agent-runtime-settings";
import { toastFailure } from "@/lib/failure-toast";
import { cn } from "@/lib/utils";
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
  return { value, pending: settings.isPending || save.isPending, save: save.mutate };
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

/** The standing text, opened for editing and saved when the field loses focus. */
export function StandingInstructionsRow() {
  const intl = useIntl();
  const { value, pending, save } = useAgentInstructions();
  const [expanded, setExpanded] = useState(false);
  // Null means no edit is pending, so the field always shows what is saved.
  const [draft, setDraft] = useState<string | null>(null);
  const firstLine = value.standingInstructions.trim().split("\n")[0] ?? "";
  return (
    <NodexSettingsExpandableRow
      label={intl.formatMessage({
        id: "settings.agentInstructions.yourInstructions",
        defaultMessage: "Your instructions",
      })}
      detail={
        firstLine === ""
          ? intl.formatMessage({
              id: "settings.agentInstructions.noneYet",
              defaultMessage: "None yet",
            })
          : firstLine
      }
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <div className="flex flex-col gap-2 px-4 pt-1 pb-4">
        <textarea
          aria-label={intl.formatMessage({
            id: "settings.agentInstructions.yourInstructions",
            defaultMessage: "Your instructions",
          })}
          rows={8}
          maxLength={AGENT_STANDING_INSTRUCTIONS_MAX_LENGTH}
          disabled={pending}
          value={draft ?? value.standingInstructions}
          placeholder={intl.formatMessage({
            id: "settings.agentInstructions.forExampleKeepAnswersShortWrite",
            defaultMessage:
              "For example: Keep answers short. Write tests before changing shared code.",
          })}
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
          {intl.formatMessage({
            id: "settings.agentInstructions.sentWithEveryTurnInEvery",
            defaultMessage:
              "Sent with every turn in every chat. Agents follow these over Nodex’s own guidance where they conflict. Changes apply from the next turn.",
          })}
        </p>
      </div>
    </NodexSettingsExpandableRow>
  );
}

/** Everything the Nodex layer sends, as the Agent reads it. */
export function EffectiveInstructionsRow() {
  const intl = useIntl();
  const { value } = useAgentInstructions();
  const [expanded, setExpanded] = useState(false);
  return (
    <NodexSettingsExpandableRow
      label={intl.formatMessage(settingsMessages.chatsWhatAgentsReceive)}
      detail={intl.formatMessage(settingsMessages.chatsWhatAgentsReceiveDescription)}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-token-text-primary">
            {intl.formatMessage({
              id: "settings.agentInstructions.nodexGuidance",
              defaultMessage: "Nodex guidance",
            })}
          </h3>
          <pre className={instructionBlockClass}>{ORCHESTRATION_INSTRUCTIONS.trim()}</pre>
          <p className="text-xs text-token-description-foreground">
            {intl.formatMessage({
              id: "settings.agentInstructions.attachedToChatsThatHaveNodex",
              defaultMessage: "Attached to chats that have Nodex tools.",
            })}
          </p>
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-token-text-primary">
            {intl.formatMessage({
              id: "settings.agentInstructions.yourInstructions",
              defaultMessage: "Your instructions",
            })}
          </h3>
          <pre className={instructionBlockClass}>{renderPersonalInstructions(value)}</pre>
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-token-text-primary">
            {intl.formatMessage({
              id: "settings.agentInstructions.codexDesktopApp",
              defaultMessage: "Codex desktop app",
            })}
          </h3>
          <pre className={instructionBlockClass}>
            {buildCodexDesktopDeveloperInstructions(REPRESENTATIVE_CODEX_THREAD)}
          </pre>
          <p className="text-xs text-token-description-foreground">
            {intl.formatMessage({
              id: "settings.agentInstructions.shownForARepresentativeCodexApp",
              defaultMessage:
                "Shown for a representative Codex app thread with its tools on and default Git settings. Each thread’s text varies with its tools and workspace.",
            })}
          </p>
        </section>
        <p className="text-xs text-token-description-foreground">
          {intl.formatMessage({
            id: "settings.agentInstructions.eachChatAlsoReceivesItsRuntime",
            defaultMessage:
              "Each chat also receives its runtime details, the Nodex CLI and any coordinator or managed session role when it starts.",
          })}
        </p>
      </div>
    </NodexSettingsExpandableRow>
  );
}
