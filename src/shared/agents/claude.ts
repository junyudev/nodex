import { defineMessage } from "../i18n/messages.ts";
import {
  AGENT_ENVIRONMENT_NAME_MESSAGES as environmentMessages,
  ENVIRONMENT_NAME_PATTERN,
  type FormatEnvironmentValidation,
} from "../agent-environment.ts";
import { profileEnvironmentDetail } from "./profile-definition.ts";
import { ClaudeCustomModelsSchema } from "./claude-custom-models.ts";
import type { AgentDefinition } from "./definition.ts";

const RESERVED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
]);

export const claudeEnvironmentNameError = (
  name: string,
  formatMessage?: FormatEnvironmentValidation,
): string | null => {
  if (name.length > 128 || !ENVIRONMENT_NAME_PATTERN.test(name))
    return formatMessage
      ? formatMessage(environmentMessages.invalid)
      : environmentMessages.invalid.defaultMessage;
  if (RESERVED_ENVIRONMENT_NAMES.has(name.toUpperCase()))
    return name.toUpperCase() === "CLAUDE_CONFIG_DIR"
      ? formatMessage
        ? formatMessage(environmentMessages.claudeConfig)
        : environmentMessages.claudeConfig.defaultMessage
      : formatMessage
        ? formatMessage(environmentMessages.claudeManaged, { name })
        : `${name} is managed by the Claude launcher.`;
  return null;
};

const environmentSuggestions = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

export const claudeAgent = {
  driver: "claudeAgent",
  analyticsFamily: "claude",
  label: "Claude Code",
  attributionLabel: "Claude",
  icon: "claude",
  accent: "#d97757",
  modelFamilies: ["Claude "],
  redundantModelQualifiers: ["claude", "claude code"],
  settingsAnchor: "claude",
  profileBased: true,
  profile: {
    defaultName: "Claude Code",
    initialId: "claude_DwwtN-gWKTuDgY0CipiA2mDkEAwUiZeUsBeQSfYr0Ks",
    description: defineMessage({
      id: "settings.claude.anthropicsCodingAgentUseAProfile",
      defaultMessage: "Anthropic's coding agent. Use a profile for each Claude setup or account.",
    }),
    setupDescription: defineMessage({
      id: "settings.claude.aProfileChoosesTheClaudeCommand",
      defaultMessage:
        "A profile chooses the claude command, config folder and environment Nodex starts Claude Code with.",
    }),
    executable: {
      defaultValue: "claude",
      placeholder: "claude",
      description: defineMessage({
        id: "settings.claude.theClaudeCommandOrItsFull",
        defaultMessage: "The claude command, or its full path.",
      }),
    },
    fields: {
      configDirectory: {
        control: "path",
        defaultValue: "",
        maxLength: 4096,
        label: defineMessage({
          id: "settings.claude.configDirectory",
          defaultMessage: "Config directory",
        }),
        description: defineMessage({
          id: "settings.claude.whereThisProfileKeepsItsSign",
          defaultMessage:
            "Where this profile keeps its sign-in and settings. Empty uses ~/.claude.",
        }),
        accessibleLabel: defineMessage({
          id: "settings.claude.claudeCodeConfigDirectory",
          defaultMessage: "Claude Code config directory",
        }),
        placeholder: defineMessage({
          id: "settings.claude.default",
          defaultMessage: "Default",
        }),
      },
      customModels: { control: "custom", schema: ClaudeCustomModelsSchema, defaultValue: [] },
    },
    environment: { nameError: claudeEnvironmentNameError, suggestions: environmentSuggestions },
    detail: ({ binaryPath, settings, environment }, format) => [
      binaryPath || "claude",
      (typeof settings.configDirectory === "string" && settings.configDirectory) ||
        "default config",
      profileEnvironmentDetail(environment?.length ?? 0, format),
    ],
    search: [
      {
        label: defineMessage({ id: "settings.agents.profile", defaultMessage: "Profile" }),
        description: defineMessage({
          id: "settings.agents.useAProfileForEachClaude",
          defaultMessage: "Use a profile for each Claude setup or account.",
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
          "claude",
        ],
      },

      {
        label: defineMessage({
          id: "settings.claude.configDirectory",
          defaultMessage: "Config directory",
        }),
        description: defineMessage({
          id: "settings.agents.whereThisProfileKeepsItsSign",
          defaultMessage: "Where this profile keeps its sign-in and settings.",
        }),
        keywords: ["~/.claude", "CLAUDE_CONFIG_DIR", "account"],
      },
      {
        label: defineMessage({
          id: "settings.agents.environmentVariables",
          defaultMessage: "Environment variables",
        }),
        description: defineMessage({
          id: "settings.agents.pasteAEnvFileOrExport",
          defaultMessage: "Paste a .env file or export lines.",
        }),
        keywords: [...environmentSuggestions.slice(0, 3), "export", "token", "proxy"],
      },
      {
        label: defineMessage({
          id: "settings.agents.customModels",
          defaultMessage: "Custom models",
        }),
        description: defineMessage({
          id: "settings.agents.modelsThisProfileCanChooseBesides",
          defaultMessage: "Models this profile can choose besides Claude's own.",
        }),
      },
    ],
  },
  registryAgentIds: ["claude-acp", "claude-agent-acp"],
  usageMeter: {
    trackedBySettings: true,
    preference: "claude",
    label: "Claude",
    accountWindows: ["five_hour", "seven_day"],
    showPlaceholder: true,
    signOut: true,
    keepProfileLabel: true,
  },
  setup: {
    signIn: { via: "terminal", owner: "claude-code" },
    firstRun: { order: 1, terminalInstall: true },
  },
  capabilities: {
    automation: { modelSource: "native" },
    pluginDelivery: "claude",
    insightsLedger: "claude",
    cliBootstrap: true,
    utilityModels: "claude",
    inbox: { suggestionEffort: "medium" },
    nativeHistory: "claude",
    skills: "claude",
    nativeSkillPrompts: true,
    nativeApplicationTools: true,
    subscriptionUsage: true,
  },
} as const satisfies AgentDefinition;
