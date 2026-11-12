import * as Effect from "effect/Effect";
import {
  compatibilityAuth,
  parseCompatibilityServer,
} from "../../shared/agent-plugins/compatibility";
import {
  PORTABLE_1_0_MCP_SCHEMA,
  portableMcpConfig,
  portableServer,
} from "../../shared/agent-plugins/portable-1.0.0";
import type {
  AgentPluginMcpServer,
  AgentPluginTransport,
  AgentPluginVariableReference,
} from "../../shared/agent-plugins/types";
import { asObject, own, packageRelativePath } from "../../shared/agent-plugins/validation";
import type { PackageFiles } from "./PackageFiles";
import { declaredPath, readComponentJson, type Diagnose } from "./package-documents";

function references(
  transport: AgentPluginTransport,
  portable: boolean,
  inherited: readonly string[],
) {
  const result: AgentPluginVariableReference[] = inherited.map((name) => ({
    kind: "inherited-env",
    name,
    token: name,
    field: "env",
  }));
  const scan = (field: AgentPluginVariableReference["field"], values: readonly string[]) => {
    const pattern = portable ? /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g : /\$\{([^}:]+)(?::-[^}]*)?\}/g;
    const seen = new Set<string>();
    for (const value of values) {
      for (const [token, name] of value.matchAll(pattern)) {
        if (seen.has(token)) continue;
        seen.add(token);
        result.push({ kind: "placeholder", name: name!, field, token });
      }
    }
  };
  if (transport.type === "stdio") {
    if (!portable) scan("command", [transport.command]);
    scan("args", transport.args);
    scan("env", Object.values(transport.env));
    scan("cwd", [transport.cwd]);
  } else if (!portable) {
    scan("url", [transport.url]);
    scan("headers", Object.values(transport.headers));
  }
  return result;
}

function safePath(files: PackageFiles, value: string, kind: "file" | "directory", data = false) {
  const relative = packageRelativePath(value);
  if (!relative) return false;
  // Runtime data is outside the package and is resolved by the eventual launcher.
  if (data) return true;
  const entry = files.inspect(relative);
  return entry.kind === kind || entry.kind === "missing";
}

function safeStdio(
  files: PackageFiles,
  { command, cwd }: Extract<AgentPluginTransport, { type: "stdio" }>,
  portable: boolean,
) {
  const root = portable ? /^\$\{PLUGIN_ROOT\}(?:\/|$)/ : /^\$\{(?:CLAUDE_)?PLUGIN_ROOT\}(?:\/|$)/;
  const data = portable ? /^\$\{PLUGIN_DATA\}(?:\/|$)/ : /^\$\{(?:CLAUDE_)?PLUGIN_DATA\}(?:\/|$)/;
  const commandPath = !portable && root.test(command) ? command.replace(root, "./") : command;
  if (/[\\/:]/.test(commandPath)) {
    if ((portable && !commandPath.startsWith("./")) || !safePath(files, commandPath, "file"))
      return "command";
  } else if (!/^[^\s\0]+$/.test(commandPath) || commandPath === "." || commandPath === "..")
    return "command";

  const dataCwd = data.test(cwd);
  const cwdPath = cwd.replace(dataCwd ? data : root, "./");
  if ((portable && !cwdPath.startsWith("./")) || !packageRelativePath(cwdPath)) return "cwd";
  // Check the fixed prefix here. Delivery checks the full path after runtime expansion.
  const template = portable ? /\$\{PLUGIN_(?:ROOT|DATA)\}/ : /\$\{[^}]+\}/;
  const firstVariable = cwdPath.search(template);
  const fixedPath =
    firstVariable === -1
      ? cwdPath
      : cwdPath.slice(0, cwdPath.lastIndexOf("/", firstVariable) + 1) || ".";
  if (!safePath(files, fixedPath, "directory", dataCwd)) return "cwd";
  return undefined;
}

function describeServers(
  files: PackageFiles,
  entries: Record<string, unknown>,
  path: string,
  portable: boolean,
  diagnose: Diagnose,
) {
  const servers: AgentPluginMcpServer[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    const parsed = portable ? portableServer.safeParse(raw) : parseCompatibilityServer(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      diagnose({
        code: "invalid-server",
        path,
        server: key,
        field: issue?.path.map(String).join("."),
        message: issue?.message ?? "Invalid MCP server.",
      });
      continue;
    }
    const { data } = parsed;
    const transport: AgentPluginTransport =
      data.type === "stdio"
        ? {
            type: "stdio",
            command: data.command,
            args: data.args ?? [],
            env: data.env ?? {},
            cwd: data.cwd ?? "./",
          }
        : {
            type: data.type === "http" ? "streamable-http" : data.type,
            url: data.url,
            headers: data.headers ?? {},
          };
    const field = transport.type === "stdio" ? safeStdio(files, transport, portable) : undefined;
    if (field) {
      diagnose({
        code: "unsafe-path",
        path,
        server: key,
        field,
        message: "The server path must remain inside its declared root.",
      });
      continue;
    }
    const vendorAuth = portable ? undefined : compatibilityAuth(raw);
    const inherited = "env_vars" in data ? (data.env_vars ?? []) : [];
    servers.push({
      key,
      transport,
      variables: references(transport, portable, inherited),
      ...(vendorAuth && { vendorAuth }),
    });
  }
  return servers;
}

export const readPluginMcp = Effect.fnUntraced(function* (
  files: PackageFiles,
  layout: "portable-1.0.0" | "codex" | "claude",
  manifestPath: string,
  declaration: unknown,
  diagnose: Diagnose,
) {
  if (layout === "portable-1.0.0") {
    const path = "mcp.json";
    const document = yield* readComponentJson(files, path, diagnose, "invalid-component", true);
    if (!document) return [];
    const raw = asObject(document.value);
    const schema = raw && own(raw, "$schema");
    if (typeof schema === "string" && schema && schema !== PORTABLE_1_0_MCP_SCHEMA) {
      diagnose({
        code: "unsupported-version",
        path,
        field: "$schema",
        message: "MCP must use the package's Agent Plugins 1.0.0 schema.",
      });
      return [];
    }
    const parsed = portableMcpConfig.safeParse(raw);
    if (!parsed.success) {
      diagnose({
        code: "invalid-component",
        path,
        message: "Expected only the matching $schema and an mcpServers object.",
      });
      return [];
    }
    return describeServers(files, asObject(raw?.mcpServers)!, path, true, diagnose);
  }

  const sources =
    layout === "claude"
      ? [
          undefined,
          ...(Array.isArray(declaration) ? declaration : [declaration]).filter(
            (item) => item !== undefined,
          ),
        ]
      : [declaration];
  const servers = new Map<string, AgentPluginMcpServer>();
  for (const source of sources) {
    const inline = asObject(source);
    const path = inline
      ? manifestPath
      : source === undefined
        ? ".mcp.json"
        : declaredPath(source, manifestPath, "mcpServers", diagnose);
    if (!path) continue;
    const document = inline
      ? { value: inline }
      : yield* readComponentJson(files, path, diagnose, "invalid-component", source === undefined);
    if (!document) continue;
    const raw = asObject(document.value);
    const entries =
      raw && !inline && Object.hasOwn(raw, "mcpServers") ? asObject(raw.mcpServers) : raw;
    if (!entries) {
      diagnose({ code: "invalid-component", path, message: "Expected an MCP server map." });
      continue;
    }
    for (const server of describeServers(files, entries, path, false, diagnose))
      servers.set(server.key, server);
  }
  return [...servers.values()];
});
