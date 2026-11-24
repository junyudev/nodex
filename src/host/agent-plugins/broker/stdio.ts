import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { IsolatedMcpStdioTransport } from "../../../main/platform/node/IsolatedMcpStdioTransport";
import type { AgentPluginTransport } from "../../../shared/agent-plugins/types";
import type { PluginMcpInstallation } from "./contract";

const windows = sep === "\\";
// libuv fills in these entries on Windows when omitted. Empty entries suppress that inheritance.
const windowsDefaults = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];
const executable = async (path: string) => {
  if (!(await stat(path)).isFile()) throw new Error("Expected an executable file");
  await access(path, constants.X_OK);
  return path;
};

async function inside(root: string, path: string) {
  const canonical = await realpath(path);
  const location = relative(root, canonical);
  if (isAbsolute(location) || location === ".." || location.startsWith(".." + sep))
    throw new Error("Path escapes the package");
  return canonical;
}

async function searchCommand(command: string, directories: readonly string[]) {
  if (!/^[^\s\\/:\0]+$/.test(command) || command === "." || command === "..")
    throw new Error("Expected one executable token");
  const names = windows && !/\.(?:exe|com)$/i.test(command) ? [command + ".exe"] : [command];
  for (const directory of directories.filter(isAbsolute)) {
    for (const name of names) {
      const found = await executable(join(directory, name)).catch(() => undefined);
      if (found) return found;
    }
  }
  throw new Error("Executable not found");
}

export async function prepareStdio(
  installation: PluginMcpInstallation,
  declaration: Extract<AgentPluginTransport, { type: "stdio" }>,
  searchPath: readonly string[],
): Promise<Transport> {
  if (!isAbsolute(installation.packageRoot) || !isAbsolute(installation.dataRoot))
    throw new Error("Expected absolute installation paths");
  const root = await realpath(installation.packageRoot);
  await mkdir(installation.dataRoot, { recursive: true, mode: 0o700 });
  const data = await realpath(installation.dataRoot);
  const expand = (value: string) =>
    value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, key) =>
      key === "PLUGIN_ROOT" ? root : data,
    );
  const cwd = await inside(root, resolve(root, expand(declaration.cwd)));
  if (!(await stat(cwd)).isDirectory()) throw new Error("Expected a working directory");

  const command = declaration.command.replace(/^\$\{(?:CLAUDE_)?PLUGIN_ROOT\}\//, "./");
  const path = command.startsWith("./")
    ? await executable(await inside(root, resolve(root, command)))
    : await searchCommand(command, searchPath);
  if (windows && !/\.(?:exe|com)$/i.test(path)) throw new Error("Expected a native executable");

  const env = new Map<string, string | undefined>([
    // Node copies this key from the parent unless the supplied object owns it.
    ["NODE_V8_COVERAGE", undefined],
    ...(windows ? windowsDefaults.map((name) => [name, ""] as const) : []),
  ]);
  // Native Windows runtimes such as Node need SystemRoot during startup.
  if (windows) env.set("SYSTEMROOT", process.env.SYSTEMROOT ?? "");
  for (const [name, value] of Object.entries(declaration.env)) {
    const key = windows ? name.toUpperCase() : name;
    if (!name || /[=\0]/.test(name) || key === "PLUGIN_ROOT" || key === "PLUGIN_DATA")
      throw new Error("Invalid environment name");
    env.set(key, expand(value));
  }
  env.set("PLUGIN_ROOT", root);
  env.set("PLUGIN_DATA", data);
  return new IsolatedMcpStdioTransport({
    command: path,
    args: declaration.args.map(expand),
    cwd,
    env: Object.fromEntries(env),
  });
}
