import { appComponentCatalog } from "../../src/main/app-components/AppComponentCatalog";
import { appComponentManifestSchema } from "../../src/shared/app-component-manifest";
import type { BuildIdentity } from "./model";

export function macComponentManifest({
  version,
  buildVersion,
}: Pick<BuildIdentity, "version" | "buildVersion">) {
  return appComponentManifestSchema.parse({
    schemaVersion: 1,
    version,
    buildVersion,
    components: appComponentCatalog({ platform: "darwin", arch: "arm64", isPackaged: true }),
  });
}
