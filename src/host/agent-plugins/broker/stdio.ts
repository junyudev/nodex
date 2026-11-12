import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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
  "SYSTEMROOT",
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
  for (const [name, value] of Object.entries(declaration.env)) {
    const key = windows ? name.toUpperCase() : name;
    if (!name || /[=\0]/.test(name) || key === "PLUGIN_ROOT" || key === "PLUGIN_DATA")
      throw new Error("Invalid environment name");
    env.set(key, expand(value));
  }
  env.set("PLUGIN_ROOT", root);
  env.set("PLUGIN_DATA", data);
  return new IsolatedStdio(path, declaration.args.map(expand), cwd, Object.fromEntries(env));
}

/** The SDK's stdio client merges ambient variables even when passed an explicit env. */
class IsolatedStdio implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly buffer = new ReadBuffer({ maxBufferSize: 4 * 1024 * 1024 });
  private child?: ChildProcess;
  private exited?: Promise<unknown>;
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly cwd: string,
    private readonly env: Record<string, string | undefined>,
  ) {}

  async start() {
    if (this.closed) throw new Error("MCP transport is closed");
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    this.exited = once(child, "exit").catch(() => undefined);
    child.once("exit", () => {
      this.finish();
      child.stdin.destroy();
      child.stdout.destroy();
    });
    child.stdin.on("error", (error) => this.onerror?.(error));
    child.stdout.on("error", (error) => this.onerror?.(error));
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage())
          this.onmessage?.(message);
      } catch {
        this.onerror?.(new Error("Invalid MCP stdio message"));
        void this.close();
      }
    });
    await once(child, "spawn");
  }

  async send(message: JSONRPCMessage) {
    const input = this.child?.stdin;
    if (!input || this.closed) throw new Error("MCP child disconnected");
    if (!input.write(serializeMessage(message))) {
      await Promise.race([once(input, "drain"), this.exited]);
    }
  }

  async close() {
    this.child?.kill("SIGKILL");
    await this.exited;
    this.child?.stdin?.destroy();
    this.child?.stdout?.destroy();
    this.finish();
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}
