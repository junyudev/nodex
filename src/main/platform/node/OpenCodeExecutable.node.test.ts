import { spawnSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect, test } from "vitest";
import { openCodeExecutableEnvironment } from "./OpenCodeExecutable";

const createHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "nodex-opencode-executable-" });
});
const createExecutable = Effect.fnUntraced(function* (directory: string, output: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(directory, { recursive: true });
  const executable = path.join(directory, "opencode");
  yield* fs.writeFileString(executable, `#!/bin/sh\nprintf '%s' '${output}'\n`);
  yield* fs.chmod(executable, 0o755);
  return executable;
});
const launch = (environment: Readonly<Record<string, string>>) =>
  Effect.sync(() => spawnSync("opencode", [], { env: environment, encoding: "utf8" }));
const options = (homeDirectory: string) => ({
  binaryPath: "opencode",
  inheritedEnvironment: { PATH: `${homeDirectory}/existing-bin` },
  environment: {},
  homeDirectory,
  platform: "darwin",
});

layer(NodeServices.layer)((it) => {
  it.effect.skipIf(process.platform === "win32")(
    "discovers an official installation created after the launch environment was prepared",
    () =>
      Effect.gen(function* () {
        const home = yield* createHome;
        const path = yield* Path.Path;
        const environment = openCodeExecutableEnvironment(options(home));
        expect((yield* launch(environment)).error).toMatchObject({ code: "ENOENT" });

        yield* createExecutable(path.join(home, ".opencode", "bin"), "official");

        expect(yield* launch(environment)).toMatchObject({ status: 0, stdout: "official" });
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "keeps installed commands earlier on PATH ahead of the official fallback",
    () =>
      Effect.gen(function* () {
        const home = yield* createHome;
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const existing = yield* createExecutable(path.join(home, "existing-bin"), "existing");
        yield* createExecutable(path.join(home, ".opencode", "bin"), "official");
        const environment = openCodeExecutableEnvironment(options(home));

        expect(yield* launch(environment)).toMatchObject({ status: 0, stdout: "existing" });
        yield* fs.remove(existing);
        expect(yield* launch(environment)).toMatchObject({ status: 0, stdout: "official" });
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "leaves explicitly configured instance PATH in control of executable discovery",
    () =>
      Effect.gen(function* () {
        const home = yield* createHome;
        const path = yield* Path.Path;
        yield* createExecutable(path.join(home, ".opencode", "bin"), "official");
        const configured = { PATH: path.join(home, "explicit-bin"), TOKEN: "instance-token" };
        const environment = openCodeExecutableEnvironment({
          ...options(home),
          environment: configured,
        });

        expect(environment).toEqual(configured);
        expect((yield* launch(environment)).error).toMatchObject({ code: "ENOENT" });
        yield* createExecutable(configured.PATH, "explicit");
        expect(yield* launch(environment)).toMatchObject({ status: 0, stdout: "explicit" });
      }).pipe(Effect.scoped),
  );
});

test("does not change custom executable commands or unsupported host paths", () => {
  const input = { ...options("/home/user"), environment: { TOKEN: "instance-token" } };
  for (const binaryPath of ["custom-opencode", "/opt/bin/opencode", "~/bin/opencode"])
    expect(openCodeExecutableEnvironment({ ...input, binaryPath })).toEqual(input.environment);
  expect(openCodeExecutableEnvironment({ ...input, platform: "win32" })).toEqual(input.environment);
  expect(openCodeExecutableEnvironment({ ...input, homeDirectory: "" })).toEqual(input.environment);
});

test("preserves an existing official PATH entry and an explicit empty PATH", () => {
  const input = options("/home/user");
  expect(
    openCodeExecutableEnvironment({
      ...input,
      inheritedEnvironment: { PATH: "/home/user/.opencode/bin:/usr/bin" },
    }),
  ).toEqual(input.environment);
  const configured = { PATH: "" };
  expect(openCodeExecutableEnvironment({ ...input, environment: configured })).toEqual(configured);
});
