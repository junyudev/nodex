// @effect-diagnostics strictEffectProvide:off
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import {
  make,
  openCodeInstallEnvironment,
  type OpenCodeInstallHost,
  type OpenCodeInstallOutput,
} from "./OpenCodeInstallPlatform";

const write = (path: string, text: string, executable = false) =>
  Effect.tryPromise(() =>
    mkdir(join(path, ".."), { recursive: true }).then(() =>
      writeFile(path, text, { mode: executable ? 0o755 : 0o600 }),
    ),
  );
const executable = (path: string, version: string) =>
  write(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, true);
const fixture = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      mkdtemp(join(tmpdir(), "nodex-opencode-install-")).then((path) => realpath(path)),
    ),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const tools = join(root, "tools");
  yield* Effect.tryPromise(() => mkdir(tools));
  const host: OpenCodeInstallHost = {
    homeDirectory: root,
    platform: "darwin",
    environment: { PATH: tools, SHELL: "/bin/zsh" },
  };
  return { root, tools, host, target: join(root, ".opencode", "bin", "opencode") };
});
/** A local curl double supplies a harmless installer; these tests never download or install OpenCode. */
const installer = (tools: string, content: string) =>
  write(
    join(tools, "curl"),
    `#!/bin/sh
[ "$#" = 2 ] && [ "$1" = '-fsSL' ] && [ "$2" = 'https://opencode.ai/v2/install' ] || exit 91
/bin/cat <<'INSTALLER'
${content}
INSTALLER
`,
    true,
  );
const installedBinary = `
/bin/mkdir -p "$HOME/.opencode/bin"
/bin/cat > "$HOME/.opencode/bin/opencode" <<'BINARY'
#!/bin/sh
printf '%s\\n' 'opencode v2.0.25'
BINARY
/bin/chmod 755 "$HOME/.opencode/bin/opencode"
`;
it.effect("uses the host home and excludes native Profile and installer version overrides", () =>
  Effect.sync(() => {
    const environment = openCodeInstallEnvironment({
      homeDirectory: "/real-user",
      platform: "darwin",
      environment: {
        HOME: "/native-profile",
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
        XDG_CONFIG_HOME: "/native-profile/config",
        OPENCODE_TEST_HOME: "/native-profile",
        OPENCODE_CONFIG_CONTENT: "{}",
        VERSION: "1.2.24",
      },
    });
    expect(environment).toEqual({ HOME: "/real-user", PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" });
  }),
);

it.live.skipIf(process.platform === "win32")(
  "discovers explicit, login PATH and official installs without replacing an existing executable",
  () =>
    Effect.gen(function* () {
      const { root, host, target } = yield* fixture;
      const explicit = join(root, "custom", "opencode");
      const loginDirectory = join(root, "login-tools");
      yield* executable(explicit, "1.19.2");
      const managedBinary = join(root, "package-version", "opencode");
      yield* executable(managedBinary, "opencode v2.0.24");
      yield* Effect.tryPromise(() =>
        mkdir(loginDirectory).then(() => symlink(managedBinary, join(loginDirectory, "opencode"))),
      );
      yield* executable(target, "opencode v2.0.25");
      const output: OpenCodeInstallOutput[] = [];
      const platform = yield* make(host, Effect.succeed(loginDirectory));
      expect(yield* platform.probe(explicit)).toEqual({ binaryPath: explicit, version: "1.19.2" });
      expect(
        yield* platform.install(
          (event) =>
            Effect.sync(() => {
              output.push(event);
            }),
          explicit,
        ),
      ).toEqual({
        binaryPath: explicit,
        version: "1.19.2",
      });
      expect(output).toEqual([]);
      expect(yield* platform.probe()).toEqual({
        binaryPath: join(loginDirectory, "opencode"),
        version: "2.0.24",
      });
      const nativeOnly = yield* make(host);
      expect(yield* nativeOnly.probe()).toEqual({ binaryPath: target, version: "2.0.25" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "streams both outputs before completion and returns the installed absolute path without a shell restart",
  () =>
    Effect.gen(function* () {
      const { root, tools, host, target } = yield* fixture;
      yield* installer(
        tools,
        `
[ "$#" = 0 ] || exit 92
/usr/bin/env > "$HOME/installer-environment"
printf 'Downloading\\n'
printf 'Extracting\\n' >&2
while [ ! -f "$HOME/release" ]; do /bin/sleep 0.01; done
${installedBinary}
printf 'export PATH="$HOME/.opencode/bin:$PATH"\\n' > "$HOME/.zshrc"
`,
      );
      const platform = yield* make({
        ...host,
        environment: {
          ...host.environment,
          HOME: "/native-profile",
          XDG_CONFIG_HOME: "/native-profile/config",
          OPENCODE_TEST_HOME: "/native-profile",
        },
      });
      const output: OpenCodeInstallOutput[] = [];
      const result = yield* platform.install((event) =>
        Effect.sync(() => {
          output.push(event);
        }).pipe(
          Effect.andThen(
            event.stream === "stdout" && event.data.includes("Downloading")
              ? write(join(root, "release"), "ready").pipe(Effect.orDie)
              : Effect.void,
          ),
        ),
      );
      expect(result).toEqual({ binaryPath: target, version: "2.0.25" });
      expect(
        output.some((event) => event.stream === "stdout" && event.data.includes("Downloading")),
      ).toBe(true);
      expect(
        output.some((event) => event.stream === "stderr" && event.data.includes("Extracting")),
      ).toBe(true);
      const captured = yield* Effect.tryPromise(() =>
        readFile(join(root, "installer-environment"), "utf8"),
      );
      const variables = Object.fromEntries(
        captured
          .trim()
          .split("\n")
          .map((line) => {
            const equals = line.indexOf("=");
            return [line.slice(0, equals), line.slice(equals + 1)];
          }),
      );
      expect(variables.HOME).toBe(root);
      expect(variables.XDG_CONFIG_HOME).toBeUndefined();
      expect(variables.OPENCODE_TEST_HOME).toBeUndefined();
      expect(yield* Effect.tryPromise(() => readFile(join(root, ".zshrc"), "utf8"))).toContain(
        ".opencode/bin",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "does not overwrite a non-executable installation path",
  () =>
    Effect.gen(function* () {
      const { host, target } = yield* fixture;
      yield* write(target, "keep existing content");
      const platform = yield* make(host);
      const result = yield* Effect.result(platform.install(() => Effect.void));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "existing-installation" },
      });
      expect(yield* Effect.tryPromise(() => readFile(target, "utf8"))).toBe(
        "keep existing content",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "protects legacy launcher files replaced by the official installer",
  () =>
    Effect.gen(function* () {
      for (const name of ["opencode2", "opencode2.exe", "opencode2.cmd"]) {
        const { root, host } = yield* fixture;
        const legacy = join(root, ".opencode", "bin", name);
        yield* write(legacy, "keep legacy launcher");
        const platform = yield* make(host);
        const result = yield* Effect.result(platform.install(() => Effect.void));
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: "existing-installation" },
        });
        expect(yield* Effect.tryPromise(() => readFile(legacy, "utf8"))).toBe(
          "keep legacy launcher",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "reports download failure even when the shell receiving its pipe exits successfully",
  () =>
    Effect.gen(function* () {
      const { tools, host } = yield* fixture;
      yield* write(join(tools, "curl"), "#!/bin/sh\nexit 42\n", true);
      const platform = yield* make(host);
      const result = yield* Effect.result(platform.install(() => Effect.void));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "process", message: "OpenCode command exited with code 42." },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "bounds streamed output and rejects an executable that does not report an OpenCode version",
  () =>
    Effect.gen(function* () {
      const { tools, host, target } = yield* fixture;
      yield* installer(tools, "/usr/bin/yes output | /usr/bin/head -c 300000");
      const platform = yield* make(host);
      let bytes = 0;
      const overflow = yield* Effect.result(
        platform.install(({ data }) =>
          Effect.sync(() => {
            bytes += Buffer.byteLength(data);
          }),
        ),
      );
      expect(overflow).toMatchObject({ _tag: "Failure", failure: { reason: "output-limit" } });
      expect(bytes).toBeLessThanOrEqual(256 * 1024);
      yield* executable(target, "unrelated-program");
      const invalid = yield* Effect.result(platform.probe());
      expect(invalid).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-version" } });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects unsupported hosts before attempting installation", () =>
  Effect.gen(function* () {
    const platform = yield* make({ homeDirectory: "/user", platform: "win32", environment: {} });
    const result = yield* Effect.result(platform.install(() => Effect.void));
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "unsupported-platform" } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("times out a stalled installer and closes its process Scope", () =>
  Effect.gen(function* () {
    const { host } = yield* fixture;
    const started = yield* Deferred.make<void>();
    let released = false;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released = true;
          }),
        );
        yield* Deferred.succeed(started, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1234),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const platform = yield* make(host).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const running = yield* platform
      .install(() => Effect.void)
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("5 minutes");
    expect(yield* Fiber.join(running)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "timeout" },
    });
    expect(released).toBe(true);
  }).pipe(Effect.scoped),
);
