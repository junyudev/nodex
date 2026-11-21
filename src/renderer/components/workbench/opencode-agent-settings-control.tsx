import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
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
  const intl = useIntl();
  return (
    <AgentInstanceSettingsControl
      open={open}
      id="opencode"
      label="OpenCode"
      icon={<OpenCodeIcon />}
      description={intl.formatMessage({
        id: "settings.opencode.openSourceCodingAgentForMany",
        defaultMessage:
          "Open-source coding agent for many model providers. Use a profile for each setup.",
      })}
      setupDescription={intl.formatMessage({
        id: "settings.opencode.aProfileChoosesTheOpencodeCommand",
        defaultMessage:
          "A profile chooses the opencode command, data folder, server and provider keys Nodex starts OpenCode with.",
      })}
      disclosure={disclosure}
      executablePlaceholder="opencode"
      executableDescription={intl.formatMessage({
        id: "settings.opencode.theOpencodeCommandOrItsFull",
        defaultMessage: "The opencode command, or its full path.",
      })}
      runtime={runtime}
      createInstance={createInstance}
      environment={{ policy: OPENCODE_ENVIRONMENT_POLICY, suggestions: environmentSuggestions }}
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
          environmentVariableCount(instance.environment.length, intl),
        ]
          .filter(Boolean)
          .join(" · ")
      }
      fields={({ draft, disabled, change }) => (
        <>
          <NodexSettingsRow
            variant="nested"
            label={intl.formatMessage(settingsMessages.opencodeProfileDirectory)}
            description={intl.formatMessage({
              id: "settings.opencode.openCodesSettingsAndDataForThis",
              defaultMessage:
                "OpenCode's settings and data for this profile. Empty lets Nodex manage it.",
            })}
          >
            <Input
              aria-label={intl.formatMessage({
                id: "settings.opencode.openCodeProfileDirectory",
                defaultMessage: "OpenCode profile directory",
              })}
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.profileDirectory ?? ""}
              disabled={disabled}
              placeholder={intl.formatMessage({
                id: "settings.opencode.managedByNodex",
                defaultMessage: "Managed by Nodex",
              })}
              spellCheck={false}
              onChange={(event) => change({ profileDirectory: event.target.value || null })}
            />
          </NodexSettingsRow>
          <NodexSettingsRow
            variant="nested"
            label={intl.formatMessage(settingsMessages.opencodeServerURL)}
            description={intl.formatMessage({
              id: "settings.opencode.connectToAnOpenCodeServerThats",
              defaultMessage:
                "Connect to an OpenCode server that's already running. Empty starts one locally.",
            })}
          >
            <Input
              aria-label={intl.formatMessage({
                id: "settings.opencode.openCodeServerURL",
                defaultMessage: "OpenCode server URL",
              })}
              className="h-8 w-[min(28rem,45vw)] text-sm"
              value={draft.serverUrl ?? ""}
              disabled={disabled}
              placeholder={intl.formatMessage({
                id: "settings.opencode.startLocally",
                defaultMessage: "Start locally",
              })}
              spellCheck={false}
              onChange={(event) => change({ serverUrl: event.target.value || null })}
            />
          </NodexSettingsRow>
        </>
      )}
    />
  );
}
