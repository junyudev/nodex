import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PluginRouteTarget } from "../codex-plugin-management";
import type { WorkspaceFileRequest } from "../types";

export interface PluginAppPresentation {
  readonly pluginName: string;
  readonly entryTitle: string;
  readonly logoUrl?: string | null;
  readonly logoDarkUrl?: string | null;
  readonly composerIconUrl?: string | null;
  readonly target?: PluginRouteTarget;
}

export type PluginAppBinding = {
  readonly pluginId: string;
  readonly entryId: string;
  readonly presentation?: PluginAppPresentation;
} & (
  | { readonly kind: "global"; readonly projectId: string | null }
  | { readonly kind: "thread"; readonly projectId: string | null; readonly sessionId: string }
  | {
      readonly kind: "file";
      readonly projectId: string;
      readonly file: WorkspaceFileRequest & { readonly hostId: string };
    }
);

export const pluginAppBindingKey = (binding: PluginAppBinding) =>
  JSON.stringify([
    binding.kind,
    binding.projectId,
    binding.pluginId,
    binding.entryId,
    binding.kind === "thread" ? binding.sessionId : null,
    binding.kind === "file" ? [binding.file.hostId, binding.file.path] : null,
  ]);

export type PluginAppEntrypoint = {
  readonly id: string;
  readonly serverKey: string;
  readonly toolName: string;
  readonly title: string;
  readonly resourceUri: string;
} & (
  | { readonly kind: "global" | "thread" }
  | { readonly kind: "file"; readonly extensions: readonly string[] }
);

export interface PluginAppCatalogEntry extends PluginAppPresentation {
  readonly pluginId: string;
  readonly entry: PluginAppEntrypoint;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function pluginAppResourceUri(tool: Tool): string | undefined {
  const uri = record(tool._meta?.ui)?.resourceUri ?? tool._meta?.["ui/resourceUri"];
  return typeof uri === "string" && /^ui:\/\/[^\s]+$/u.test(uri) ? uri : undefined;
}

export function derivePluginAppEntrypoints(
  serverKey: string,
  tools: readonly Tool[],
): PluginAppEntrypoint[] {
  return tools.flatMap((tool): PluginAppEntrypoint[] => {
    const resourceUri = pluginAppResourceUri(tool);
    const entrypoints = record(tool._meta?.["openai/ui"])?.entrypoints;
    if (!resourceUri || !Array.isArray(entrypoints)) return [];
    const base = {
      serverKey,
      toolName: tool.name,
      title: tool.title || tool.annotations?.title || tool.name,
      resourceUri,
    };

    const extensions = entrypoints.flatMap((value: unknown): string[] => {
      const entry = record(value);
      if (entry?.type !== "file" || !Array.isArray(entry.extensions) || !entry.extensions.length)
        return [];
      const declared: unknown[] = entry.extensions;
      if (
        !declared.every(
          (ext): ext is string => typeof ext === "string" && /^\.[^\s,/\\*]+$/u.test(ext),
        )
      )
        return [];
      return declared.map((ext) => ext.toLowerCase());
    });
    return [
      ...(["global", "thread"] as const)
        .filter((kind) => entrypoints.some((value: unknown) => record(value)?.type === kind))
        .map((kind) => ({ ...base, id: JSON.stringify([serverKey, tool.name, kind]), kind })),
      ...(extensions.length
        ? [
            {
              ...base,
              id: JSON.stringify([serverKey, tool.name, "file"]),
              kind: "file" as const,
              extensions: [...new Set(extensions)].sort(),
            },
          ]
        : []),
    ];
  });
}

/** Each navigation entry stays selectable. File actions choose one matching viewer per plugin. */
export function selectPluginAppEntries(
  catalog: readonly PluginAppCatalogEntry[],
  target: { kind: "global" | "thread" } | { kind: "file"; name: string },
) {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...catalog].sort(
    (a, b) =>
      compare(a.entry.serverKey, b.entry.serverKey) || compare(a.entry.toolName, b.entry.toolName),
  );
  const matching = sorted.filter(({ entry }) =>
    target.kind === "file" ? pluginAppMatchesFile(entry, target.name) : entry.kind === target.kind,
  );
  const selected =
    target.kind === "file"
      ? matching.filter(
          (item, index) =>
            matching.findIndex(({ pluginId }) => pluginId === item.pluginId) === index,
        )
      : matching;
  return selected.sort(
    (a, b) =>
      a.pluginName.localeCompare(b.pluginName) ||
      a.pluginId.localeCompare(b.pluginId) ||
      a.entry.title.localeCompare(b.entry.title),
  );
}

export function pluginAppMatchesFile(entry: PluginAppEntrypoint, name: string) {
  return entry.kind === "file" && entry.extensions.some((ext) => name.toLowerCase().endsWith(ext));
}

export function pluginAppFileName(path: string) {
  return path.split(/[\\/]/u).at(-1) ?? "";
}

export type PluginAppLaunchInput = {
  readonly file?: { readonly name: string; readonly resourceUri: string };
};

export function pluginAppLaunchInput(
  binding: PluginAppBinding,
  opaqueId: string,
): PluginAppLaunchInput {
  return binding.kind !== "file"
    ? {}
    : {
        file: {
          name: pluginAppFileName(binding.file.path),
          resourceUri: `host-resource://${opaqueId}`,
        },
      };
}
