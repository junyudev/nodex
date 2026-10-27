/* @effect-diagnostics asyncFunction:off -- Behavioral shell tests exercise the Node process/filesystem boundary directly. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import {
  bindNodexCliShell,
  composeNodexCliShellEnvironment,
  nodexCliShellLaunchArgs,
  prepareNodexCliShell,
  shellQuote,
} from "./NodexCliShell";

const exec = promisify(execFile);
const shells = process.platform === "darwin" ? ["/bin/bash", "/bin/zsh"] : ["/bin/bash"];

async function withShellFixture(
  run: (fixture: {
    root: string;
    userHome: string;
    userBashEnv: string;
    startupLog: string;
    inherited: Record<string, string>;
    compose: (
      name: string,
      inherited: Record<string, string>,
      configured?: Record<string, string>,
    ) => Promise<Record<string, string>>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "nodex shell ' "));
  try {
    const userHome = join(root, "user");
    const userBashEnv = join(userHome, "bash-env");
    const startupLog = join(root, "startup.log");
    await mkdir(userHome);
    await writeFile(startupLog, "");
    const startup = [
      `printf 'user\\n' >> ${shellQuote(startupLog)}`,
      "export USER_SETTING=preserved",
      "export NODEX_HOME=/wrong-profile",
      "export BASH_ENV=/wrong-startup",
      "export NODEX_USER_BASH_ENV=/wrong-startup",
      "nodex() { printf user-cli; }",
      "alias nodex='printf user-alias'",
      "",
    ].join("\n");
    await writeFile(userBashEnv, startup);
    await writeFile(join(userHome, ".zshenv"), startup);
    const executable = join(root, "cli");
    await writeFile(
      executable,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e 'console.log(JSON.stringify({home:process.env.NODEX_HOME,args:process.argv.slice(1),user:process.env.USER_SETTING}))' -- "$@"\n`,
      { mode: 0o700 },
    );
    const inherited = {
      PATH: "/usr/bin:/bin",
      HOME: userHome,
      CODEX_THREAD_ID: "shell-task",
      // Bash 3 treats top-level socket stdin as a remote shell and skips BASH_ENV.
      SHLVL: "1",
    };
    await run({
      root,
      userHome,
      userBashEnv,
      startupLog,
      inherited,
      compose: async (name, environment, configuredEnvironment) => {
        const nodexHome = join(root, name);
        await prepareNodexCliShell(nodexHome);
        await bindNodexCliShell({
          nodexHome,
          threadId: "shell-task",
          executable,
          profileId: name,
          projectId: `${name}-project`,
        });
        return {
          ...environment,
          ...(await composeNodexCliShellEnvironment({
            nodexHome,
            homeDirectory: userHome,
            searchPaths: [],
            inheritedEnvironment: environment,
            configuredEnvironment,
          })),
        };
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const shellContext = async (shell: string, env: Record<string, string>, mode = "-c") => {
  const result = await exec(shell, [mode, "nodex context"], { env, timeout: 5_000 });
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
};

test("Bash without inherited BASH_ENV routes to its own Profile without sourcing user startup", async () => {
  await withShellFixture(async ({ root, compose, inherited, startupLog }) => {
    const environment = await compose("inner", inherited);
    expect(await shellContext("/bin/bash", environment)).toEqual({
      home: join(root, "inner"),
      args: ["--expect-profile", "inner", "--project", "inner-project", "context"],
    });
    expect(environment.NODEX_USER_BASH_ENV).toBe("");
    expect(await readFile(startupLog, "utf8")).toBe("");
  });
});

test.each(shells)(
  "%s preserves user startup and restores routing for subsequent shells",
  async (shell) => {
    await withShellFixture(async ({ compose, inherited, userHome, userBashEnv, startupLog }) => {
      const environment = await compose("inner", {
        ...inherited,
        BASH_ENV: userBashEnv,
        ZDOTDIR: userHome,
      });
      for (const mode of ["-c", "-lc"]) {
        const result = await exec(
          shell,
          [mode, 'test "$NODEX_HOME" = "$EXPECTED_HOME" && /bin/bash -c "nodex context"'],
          { env: { ...environment, EXPECTED_HOME: environment.NODEX_HOME! }, timeout: 5_000 },
        );
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          home: environment.NODEX_HOME,
          user: "preserved",
          args: ["--expect-profile", "inner", "--project", "inner-project", "context"],
        });
      }
      expect((await readFile(startupLog, "utf8")).trim().split("\n")).toEqual([
        "user",
        "user",
        "user",
        "user",
      ]);
    });
  },
);

test.each([true, false])(
  "nested shells unwrap outer routing with user startup = %s",
  async (hasUser) => {
    await withShellFixture(async ({ compose, inherited, userHome, userBashEnv, startupLog }) => {
      const outer = await compose("outer", {
        ...inherited,
        ZDOTDIR: userHome,
        ...(hasUser ? { BASH_ENV: userBashEnv } : {}),
      });
      // Capture a real exported outer function as well as its wrapper metadata.
      const captured = await exec(
        "/bin/bash",
        ["-c", `exec ${shellQuote(process.execPath)} -p 'JSON.stringify(process.env)'`],
        { env: outer, timeout: 5_000 },
      );
      const outerEnvironment: Record<string, string> = JSON.parse(captured.stdout);
      expect((await shellContext("/bin/sh", outerEnvironment)).home).toBe(outer.NODEX_HOME);
      const inner = await compose("inner", outerEnvironment);
      expect(inner.NODEX_USER_BASH_ENV).toBe(hasUser ? userBashEnv : "");
      expect(inner.NODEX_USER_ZDOTDIR).toBe(userHome);
      // If an outer wrapper is ever sourced, fail before it can recurse or route a command.
      await writeFile(outer.BASH_ENV!, "return 97\n");
      await writeFile(join(outer.ZDOTDIR!, ".zshenv"), "return 98\n");
      await writeFile(startupLog, "");
      for (const shell of [...shells, "/bin/sh"]) {
        const actual = await shellContext(shell, inner);
        expect(actual.home).toBe(inner.NODEX_HOME);
        expect(actual.args).toEqual([
          "--expect-profile",
          "inner",
          "--project",
          "inner-project",
          "context",
        ]);
      }
      const expectedSources = (hasUser ? 1 : 0) + (shells.includes("/bin/zsh") ? 1 : 0);
      expect(await readFile(startupLog, "utf8")).toBe("user\n".repeat(expectedSources));
    });
  },
);

test("configured user startup overrides inherited wrappers through the runtime policy", async () => {
  await withShellFixture(async ({ root, compose, inherited, userHome, userBashEnv }) => {
    const outer = await compose("outer", inherited);
    const codexHome = join(root, "codex");
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      `[shell_environment_policy.set]\nBASH_ENV=${JSON.stringify(userBashEnv)}\nZDOTDIR=${JSON.stringify(userHome)}\nPATH="/usr/bin:/bin"\nNODEX_HOME="/wrong-profile"\n`,
    );
    const inner = await compose("inner", inherited);
    const args = await nodexCliShellLaunchArgs({
      nodexHome: inner.NODEX_HOME!,
      codexHome,
      homeDirectory: userHome,
      searchPaths: [],
      inheritedEnvironment: outer,
    });
    const policy = Object.fromEntries(
      args
        .filter((_, i) => i % 2 === 1)
        .map((entry) => {
          const equal = entry.indexOf("=");
          return [
            entry.slice("shell_environment_policy.set.".length, equal),
            JSON.parse(entry.slice(equal + 1)) as string,
          ];
        }),
    );
    for (const shell of shells) {
      expect(await shellContext(shell, { ...outer, ...policy })).toMatchObject({
        home: inner.NODEX_HOME,
        user: "preserved",
        args: ["--expect-profile", "inner", "--project", "inner-project", "context"],
      });
    }
  });
});
