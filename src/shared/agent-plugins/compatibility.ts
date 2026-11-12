import { z } from "zod";
import { httpHeaders, remoteEndpoint } from "./portable-1.0.0";
import { asObject, identityFields, own, stringMap, strings, text } from "./validation";

export const compatibilityManifest = z.object({
  ...identityFields,
  name: text.trim().min(1),
});

const remote = z.object({
  type: z.enum(["http", "streamable-http", "sse"]),
  url: remoteEndpoint,
  headers: httpHeaders.optional(),
});

const stdio = z.object({
  type: z.literal("stdio"),
  command: text.min(1),
  args: strings.optional(),
  env: stringMap.optional(),
  cwd: text.optional(),
  env_vars: strings.optional(),
});

const server = z.discriminatedUnion("type", [stdio, remote]);
export function parseCompatibilityServer(value: unknown) {
  const raw = asObject(value);
  const inferred = raw?.type ?? (raw?.url === undefined ? "stdio" : "http");
  return server.safeParse(
    raw && {
      ...raw,
      type: inferred,
      headers: Object.hasOwn(raw, "headers") ? raw.headers : raw.http_headers,
    },
  );
}

export function compatibilityAuth(raw: unknown) {
  const value = asObject(raw);
  if (!value) return undefined;
  const openai = asObject(own(asObject(value.extensions) ?? {}, "com.openai"));
  const legacy = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        /^(?:oauth(?:_|$)|.*_env_var$)/.test(key) ||
        ["http_headers_helper", "env_http_headers", "scopes"].includes(key),
    ),
  );
  const declaration = openai && own(openai, "auth");
  if (declaration === undefined && !Object.keys(legacy).length) return undefined;
  return {
    ...(declaration !== undefined && { declaration }),
    ...(Object.keys(legacy).length && { legacy }),
  };
}

export const interfaceText = z.object({
  displayName: text.optional(),
  shortDescription: text.optional(),
  longDescription: text.optional(),
  developerName: text.optional(),
  category: text.optional(),
  capabilities: strings.optional(),
  brandColor: text.optional(),
  brandColorDark: text.optional(),
  websiteURL: text.optional(),
  supportURL: text.optional(),
  privacyPolicyURL: text.optional(),
  termsOfServiceURL: text.optional(),
  defaultPrompt: z.union([text, strings]).optional(),
});

export const hostedApp = z.object({
  id: text.trim().min(1),
  category: text.optional(),
  optional: z.boolean().optional(),
  required: z.boolean().optional(),
  capabilities: strings.optional(),
});
