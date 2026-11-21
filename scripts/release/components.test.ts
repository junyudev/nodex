import { expect, test } from "vite-plus/test";
import codexLock from "../../resources/agent-runtime/codex-app-server.lock.json";

import { appComponentCatalog } from "../../src/main/app-components/AppComponentCatalog";
import { macComponentManifest } from "./components";

test("the macOS Components manifest uses the exact packaged catalog and build identity", () => {
  const identity = { version: "0.2.2", buildVersion: "1.25.24" };
  expect(macComponentManifest(identity)).toEqual({
    schemaVersion: 1,
    ...identity,
    components: appComponentCatalog({ platform: "darwin", arch: "arm64", isPackaged: true }),
  });
});

test("the macOS Components manifest advertises the exact official Codex download", () => {
  const manifest = macComponentManifest({ version: "0.2.2", buildVersion: "1.25.24" });
  const asset = codexLock.builds["darwin-arm64"];
  expect(manifest.components.find(({ id }) => id === "codex")).toMatchObject({
    install: "on-first-use",
    archive: { url: asset.url, size: asset.archiveSize, sha256: asset.archiveSha256 },
    payload: {
      kind: "codex",
      metadataSha256: asset.runtimeMetadataSha256,
      entrypointSha256: asset.entrypointSha256,
    },
  });
});
