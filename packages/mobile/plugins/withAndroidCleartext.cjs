const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

const resourceName = "nodex_network_security";

module.exports = function withAndroidCleartext(config) {
  config = withAndroidManifest(config, (config) => {
    const [application] = config.modResults.manifest.application ?? [];
    if (!application) throw new Error("Missing Android manifest application.");

    application.$["android:networkSecurityConfig"] = `@xml/${resourceName}`;
    return config;
  });

  return withDangerousMod(config, [
    "android",
    async (config) => {
      const directory = path.join(config.modRequest.platformProjectRoot, "app/src/main/res/xml");
      // Pairing selects LAN addresses at runtime. Android domain rules match exact hosts,
      // with no subnet or WebSocket-only rules, so a static host allowlist cannot cover them.
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${resourceName}.xml`),
        `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`,
      );
      return config;
    },
  ]);
};
