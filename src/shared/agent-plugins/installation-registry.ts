import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type {
  AgentPluginHooks,
  AgentPluginHostedApp,
  AgentPluginMcpServer,
  AgentPluginPackage,
} from "./types";
import { packageRelativePath } from "./validation";

export type LocalPluginSource = { readonly kind: "local"; readonly locator: string };
export type PluginInstallationSource =
  | LocalPluginSource
  | { readonly kind: "git" | "npm"; readonly locator: string };

export interface PluginProject {
  readonly spaceId: string;
  readonly projectId: string;
}

export interface PluginInstallationRecord {
  readonly id: string;
  readonly source: LocalPluginSource;
  readonly admission: "admitted";
  readonly activeGeneration: string;
  readonly enabled: boolean;
  readonly projects: readonly PluginProject[];
  /** Includes the declared version, verified digest, and normalized contributions. */
  readonly package: AgentPluginPackage;
}

export type PluginWriterStatus = "clear" | "busy" | "stale";

export type PluginCleanupWarning =
  | { readonly kind: "generation" | "data"; readonly installationId: string }
  | { readonly kind: "writer-lock" };

export interface PluginRegistry {
  readonly format: 1;
  readonly revision: number;
  readonly installations: readonly PluginInstallationRecord[];
}

export const emptyPluginRegistry: PluginRegistry = { format: 1, revision: 0, installations: [] };

export function pluginInstallationId(name: string, source: PluginInstallationSource): string {
  // The reader normalizes the manifest name. Version and layout can change independently.
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([name, source.kind, source.locator]))));
}

export const PLUGIN_REGISTRY_DIRECTORY = "agent-plugins";

/** Profile-relative, slash-separated paths. */
export const pluginPackageDirectory = (installation: PluginInstallationRecord): string =>
  [
    PLUGIN_REGISTRY_DIRECTORY,
    "packages",
    installation.id,
    installation.package.digest,
    installation.activeGeneration,
  ].join("/");

export const pluginDataDirectory = (installationId: string): string =>
  [PLUGIN_REGISTRY_DIRECTORY, "data", installationId].join("/");

export type PluginTransitionError =
  | { readonly code: "not-installed"; readonly id: string }
  | { readonly code: "identity-changed"; readonly id: string; readonly observedId: string }
  | { readonly code: "invalid-project" };

type PluginTransition =
  | {
      readonly ok: true;
      readonly registry: PluginRegistry;
      readonly installation: PluginInstallationRecord;
    }
  | { readonly ok: false; readonly error: PluginTransitionError };

function replace(
  registry: PluginRegistry,
  installation: PluginInstallationRecord,
): PluginTransition {
  const installations = registry.installations.some(({ id }) => id === installation.id)
    ? registry.installations.map((entry) => (entry.id === installation.id ? installation : entry))
    : [...registry.installations, installation];
  return {
    ok: true,
    registry: { ...registry, revision: registry.revision + 1, installations },
    installation,
  };
}

/** Publish only after the host has verified a staged generation. */
export function publishPluginInstallation(
  registry: PluginRegistry,
  source: LocalPluginSource,
  pkg: AgentPluginPackage,
  generation: string,
): PluginTransition {
  const id = pluginInstallationId(pkg.identity.name, source);
  const current = registry.installations.find((entry) => entry.id === id);
  return replace(registry, {
    id,
    source,
    admission: "admitted",
    activeGeneration: generation,
    enabled: current?.enabled ?? true,
    projects: current?.projects ?? [],
    package: pkg,
  });
}

export function reloadPluginInstallation(
  registry: PluginRegistry,
  id: string,
  source: LocalPluginSource,
  pkg: AgentPluginPackage,
  generation: string,
): PluginTransition {
  if (!registry.installations.some((entry) => entry.id === id))
    return { ok: false, error: { code: "not-installed", id } };
  const observedId = pluginInstallationId(pkg.identity.name, source);
  if (observedId !== id) return { ok: false, error: { code: "identity-changed", id, observedId } };
  return publishPluginInstallation(registry, source, pkg, generation);
}

export const samePluginProject = (a: PluginProject, b: PluginProject): boolean =>
  a.spaceId === b.spaceId && a.projectId === b.projectId;

export function setPluginProjectEnabled(
  registry: PluginRegistry,
  id: string,
  project: PluginProject,
  enabled: boolean,
): PluginTransition {
  if (!project.spaceId.trim() || !project.projectId.trim())
    return { ok: false, error: { code: "invalid-project" } };
  const installation = registry.installations.find((entry) => entry.id === id);
  if (!installation) return { ok: false, error: { code: "not-installed", id } };
  const { spaceId, projectId } = project;
  const active = installation.projects.some((entry) => samePluginProject(entry, project));
  if (active === enabled) return { ok: true, registry, installation };
  return replace(registry, {
    ...installation,
    projects: enabled
      ? [...installation.projects, { spaceId, projectId }]
      : installation.projects.filter((entry) => !samePluginProject(entry, project)),
  });
}

export function setPluginInstallationEnabled(
  registry: PluginRegistry,
  id: string,
  enabled: boolean,
): PluginTransition {
  const installation = registry.installations.find((entry) => entry.id === id);
  if (!installation) return { ok: false, error: { code: "not-installed", id } };
  if (installation.enabled === enabled) return { ok: true, registry, installation };
  return replace(registry, { ...installation, enabled });
}

export function uninstallPluginInstallation(
  registry: PluginRegistry,
  id: string,
): PluginTransition {
  const installation = registry.installations.find((entry) => entry.id === id);
  if (!installation) return { ok: false, error: { code: "not-installed", id } };
  return {
    ok: true,
    installation,
    registry: {
      ...registry,
      revision: registry.revision + 1,
      installations: registry.installations.filter((entry) => entry.id !== id),
    },
  };
}

export interface EffectivePluginContributions {
  readonly identity: string;
  readonly installationId: string;
  readonly generation: string;
  readonly packageDirectory: string;
  readonly dataDirectory: string;
  /** Skill directories are Profile-relative. */
  readonly skills: readonly { readonly name: string; readonly directory: string }[];
  readonly mcpServers: readonly AgentPluginMcpServer[];
  readonly hooks: readonly (AgentPluginHooks & { readonly status: "inert" })[];
  readonly apps: readonly (AgentPluginHostedApp & {
    readonly status: "requires-hosted-services";
  })[];
}

export function effectivePluginContributions(
  registry: PluginRegistry,
  project: PluginProject,
): readonly EffectivePluginContributions[] {
  return registry.installations.flatMap((installation): EffectivePluginContributions[] => {
    if (
      !installation.enabled ||
      !installation.projects.some((entry) => samePluginProject(entry, project))
    )
      return [];
    const directory = pluginPackageDirectory(installation);
    const pkg = installation.package;
    return [
      {
        identity: pkg.identity.name,
        installationId: installation.id,
        generation: installation.activeGeneration,
        packageDirectory: directory,
        dataDirectory: pluginDataDirectory(installation.id),
        skills: pkg.skills.flatMap((skill) => {
          const relative = packageRelativePath(skill.directory);
          if (!skill.valid || relative === undefined) return [];
          return [
            {
              name: skill.name,
              directory: relative === "." ? directory : directory + "/" + relative,
            },
          ];
        }),
        mcpServers: pkg.mcpServers,
        hooks: pkg.hooks.map((hook) => ({ ...hook, status: "inert" })),
        apps: pkg.apps.map((app) => ({ ...app, status: "requires-hosted-services" })),
      },
    ];
  });
}
