import * as Effect from "effect/Effect";
import type { AcpSessionRuntimeOptions } from "./AcpSessionRuntime";
import type { AcpRuntimeError } from "./AcpRuntimeError";
import { workspaceAcpClientCapabilities } from "./AcpClientCapabilityOwner";
import { AcpAgentLaunchProbe } from "../../platform/node/AcpAgentLaunchProbe";
import { CLAUDE_ACP_AGENT_DEFINITION } from "../../../shared/acp-agent-definitions";

export const CLAUDE_ACP_PACKAGE_NAME = CLAUDE_ACP_AGENT_DEFINITION.packageName;
export const CLAUDE_ACP_PACKAGE_VERSION = CLAUDE_ACP_AGENT_DEFINITION.packageVersion;

export const claudeAcpAgentDefinition = {
  ...CLAUDE_ACP_AGENT_DEFINITION,
  sandboxBoundary: "agent-native-permissions",
  stableClientCapabilities: workspaceAcpClientCapabilities,
} as const;

export interface ClaudeAcpInstallation {
  readonly packageRoot: string;
}

export type ClaudeAcpCredentialPolicy =
  | { readonly kind: "inherit-host-profile" }
  | { readonly kind: "isolated-home"; readonly home: string };

export type ClaudeAcpProxyPolicy = "inherit-host" | "isolated";

export interface ClaudeAcpLaunchPolicy {
  readonly credentials: ClaudeAcpCredentialPolicy;
  readonly proxy: ClaudeAcpProxyPolicy;
  /** Acknowledges that Claude's own tool policy, not an OS sandbox owned by Nodex, governs the child. */
  readonly sandbox: { readonly kind: "agent-native-permissions"; readonly acknowledged: true };
}

export interface ResolveClaudeAcpLaunchInput {
  readonly installation: ClaudeAcpInstallation;
  readonly nodeExecutable: string;
  readonly workspaceRoot: string;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly policy: ClaudeAcpLaunchPolicy;
}

export interface ResolvedClaudeAcpLaunch {
  readonly definition: typeof claudeAcpAgentDefinition;
  readonly capabilityProfile: typeof workspaceAcpClientCapabilities;
  readonly spawn: AcpSessionRuntimeOptions["spawn"];
  readonly cwd: string;
  readonly nodeVersion: string;
  readonly agentVersion: string;
}

const BASE_ENVIRONMENT_KEYS = new Set(["LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR"]);
const PROXY_KEY = /^(?:all|http|https|no)_proxy$/i;
const CREDENTIAL_KEY = /^(?:ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_)/;

const selectEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  policy: ClaudeAcpLaunchPolicy,
  isolatedHome: string | null,
): Readonly<Record<string, string | undefined>> => {
  const selected: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (BASE_ENVIRONMENT_KEYS.has(name)) selected[name] = value;
    if (policy.proxy === "inherit-host" && PROXY_KEY.test(name)) selected[name] = value;
    if (policy.credentials.kind === "inherit-host-profile" && CREDENTIAL_KEY.test(name)) {
      selected[name] = value;
    }
  }
  if (policy.credentials.kind === "inherit-host-profile" && source.HOME !== undefined) {
    selected.HOME = source.HOME;
  }
  if (isolatedHome !== null) {
    selected.HOME = isolatedHome;
    selected.XDG_CONFIG_HOME = isolatedHome;
  }
  return selected;
};

export const resolveClaudeAcpLaunch = Effect.fn("resolveClaudeAcpLaunch")(function* (
  input: ResolveClaudeAcpLaunchInput,
): Effect.fn.Return<ResolvedClaudeAcpLaunch, AcpRuntimeError, AcpAgentLaunchProbe> {
  const probe = yield* AcpAgentLaunchProbe;
  const workspaceRoot = yield* probe.canonicalDirectory(input.workspaceRoot);
  const isolatedHome =
    input.policy.credentials.kind === "isolated-home"
      ? yield* probe.canonicalDirectory(input.policy.credentials.home)
      : null;
  const compatible = yield* probe.probeUserManagedNodePackage({
    packageRoot: input.installation.packageRoot,
    expectedPackageName: CLAUDE_ACP_PACKAGE_NAME,
    expectedPackageVersion: CLAUDE_ACP_PACKAGE_VERSION,
    entryRelativePath: claudeAcpAgentDefinition.entryRelativePath,
    nodeExecutable: input.nodeExecutable,
    minimumNodeMajor: claudeAcpAgentDefinition.minimumNodeMajor,
  });
  return {
    definition: claudeAcpAgentDefinition,
    capabilityProfile: workspaceAcpClientCapabilities,
    cwd: workspaceRoot,
    nodeVersion: compatible.nodeVersion,
    agentVersion: compatible.agentVersion,
    spawn: {
      command: compatible.nodeExecutable,
      args: [compatible.entryPath],
      cwd: workspaceRoot,
      env: selectEnvironment(input.hostEnvironment, input.policy, isolatedHome),
      forceTermination: "2 seconds",
    },
  };
});
