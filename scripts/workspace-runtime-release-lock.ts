import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { WORKSPACE_RUNTIME_DISTRIBUTION_ID } from "../src/shared/workspace-dependency-runtime";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const workspaceSourceAssetSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.+-]+$/u),
  url: z.url().refine((url) => new URL(url).protocol === "https:"),
  sha256,
  size: z.number().int().positive(),
});
const source = z.object({
  distributionId: z.string().regex(WORKSPACE_RUNTIME_DISTRIBUTION_ID),
  pythonVersion: z.string().regex(/^3\.13\.\d+$/u),
  pythonRelease: z.string().min(1),
  targets: z.strictObject({
    arm64: z.strictObject({
      python: workspaceSourceAssetSchema,
      wheels: z
        .array(
          z.strictObject({
            package: z.string(),
            version: z.string(),
            ...workspaceSourceAssetSchema.shape,
          }),
        )
        .min(1),
    }),
  }),
});
const releaseAsset = z.strictObject({
  assetName: z.string(),
  url: z.string().nullable(),
  archiveSize: z.number().int().positive(),
  archiveSha256: sha256,
  manifestSha256: sha256,
  unpackedBytes: z.number().int().positive(),
});
export type WorkspaceRuntimeReleaseAsset = z.infer<typeof releaseAsset>;

export const workspaceRuntimeAssetName = (distributionId: string) =>
  `nodex-workspace-runtime-${distributionId}-darwin-arm64.tar.gz`;

export const workspaceRuntimeLockSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    ...source.shape,
    release: z.strictObject({
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      tag: z.string(),
      assets: z.strictObject({ "darwin-arm64": releaseAsset.nullable() }),
    }),
  })
  .superRefine(({ distributionId, release }, ctx) => {
    const tagPrefix = `workspace-runtime-v${distributionId}`;
    const suffix = release.tag.slice(tagPrefix.length);
    if (!release.tag.startsWith(tagPrefix) || (suffix !== "" && !/^-[1-9]\d*$/u.test(suffix))) {
      ctx.addIssue({
        code: "custom",
        path: ["release", "tag"],
        message: "Workspace runtime tag must name the distribution",
      });
    }
    const asset = release.assets["darwin-arm64"];
    if (!asset) return;
    const assetName = workspaceRuntimeAssetName(distributionId);
    const url = `https://github.com/${release.repository}/releases/download/${release.tag}/${assetName}`;
    if (asset.assetName !== assetName || (asset.url !== null && asset.url !== url)) {
      ctx.addIssue({
        code: "custom",
        path: ["release", "assets", "darwin-arm64"],
        message: "Workspace runtime asset identity does not match the release",
      });
    }
  });

export const readWorkspaceRuntimeLock = (file: string) =>
  workspaceRuntimeLockSchema.parse(JSON.parse(readFileSync(file, "utf8")));

// Keep staged closures keyed to their source inputs. Publishing an already-built archive
// cannot change the manifest digest inside that archive or invalidate a staged closure.
export const workspaceRuntimeSourceDigest = (lock: z.infer<typeof workspaceRuntimeLockSchema>) =>
  createHash("sha256")
    .update(`${JSON.stringify({ schemaVersion: 1, ...source.parse(lock) }, null, 2)}\n`)
    .digest("hex");
