/* @effect-diagnostics asyncFunction:off newPromise:off preferSchemaOverJson:off -- Behavioral process/filesystem admission tests use the Node Adapter directly. */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import {
  agentProcessLaunch,
  isAgentProviderVariable,
  scrubHostAgentEnvironment,
} from "../../../host/HostAgentPolicy";
import { parse as parseToml } from "smol-toml";
import {
  composeNodexCliShellEnvironment,
  prepareNodexCliShell,
  nodexCliShellLaunchArgs,
} from "./NodexCliShell";
import { hostListenerWarning, verifyHostSecrets } from "./HostSecurity";

const exec = promisify(execFile);

test("an Agent shell receives no host secrets or host configuration in its environment", async () => {
  const coreHome = "/private/nodex-space";
  const environment = scrubHostAgentEnvironment(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      NODEX_HOME: coreHome,
      NODEX_CORE_AUTH: "private-capability",
      CORE_AUTH_PATH: `${coreHome}/run/core/core.auth`,
      NODE_OPTIONS: "--require /private/inject.js",
      BASH_ENV: "/private/host-startup",
      ARBITRARY_SECRET: "host-secret",
      TMPDIR: `${coreHome}/tmp`,
    },
    coreHome,
  );
  const allowed = { PATH: "/usr/bin:/bin", HOME: "/home/operator" };
  expect(environment).toEqual(allowed);
  // Windows supplies required system variables when spawning a child with a custom environment.
  const observe = async (env: NodeJS.ProcessEnv) => {
    const { stdout } = await exec(
      process.execPath,
      ["-e", "console.log(JSON.stringify(process.env))"],
      { env, timeout: 5_000 },
    );
    return JSON.parse(stdout) as Record<string, string>;
  };
  const [observed, baseline] = await Promise.all([observe(environment), observe(allowed)]);
  expect(observed).toEqual(baseline);
  expect(isAgentProviderVariable("ANTHROPIC_API_KEY", "provider-credential", coreHome)).toBe(true);
  expect(isAgentProviderVariable("NODEX_CORE_AUTH", "secret", coreHome)).toBe(false);
  expect(isAgentProviderVariable("CUSTOM_PATH", `${coreHome}/run/core/core.auth`, coreHome)).toBe(
    false,
  );
});

test.skipIf(process.platform === "win32")(
  "headless CLI shells exclude host startup files and configured administration variables",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex-host-shell-"));
    try {
      const marker = join(root, "host-startup-ran");
      const startup = join(root, "host-startup");
      await writeFile(startup, `touch '${marker}'`);
      const coreHome = join(root, "private-core");
      const executionHome = join(root, "execution");
      await prepareNodexCliShell(executionHome);
      const inherited = {
        PATH: "/usr/bin:/bin",
        HOME: root,
        BASH_ENV: startup,
        ZDOTDIR: root,
        NODEX_HOME: coreHome,
        NODEX_CORE_AUTH: "private-host-capability",
      };
      const shell = await composeNodexCliShellEnvironment({
        nodexHome: executionHome,
        privateCoreHome: coreHome,
        platform: process.platform,
        searchPaths: [],
        homeDirectory: root,
        inheritedEnvironment: inherited,
        configuredEnvironment: {
          BASH_ENV: startup,
          ZDOTDIR: root,
          NODEX_CORE_AUTH: "private-host-capability",
          CUSTOM_PATH: coreHome,
        },
      });
      const codexHome = join(root, "codex");
      await mkdir(codexHome);
      await writeFile(
        join(codexHome, "config.toml"),
        `[shell_environment_policy.set]\nNODEX_CORE_AUTH="private-host-capability"\nANTHROPIC_API_KEY="provider-key"\nBASH_ENV=${JSON.stringify(startup)}\n`,
      );
      const overrides = await nodexCliShellLaunchArgs({
        nodexHome: executionHome,
        privateCoreHome: coreHome,
        codexHome,
        platform: process.platform,
        searchPaths: [],
        homeDirectory: root,
        inheritedEnvironment: inherited,
      });
      const nativePolicy = parseToml(overrides[1]!);
      expect(nativePolicy.shell_environment_policy).toMatchObject({
        set: { ANTHROPIC_API_KEY: "provider-key" },
      });
      expect(JSON.stringify(nativePolicy)).not.toContain("private-host-capability");
      expect(JSON.stringify(nativePolicy)).not.toContain(startup);
      expect(Object.values(shell).some((value) => value.includes(coreHome))).toBe(false);
      const { stdout } = await exec("/bin/bash", ["--noprofile", "--norc", "-c", "env"], {
        env: { ...scrubHostAgentEnvironment(inherited, coreHome), ...shell },
        timeout: 5_000,
      });
      expect(stdout).not.toContain("private-host-capability");
      expect(stdout).not.toContain(coreHome);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a configured Agent Runner wraps the executable without evaluating shell expressions", async () => {
  const home = await mkdtemp(join(tmpdir(), "nodex-runner-policy-"));
  try {
    const wrapper = join(home, "runner.cjs");
    const observed = join(home, "launch.json");
    await writeFile(
      wrapper,
      "const fs = require('node:fs'); const cp = require('node:child_process'); " +
        "fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3, 5))); " +
        "const result = cp.spawnSync(process.argv[5], process.argv.slice(6), {stdio:'inherit'}); " +
        "process.exit(result.status ?? 1);",
    );
    const literal = "$(touch forbidden) ; $HOME";
    const launch = agentProcessLaunch(
      process.execPath,
      ["-e", "console.log(process.argv[1])", literal],
      {
        user: "test-runner",
        launcher: [process.execPath, wrapper, observed, "--user", "test-runner"],
      },
    );
    const { stdout } = await exec(launch.executable, [...launch.args], { timeout: 5_000 });
    expect(stdout.trim()).toBe(literal);
    expect(JSON.parse(await readFile(observed, "utf8"))).toEqual(["--user", "test-runner"]);
    expect(agentProcessLaunch("node", ["entry.js"])).toEqual({
      executable: "node",
      args: ["entry.js"],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["127.0.0.1:8443", "127.100.0.1:0", "[::1]:8443"])(
  "same-user Agents may listen on loopback %s with a status warning",
  (address) =>
    expect(hostListenerWarning({ address, allowSameUserAgents: false })).toMatch(/host user/u),
);

test.each(["0.0.0.0:8443", "[::]:8443", "192.168.1.5:8443"])(
  "listening beyond loopback on %s requires isolation or explicit acknowledgement",
  (address) => {
    expect(() => hostListenerWarning({ address, allowSameUserAgents: false })).toThrow(
      /agentRunner/u,
    );
    expect(hostListenerWarning({ address, allowSameUserAgents: true })).toMatch(/private files/u);
    expect(
      hostListenerWarning({
        address,
        allowSameUserAgents: false,
        agentRunner: { user: "agent", launcher: ["not-executed"] },
      }),
    ).toBeNull();
  },
);

test.each(["localhost:8443", "0.0.0.0:99999", "https://127.0.0.1:8443"])(
  "listener admission refuses ambiguous addresses: %s",
  (address) =>
    expect(() => hostListenerWarning({ address, allowSameUserAgents: true })).toThrow(
      /numeric IP/u,
    ),
);

test.skipIf(process.platform === "win32")(
  "host secret admission refuses broader file permissions and aliases without repairing them",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "nodex-host-security-"));
    const coreExecutable = requiredNativeExecutable("core-server");
    try {
      await mkdir(join(home, "run", "core"), { recursive: true, mode: 0o700 });
      await mkdir(join(home, "team-transport"), { mode: 0o700 });
      const secrets = ["nodex.db", "run/core/core.auth", "team-transport/server-identity.pem"];
      for (const secret of secrets) await writeFile(join(home, secret), "secret", { mode: 0o600 });
      await verifyHostSecrets(home, coreExecutable);
      for (const secret of secrets) {
        await chmod(join(home, secret), 0o640);
        await expect(verifyHostSecrets(home, coreExecutable)).rejects.toThrow();
        await chmod(join(home, secret), 0o600);
      }
      const auth = join(home, "run/core/core.auth");
      await rm(auth);
      await symlink(join(home, "nodex.db"), auth);
      await expect(verifyHostSecrets(home, coreExecutable)).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
