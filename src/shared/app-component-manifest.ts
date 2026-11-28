import { z } from "zod";
import { APP_COMPONENT_IDS } from "./app-components";
import { APP_UPDATE_BUILD_VERSION_PATTERN, appBuildOrdinal } from "./app-version";
import { isSafeBrowserRuntimeRelativePath } from "./browser-runtime-metadata";

export const APP_COMPONENT_MANIFEST_MAX_BYTES = 256 * 1024;
export const appComponentManifestTarget = z.enum(["darwin-arm64", "win32-x64"]);
export type AppComponentManifestTarget = z.infer<typeof appComponentManifestTarget>;
export const appComponentManifestName = (
  version: string,
  target: AppComponentManifestTarget,
): string =>
  `Nodex-${version}-components-${target === "darwin-arm64" ? "arm64" : "windows-x64"}.json`;

export const appComponentReleaseVersion = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
export const appComponentBuildVersion = z
  .string()
  .regex(APP_UPDATE_BUILD_VERSION_PATTERN)
  .refine((value) => appBuildOrdinal(value) !== null);
export const appComponentArchiveSha = z.string().regex(/^[a-f0-9]{64}$/u);
const bytes = z.number().int().positive();
const archive = z.strictObject({
  assetName: z
    .string()
    .max(255)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/u),
  url: z
    .url({ protocol: /^https$/u })
    .max(4096)
    .refine((value) => {
      const url = URL.parse(value);
      return !!url && !url.username && !url.password && !url.hash;
    }),
  size: bytes,
  sha256: appComponentArchiveSha,
});
const payload = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("desktop-tools"), manifestSha256: appComponentArchiveSha }),
  z.strictObject({
    kind: z.literal("claude-code"),
    executable: z.strictObject({
      path: z.string().max(255).refine(isSafeBrowserRuntimeRelativePath),
      size: bytes,
      sha256: appComponentArchiveSha,
    }),
  }),
  z.strictObject({
    kind: z.literal("codex"),
    metadataSha256: appComponentArchiveSha,
    entrypointSha256: appComponentArchiveSha,
  }),
  z.strictObject({ kind: z.literal("document-tools"), manifestSha256: appComponentArchiveSha }),
]);
const component = z
  .strictObject({
    id: z.enum(APP_COMPONENT_IDS),
    install: z.enum(["at-startup", "on-first-use"]),
    archive,
    unpackedBytes: bytes,
    payload,
  })
  .refine((value) => value.id === value.payload.kind);

export const appComponentManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  target: appComponentManifestTarget,
  version: appComponentReleaseVersion,
  buildVersion: appComponentBuildVersion,
  components: z
    .array(component)
    .max(APP_COMPONENT_IDS.length)
    .refine((values) => new Set(values.map(({ id }) => id)).size === values.length),
});
