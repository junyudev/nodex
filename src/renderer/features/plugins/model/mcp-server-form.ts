import type { PluginMcpDeclaration } from "../../../../shared/codex-plugin-settings";

export interface KeyValuePair {
  readonly key: string;
  readonly value: string;
}

/** An MCP server declaration as the settings form edits it. */
export interface McpServerForm {
  /** Declaration fields the form doesn't edit, such as timeouts and tool filters. */
  readonly base: Readonly<Record<string, unknown>>;
  readonly label: string;
  readonly transport: "stdio" | "streamable_http";
  readonly stdio: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: readonly KeyValuePair[];
    readonly envVars: readonly string[];
    readonly cwd: string;
  };
  readonly http: {
    readonly url: string;
    readonly bearerTokenEnvVar: string;
    readonly httpHeaders: readonly KeyValuePair[];
    readonly envHttpHeaders: readonly KeyValuePair[];
    /** OAuth settings the form keeps but doesn't edit. */
    readonly passthrough: Readonly<Record<string, unknown>>;
  };
}

const BASE_FIELDS = [
  "enabled",
  "startup_timeout_sec",
  "startup_timeout_ms",
  "tool_timeout_sec",
  "enabled_tools",
  "disabled_tools",
] as const;
const HTTP_PASSTHROUGH_FIELDS = ["auth", "oauth", "scopes", "oauth_resource"] as const;

export const NEW_MCP_SERVER: PluginMcpDeclaration = {
  command: "",
  args: [],
  env_vars: [],
  enabled: true,
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** A map as editable pairs; an empty map becomes one blank pair to type into. */
function toPairs(value: unknown): KeyValuePair[] {
  const entries =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )
      : [];
  return entries.length === 0
    ? [{ key: "", value: "" }]
    : entries.map(([key, entryValue]) => ({ key, value: entryValue }));
}

/** Pairs back to a map, dropping blank keys, and blank values unless they are kept. */
function fromPairs(
  pairs: readonly KeyValuePair[],
  { keepValues = false }: { keepValues?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const trimmedKey = key.trim();
    const kept = keepValues ? value : value.trim();
    if (trimmedKey.length === 0 || (!keepValues && kept.length === 0)) continue;
    out[trimmedKey] = kept;
  }
  return out;
}

function pick(
  declaration: PluginMcpDeclaration,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (declaration[field] !== undefined && declaration[field] !== null) {
      out[field] = declaration[field];
    }
  }
  return out;
}

/** The form for a declaration; `label` starts as the server's key. */
export function mcpServerForm(declaration: PluginMcpDeclaration, label: string): McpServerForm {
  const isHttp = "url" in declaration && !("command" in declaration);
  return {
    base: pick(declaration, BASE_FIELDS),
    label,
    transport: isHttp ? "streamable_http" : "stdio",
    stdio: {
      command: stringValue(declaration.command),
      args: stringList(declaration.args),
      env: toPairs(declaration.env),
      envVars: stringList(declaration.env_vars),
      cwd: stringValue(declaration.cwd),
    },
    http: {
      url: stringValue(declaration.url),
      bearerTokenEnvVar: stringValue(declaration.bearer_token_env_var),
      httpHeaders: toPairs(declaration.http_headers),
      envHttpHeaders: toPairs(declaration.env_http_headers),
      passthrough: pick(declaration, HTTP_PASSTHROUGH_FIELDS),
    },
  };
}

function withoutEmpty(record: Record<string, unknown>): PluginMcpDeclaration {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out as PluginMcpDeclaration;
}

/** The declaration a form saves: the chosen transport's fields, without empty values. */
export function mcpServerDeclaration(form: McpServerForm): PluginMcpDeclaration {
  if (form.transport === "streamable_http") {
    const headers = fromPairs(form.http.httpHeaders);
    const envHeaders = fromPairs(form.http.envHttpHeaders);
    const bearer = form.http.bearerTokenEnvVar.trim();
    return withoutEmpty({
      ...form.base,
      url: form.http.url,
      ...form.http.passthrough,
      bearer_token_env_var: bearer.length > 0 ? bearer : undefined,
      http_headers: Object.keys(headers).length > 0 ? headers : undefined,
      env_http_headers: Object.keys(envHeaders).length > 0 ? envHeaders : undefined,
    });
  }
  const env = fromPairs(form.stdio.env, { keepValues: true });
  const envVars = form.stdio.envVars.map((item) => item.trim()).filter((item) => item.length > 0);
  const cwd = form.stdio.cwd.trim();
  return withoutEmpty({
    ...form.base,
    command: form.stdio.command,
    args: form.stdio.args.length > 0 ? form.stdio.args : undefined,
    env: Object.keys(env).length > 0 ? env : undefined,
    env_vars: envVars.length > 0 ? envVars : undefined,
    cwd: cwd.length > 0 ? cwd : undefined,
  });
}

/** Whether the form names its server and says how to reach it. */
export function mcpServerFormComplete(form: McpServerForm): boolean {
  if (form.label.trim().length === 0) return false;
  return form.transport === "streamable_http"
    ? form.http.url.trim().length > 0
    : form.stdio.command.trim().length > 0;
}

/** A config key for a new server's name, unique among the existing keys. */
export function mcpServerKey(label: string, existingKeys: readonly string[]): string {
  const slug = label
    .trim()
    .replace(/\s+/gu, "_")
    .replace(/[^a-zA-Z0-9-_]+/gu, "-")
    .replace(/-+/gu, "-");
  const base = slug.length > 0 ? slug.toLowerCase() : "custom-server";
  if (!existingKeys.includes(base)) return base;
  let index = 2;
  while (existingKeys.includes(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/** A lower-case name with its first letter raised, as titles show it. */
export function capitalizeLowercaseName(name: string): string {
  if (name.trim().length === 0 || name !== name.toLowerCase()) return name;
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}
