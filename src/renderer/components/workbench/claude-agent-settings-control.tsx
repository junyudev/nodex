import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import {
  defaultClaudeInstance,
  type ClaudeAgentInstanceConfig,
} from "../../../shared/claude-agent-settings";
import { CLAUDE_ENVIRONMENT_POLICY } from "../../lib/agent-environment-policies";
import { ClaudeIcon } from "../shared/icons";
import { ClaudeCustomModelsEditor } from "./claude-custom-models-editor";
import { Input } from "../ui/input";
import { NodexSettingsRow, type NodexSettingsDisclosureState } from "../ui/settings";
import {
  readClaudeAgentSettings,
  updateClaudeAgentSettings,
} from "./workbench-settings-overlay-deps";
import {
  AgentInstanceSettingsControl,
  environmentVariableCount,
  type AgentInstanceSettingsRuntime,
} from "./agent-instance-settings-control";

export type ClaudeAgentSettingsRuntime = AgentInstanceSettingsRuntime<ClaudeAgentInstanceConfig>;
const defaultRuntime: ClaudeAgentSettingsRuntime = {
  read: readClaudeAgentSettings,
  update: updateClaudeAgentSettings,
};
const createInstance = (): ClaudeAgentInstanceConfig => ({
  ...defaultClaudeInstance(),
  id: crypto.randomUUID(),
});
const environmentSuggestions = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

export function ClaudeAgentSettingsControl({
  open,
  disclosure,
  runtime = defaultRuntime,
}: {
  readonly open: boolean;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly runtime?: ClaudeAgentSettingsRuntime;
}) {
  const intl = useIntl();
  return (
    <AgentInstanceSettingsControl
      open={open}
      id="claude"
      label="Claude Code"
      icon={<ClaudeIcon />}
      description={intl.formatMessage({
        id: "settings.claude.anthropicsCodingAgentUseAProfile",
        defaultMessage: "Anthropic's coding agent. Use a profile for each Claude setup or account.",
      })}
      setupDescription={intl.formatMessage({
        id: "settings.claude.aProfileChoosesTheClaudeCommand",
        defaultMessage:
          "A profile chooses the claude command, config folder and environment Nodex starts Claude Code with.",
      })}
      disclosure={disclosure}
      executablePlaceholder="claude"
      executableDescription={intl.formatMessage({
        id: "settings.claude.theClaudeCommandOrItsFull",
        defaultMessage: "The claude command, or its full path.",
      })}
      runtime={runtime}
      createInstance={createInstance}
      environment={{ policy: CLAUDE_ENVIRONMENT_POLICY, suggestions: environmentSuggestions }}
      profileDetail={(instance) =>
        [
          instance.binaryPath || "claude",
          instance.configDirectory || "default config",
          environmentVariableCount(instance.environment.length, intl),
        ]
          .filter(Boolean)
          .join(" · ")
      }
      fields={({ draft, disabled, change }) => (
        <>
          <NodexSettingsRow
            variant="nested"
            label={intl.formatMessage(settingsMessages.claudeConfigDirectory)}
            description={intl.formatMessage({
              id: "settings.claude.whereThisProfileKeepsItsSign",
              defaultMessage:
                "Where this profile keeps its sign-in and settings. Empty uses ~/.claude.",
            })}
          >
            <Input
              aria-label={intl.formatMessage({
                id: "settings.claude.claudeCodeConfigDirectory",
                defaultMessage: "Claude Code config directory",
              })}
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.configDirectory}
              disabled={disabled}
              placeholder={intl.formatMessage({
                id: "settings.claude.default",
                defaultMessage: "Default",
              })}
              spellCheck={false}
              onChange={(event) => change({ configDirectory: event.target.value })}
            />
          </NodexSettingsRow>
          <ClaudeCustomModelsEditor
            models={draft.customModels}
            disabled={disabled}
            onChange={(customModels) => change({ customModels })}
          />
        </>
      )}
    />
  );
}
