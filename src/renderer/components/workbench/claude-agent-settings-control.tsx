import {
  defaultClaudeInstance,
  type ClaudeAgentInstanceConfig,
} from "../../../shared/claude-agent-settings";
import { CLAUDE_ENVIRONMENT_POLICY } from "../../lib/agent-environment-policies";
import { ClaudeCustomModelsEditor } from "./claude-custom-models-editor";
import { Input } from "../ui/input";
import { NodexSettingsRow } from "../ui/settings";
import {
  readClaudeAgentSettings,
  updateClaudeAgentSettings,
} from "./workbench-settings-overlay-deps";
import {
  AgentInstanceSettingsControl,
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
  displayName: "Claude profile",
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
  runtime = defaultRuntime,
}: {
  readonly open: boolean;
  readonly runtime?: ClaudeAgentSettingsRuntime;
}) {
  return (
    <AgentInstanceSettingsControl
      open={open}
      label="Claude Code"
      executablePlaceholder="claude"
      runtime={runtime}
      defaultInstance={defaultClaudeInstance}
      createInstance={createInstance}
      environmentPolicy={CLAUDE_ENVIRONMENT_POLICY}
      environmentSuggestions={environmentSuggestions}
      fields={({ draft, disabled, change }) => (
        <>
          <NodexSettingsRow label="Config directory">
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
