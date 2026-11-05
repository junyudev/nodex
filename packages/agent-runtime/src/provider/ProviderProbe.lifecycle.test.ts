import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import { makeCodexInstallation } from "./CodexInstallation.ts";
import * as ModelManifest from "./ModelManifest.ts";

for (const kind of ["claude", "codex", "opencode"] as const) {
  it.live.skipIf(process.platform === "win32")(
    `${kind} catalog commands stay in their owner's process group and drain on interruption`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-catalog-" });
        const binaryPath = `${home}/${kind}`;
        const pidPath = `${home}/probe-pid`;
        yield* fs.writeFileString(
          binaryPath,
          `#!/bin/sh\nprintf '%s' "$$" > '${pidPath}'\nexec /bin/sleep 30\n`,
        );
        yield* fs.chmod(binaryPath, 0o700);
        const environment = { PATH: home, HOME: home };
        const probe: Effect.Effect<
          unknown,
          unknown,
          NodeServices.NodeServices | OpenCodeRuntime.OpenCodeRuntime | Scope.Scope
        > =
          kind === "claude"
            ? checkClaudeProviderStatus(
                Schema.decodeSync(ClaudeSettings)({ binaryPath }),
                undefined,
                environment,
                home,
              )
            : kind === "codex"
              ? makeCodexInstallation({ baseDir: home }).pipe(
                  Effect.flatMap((installation) => installation.resolve()),
                  Effect.provideService(HostProcess.Environment, environment),
                  Effect.provideService(
                    HttpClient.HttpClient,
                    HttpClient.make(() => Effect.die("No network expected")),
                  ),
                  Effect.provide(ModelManifest.layer),
                )
              : OpenCodeRuntime.OpenCodeRuntime.pipe(
                  Effect.flatMap((runtime) =>
                    runtime.runOpenCodeCommand({
                      binaryPath,
                      args: ["models"],
                      cwd: home,
                      environment,
                    }),
                  ),
                );
        const running = yield* probe.pipe(Effect.asVoid, Effect.scoped, Effect.forkChild);
        const pid = yield* fs
          .readFileString(pidPath)
          .pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"));
        const group = (id: string) =>
          execFileSync("/bin/ps", ["-o", "pgid=", "-p", id], { encoding: "utf8" }).trim();
        assert.strictEqual(group(pid), group(String(process.pid)));
        yield* Fiber.interrupt(running);
        assert.throws(() => process.kill(Number(pid), 0));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          OpenCodeRuntime.layer.pipe(
            Layer.provide(OpenCodeServerLedger.layerTest),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
}
