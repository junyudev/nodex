import type { AgentProfileDefinition } from "./profile-definition.ts";

/** Histories Nodex reads through one of the Agent's profiles; Codex keeps one shared home. */
export const PROFILE_NATIVE_HISTORIES = ["claude", "antigravity"] as const;
export type ProfileNativeHistory = (typeof PROFILE_NATIVE_HISTORIES)[number];

/** Product integrations offered by an Agent. Missing capabilities are off. */
export interface AgentCapabilities {
  readonly utilityModels?: "codex" | "claude";
  readonly automation?: { readonly modelSource: "appServer" | "native" | "discovery" | "account" };
  readonly inbox?: { readonly suggestionEffort: "medium" | "high" };
  /** Whose conversation history a person can copy into Nodex. */
  readonly nativeHistory?: "codex" | ProfileNativeHistory;
  readonly cliBootstrap?: true;
  readonly insightsLedger?: "codex" | "claude";
  readonly nativeSkillPrompts?: true;
  readonly skills?: "codex" | "claude";
  readonly nativeApplicationTools?: true;
  readonly predictions?: true;
  readonly desktopCatalogs?: true;
  readonly subscriptionUsage?: true;
  readonly modelsOptIn?: true;
}

export type AgentAnalyticsFamily = "codex" | "claude" | "opencode" | "antigravity" | "acp";

export type AgentSignIn =
  | { readonly via: "settings" | "dialog" }
  | { readonly via: "browser" | "terminal"; readonly owner: string };

/** How a person finishes setup for an Agent instance. */
export interface AgentSetup {
  readonly signIn?: AgentSignIn;
  readonly models?: "choose" | "discover";
  readonly installation?: {
    readonly kind: "component" | "managed";
    readonly id: string;
    readonly action?: "settings";
  };
  readonly firstRun?: {
    readonly order: number;
    readonly showWhenOff?: true;
    readonly terminalInstall?: true;
    readonly requireKnownAccount?: true;
  };
}

export interface AgentUsageMeter {
  readonly preference: string;
  readonly label: string;
  /** Credential identities may distinguish accounts even when the address is unavailable. */
  readonly preferCredentialIdentity?: true;
  readonly accountWindows?: readonly string[];
  readonly keepWindowLabels?: true;
  readonly accountTypes?: readonly string[];
  /** The profile setting that holds a saved profile's account type, when only some report usage. */
  readonly accountTypeSetting?: string;
  readonly showPlaceholder?: true;
  readonly signOut?: true;
  readonly keepProfileLabel?: true;
  readonly deferredReadingMs?: number;
  readonly trackedBySettings?: true;
}

export interface AgentDefinition {
  readonly driver: string;
  readonly aliases?: readonly string[];
  readonly label: string;
  readonly conversationLabel?: string | null;
  readonly attributionLabel?: string;
  readonly analyticsFamily?: AgentAnalyticsFamily;
  readonly icon?: "openai" | "claude" | "opencode" | "antigravity";
  /** Accent for connections to this Agent in a delegation map. */
  readonly accent?: string;
  readonly modelFamilies?: readonly string[];
  readonly redundantModelQualifiers?: readonly string[];
  readonly settingsAnchor?: string;
  readonly profileAnchorPrefix?: string;
  readonly profileBased: boolean;
  readonly profile?: AgentProfileDefinition;
  readonly registryAgentIds?: readonly string[];
  readonly setup?: AgentSetup;
  readonly usageMeter?: AgentUsageMeter;
  readonly usageFromAccountControl?: true;
  readonly capabilities: AgentCapabilities;
}
