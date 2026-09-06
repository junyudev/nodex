/* oxlint-disable effecttsgo/strict-effect-provide -- This standalone runtime probe is the application entry point for its isolated configuration layer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import * as Effect from "effect/Effect";
import { MainConfig, testLayer } from "../../src/main/app/MainConfig";
import { buildNodexCliBootstrap } from "../../src/main/platform/node/NodexCliBootstrap";
import { withCoreScenario } from "../scenarios/harness/core-scenario-harness";
import { prepareNativeArtifacts, preparedNativeEnvironment } from "./native-artifacts";

const withPinnedShell = async (
  home: string,
  run: (
    request: (params: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  ) => Promise<void>,
) => {
  await mkdir(home, { recursive: true });
  const server = spawn(
    resolve(".generated/codex-runtime/agent-runtime/bin/codex-app-server"),
    ["--listen", "stdio://", "--session-source", "app-server"],
    {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  server.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4096);
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 0;
  const lines = createInterface({ input: server.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const receiver = pending.get(message.id);
    if (!receiver) return;
    pending.delete(message.id);
    if (message.error) receiver.reject(new Error(JSON.stringify(message.error)));
    else receiver.resolve(message.result);
  });
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolveResult, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}: ${diagnostics}`));
      }, 20_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveResult(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    await request("initialize", {
      clientInfo: { name: "nodex-cli-bootstrap-test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    server.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    await run(
      (params) =>
        request("command/exec", params) as Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
        }>,
    );
  } finally {
    lines.close();
    server.kill();
    for (const receiver of pending.values()) receiver.reject(new Error("App-server closed"));
  }
};

const main = async () => {
  const prepared = await prepareNativeArtifacts(["core-server", "cli"], {
    repositoryRoot: resolve("."),
    env: process.env,
  });
  Object.assign(process.env, preparedNativeEnvironment(prepared));
  const defaults = Effect.runSync(MainConfig.pipe(Effect.provide(testLayer())));
  await withCoreScenario({ scenarioId: "library/files" }, async (scenario) => {
    const bootstrap = await Effect.runPromise(
      buildNodexCliBootstrap(
        {
          ...defaults,
          environment: process.env as Record<string, string>,
          projectRootPath: resolve("."),
          nodexHome: scenario.profile.nodexHome,
          profileId: scenario.runtime.identity.profileId,
        },
        {
          hostId: "local",
          projectId: scenario.manifest.projectId,
          verifiedBuiltinFullAccess: true,
          sandboxPolicy: { type: "dangerFullAccess" },
          planMode: false,
        },
      ),
    );
    const prefix = bootstrap.value
      .split("\n")
      .find((line) => line.startsWith("/usr/bin/env NODEX_HOME="));
    assert.ok(prefix, bootstrap.value);
    await withPinnedShell(join(scenario.profile.runRoot, "private codex home"), async (command) => {
      const context = await command({
        command: ["/bin/sh", "-c", `${prefix} --json context`],
        cwd: scenario.profile.runRoot,
        env: { PATH: "", NODEX_HOME: "/unavailable/wrong-profile" },
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      assert.equal(context.exitCode, 0, context.stderr);
      assert.equal(JSON.parse(context.stdout).result.project.id, scenario.manifest.projectId);
      await scenario.withStoppedCore(async () => {
        const restarted = await command({
          command: ["/bin/sh", "-c", `${prefix} --json context`],
          cwd: scenario.profile.runRoot,
          env: { PATH: "", NODEX_HOME: "/unavailable/wrong-profile" },
          sandboxPolicy: { type: "dangerFullAccess" },
          timeoutMs: 60_000,
        });
        assert.equal(restarted.exitCode, 0, restarted.stderr);
        const nextContext = JSON.parse(restarted.stdout).result;
        assert.equal(nextContext.profile.id, scenario.runtime.identity.profileId);
        assert.equal(nextContext.project.id, scenario.manifest.projectId);
        assert.notEqual(nextContext.core.pid, JSON.parse(context.stdout).result.core.pid);
      });
      const page = scenario.manifest.pageIdsByKey.sharedImageA;
      const full = await command({
        command: [
          "/bin/sh",
          "-c",
          `${prefix} page insert '@${page}' <<'BODY'\nBootstrap runtime proof\nBODY`,
        ],
        cwd: scenario.profile.runRoot,
        env: { PATH: "" },
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      assert.equal(full.exitCode, 0, full.stderr);
      const read = await command({
        command: ["/bin/sh", "-c", `${prefix} read '@${page}'`],
        cwd: scenario.profile.runRoot,
        env: { PATH: "" },
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      assert.equal(read.exitCode, 0, read.stderr);
      assert.ok(read.stdout.includes("Bootstrap runtime proof"));
      const restrictedRead = await command({
        command: ["/bin/sh", "-c", `${prefix} read '@${page}'`],
        cwd: scenario.profile.runRoot,
        env: { PATH: "" },
        sandboxPolicy: { type: "readOnly" },
      });
      const restricted = await command({
        command: [
          "/bin/sh",
          "-c",
          `printf 'Restricted runtime probe\\n' | ${prefix} page insert '@${page}'`,
        ],
        cwd: scenario.profile.runRoot,
        env: { PATH: "" },
        sandboxPolicy: { type: "readOnly" },
      });
      process.stdout.write(
        JSON.stringify({
          fullAccess: { context: true, coldCore: true, write: true, read: true },
          readOnlyProbe: {
            readExitCode: restrictedRead.exitCode,
            readStderr: restrictedRead.stderr,
            writeExitCode: restricted.exitCode,
            writeStderr: restricted.stderr,
          },
          conclusion:
            "Native CLI is Project-authorized; restricted Turn writes require a future trusted execution channel.",
        }) + "\n",
      );
    });
  });
};
void main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
