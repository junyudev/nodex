import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";
import {
  AcpAgentLaunchProbe,
  makeAcpAgentLaunchProbe,
} from "../../platform/node/AcpAgentLaunchProbe";
import {
  CLAUDE_ACP_PACKAGE_NAME,
  CLAUDE_ACP_PACKAGE_VERSION,
  resolveClaudeAcpLaunch,
} from "./ClaudeAcpAgentDefinition";

const withFixture = <A, E>(
  use: (fixture: {
    readonly packageRoot: string;
    readonly workspaceRoot: string;
    readonly isolatedHome: string;
    readonly nodeExecutable: string;
  }) => Effect.Effect<A, E>,
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "nodex-claude-acp-definition-"));
      const packageRoot = join(root, "package");
      const workspaceRoot = join(root, "workspace");
      const isolatedHome = join(root, "home");
      const nodeExecutable = join(root, "node");
      await Promise.all([
        mkdir(join(packageRoot, "dist"), { recursive: true }),
        mkdir(workspaceRoot),
        mkdir(isolatedHome),
      ]);
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: CLAUDE_ACP_PACKAGE_NAME, version: CLAUDE_ACP_PACKAGE_VERSION }),
      );
      await writeFile(join(packageRoot, "dist/index.js"), "// user-managed executable\n");
      await writeFile(
        nodeExecutable,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'v24.15.0\\n'; else printf '${CLAUDE_ACP_PACKAGE_VERSION}\\n'; fi\n`,
      );
      await chmod(nodeExecutable, 0o700);
      return { root, packageRoot, workspaceRoot, isolatedHome, nodeExecutable };
    }),
    ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(({ root: _root, ...fixture }) => use(fixture)));

it.effect(
  "probes a user-managed compatible package and exposes an explicit minimal launch environment",
  () =>
    Effect.scoped(
      withFixture((fixture) =>
        resolveClaudeAcpLaunch({
          ...fixture,
          installation: { packageRoot: fixture.packageRoot },
          hostEnvironment: {
            HOME: "/host/home",
            PATH: "/usr/bin:/bin",
            LANG: "en_US.UTF-8",
            HTTPS_PROXY: "http://proxy.invalid",
            ANTHROPIC_API_KEY: "secret",
            AWS_SECRET_ACCESS_KEY: "secret",
            UNRELATED_SECRET: "must-not-pass",
          },
          policy: {
            credentials: { kind: "isolated-home", home: fixture.isolatedHome },
            proxy: "inherit-host",
            sandbox: { kind: "agent-native-permissions", acknowledged: true },
          },
        }).pipe(
          Effect.provideService(AcpAgentLaunchProbe, makeAcpAgentLaunchProbe),
          Effect.tap((resolved) =>
            Effect.promise(async () => {
              const canonicalWorkspace = await realpath(fixture.workspaceRoot);
              const canonicalHome = await realpath(fixture.isolatedHome);
              expect(resolved.agentVersion).toBe(CLAUDE_ACP_PACKAGE_VERSION);
              expect(resolved.nodeVersion).toBe("v24.15.0");
              expect(resolved.spawn.cwd).toBe(canonicalWorkspace);
              expect(resolved.capabilityProfile).toEqual({
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
                auth: { terminal: false },
                elicitation: { form: false, url: false },
              });
              expect(resolved.spawn.env).toEqual({
                HOME: canonicalHome,
                XDG_CONFIG_HOME: canonicalHome,
                PATH: "/usr/bin:/bin",
                LANG: "en_US.UTF-8",
                HTTPS_PROXY: "http://proxy.invalid",
              });
            }),
          ),
        ),
      ),
    ),
);

it.effect("rejects an installed package whose executable identity does not match", () =>
  Effect.scoped(
    withFixture((fixture) =>
      Effect.promise(() =>
        writeFile(
          join(fixture.packageRoot, "package.json"),
          JSON.stringify({ name: CLAUDE_ACP_PACKAGE_NAME, version: "0.72.0" }),
        ),
      ).pipe(
        Effect.andThen(() =>
          resolveClaudeAcpLaunch({
            ...fixture,
            installation: { packageRoot: fixture.packageRoot },
            hostEnvironment: {},
            policy: {
              credentials: { kind: "inherit-host-profile" },
              proxy: "isolated",
              sandbox: { kind: "agent-native-permissions", acknowledged: true },
            },
          }),
        ),
        Effect.provideService(AcpAgentLaunchProbe, makeAcpAgentLaunchProbe),
        Effect.flip,
        Effect.tap((failure) =>
          Effect.sync(() => expect(failure).toMatchObject({ reason: "spawn" })),
        ),
      ),
    ),
  ),
);
