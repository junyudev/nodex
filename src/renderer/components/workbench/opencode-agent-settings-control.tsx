import {
  defaultOpenCodeInstance,
  type OpenCodeAgentInstanceConfig,
} from "../../../shared/opencode-agent-settings";
import { OPENCODE_ENVIRONMENT_POLICY } from "../../lib/agent-environment-policies";
import {
  readOpenCodeAgentSettings,
  updateOpenCodeAgentSettings,
} from "../../lib/opencode-agent-settings-runtime";
import { Input } from "../ui/input";
import { NodexSettingsRow } from "../ui/settings";
import {
  AgentInstanceSettingsControl,
  type AgentInstanceSettingsRuntime,
} from "./agent-instance-settings-control";

export type OpenCodeAgentSettingsRuntime =
  AgentInstanceSettingsRuntime<OpenCodeAgentInstanceConfig>;
const defaultRuntime: OpenCodeAgentSettingsRuntime = {
  read: readOpenCodeAgentSettings,
  update: updateOpenCodeAgentSettings,
};
const createInstance = (): OpenCodeAgentInstanceConfig => ({
  ...defaultOpenCodeInstance(),
  id: crypto.randomUUID(),
  displayName: "OpenCode profile",
  enabled: true,
});
const environmentSuggestions = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MOONSHOT_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
];

export function OpenCodeAgentSettingsControl({
  open,
  runtime = defaultRuntime,
}: {
  readonly open: boolean;
  readonly runtime?: OpenCodeAgentSettingsRuntime;
}) {
  return (
    <AgentInstanceSettingsControl
      open={open}
      label="OpenCode"
      executablePlaceholder="opencode"
      runtime={runtime}
      defaultInstance={defaultOpenCodeInstance}
      createInstance={createInstance}
      environmentPolicy={OPENCODE_ENVIRONMENT_POLICY}
      environmentSuggestions={environmentSuggestions}
      fields={({ draft, disabled, change }) => (
        <>
          <NodexSettingsRow label="Profile directory">
            <Input
              aria-label="OpenCode profile directory"
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.profileDirectory ?? ""}
              disabled={disabled}
              placeholder="Managed profile"
              spellCheck={false}
              onChange={(event) => change({ profileDirectory: event.target.value || null })}
            />
          </NodexSettingsRow>
          <NodexSettingsRow label="Server URL">
            <Input
              aria-label="OpenCode server URL"
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.serverUrl ?? ""}
              disabled={disabled}
              placeholder="Local server"
              spellCheck={false}
              onChange={(event) => change({ serverUrl: event.target.value || null })}
            />
          </NodexSettingsRow>
        </>
      )}
    />
  );
}
