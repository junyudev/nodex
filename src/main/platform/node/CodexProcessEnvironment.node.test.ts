import { describe, expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { HostShellEnvironment, live as shellLive } from "../../host-runtime/HostShellEnvironment";
import { resolveCodexProcessEnvironment, resolveLocalCodexLaunch } from "./CodexProcessEnvironment";
import { composeNodexCliShellEnvironment, nodexCliShellPaths } from "./NodexCliShell";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import {
  createCodexHomeDirectory,
  readCodexHomeReceipt,
  writeCodexHomeReceipt,
} from "./CodexHomeReceipt";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import release from "../../../../resources/agent-runtime/codex-app-server.lock.json";
import { classifyCodexExecutable, probeCodexExecutable } from "./CodexExecutable";

describe("CodexProcessEnvironment", () => {
  it.effect("Codex uses its account and tool paths over case-variant inherited values", () =>
    Effect.gen(function* () {
      const environment = yield* resolveCodexProcessEnvironment({
        additionalSearchPaths: ["C:\\Nodex\\bin"],
        pathDelimiter: ";",
        codexHome: "C:\\account",
        environment: {
          Path: "old",
          PATH: "current",
          codex_home: "wrong-account",
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
      expect(environment).toEqual({ PATH: "C:\\Nodex\\bin;current", CODEX_HOME: "C:\\account" });
    }),
  );

  it.effect("Windows CLI routing honors a configured Path over the inherited PATH", () =>
    Effect.gen(function* () {
      const environment = yield* Effect.promise(() =>
        composeNodexCliShellEnvironment({
          nodexHome: "profile",
          platform: "win32",
          homeDirectory: "user",
          searchPaths: ["tools"],
          inheritedEnvironment: { PATH: "inherited" },
          configuredEnvironment: { Path: "configured" },
        }),
      );
      expect(environment.PATH).toBe(`${nodexCliShellPaths("profile").bin};tools;configured`);
    }),
  );

  const accountHome = {
    mode: "overlay",
    sharedHome: "/profile/codex",
    effectiveHome: "/profile/account",
    directoryIdentity: null,
    sharedDirectoryIdentity: null,
    sharedEntryNames: [],
  } as const;

  it.effect.each(["captured", "failed"] as const)(
    "resolves the physical Codex launch with %s shell recovery",
    (status) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          shellLive({
            platform: "darwin",
            baseEnvironment: { PATH: "/desktop", HTTPS_PROXY: "http://desktop-proxy.example" },
            loadInteractiveEnvironment: () =>
              status === "captured"
                ? Promise.resolve({
                    PATH: "/login",
                    HTTPS_PROXY: "http://shell-proxy.example",
                    HTTP_PROXY: "http://shell-http.example",
                    SSL_CERT_FILE: "/user/custom-ca.pem",
                    CODEX_HOME: "/other-account",
                    NODEX_HOME: "/other-profile",
                    CODEX_APP_SERVER_CHATGPT_BASE_URL: "https://shell-endpoint.example",
                    CODEX_APP_SERVER_OPENAI_BASE_URL: "https://shell-openai.example",
                    BROWSER_USE_ACCESS_PIPE_PATH: "/foreign-host",
                    ELECTRON_RUN_AS_NODE: "1",
                  })
                : Promise.reject(new Error("Shell exited")),
          }),
        );
        const launch = yield* resolveLocalCodexLaunch({
          accountHome,
          profileHome: "/profile",
          platform: "darwin",
          additionalSearchPaths: ["/nodex/tools"],
          shell: Context.get(context, HostShellEnvironment),
          localLaunch: {
            resolveOverrides: (environment) =>
              Effect.succeed(["-c", `shell_environment_policy.set.PATH="${environment.PATH}"`]),
          },
          pending: {
            args: ["-c", "mcp_servers.nodex.enabled=true"],
            env: {
              HTTP_PROXY: "http://configured-proxy.example",
              CODEX_HOME: "/also-wrong",
              CODEX_APP_SERVER_OPENAI_BASE_URL: "https://explicit-openai.example",
            },
          },
        });
        const path = status === "captured" ? "/login" : "/desktop";
        expect(launch.env).toMatchObject({
          HTTP_PROXY: "http://configured-proxy.example",
          HTTPS_PROXY:
            status === "captured" ? "http://shell-proxy.example" : "http://desktop-proxy.example",
          PATH: `/nodex/tools:${path}`,
          CODEX_HOME: "/profile/account",
          NODEX_HOME: "/profile",
          CODEX_SQLITE_HOME: "/profile/codex",
        });
        expect(launch.env.SSL_CERT_FILE).toBe(
          status === "captured" ? "/user/custom-ca.pem" : undefined,
        );
        expect(launch.env.BROWSER_USE_ACCESS_PIPE_PATH).toBeUndefined();
        expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        const matchesEndpoint = launch.args.includes(
          'chatgpt_base_url="https://shell-endpoint.example"',
        );
        expect(matchesEndpoint).toBe(status === "captured");
        expect(launch.args).toContain('openai_base_url="https://explicit-openai.example"');
        expect(launch.args).not.toContain('openai_base_url="https://shell-openai.example"');
        expect(launch.args.slice(-4)).toEqual([
          "-c",
          `shell_environment_policy.set.PATH="${path}"`,
          "-c",
          "mcp_servers.nodex.enabled=true",
        ]);
      }).pipe(Effect.scoped),
  );
});

describe("CodexHomeReceipt", () => {
  const newHome = () => realpathSync(mkdtempSync(join(tmpdir(), "nodex-codex-home-")));

  test("active home receipts publish the current directory without leaving temporary files", () => {
    const profileHome = newHome();
    try {
      expect(readCodexHomeReceipt(profileHome)).toBeNull();
      const active = join(profileHome, "active");
      writeCodexHomeReceipt({ profileHome, codexHome: active });
      expect(readCodexHomeReceipt(profileHome)).toBe(active);
      const replacement = join(profileHome, "replacement");
      writeCodexHomeReceipt({ profileHome, codexHome: replacement });
      expect(readCodexHomeReceipt(profileHome)).toBe(replacement);
      const directory = join(profileHome, "runtime", "agent");
      expect(readdirSync(directory)).toEqual(["codex-home.json"]);
      if (process.platform !== "win32") {
        expect(statSync(join(directory, "codex-home.json")).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  test("home receipts reject invalid home identities", () => {
    const profileHome = newHome();
    try {
      expect(() => writeCodexHomeReceipt({ profileHome, codexHome: "relative" })).toThrow(
        "absolute path",
      );
      const directory = join(profileHome, "runtime", "agent");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "codex-home.json"),
        JSON.stringify({ version: 1, codexHome: "relative" }),
      );
      expect(() => readCodexHomeReceipt(profileHome)).toThrow("absolute path");
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  test("home receipts reject oversized, malformed and symlinked files", () => {
    const profileHome = newHome();
    try {
      const directory = join(profileHome, "runtime", "agent");
      mkdirSync(directory, { recursive: true });
      const file = join(directory, "codex-home.json");
      writeFileSync(file, Buffer.alloc(16 * 1024 + 1));
      expect(() => readCodexHomeReceipt(profileHome)).toThrow("too large");
      writeFileSync(file, "malformed");
      expect(() => readCodexHomeReceipt(profileHome)).toThrow();
      rmSync(file);
      const outside = join(profileHome, "outside.json");
      const contents = JSON.stringify({ version: 1, codexHome: join(profileHome, "native") });
      writeFileSync(outside, contents);
      symlinkSync(outside, file);
      expect(() => readCodexHomeReceipt(profileHome)).toThrow("regular file");
      expect(() =>
        writeCodexHomeReceipt({ profileHome, codexHome: join(profileHome, "replacement") }),
      ).toThrow("regular file");
      expect(readFileSync(outside, "utf8")).toBe(contents);
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  test("native home symlinks retain canonical identity while regular files are rejected", () => {
    const profileHome = newHome();
    try {
      const target = join(profileHome, "native");
      const alias = join(profileHome, "alias");
      mkdirSync(target);
      symlinkSync(target, alias, "dir");
      writeCodexHomeReceipt({ profileHome, codexHome: alias });
      expect(readCodexHomeReceipt(profileHome)).toBe(target);
      const regular = join(profileHome, "file");
      writeFileSync(regular, "content");
      expect(() => writeCodexHomeReceipt({ profileHome, codexHome: regular })).toThrow("directory");
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  test("native home preparation creates a private directory and preserves existing configuration", () => {
    const profileHome = newHome();
    try {
      const native = join(profileHome, "native");
      createCodexHomeDirectory(native);
      expect(statSync(native).isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(statSync(native).mode & 0o777).toBe(0o700);
      const config = join(native, "config.toml");
      writeFileSync(config, "model = 'custom'\n");
      createCodexHomeDirectory(native);
      expect(readFileSync(config, "utf8")).toBe("model = 'custom'\n");
      expect(() => createCodexHomeDirectory(config)).toThrow("directory");
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });
});

describe("CodexExecutable", () => {
  test.each([
    ["codex-cli 0.0.0", { status: "too-old", version: "0.0.0" }],
    ["codex-cli 0.140.9", { status: "too-old", version: "0.140.9" }],
    ["codex-cli 0.141.0-alpha.1", { status: "too-old", version: "0.141.0-alpha.1" }],
    ["codex-cli 0.141.0", { status: "ready", version: "0.141.0" }],
    [
      `codex-cli ${release.appServerRuntimeVersion}`,
      { status: "ready", version: release.appServerRuntimeVersion },
    ],
    ["codex-cli 0.170.1", { status: "ready", version: "0.170.1" }],
    ["oops", { status: "invalid-version" }],
  ])("classifies the external Codex version output %s", (output, classification) => {
    expect(classifyCodexExecutable(output, "/p/codex")).toMatchObject(classification);
  });

  test.skipIf(process.platform === "win32")(
    "probes only executable files in a credential-free home",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "nodex-executable-fixture-"));
      try {
        const bin = path.join(home, "bin");
        await mkdir(bin);
        const executable = path.join(bin, "codex");
        await writeFile(
          executable,
          '#!/bin/sh\n[ "$1" = "--version" ] && [ "$CODEX_HOME" = "$HOME" ] && [ -z "$OPENAI_API_KEY" ] && [ ! -e "$CODEX_HOME/auth.json" ] || exit 1\nprintf "codex-cli 0.170.1\\n"\n',
          { mode: 0o755 },
        );
        await writeFile(path.join(home, "auth.json"), "{}");
        await writeFile(path.join(bin, "broken"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const probe = (command: string) =>
          probeCodexExecutable({
            executable: command,
            home,
            platform: process.platform,
            environment: { HOME: home, CODEX_HOME: home, PATH: bin, OPENAI_API_KEY: "fixture" },
            signal: new AbortController().signal,
          });
        for (const command of ["codex", "~/bin/codex", executable]) {
          const result = await probe(command);
          expect(result).toMatchObject({ status: "ready", version: "0.170.1" });
          if (result.status === "ready") expect(path.isAbsolute(result.binaryPath)).toBe(true);
        }
        for (const command of [bin, "missing", "bin/codex"]) {
          await expect(probe(command)).resolves.toEqual({ status: "not-found" });
        }
        await expect(probe("broken")).resolves.toEqual({ status: "probe-failed" });
        await chmod(executable, 0o644);
        await expect(probe(executable)).resolves.toEqual({ status: "not-found" });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
