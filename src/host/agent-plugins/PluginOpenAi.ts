import * as Effect from "effect/Effect";
import { hostedApp, interfaceText } from "../../shared/agent-plugins/compatibility";
import {
  OPENAI_PLUGIN_NAMESPACE,
  type AgentPluginHooks,
  type AgentPluginHostedApp,
  type AgentPluginPresentation,
  type AgentPluginVendorSource,
} from "../../shared/agent-plugins/types";
import {
  asObject,
  own,
  schemaIssues,
  type JsonObject,
} from "../../shared/agent-plugins/validation";
import type { PackageFiles } from "./PackageFiles";
import { declaredPath, readComponentJson, type Diagnose } from "./package-documents";

export interface VendorManifest {
  readonly source: AgentPluginVendorSource;
  readonly path: string;
  readonly data: JsonObject;
}

function resolveFile(
  files: PackageFiles,
  raw: unknown,
  source: string,
  field: string,
  diagnose: Diagnose,
) {
  const path = declaredPath(raw, source, field, diagnose);
  if (!path) return undefined;
  const entry = files.inspect(path);
  if (entry.kind === "file") return entry.path;
  diagnose({
    code:
      entry.kind === "unsafe" || entry.kind === "special" ? "unsafe-path" : "invalid-vendor-data",
    path: source,
    field,
    message: "The declared file is missing or is not a regular package file.",
  });
  return undefined;
}

function presentation(
  files: PackageFiles,
  vendor: VendorManifest,
  diagnose: Diagnose,
): AgentPluginPresentation | undefined {
  const raw = vendor.data.interface;
  if (raw === undefined) return undefined;
  const input = asObject(raw);
  const parsed = interfaceText.safeParse(input);
  const { defaultPrompt, ...metadata } = parsed.success ? parsed.data : {};
  if (!parsed.success) {
    for (const issue of schemaIssues(parsed.error))
      diagnose({
        ...issue,
        field: issue.field ? "interface." + issue.field : "interface",
        code: "invalid-vendor-data",
        path: vendor.path,
      });
  }
  if (!input) return undefined;
  const assets = Object.fromEntries(
    ["composerIcon", "composerIconDark", "logo", "logoDark"].flatMap((key) => {
      if (!Object.hasOwn(input, key)) return [];
      const path = resolveFile(files, input[key], vendor.path, "interface." + key, diagnose);
      return path ? [[key, path]] : [];
    }),
  );
  const screenshots = input.screenshots;
  if (screenshots !== undefined && !Array.isArray(screenshots))
    diagnose({
      code: "invalid-vendor-data",
      path: vendor.path,
      field: "interface.screenshots",
      message: "Expected a list of package paths.",
    });
  return {
    ...metadata,
    ...assets,
    ...(defaultPrompt !== undefined && {
      defaultPrompts: typeof defaultPrompt === "string" ? [defaultPrompt] : defaultPrompt,
    }),
    ...(Array.isArray(screenshots) && {
      screenshots: screenshots.flatMap(
        (item: unknown) =>
          resolveFile(files, item, vendor.path, "interface.screenshots", diagnose) ?? [],
      ),
    }),
  };
}

function summarizeHooks(
  raw: unknown,
  source: AgentPluginHooks["source"],
  diagnose: Diagnose,
): AgentPluginHooks | undefined {
  const config = asObject(raw);
  const events = config && asObject(config.hooks);
  if (!events && (!config || Object.keys(config).length)) {
    diagnose({
      code: "invalid-vendor-data",
      path: source.path,
      field: "hooks",
      message: "Expected a hook event map.",
    });
    return undefined;
  }
  return {
    source,
    events: Object.entries(events ?? {}).map(([name, matchers]) => ({
      name,
      commands: Array.isArray(matchers)
        ? matchers.flatMap((matcher: unknown) => {
            const handlers = asObject(matcher)?.hooks;
            if (!Array.isArray(handlers)) return [];
            return handlers.flatMap((handler: unknown) => {
              const entry = asObject(handler);
              if (entry?.type !== "command") return [];
              return [entry.command, entry.commandWindows].filter(
                (value): value is string => typeof value === "string",
              );
            });
          })
        : [],
    })),
  };
}

const readHooks = Effect.fnUntraced(function* (
  files: PackageFiles,
  vendor: VendorManifest,
  diagnose: Diagnose,
) {
  const declaration = vendor.data.hooks;
  const fallback =
    vendor.source === "openai-extension"
      ? OPENAI_PLUGIN_NAMESPACE + "/hooks/hooks.json"
      : "hooks/hooks.json";
  const sources = Array.isArray(declaration) ? declaration : [declaration];
  const hooks: AgentPluginHooks[] = [];
  for (const source of sources) {
    const inline = asObject(source);
    const path = inline
      ? vendor.path
      : source === undefined
        ? fallback
        : declaredPath(source, vendor.path, "hooks", diagnose);
    if (!path) continue;
    const document = inline
      ? { value: inline }
      : yield* readComponentJson(
          files,
          path,
          diagnose,
          "invalid-vendor-data",
          source === undefined,
        );
    if (!document) continue;
    const summary = summarizeHooks(
      document.value,
      { kind: inline ? "manifest" : "file", path },
      diagnose,
    );
    if (summary) hooks.push(summary);
  }
  return hooks;
});

const readApps = Effect.fnUntraced(function* (
  files: PackageFiles,
  vendor: VendorManifest,
  diagnose: Diagnose,
) {
  const declaration = vendor.data.apps;
  const fallback =
    vendor.source === "openai-extension" ? OPENAI_PLUGIN_NAMESPACE + "/.app.json" : ".app.json";
  const path =
    declaration === undefined ? fallback : declaredPath(declaration, vendor.path, "apps", diagnose);
  if (!path) return [];
  const document = yield* readComponentJson(
    files,
    path,
    diagnose,
    "invalid-vendor-data",
    declaration === undefined,
  );
  if (!document) return [];
  const entries = asObject(asObject(document.value)?.apps);
  if (!entries) {
    diagnose({
      code: "invalid-vendor-data",
      path,
      field: "apps",
      message: "Expected a hosted app map.",
    });
    return [];
  }
  const apps: AgentPluginHostedApp[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const parsed = hostedApp.safeParse(value);
    if (parsed.success) {
      apps.push({ kind: "openai-hosted", key, ...parsed.data });
      continue;
    }
    diagnose({
      code: "invalid-vendor-data",
      path,
      field: "apps." + key,
      message: "Invalid hosted app declaration.",
    });
  }
  return apps;
});

export const readOpenAiPlugin = Effect.fnUntraced(function* (
  files: PackageFiles,
  vendor: VendorManifest | undefined,
  diagnose: Diagnose,
) {
  if (!vendor) return { hooks: [], apps: [] };
  const onboarding = vendor.data.onboardingSkill;
  const onboardingSkill =
    onboarding === undefined
      ? undefined
      : resolveFile(files, onboarding, vendor.path, "onboardingSkill", diagnose);
  return {
    vendorSource: vendor.source,
    presentation: presentation(files, vendor, diagnose),
    onboardingSkill,
    hooks: yield* readHooks(files, vendor, diagnose),
    apps: yield* readApps(files, vendor, diagnose),
  };
});

export function legacyVendor(raw: JsonObject, path: string): VendorManifest {
  const extensions = asObject(raw.extensions);
  const openAi = extensions && asObject(own(extensions, OPENAI_PLUGIN_NAMESPACE));
  const onboardingSkill = openAi?.onboardingSkill ?? raw.onboardingSkill;
  return { source: "codex-manifest", path, data: { ...raw, onboardingSkill } };
}
