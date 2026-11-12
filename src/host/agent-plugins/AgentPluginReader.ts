import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { compatibilityManifest } from "../../shared/agent-plugins/compatibility";
import {
  PORTABLE_1_0_MANIFEST_SCHEMA,
  portableManifest,
  portableManifestFields,
} from "../../shared/agent-plugins/portable-1.0.0";
import {
  OPENAI_PLUGIN_NAMESPACE,
  type AgentPluginDiagnostic,
  type AgentPluginLayout,
  type AgentPluginReadResult,
  type AgentPluginRejectionReason,
} from "../../shared/agent-plugins/types";
import {
  asObject,
  own,
  schemaIssues,
  type JsonObject,
} from "../../shared/agent-plugins/validation";
import type { PackageFiles, PackageFilesPort } from "./PackageFiles";
import { readPluginMcp } from "./PluginMcp";
import { legacyVendor, readOpenAiPlugin, type VendorManifest } from "./PluginOpenAi";
import { readPluginSkills } from "./PluginSkills";
import { parseJson, readComponentJson, readDocument, type Diagnose } from "./package-documents";

const MANIFESTS = [
  ["plugin.json", "portable-1.0.0"],
  [".codex-plugin/plugin.json", "codex"],
  [".claude-plugin/plugin.json", "claude"],
] as const satisfies readonly (readonly [string, AgentPluginLayout])[];

const portableReaders = new Map([
  [
    PORTABLE_1_0_MANIFEST_SCHEMA,
    {
      manifest: portableManifest,
      manifestFields: portableManifestFields,
    },
  ],
]);

function readExtensions(raw: JsonObject, path: string, diagnose: Diagnose) {
  const extensions = asObject(raw.extensions);
  if (!extensions && Object.hasOwn(raw, "extensions"))
    diagnose({
      code: "invalid-extensions",
      path,
      field: "extensions",
      message: "Expected an extension namespace map.",
    });
  return extensions ?? {};
}

const readVendor = Effect.fnUntraced(function* (
  files: PackageFiles,
  layout: AgentPluginLayout,
  path: string,
  raw: JsonObject,
  extensions: JsonObject,
  diagnose: Diagnose,
): Effect.fn.Return<VendorManifest | undefined, AgentPluginRejectionReason> {
  if (layout === "claude") return undefined;
  if (layout === "codex") return legacyVendor(raw, path);
  const overlay = own(extensions, OPENAI_PLUGIN_NAMESPACE);
  if (overlay !== undefined) {
    const data = asObject(overlay);
    if (data) return { source: "openai-extension", path, data };
    diagnose({
      code: "invalid-vendor-data",
      path,
      field: "extensions." + OPENAI_PLUGIN_NAMESPACE,
      message: "Expected an OpenAI extension object.",
    });
    return undefined;
  }
  const overlayPath = ".codex-plugin/plugin.json";
  const document = yield* readComponentJson(
    files,
    overlayPath,
    diagnose,
    "invalid-vendor-data",
    true,
  );
  if (!document) return undefined;
  const data = asObject(document.value);
  if (data) return legacyVendor(data, overlayPath);
  diagnose({
    code: "invalid-vendor-data",
    path: overlayPath,
    message: "Expected a Codex manifest object.",
  });
  return undefined;
});

const rejected = (...reasons: AgentPluginRejectionReason[]): AgentPluginReadResult => ({
  status: "rejected",
  reasons,
});

export interface AgentPluginReaderService {
  readonly read: (directory: string) => Effect.Effect<AgentPluginReadResult>;
}

export class AgentPluginReader extends Context.Service<
  AgentPluginReader,
  AgentPluginReaderService
>()("nodex/host/AgentPluginReader") {}

export function makeAgentPluginReader(port: PackageFilesPort): AgentPluginReaderService {
  const read = Effect.fn("AgentPluginReader.read")(
    function* (
      directory: string,
    ): Effect.fn.Return<AgentPluginReadResult, AgentPluginRejectionReason> {
      const files = yield* port.open(directory);
      const selected = MANIFESTS.find(
        ([path]) => files.hasEntry(path) || files.inspect(path).kind !== "missing",
      );
      if (!selected)
        return rejected({
          code: "missing-manifest",
          message: "No supported plugin manifest was found.",
        });
      const [path, layout] = selected;
      const document = yield* readDocument(files, path);
      if (document.status !== "read")
        return rejected({
          code:
            document.status === "invalid" && document.unsafe ? "unsafe-path" : "invalid-manifest",
          path,
          message:
            document.status === "invalid" ? document.message : "The package manifest is missing.",
        });

      const json = parseJson(document.value);
      if (json.status === "invalid")
        return rejected({ code: "invalid-manifest", path, message: json.message });
      const raw = asObject(json.value);
      if (!raw)
        return rejected({
          code: "invalid-manifest",
          path,
          message: "Expected a plugin manifest object.",
        });
      const diagnostics: AgentPluginDiagnostic[] = [];
      const diagnose: Diagnose = (diagnostic) => diagnostics.push(diagnostic);
      const schema = own(raw, "$schema");
      const reader =
        layout === "portable-1.0.0" && typeof schema === "string"
          ? portableReaders.get(schema)
          : undefined;
      if (layout === "portable-1.0.0" && !reader)
        return rejected({
          code: typeof schema === "string" && schema ? "unsupported-version" : "invalid-manifest",
          path,
          field: "$schema",
          message:
            typeof schema === "string" && schema
              ? "The declared Agent Plugins schema version is unsupported."
              : "A canonical Agent Plugins manifest schema is required.",
        });
      const identity = (reader?.manifest ?? compatibilityManifest).safeParse(raw);
      if (!identity.success)
        return rejected(
          ...schemaIssues(identity.error).map((issue): AgentPluginRejectionReason => ({
            ...issue,
            code: "invalid-manifest",
            path,
          })),
        );

      for (const field of Object.keys(raw)) {
        if (reader && !reader.manifestFields.has(field))
          diagnose({
            code: "unknown-manifest-field",
            path,
            field,
            message: "The portable manifest does not define this field.",
          });
      }
      const extensions = readExtensions(raw, path, diagnose);
      const vendor = yield* readVendor(files, layout, path, raw, extensions, diagnose);
      const openAi = yield* readOpenAiPlugin(files, vendor, diagnose);
      const skills = yield* readPluginSkills(files, layout, path, own(raw, "skills"), diagnose);
      const mcpServers = yield* readPluginMcp(
        files,
        layout,
        path,
        own(raw, "mcpServers"),
        diagnose,
      );
      const digest = yield* files.digest;
      return {
        status: "loaded",
        package: {
          identity: identity.data,
          layout,
          ...openAi,
          skills,
          mcpServers,
          extensions: Object.fromEntries(
            Object.entries(extensions).filter(
              ([key]) => key !== OPENAI_PLUGIN_NAMESPACE || layout === "claude",
            ),
          ),
          digest,
          diagnostics: [...diagnostics, ...files.diagnostics()],
        },
      };
    },
    Effect.catch((reason) => Effect.succeed(rejected(reason))),
  );
  return AgentPluginReader.of({ read });
}
