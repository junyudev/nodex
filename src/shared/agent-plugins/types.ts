export const NODEX_PLUGIN_NAMESPACE = "app.jyu.nodex";
export const OPENAI_PLUGIN_NAMESPACE = "com.openai";

export type AgentPluginLayout = "portable-1.0.0" | "codex" | "claude";
export type AgentPluginVendorSource = "openai-extension" | "codex-manifest";

export interface AgentPluginDiagnostic {
  readonly code:
    | "unknown-manifest-field"
    | "invalid-extensions"
    | "invalid-component"
    | "invalid-skill"
    | "invalid-server"
    | "unsupported-version"
    | "unsafe-path"
    | "invalid-vendor-data";
  /** Package-relative source path. */
  readonly path: string;
  readonly message: string;
  readonly field?: string;
  readonly server?: string;
}

export interface AgentPluginRejectionReason {
  readonly code:
    | "invalid-root"
    | "missing-manifest"
    | "invalid-manifest"
    | "unsupported-version"
    | "unsafe-path"
    | "package-limit"
    | "filesystem-error";
  readonly message: string;
  readonly path?: string;
  readonly field?: string;
}

export interface AgentPluginIdentity {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: { readonly name?: string; readonly email?: string; readonly url?: string };
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
}

export interface AgentPluginPresentation {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly category?: string;
  readonly capabilities?: readonly string[];
  readonly defaultPrompts?: readonly string[];
  readonly brandColor?: string;
  readonly brandColorDark?: string;
  readonly websiteURL?: string;
  readonly supportURL?: string;
  readonly privacyPolicyURL?: string;
  readonly termsOfServiceURL?: string;
  /** Asset paths are resolved relative to the package root. */
  readonly composerIcon?: string;
  readonly composerIconDark?: string;
  readonly logo?: string;
  readonly logoDark?: string;
  readonly screenshots?: readonly string[];
}

export interface AgentPluginSkill {
  readonly name: string;
  readonly description: string;
  readonly directory: string;
  readonly valid: boolean;
  readonly diagnostics: readonly AgentPluginDiagnostic[];
}

type AgentPluginRemoteTransport<Type extends "streamable-http" | "sse"> = {
  readonly type: Type;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

export type AgentPluginTransport =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      /** Original declaration, defaulting to "./". Delivery must check containment after expansion. */
      readonly cwd: string;
    }
  | AgentPluginRemoteTransport<"streamable-http">
  | AgentPluginRemoteTransport<"sse">;

export interface AgentPluginVariableReference {
  readonly name: string;
  readonly field: "command" | "args" | "env" | "cwd" | "url" | "headers";
  readonly token: string;
  readonly kind: "placeholder" | "inherited-env";
}

export interface AgentPluginMcpServer {
  readonly key: string;
  readonly transport: AgentPluginTransport;
  readonly variables: readonly AgentPluginVariableReference[];
  readonly vendorAuth?: {
    readonly declaration?: unknown;
    readonly legacy?: Readonly<Record<string, unknown>>;
  };
}

export interface AgentPluginHooks {
  readonly source: { readonly kind: "file" | "manifest"; readonly path: string };
  readonly events: readonly {
    readonly name: string;
    readonly commands: readonly string[];
  }[];
}

export interface AgentPluginHostedApp {
  readonly kind: "openai-hosted";
  readonly key: string;
  readonly id: string;
  readonly category?: string;
  readonly optional?: boolean;
  readonly required?: boolean;
  readonly capabilities?: readonly string[];
}

export interface AgentPluginPackage {
  readonly identity: AgentPluginIdentity;
  readonly layout: AgentPluginLayout;
  readonly vendorSource?: AgentPluginVendorSource;
  readonly presentation?: AgentPluginPresentation;
  readonly onboardingSkill?: string;
  readonly skills: readonly AgentPluginSkill[];
  readonly mcpServers: readonly AgentPluginMcpServer[];
  readonly hooks: readonly AgentPluginHooks[];
  readonly apps: readonly AgentPluginHostedApp[];
  readonly extensions: Readonly<Record<string, unknown>>;
  /** Hex SHA-256 of the package's framed, sorted content. */
  readonly digest: string;
  readonly diagnostics: readonly AgentPluginDiagnostic[];
}

export type AgentPluginReadResult =
  | { readonly status: "loaded"; readonly package: AgentPluginPackage }
  | { readonly status: "rejected"; readonly reasons: readonly AgentPluginRejectionReason[] };
