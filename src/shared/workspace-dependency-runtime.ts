import { z } from "zod";

export const WORKSPACE_RUNTIME_MANIFEST = "workspace-runtime-manifest.json";

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((segment) => segment !== ".." && segment !== "." && segment !== ""),
  );
export const workspaceRuntimeManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetPlatform: z.literal("darwin"),
  targetArch: z.enum(["arm64", "x64"]),
  distributionId: z.string().min(1).max(256),
  sourceLockSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pythonVersion: z.string().min(1).max(64),
  pythonExecutable: relativePath,
  pythonSitePackages: relativePath,
  libraries: z
    .array(z.strictObject({ name: z.string(), version: z.string() }))
    .min(1)
    .max(128),
  artifacts: z
    .array(
      z.strictObject({
        path: relativePath,
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        executable: z.boolean(),
      }),
    )
    .min(1)
    .max(30000),
});
export type WorkspaceRuntimeManifest = z.infer<typeof workspaceRuntimeManifestSchema>;

export type WorkspaceDependencies =
  | {
      readonly status: "available";
      readonly distributionId: string;
      readonly node: { readonly executable: string; readonly version: string };
      readonly python: {
        readonly executable: string;
        readonly version: string;
        readonly recommendedArgs: readonly string[];
        readonly sitePackages: string;
      };
      readonly libraries: readonly { readonly name: string; readonly version: string }[];
    }
  | {
      readonly status: "unavailable";
      readonly reason: "not_installed" | "invalid_bundle" | "node_unavailable";
    };
