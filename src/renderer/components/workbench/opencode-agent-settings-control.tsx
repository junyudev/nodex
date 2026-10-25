import {
  defaultOpenCodeInstance,
  type OpenCodeAgentInstanceConfig,
} from "../../../shared/opencode-agent-settings";
import { OpenCodeExecutableStatus } from "../../features/opencode-setup/opencode-executable-status";
import { usesHostOpenCodeExecutable } from "../../features/opencode-setup/opencode-setup-model";
import type { OpenCodeSetupOwner } from "../../features/opencode-setup/opencode-setup-owner";
import { openCodeSetupOwner } from "../../features/opencode-setup/use-opencode-setup";
import { OPENCODE_ENVIRONMENT_POLICY } from "../../lib/agent-environment-policies";
import {
  readOpenCodeAgentSettings,
  updateOpenCodeAgentSettings,
} from "../../lib/opencode-agent-settings-runtime";
import { OpenCodeIcon } from "../shared/icons";
import { Input } from "../ui/input";
import { NodexSettingsRow, type NodexSettingsDisclosureState } from "../ui/settings";
import {
  AgentInstanceSettingsControl,
  environmentVariableCount,
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
  disclosure,
  runtime = defaultRuntime,
  setup = openCodeSetupOwner,
}: {
  readonly open: boolean;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly runtime?: OpenCodeAgentSettingsRuntime;
  readonly setup?: OpenCodeSetupOwner;
}) {
  return (
    <AgentInstanceSettingsControl
      open={open}
      id="opencode"
      label="OpenCode"
      icon={<OpenCodeIcon />}
      description="Open-source coding agent for many model providers. Use a profile for each setup."
      setupDescription="A profile chooses the opencode command, data folder, server and provider keys Nodex starts OpenCode with."
      disclosure={disclosure}
      executablePlaceholder="opencode"
      executableDescription="The opencode command, or its full path."
      runtime={runtime}
      createInstance={createInstance}
      environmentPolicy={OPENCODE_ENVIRONMENT_POLICY}
      environmentSuggestions={environmentSuggestions}
      // Host status describes a saved local default that the unsaved draft still keeps; custom
      // paths, servers and an explicit PATH own their resolution.
      executableStatus={({ saved, draft, environment }) =>
        saved &&
        usesHostOpenCodeExecutable(saved) &&
        usesHostOpenCodeExecutable({ ...draft, environment }) ? (
          <OpenCodeExecutableStatus owner={setup} open={open} />
        ) : null
      }
      profileDetail={(instance) =>
        [
          instance.serverUrl ? `Server ${instance.serverUrl}` : instance.binaryPath || "opencode",
          instance.serverUrl ? null : (instance.profileDirectory ?? "managed data"),
          environmentVariableCount(instance.environment.length),
        ]
          .filter(Boolean)
          .join(" · ")
      }
      fields={({ draft, disabled, change }) => (
        <>
          <NodexSettingsRow
            variant="nested"
            label="Profile directory"
            description="OpenCode's settings and data for this profile. Empty lets Nodex manage it."
          >
            <Input
              aria-label="OpenCode profile directory"
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.profileDirectory ?? ""}
              disabled={disabled}
              placeholder="Managed by Nodex"
              spellCheck={false}
              onChange={(event) => change({ profileDirectory: event.target.value || null })}
            />
          </NodexSettingsRow>
          <NodexSettingsRow
            variant="nested"
            label="Server URL"
            description="Connect to an OpenCode server that's already running. Empty starts one locally."
          >
            <Input
              aria-label="OpenCode server URL"
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.serverUrl ?? ""}
              disabled={disabled}
              placeholder="Start locally"
              spellCheck={false}
              onChange={(event) => change({ serverUrl: event.target.value || null })}
            />
          </NodexSettingsRow>
        </>
      )}
    />
  );
}
