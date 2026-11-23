import { defineMessage } from "../i18n/messages.ts";
import {
  AGENT_ENVIRONMENT_NAME_MESSAGES as environmentMessages,
  ENVIRONMENT_NAME_PATTERN,
  type FormatEnvironmentValidation,
} from "../agent-environment.ts";
import { profileEnvironmentDetail, type AgentProfileDefinition } from "./profile-definition.ts";
import type { AgentDefinition } from "./definition.ts";

export const OPENCODE_MANAGED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_TEST_HOME",
  "OPENCODE_AUTH_CONTENT",
]);
export const openCodeEnvironmentNameError = (
  name: string,
  formatMessage?: FormatEnvironmentValidation,
): string | null => {
  if (name.length > 128 || !ENVIRONMENT_NAME_PATTERN.test(name))
    return formatMessage
      ? formatMessage(environmentMessages.invalid)
      : environmentMessages.invalid.defaultMessage;
  if (OPENCODE_MANAGED_ENVIRONMENT_NAMES.has(name.toUpperCase()))
    return formatMessage
      ? formatMessage(environmentMessages.openCodeManaged, { name })
      : `${name} is managed by the OpenCode profile.`;
  return null;
};

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

const defaultCommand = "opencode";

const usesHostExecutable: NonNullable<AgentProfileDefinition["usesHostExecutable"]> = (profile) =>
  !profile.settings.serverUrl &&
  profile.binaryPath.trim() === defaultCommand &&
  !profile.environment?.some(({ name }) => name.trim() === "PATH");

export const openCodeAgent = {
  driver: "opencode",
  aliases: ["opencode2"],
  analyticsFamily: "opencode",
  label: "OpenCode",
  icon: "opencode",
  accent: "#e7b549",
  settingsAnchor: "opencode",
  profileBased: true,
  profile: {
    defaultName: "OpenCode",
    initialId: "opencode_c2rJrNSkj15MORZec1QoCBQISQyVH6s-6y_wSMvOUJw",
    description: defineMessage({
      id: "settings.opencode.openSourceCodingAgentForMany",
      defaultMessage:
        "Open-source coding agent for many model providers. Use a profile for each setup.",
    }),
    setupDescription: defineMessage({
      id: "settings.opencode.aProfileChoosesTheOpencodeCommand",
      defaultMessage:
        "A profile chooses the opencode command, data folder, server and provider keys Nodex starts OpenCode with.",
    }),
    executable: {
      defaultValue: defaultCommand,
      placeholder: defaultCommand,
      description: defineMessage({
        id: "settings.opencode.theOpencodeCommandOrItsFull",
        defaultMessage: "The opencode command, or its full path.",
      }),
    },
    fields: {
      profileDirectory: {
        control: "path",
        empty: "null",
        defaultValue: null,
        maxLength: 4096,
        label: defineMessage({
          id: "settings.opencode.profileDirectory",
          defaultMessage: "Profile directory",
        }),
        description: defineMessage({
          id: "settings.opencode.openCodesSettingsAndDataForThis",
          defaultMessage:
            "OpenCode's settings and data for this profile. Empty lets Nodex manage it.",
        }),
        accessibleLabel: defineMessage({
          id: "settings.opencode.openCodeProfileDirectory",
          defaultMessage: "OpenCode profile directory",
        }),
        placeholder: defineMessage({
          id: "settings.opencode.managedByNodex",
          defaultMessage: "Managed by Nodex",
        }),
      },
      serverUrl: {
        control: "text",
        format: "http-url",
        empty: "null",
        defaultValue: null,
        label: defineMessage({ id: "settings.opencode.serverURL", defaultMessage: "Server URL" }),
        description: defineMessage({
          id: "settings.opencode.connectToAnOpenCodeServerThats",
          defaultMessage:
            "Connect to an OpenCode server that's already running. Empty starts one locally.",
        }),
        accessibleLabel: defineMessage({
          id: "settings.opencode.openCodeServerURL",
          defaultMessage: "OpenCode server URL",
        }),
        placeholder: defineMessage({
          id: "settings.opencode.startLocally",
          defaultMessage: "Start locally",
        }),
      },
    },
    environment: { nameError: openCodeEnvironmentNameError, suggestions: environmentSuggestions },
    usesHostExecutable,
    detail: ({ binaryPath, settings, environment }, format) => [
      settings.serverUrl ? `Server ${settings.serverUrl}` : binaryPath || "opencode",
      settings.serverUrl
        ? null
        : typeof settings.profileDirectory === "string"
          ? settings.profileDirectory
          : "managed data",
      profileEnvironmentDetail(environment?.length ?? 0, format),
    ],
    search: [
      {
        label: defineMessage({ id: "settings.agents.profile", defaultMessage: "Profile" }),
        description: defineMessage({
          id: "settings.agents.useAProfileForEachOpenCode",
          defaultMessage: "Use a profile for each OpenCode setup.",
        }),
        keywords: [
          defineMessage({
            id: "settings.agentProfiles.addProfile",
            defaultMessage: "Add profile",
          }),
          defineMessage({ id: "settings.agentProfiles.name", defaultMessage: "Name" }),
          defineMessage({
            id: "settings.agentProfiles.executable",
            defaultMessage: "Executable",
          }),
          "opencode",
        ],
      },

      {
        label: defineMessage({
          id: "settings.opencode.profileDirectory",
          defaultMessage: "Profile directory",
        }),
        description: defineMessage({
          id: "settings.agents.openCodesSettingsAndDataForThis",
          defaultMessage: "OpenCode's settings and data for this profile.",
        }),
        keywords: ["account"],
      },
      {
        label: defineMessage({ id: "settings.opencode.serverURL", defaultMessage: "Server URL" }),
        description: defineMessage({
          id: "settings.agents.connectToAnOpenCodeServerThats",
          defaultMessage: "Connect to an OpenCode server that's already running.",
        }),
        keywords: ["Local server", "OPENCODE_SERVER_PASSWORD"],
      },
      {
        label: defineMessage({
          id: "settings.agents.environmentVariables",
          defaultMessage: "Environment variables",
        }),
        description: defineMessage({
          id: "settings.agents.providerCredentialsForThisOpenCodeProfile",
          defaultMessage: "Provider credentials for this OpenCode profile.",
        }),
        keywords: ["API key", "Moonshot", "Kimi", "DeepSeek", "OpenRouter", "Secret", "export"],
      },
    ],
  },
  registryAgentIds: ["opencode", "opencode-v2"],
  setup: { installation: { kind: "managed", id: "opencode" }, firstRun: { order: 6 } },
  capabilities: {
    cliBootstrap: true,
    nativeApplicationTools: true,
    modelsOptIn: true,
  },
} as const satisfies AgentDefinition;
