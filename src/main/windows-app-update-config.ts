import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { APP_UPDATE_BUILD_VERSION_PATTERN } from "../shared/app-version";
import { APP_UPDATE_PUBLIC_KEY } from "./app-update-trust";

export const windowsUpdateFeedUrls = (architecture: "x64") => ({
  stable: `https://nodex.jyu.app/updates/stable/windows-${architecture}/appcast.xml`,
  nightly: `https://nodex.jyu.app/updates/nightly/windows-${architecture}/appcast.xml`,
});

const manifestFields = {
  schemaVersion: z.literal(1),
  buildVersion: z.string().regex(APP_UPDATE_BUILD_VERSION_PATTERN),
  publicKey: z.literal(APP_UPDATE_PUBLIC_KEY),
};

const manifest = z.discriminatedUnion("updates", [
  z.strictObject({
    ...manifestFields,
    architecture: z.enum(["x64", "arm64"]),
    updates: z.literal("disabled"),
    feedUrls: z.null(),
  }),
  z.strictObject({
    ...manifestFields,
    architecture: z.literal("x64"),
    updates: z.literal("enabled"),
    feedUrls: z.strictObject({ stable: z.string(), nightly: z.string() }),
  }),
]);

export type WindowsAppUpdateConfig = z.infer<typeof manifest>;

export function parseWindowsAppUpdateConfig(value: unknown): WindowsAppUpdateConfig {
  const config = manifest.parse(value);
  if (config.updates === "disabled") return config;
  const expected = windowsUpdateFeedUrls(config.architecture);
  if (config.feedUrls.stable !== expected.stable || config.feedUrls.nightly !== expected.nightly) {
    throw new Error("Packaged Windows update feeds do not match their architecture.");
  }
  return config;
}

export function readWindowsAppUpdateConfig(resourcesPath: string): WindowsAppUpdateConfig {
  const manifestPath = join(resourcesPath, "native", "app-update.json");
  return parseWindowsAppUpdateConfig(JSON.parse(readFileSync(manifestPath, "utf8")));
}
