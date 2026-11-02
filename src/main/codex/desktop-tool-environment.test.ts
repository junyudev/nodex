import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  desktopToolHostBindingNames,
  nodeReplServerDefinition,
  withoutDesktopToolHostBindings,
} from "./desktop-tool-environment";

const temporaryRoots: string[] = [];
const ambientPath = path.dirname(process.execPath);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

/** A foreign host's process tree, as Nodex inherits it when launched from inside that host. */
const foreignHostEnvironment = {
  BROWSER_USE_ACCESS_EXECUTOR_ID: JSON.stringify(["foreign-install", "native-browser-plugin"]),
  BROWSER_USE_ACCESS_PIPE_PATH: "/tmp/codex-app-tools/foreign.sock",
  BROWSER_USE_ACCESS_VERIFYING_IDENTITY: "MCowBQYDK2VwAyEAforeign",
  CODEX_APP_TOOLS_PIPE_PATH: "/tmp/codex-app-tools/foreign.sock",
  CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY: "MCowBQYDK2VwAyEAforeign",
  NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: "foreign-hash",
} as const;

interface ObservedSandboxLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Runs the closed launcher with Node executing an owned recording sandbox entrypoint. */
function launchNodeRepl(input: {
  readonly declared: Readonly<Record<string, string>>;
  readonly persisted: Readonly<Record<string, string>>;
}): ObservedSandboxLaunch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-node-repl-launcher-"));
  temporaryRoots.push(root);
  // Let the current native Node/Electron execute a recording sandbox entrypoint.
  // A shebang executable cannot be spawned directly on Windows.
  const recorder = path.join(root, "sandbox");
  fs.writeFileSync(
    recorder,
    [
      "const env = { ...process.env };",
      'const argv = [require("node:path").basename(process.argv[1]), ...process.argv.slice(2)];',
      "process.stdout.write(JSON.stringify({ argv, env }));",
    ].join("\n"),
  );
  const definition = nodeReplServerDefinition({
    codexCliPath: process.execPath,
    env: input.declared,
    nodePath: process.execPath,
    nodeReplPath: "/runtime/bin/node_repl",
  });
  // Codex starts MCP servers from its base variables plus the merged server environment, in which
  // Nodex's declared values win over the shared Codex home's persisted ones.
  const result = spawnSync(definition.command, definition.args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    // The Main suite runs on Electron, which acts as the vendor Node only in Node mode.
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      HOME: os.homedir(),
      PATH: ambientPath,
      ...input.persisted,
      ...definition.env,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `launcher exited ${result.status}`);
  return JSON.parse(result.stdout) as ObservedSandboxLaunch;
}

/** The sandbox shell-environment policy the launcher pins, decoded from `-c key=value` pairs. */
function pinnedPolicy(argv: readonly string[]): Map<string, unknown> {
  const policy = new Map<string, unknown>();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "-c") continue;
    const [key, value] = splitOnce(argv[index + 1] ?? "", "=");
    policy.set(key.replace(/^shell_environment_policy\./u, ""), JSON.parse(value));
  }
  return policy;
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return [value.slice(0, index), value.slice(index + 1)];
}

describe("Desktop Tool host bindings", () => {
  test("names only another host's bindings and keeps unrelated Browser variables", () => {
    const environment = {
      ...foreignHostEnvironment,
      BROWSER: "firefox",
      BROWSER_USE_API_KEY: "third-party-library",
      PATH: "/usr/bin",
    };

    expect(desktopToolHostBindingNames(environment)).toEqual(
      Object.keys(foreignHostEnvironment).sort(),
    );
    expect(withoutDesktopToolHostBindings(environment)).toEqual({
      BROWSER: "firefox",
      BROWSER_USE_API_KEY: "third-party-library",
      PATH: "/usr/bin",
    });
  });
});

describe("node_repl launcher", () => {
  test("gives codex sandbox only declared Desktop Tool variables and the ambient process", () => {
    const declared = {
      CODEX_HOME: "/nodex/codex-home",
      NODE_REPL_TRUSTED_CODE_PATHS: "/nodex/runtime",
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: "/nodex/browser-service.mjs" }),
    };
    const { env } = launchNodeRepl({
      declared,
      persisted: {
        ...foreignHostEnvironment,
        CODEX_HOME: "/foreign/codex-home",
        NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
        SKY_CUA_SERVICE_PATH: "/Applications/Foreign.app",
      },
    });

    expect(env).toMatchObject({
      ...declared,
      HOME: os.homedir(),
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      PATH: ambientPath,
    });
    for (const name of [...Object.keys(foreignHostEnvironment), "SKY_CUA_SERVICE_PATH"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  test("pins the sandbox policy so node_repl receives exactly that environment", () => {
    const declared = {
      CODEX_HOME: "/nodex/codex-home",
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: "/path with spaces/service.mjs" }),
    };
    const { argv, env } = launchNodeRepl({ declared, persisted: foreignHostEnvironment });
    const separator = argv.indexOf("--");
    const policy = pinnedPolicy(argv.slice(0, separator));

    expect(argv[0]).toBe("sandbox");
    expect(argv.slice(separator - 2)).toEqual([
      "-P",
      ":danger-full-access",
      "--",
      "/runtime/bin/node_repl",
    ]);
    // A persisted policy can neither narrow the inherited set nor add or replace variables.
    expect(policy.get("inherit")).toBe("all");
    expect(policy.get("exclude")).toEqual([]);
    expect(new Set(policy.get("include_only") as string[])).toEqual(new Set(Object.keys(env)));
    for (const [name, value] of Object.entries(declared)) {
      expect(policy.get(`set.${name}`)).toBe(value);
    }
  });
});
