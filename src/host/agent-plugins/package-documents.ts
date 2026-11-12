import * as Effect from "effect/Effect";
import { PACKAGE_LIMITS, type PackageFiles } from "./PackageFiles";
import { packageRelativePath } from "../../shared/agent-plugins/validation";
import type {
  AgentPluginDiagnostic,
  AgentPluginRejectionReason,
} from "../../shared/agent-plugins/types";

export type Diagnose = (diagnostic: AgentPluginDiagnostic) => void;

type DocumentResult =
  | { status: "read"; value: string }
  | { status: "missing" }
  | { status: "invalid"; unsafe: boolean; message: string };

export const readDocument = Effect.fnUntraced(function* (
  files: PackageFiles,
  relative: string,
): Effect.fn.Return<DocumentResult, AgentPluginRejectionReason> {
  const entry = files.inspect(relative);
  if (entry.kind === "missing" && !files.hasEntry(relative)) return { status: "missing" };
  if (entry.kind !== "file")
    return {
      status: "invalid",
      unsafe: entry.kind === "unsafe" || entry.kind === "special",
      message: "Expected a regular file inside the package.",
    };
  if (entry.size > PACKAGE_LIMITS.documentBytes)
    return {
      status: "invalid",
      unsafe: false,
      message: "The document exceeds the text size limit.",
    };
  const bytes = yield* files.read(entry.path);
  try {
    return { status: "read", value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { status: "invalid", unsafe: false, message: "Expected a UTF-8 document." };
  }
});

export function parseJson(
  text: string,
): { status: "read"; value: unknown } | { status: "invalid"; message: string } {
  try {
    const value: unknown = JSON.parse(text);
    return { status: "read", value };
  } catch {
    return { status: "invalid", message: "The document contains malformed JSON." };
  }
}

export const readComponentJson = Effect.fnUntraced(function* (
  files: PackageFiles,
  path: string,
  diagnose: Diagnose,
  code: "invalid-component" | "invalid-vendor-data",
  optional: boolean,
) {
  const document = yield* readDocument(files, path);
  if (document.status === "missing") {
    if (!optional) diagnose({ code, path, message: "The declared file is missing." });
    return undefined;
  }
  if (document.status === "invalid") {
    diagnose({ code: document.unsafe ? "unsafe-path" : code, path, message: document.message });
    return undefined;
  }
  const parsed = parseJson(document.value);
  if (parsed.status === "read") return { value: parsed.value };
  diagnose({ code, path, message: parsed.message });
  return undefined;
});

export function declaredPath(
  value: unknown,
  path: string,
  field: string,
  diagnose: Diagnose,
  requirePrefix = true,
) {
  const normalized = typeof value === "string" ? packageRelativePath(value) : undefined;
  if (normalized && (!requirePrefix || (typeof value === "string" && value.startsWith("./"))))
    return normalized;
  diagnose({
    code: "unsafe-path",
    path,
    field,
    message: "Expected a package-relative path without traversal.",
  });
  return undefined;
}
