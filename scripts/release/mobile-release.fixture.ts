import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MOBILE_BUILD_MANIFEST,
  expectedMobileSigner,
  mobileAppFor,
  mobileArtifactName,
  type MobileBuildManifest,
  type MobilePlatform,
} from "./mobile";
import { sha256File, type ReleaseIdentity } from "./model";

/** One phone build directory as the mobile distribution jobs leave it. */
export function makeMobileBuild(
  root: string,
  platform: MobilePlatform,
  identity: ReleaseIdentity,
  overrides: Partial<MobileBuildManifest> = {},
): string {
  const directory = join(root, `mobile-${platform}`);
  mkdirSync(directory, { recursive: true });
  const name = mobileArtifactName(platform, identity.version);
  const artifactPath = join(directory, name);
  writeFileSync(artifactPath, `${platform}:${identity.version}`);
  const manifest: MobileBuildManifest = {
    schemaVersion: 1,
    platform,
    releaseIdentity: identity,
    app: mobileAppFor(platform, identity),
    artifact: { name, bytes: statSync(artifactPath).size, sha256: sha256File(artifactPath) },
    signer: expectedMobileSigner(platform),
    runner: { image: "test" },
    ...overrides,
  };
  writeFileSync(join(directory, MOBILE_BUILD_MANIFEST), JSON.stringify(manifest));
  return directory;
}

export function makeMobileReleaseFixture(root: string, identity: ReleaseIdentity) {
  return {
    androidDirectory: makeMobileBuild(root, "android", identity),
    iosDirectory: makeMobileBuild(root, "ios", identity),
  };
}
