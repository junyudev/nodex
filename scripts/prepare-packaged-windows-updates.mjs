import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Arch } from "electron-builder";

const require = createRequire(import.meta.url);

/** All Windows packaging paths, including direct release packaging, share these inputs. */
export default function preparePackagedWindowsUpdates(context) {
  if (context.electronPlatformName !== "win32") return;
  const architecture = Arch[context.arch];
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error("Windows updates require an x64 or arm64 package.");
  }
  execFileSync(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      fileURLToPath(new URL("./windows-update-manifest.ts", import.meta.url)),
      architecture,
    ],
    { cwd: context.packager.projectDir, env: process.env, stdio: "inherit" },
  );
}
