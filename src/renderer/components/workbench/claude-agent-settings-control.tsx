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
  return (
    <AgentInstanceSettingsControl
      open={open}
      id="claude"
      label="Claude Code"
      icon={<ClaudeIcon />}
      description="Anthropic's coding agent. Use a profile for each Claude setup or account."
      setupDescription="A profile chooses the claude command, config folder and environment Nodex starts Claude Code with."
      disclosure={disclosure}
      executablePlaceholder="claude"
      executableDescription="The claude command, or its full path."
      runtime={runtime}
      createInstance={createInstance}
      environmentPolicy={CLAUDE_ENVIRONMENT_POLICY}
      environmentSuggestions={environmentSuggestions}
      profileDetail={(instance) =>
        [
          instance.binaryPath || "claude",
          instance.configDirectory || "default config",
          environmentVariableCount(instance.environment.length),
        ]
          .filter(Boolean)
          .join(" · ")
      }
      fields={({ draft, disabled, change }) => (
        <>
          <NodexSettingsRow
            variant="nested"
            label="Config directory"
            description="Where this profile keeps its sign-in and settings. Empty uses ~/.claude."
          >
            <Input
              aria-label="Claude Code config directory"
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.configDirectory}
              disabled={disabled}
              placeholder="Default"
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
