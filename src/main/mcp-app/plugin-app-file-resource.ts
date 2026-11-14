import type { AgentPluginFailure } from "../../shared/agent-plugins/ipc";
import type { WorkspaceFileBinaryReadResult } from "../../shared/types";

export const PLUGIN_FILE_RESOURCE_EXTENSION = "openai/resource";

export type PluginFileResourceRequest =
  | { readonly method: "resources/read"; readonly representation: "text" | "blob" }
  | { readonly method: "resources/subscribe" | "resources/unsubscribe" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Only the granted URI enters the workspace-file owner. All writes fail before file access. */
export function resolvePluginFileResourceRequest(
  grant: string,
  method: string,
  raw: unknown,
): PluginFileResourceRequest | AgentPluginFailure {
  if (method === "openai/resources/write") {
    return {
      code: "unsupported",
      message: "Writing plugin file resources is not yet available.",
    } as const;
  }
  const params = record(raw);
  if (params?.uri !== grant) {
    return {
      code: "resource_not_granted",
      message: "This resource is outside the app’s file grant.",
    } as const;
  }
  if (method === "resources/subscribe" || method === "resources/unsubscribe")
    return { method } as const;
  if (method !== "resources/read")
    return { code: "unsupported", message: "This resource operation is unsupported." } as const;
  const representation = record(
    record(params._meta)?.[PLUGIN_FILE_RESOURCE_EXTENSION],
  )?.representation;
  if (representation !== undefined && representation !== "text" && representation !== "blob")
    return { code: "invalid_input", message: "Choose text or blob representation." } as const;
  return { method, representation: representation ?? "blob" } as const;
}

export function pluginFileReadResult(
  uri: string,
  bytes: WorkspaceFileBinaryReadResult,
  representation: "text" | "blob",
) {
  if (bytes.contentsBase64 === null) return null;
  let body: { text: string } | { blob: string } = { blob: bytes.contentsBase64 };
  if (representation === "text") {
    try {
      body = {
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          Buffer.from(bytes.contentsBase64, "base64"),
        ),
      };
    } catch {
      return null;
    }
  }
  return {
    contents: [
      {
        uri,
        ...body,
        mimeType: bytes.mimeType,
        _meta: { [PLUGIN_FILE_RESOURCE_EXTENSION]: { writable: false } },
      },
    ],
  };
}
