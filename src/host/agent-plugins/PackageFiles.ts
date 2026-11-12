import type * as Effect from "effect/Effect";
import type {
  AgentPluginDiagnostic,
  AgentPluginRejectionReason,
} from "../../shared/agent-plugins/types";

export type PackagePath =
  | { readonly kind: "file"; readonly path: string; readonly size: number }
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "missing" | "unsafe" | "special" };

export interface PackageFiles {
  /** Paths here are normalized, package-relative, and use slash separators. */
  readonly inspect: (path: string) => PackagePath;
  readonly hasEntry: (path: string) => boolean;
  readonly children: (directory: string) => readonly string[];
  readonly read: (file: string) => Effect.Effect<Uint8Array, AgentPluginRejectionReason>;
  readonly digest: Effect.Effect<string, AgentPluginRejectionReason>;
  readonly diagnostics: () => readonly AgentPluginDiagnostic[];
}

export interface PackageFilesPort {
  readonly open: (root: string) => Effect.Effect<PackageFiles, AgentPluginRejectionReason>;
}

export const PACKAGE_LIMITS = {
  entries: 10_000,
  depth: 64,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  documentBytes: 2 * 1024 * 1024,
} as const;
