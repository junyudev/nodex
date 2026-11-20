import { expect, test } from "vite-plus/test";
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
