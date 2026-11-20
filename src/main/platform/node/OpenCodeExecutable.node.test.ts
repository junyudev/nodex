import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vitest";
import { inheritedHostShellEnvironment } from "../../host-runtime/HostShellEnvironment";
import { resolveOpenCodeLaunch } from "./OpenCodeExecutable";

layer(NodeServices.layer)((it) => {
  it.effect.skipIf(process.platform === "win32")(
    "discovers a new official installation and continues honoring configured PATH and binaries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "nodex-opencode-executable-",
        });
        const cfg = {
          binaryPath: "opencode",
          inheritedEnvironment: { PATH: "/usr/bin" },
          environment: {},
          homeDirectory,
          platform: "darwin",
          systemInstallDirectories: [],
        };
        const shell = inheritedHostShellEnvironment(cfg.inheritedEnvironment);
        expect((yield* resolveOpenCodeLaunch(cfg, shell)).binaryPath).toBe("opencode");

        const directory = path.join(homeDirectory, ".opencode", "bin");
        const binaryPath = path.join(directory, "opencode");
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(binaryPath, 0o755);

        expect((yield* resolveOpenCodeLaunch(cfg, shell)).binaryPath).toBe(binaryPath);
        const environment = { PATH: "" };
        expect(yield* resolveOpenCodeLaunch({ ...cfg, environment }, shell)).toEqual({
          binaryPath: "opencode",
          environment,
        });
        expect(
          (yield* resolveOpenCodeLaunch({ ...cfg, binaryPath: "./my-opencode" }, shell)).binaryPath,
        ).toBe("./my-opencode");
        expect(
          (yield* resolveOpenCodeLaunch({ ...cfg, serverUrl: "https://example.com/" }, shell))
            .binaryPath,
        ).toBe("opencode");
      }).pipe(Effect.scoped),
  );
});
