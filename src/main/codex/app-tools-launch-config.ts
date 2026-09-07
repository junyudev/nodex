import path from "node:path";
import { appToolsManifest } from "@nodex/app-tools-mcp/manifest";
import type { AppToolsPipeDescriptor } from "@nodex/app-tools-mcp/pipe";
import type { VerifiedBrowserRuntimeBundle } from "./browser-runtime-bundle";

/** Use the verified bundled Node; the standalone server must be outside ASAR. */
export function appToolsEntrypoint(input: {
  isPackaged: boolean;
  projectRootPath: string;
  resourcesPath: string;
}): string {
  const root = input.isPackaged
    ? path.join(input.resourcesPath, "app.asar.unpacked")
    : input.projectRootPath;
  return path.join(root, "out", "main", "app-tools", "server.mjs");
}

export function appToolsServerConfig(input: {
  runtime: { paths: Pick<VerifiedBrowserRuntimeBundle["paths"], "node"> };
  entrypoint: string;
  pipe: AppToolsPipeDescriptor;
}) {
  const definition = appToolsManifest.mcpServers.nodex_app;
  const cwd = path.resolve(path.dirname(input.entrypoint), definition.cwd);
  return {
    ...definition,
    command: input.runtime.paths.node,
    args: definition.args.map((argument) =>
      argument.startsWith(".") ? path.resolve(cwd, argument) : argument,
    ),
    cwd,
    env: {
      NODEX_APP_TOOLS_PIPE: input.pipe.path,
      NODEX_APP_TOOLS_INSTANCE: input.pipe.instanceId,
      NODEX_APP_TOOLS_TOKEN: input.pipe.token,
    },
  };
}

type TomlValue =
  | string
  | number
  | boolean
  | readonly TomlValue[]
  | { readonly [key: string]: TomlValue };

const inlineToml = (value: TomlValue): string => {
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${inlineToml(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** Replace this physical session's server definition atomically; private credentials never enter saved Thread config. */
export function appToolsLaunchArgs(input: Parameters<typeof appToolsServerConfig>[0]): string[] {
  return ["-c", `mcp_servers.nodex_app=${inlineToml(appToolsServerConfig(input))}`];
}
