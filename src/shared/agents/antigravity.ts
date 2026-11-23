import { defineMessage, type MessageDescriptor } from "../i18n/messages.ts";
import type { ANTIGRAVITY_AUTH_METHODS } from "../../../packages/agent-runtime/vendor/contracts/src/settings.ts";
import { ENVIRONMENT_VALUE_LIMIT } from "../agent-environment.ts";
import type { ProfileValues } from "./profile-definition.ts";
import type { AgentDefinition } from "./definition.ts";

export type AntigravityAuthMethod = (typeof ANTIGRAVITY_AUTH_METHODS)[number]["value"];
const SIGN_IN_METHODS = [
  {
    value: "computer",
    label: defineMessage({
      id: "settings.antigravity.method.computer",
      defaultMessage: "agy on this computer",
    }),
    // agy keeps one sign-in for this computer, so two profiles would be one account.
    exclusive: true,
  },
  {
    value: "oauth-personal",
    label: defineMessage({
      id: "settings.antigravity.method.googleAccount",
      defaultMessage: "Google account",
    }),
  },
  {
    value: "oauth-business",
    label: defineMessage({
      id: "settings.antigravity.method.geminiEnterprise",
      defaultMessage: "Gemini Enterprise",
    }),
  },
  {
    value: "gemini-api-key",
    label: defineMessage({
      id: "settings.antigravity.method.geminiApiKey",
      defaultMessage: "Gemini API key",
    }),
  },
  {
    value: "agent-platform",
    label: defineMessage({
      id: "settings.antigravity.method.agentPlatform",
      defaultMessage: "Agent Platform (Vertex AI)",
    }),
  },
] as const satisfies readonly {
  readonly value: AntigravityAuthMethod;
  readonly label: MessageDescriptor;
  readonly exclusive?: true;
}[];

const methodLabels = Object.fromEntries(SIGN_IN_METHODS.map(({ value, label }) => [value, label]));
const methodLabel = (method: unknown) =>
  typeof method === "string" ? methodLabels[method] : undefined;
const readsKey = (values: ProfileValues) =>
  values.authMethod === "gemini-api-key" || values.authMethod === "agent-platform";
const readsCloudProject = (values: ProfileValues) =>
  values.authMethod === "oauth-business" || values.authMethod === "agent-platform";

export type AntigravityProfileAuthMethod = (typeof SIGN_IN_METHODS)[number]["value"];
const gcpProjectOptional = defineMessage({
  id: "settings.antigravity.gcpProject.optional",
  defaultMessage: "Optional. The project your key's usage belongs to.",
});
const signInMethodDescription = defineMessage({
  id: "settings.antigravity.signInMethod.description",
  defaultMessage:
    "A Google account uses your plan. API keys and Agent Platform bill for what you use.",
});
const computerSignInDescription = defineMessage({
  id: "settings.antigravity.signInMethod.computer.description",
  defaultMessage:
    "Uses the account agy is signed in to on this computer. Signing in or out here does the same for agy.",
});

export const antigravityAgent = {
  driver: "antigravity",
  analyticsFamily: "antigravity",
  label: "Antigravity",
  icon: "antigravity",
  accent: "#4fbf8b",
  modelFamilies: ["Gemini "],
  settingsAnchor: "antigravity",
  profileAnchorPrefix: "antigravity-agent-",
  profileBased: true,
  profile: {
    defaultName: "Antigravity",
    initialId: "antigravity_u0SfydHcHMn3hO6kKWtdp1fZbW1U6kFxeVq9pJbh2Ew",
    description: defineMessage({
      id: "settings.antigravity.description",
      defaultMessage:
        "Google's coding agent for Gemini and the other models on your plan. Use a profile for each account.",
    }),
    setupDescription: defineMessage({
      id: "settings.antigravity.setupDescription",
      defaultMessage:
        "A profile is one account. The first uses agy's sign-in on this computer; add a profile for each other account.",
    }),
    executable: {
      defaultValue: "",
      allowEmpty: true,
      position: "afterFields",
      placeholder: defineMessage({
        id: "settings.antigravity.executable.automatic",
        defaultMessage: "Automatic",
      }),
      description: defineMessage({
        id: "settings.antigravity.executable.description",
        defaultMessage: "Empty runs Nodex's download, or agy on this computer.",
      }),
    },
    // The first profile uses this computer's sign-in; later ones sign in on their own.
    initialSettings: (others) =>
      others.some(({ authMethod }) => authMethod === "computer") ? {} : { authMethod: "computer" },
    fields: {
      authMethod: {
        control: "select",
        defaultValue: "oauth-personal",
        options: SIGN_IN_METHODS,
        label: defineMessage({
          id: "settings.antigravity.signInMethod",
          defaultMessage: "Sign-in method",
        }),
        description: (values) =>
          values.authMethod === "computer" ? computerSignInDescription : signInMethodDescription,
        accessibleLabel: defineMessage({
          id: "settings.antigravity.signInMethod.label",
          defaultMessage: "Antigravity sign-in method",
        }),
      },
      apiKey: {
        control: "secret",
        defaultValue: null,
        maxLength: ENVIRONMENT_VALUE_LIMIT,
        label: defineMessage({
          id: "settings.antigravity.apiKey",
          defaultMessage: "API key",
        }),
        description: defineMessage({
          id: "settings.antigravity.apiKey.description",
          defaultMessage: "Kept encrypted on this computer, and never shown again.",
        }),
        accessibleLabel: defineMessage({
          id: "settings.antigravity.apiKey.label",
          defaultMessage: "Antigravity API key",
        }),
        savedPlaceholder: defineMessage({
          id: "settings.antigravity.apiKey.saved",
          defaultMessage: "Saved",
        }),
        when: readsKey,
      },
      gcpProject: {
        control: "text",
        defaultValue: "",
        maxLength: 4096,
        label: defineMessage({
          id: "settings.antigravity.gcpProject",
          defaultMessage: "Google Cloud project",
        }),
        description: (values) =>
          values.authMethod === "agent-platform" ? gcpProjectOptional : undefined,
        accessibleLabel: defineMessage({
          id: "settings.antigravity.gcpProject.label",
          defaultMessage: "Antigravity Google Cloud project",
        }),
        placeholder: "my-project-id",
        when: readsCloudProject,
      },
      gcpLocation: {
        control: "text",
        defaultValue: "",
        maxLength: 4096,
        label: defineMessage({
          id: "settings.antigravity.gcpLocation",
          defaultMessage: "Location",
        }),
        accessibleLabel: defineMessage({
          id: "settings.antigravity.gcpLocation.label",
          defaultMessage: "Antigravity Google Cloud location",
        }),
        placeholder: "us-central1",
        when: readsCloudProject,
      },
    },
    detail: ({ settings, binaryPath }, format) => {
      const label = methodLabel(settings.authMethod);
      return [label && format(label), binaryPath];
    },
    search: [
      {
        label: "Antigravity",
        description: defineMessage({
          id: "settings.antigravity.description",
          defaultMessage:
            "Google's coding agent for Gemini and the other models on your plan. Use a profile for each account.",
        }),
        keywords: [
          "agy",
          "Gemini",
          "Google",
          defineMessage({
            id: "settings.agentProfiles.addProfile",
            defaultMessage: "Add profile",
          }),
        ],
      },
      {
        label: defineMessage({ id: "antigravityRuntime.label", defaultMessage: "Runtime" }),
        description: defineMessage({
          id: "settings.antigravity.runtime.description",
          defaultMessage: "Install, update or remove the runtime Antigravity profiles share.",
        }),
        keywords: [
          "Install",
          "Update",
          "Download",
          defineMessage({
            id: "settings.agentProfiles.executable",
            defaultMessage: "Executable",
          }),
        ],
      },
      {
        label: defineMessage({
          id: "settings.antigravity.signInMethod",
          defaultMessage: "Sign-in method",
        }),
        description: signInMethodDescription,
        keywords: [
          "Account",
          "Sign in",
          "Sign out",
          "agy",
          "Terminal",
          "Google account",
          "Gemini Enterprise",
          "Gemini API key",
          "Agent Platform",
          "Vertex AI",
          "Google Cloud project",
        ],
      },
    ],
  },
  registryAgentIds: ["antigravity-acp"],
  usageMeter: {
    trackedBySettings: true,
    preference: "antigravity",
    label: "Antigravity",
    preferCredentialIdentity: true,
    keepWindowLabels: true,
    accountTypes: ["computer", "oauth-personal", "oauth-business"],
    accountTypeSetting: "authMethod",
    deferredReadingMs: 32_000,
  },
  setup: {
    signIn: { via: "settings" },
    models: "choose",
    installation: { kind: "managed", id: "antigravity", action: "settings" },
    firstRun: { order: 4, showWhenOff: true, requireKnownAccount: true },
  },
  capabilities: {
    automation: { modelSource: "account" },
    cliBootstrap: true,
    nativeHistory: "antigravity",
    nativeApplicationTools: true,
    subscriptionUsage: true,
  },
} as const satisfies AgentDefinition;
