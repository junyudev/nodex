import { z } from "zod";
import {
  identityFields,
  jsonObject,
  packageRelativePath,
  strictAuthor,
  stringMap,
  strings,
  text,
} from "./validation";

export const PORTABLE_1_0_MANIFEST_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const PORTABLE_1_0_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export const portableManifest = z.object({ ...identityFields, author: strictAuthor.optional() });
export const portableManifestFields = new Set([
  "$schema",
  "extensions",
  ...Object.keys(portableManifest.shape),
]);

export const portableMcpConfig = z.strictObject({
  $schema: z.literal(PORTABLE_1_0_MCP_SCHEMA),
  mcpServers: jsonObject,
});

const portableEnv = stringMap.refine(
  (env) => !Object.hasOwn(env, "PLUGIN_ROOT") && !Object.hasOwn(env, "PLUGIN_DATA"),
  "PLUGIN_ROOT and PLUGIN_DATA are reserved.",
);

const stdio = z.strictObject({
  type: z.literal("stdio"),
  command: text.refine(
    (command) =>
      command.startsWith("./")
        ? packageRelativePath(command) !== undefined
        : /^[^\s\\/:]+$/.test(command) &&
          command !== "." &&
          command !== ".." &&
          !command.includes("\0"),
    "Expected one bare executable name or a package-relative executable path.",
  ),
  args: strings.optional(),
  env: portableEnv.optional(),
  cwd: text.regex(/^(?:\.\/|\$\{PLUGIN_(?:ROOT|DATA)\}(?:\/|$))/).optional(),
});

function isLoopback(host: string): boolean {
  // WHATWG URL serializes IPv4 and IPv6 literals into canonical form.
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export const remoteEndpoint = text.refine((value) => {
  if (!/^https?:\/\/[^/\\?#\s]+/i.test(value) || /[#\\\s]/u.test(value)) return false;
  const url = URL.parse(value);
  if (!url || value.split("/")[2]?.includes("@")) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}, "Expected HTTPS or loopback HTTP with no credentials or fragment.");

export const httpHeaders = stringMap.refine((entries) => {
  const names = Object.keys(entries);
  return (
    new Set(names.map((name) => name.toLowerCase())).size === names.length &&
    Object.entries(entries).every(
      ([name, value]) =>
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && /^[\t\x20-\x7e\x80-\xff]*$/.test(value),
    )
  );
}, "Expected valid HTTP headers with case-insensitively unique names.");

const remote = z.strictObject({
  type: z.enum(["streamable-http", "sse"]),
  url: remoteEndpoint,
  headers: httpHeaders.optional(),
});

export const portableServer = z.discriminatedUnion("type", [stdio, remote]);
