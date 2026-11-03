import { z } from "zod";
import { APP_UPDATE_BUILD_VERSION_PATTERN, APP_UPDATE_PUBLIC_KEY } from "./app-update-trust";

export const windowsUpdateFeedUrls = (architecture: "x64" | "arm64") => ({
  stable: `https://nodex.jyu.app/updates/stable/windows-${architecture}/appcast.xml`,
  nightly: `https://nodex.jyu.app/updates/nightly/windows-${architecture}/appcast.xml`,
});

const manifest = z
  .object({
    schemaVersion: z.literal(1),
    architecture: z.enum(["x64", "arm64"]),
    buildChannel: z.enum(["disabled", "stable", "nightly"]),
    buildVersion: z.string().regex(APP_UPDATE_BUILD_VERSION_PATTERN),
    feedUrls: z.object({ stable: z.string(), nightly: z.string() }).strict().nullable(),
    publicKey: z.literal(APP_UPDATE_PUBLIC_KEY),
  })
  .strict();

export type WindowsAppUpdateConfig = z.infer<typeof manifest>;

export function parseWindowsAppUpdateConfig(value: unknown): WindowsAppUpdateConfig {
  const config = manifest.parse(value);
  const expected = windowsUpdateFeedUrls(config.architecture);
  if (config.buildChannel === "disabled") {
    if (config.feedUrls !== null) throw new Error("Disabled Windows updates must have no feeds.");
    return config;
  }
  if (config.feedUrls?.stable !== expected.stable || config.feedUrls.nightly !== expected.nightly) {
    throw new Error("Packaged Windows update feeds do not match their architecture.");
  }
  return config;
}
