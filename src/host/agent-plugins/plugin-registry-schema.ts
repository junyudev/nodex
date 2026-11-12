import { z } from "zod";
import path from "node:path";
import {
  pluginInstallationId,
  type PluginRegistry,
} from "../../shared/agent-plugins/installation-registry";
import type { AgentPluginPackage } from "../../shared/agent-plugins/types";
import { compatibilityManifest, hostedApp } from "../../shared/agent-plugins/compatibility";
import { httpHeaders, remoteEndpoint } from "../../shared/agent-plugins/portable-1.0.0";
import { jsonObject, stringMap, strings, text } from "../../shared/agent-plugins/validation";

const nonblank = text.refine((value) => value.trim().length > 0);
const digest = text.regex(/^[a-f0-9]{64}$/);

const diagnostic = z.strictObject({
  code: z.enum([
    "unknown-manifest-field",
    "invalid-extensions",
    "invalid-component",
    "invalid-skill",
    "invalid-server",
    "unsupported-version",
    "unsafe-path",
    "invalid-vendor-data",
  ]),
  path: text,
  message: text,
  field: text.optional(),
  server: text.optional(),
});

const transport = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stdio"),
    command: text.min(1),
    args: strings,
    env: stringMap,
    cwd: text,
  }),
  z.strictObject({
    type: z.enum(["streamable-http", "sse"]),
    url: remoteEndpoint,
    headers: httpHeaders,
  }),
]);

const packageDescription = z.strictObject({
  identity: compatibilityManifest,
  layout: z.enum(["portable-1.0.0", "codex", "claude"]),
  vendorSource: z.enum(["openai-extension", "codex-manifest"]).optional(),
  presentation: z
    .strictObject({
      displayName: text.optional(),
      shortDescription: text.optional(),
      longDescription: text.optional(),
      developerName: text.optional(),
      category: text.optional(),
      capabilities: strings.optional(),
      defaultPrompts: strings.optional(),
      brandColor: text.optional(),
      brandColorDark: text.optional(),
      websiteURL: text.optional(),
      supportURL: text.optional(),
      privacyPolicyURL: text.optional(),
      termsOfServiceURL: text.optional(),
      composerIcon: text.optional(),
      composerIconDark: text.optional(),
      logo: text.optional(),
      logoDark: text.optional(),
      screenshots: strings.optional(),
    })
    .optional(),
  onboardingSkill: text.optional(),
  skills: z.array(
    z.strictObject({
      name: text,
      description: text,
      directory: text,
      valid: z.boolean(),
      diagnostics: z.array(diagnostic),
    }),
  ),
  mcpServers: z.array(
    z.strictObject({
      key: text,
      transport,
      variables: z.array(
        z.strictObject({
          name: text,
          field: z.enum(["command", "args", "env", "cwd", "url", "headers"]),
          token: text,
          kind: z.enum(["placeholder", "inherited-env"]),
        }),
      ),
      vendorAuth: z
        .strictObject({ declaration: z.json().optional(), legacy: jsonObject.optional() })
        .optional(),
    }),
  ),
  hooks: z.array(
    z.strictObject({
      source: z.strictObject({ kind: z.enum(["file", "manifest"]), path: text }),
      events: z.array(z.strictObject({ name: text, commands: strings })),
    }),
  ),
  apps: z.array(hostedApp.strict().extend({ kind: z.literal("openai-hosted"), key: text })),
  extensions: jsonObject,
  digest,
  diagnostics: z.array(diagnostic),
}) satisfies z.ZodType<AgentPluginPackage>;

const installation = z
  .strictObject({
    id: digest,
    source: z.strictObject({
      kind: z.literal("local"),
      locator: text.refine((value) => path.isAbsolute(value) && !value.includes("\0")),
    }),
    admission: z.literal("admitted"),
    activeGeneration: z.uuidv4(),
    enabled: z.boolean(),
    projects: z.array(z.strictObject({ spaceId: nonblank, projectId: nonblank })),
    package: packageDescription,
  })
  .refine(
    ({ id, source, package: pkg, projects }) =>
      id === pluginInstallationId(pkg.identity.name, source) &&
      new Set(projects.map(({ spaceId, projectId }) => JSON.stringify([spaceId, projectId])))
        .size === projects.length,
  );

export const pluginRegistrySchema = z
  .strictObject({
    format: z.literal(1),
    revision: z.int().nonnegative(),
    installations: z.array(installation),
  })
  .refine(
    ({ installations }) => new Set(installations.map(({ id }) => id)).size === installations.length,
  ) satisfies z.ZodType<PluginRegistry>;
