/* @effect-diagnostics asyncFunction:off processEnv:off -- Native integration fixtures. */
import {
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
} from "../../../shared/browser-runtime-metadata";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { makeWindowsBrowserPeerAuthorizer } from "../../browser-use/browser-use-peer-authorizer";
import { nodeReplServerDefinition } from "../../codex/desktop-tool-environment";
import { makeWindowsBrowserRuntimeVerifier } from "./WindowsBrowserRuntimeVerifier";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { probeWindowsDesktopTools } from "../../../../scripts/testing/windows-desktop-tools.test-support";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import {
  WindowsDesktopTools,
  windowsDesktopToolsLayer,
  type WindowsDesktopToolsService,
} from "./WindowsDesktopTools";

const testOnWindows = test.skipIf(process.platform !== "win32");
const tools = () => windowsDesktopToolsLayer("win32", requiredNativeExecutable("core-server"));
const run = <T, E>(
  use: (service: WindowsDesktopToolsService) => Effect.Effect<T, E, WindowsDesktopTools>,
) => Effect.runPromise(Effect.flatMap(WindowsDesktopTools, use).pipe(Effect.provide(tools())));

const nodeEnvironment = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1" });

const closeChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "exit");
  child.kill();
  await closed;
};

testOnWindows(
  "validates an embedded inbox signature and refuses its tampered copy",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "nodex-signature-"));
    try {
      const system = join(process.env.SystemRoot!, "System32");
      const candidates = [
        "ntoskrnl.exe",
        "winload.efi",
        "curl.exe",
        "WindowsPowerShell/v1.0/powershell.exe",
      ];
      const examined = [];
      let signed: string | undefined;
      let publisher: { subject: string; issuer: string } | undefined;
      const verifier = await run((service) =>
        Effect.succeed(makeWindowsBrowserRuntimeVerifier(service, temp, Effect.runPromise)),
      );
      for (const candidate of candidates) {
        const path = join(system, candidate);
        const result = await run((service) =>
          service.verifyAuthenticode(path, true).pipe(Effect.result),
        );
        examined.push({ candidate, result });
        if (
          result._tag !== "Success" ||
          result.success.status !== "verified" ||
          !result.success.codeSigningEku
        )
          continue;
        expect(result.success.signature).toBe("embedded");
        expect(result.success.chain[0]?.subject).toBeTruthy();
        publisher = result.success.chain[0];
        signed = path;
        break;
      }
      expect(signed, JSON.stringify(examined)).toBeDefined();
      expect(await verifier.verifyAuthenticode(signed!, publisher!)).toEqual({
        ok: true,
        value: publisher,
      });
      expect(
        await verifier.verifyAuthenticode(signed!, { ...publisher!, issuer: "CN=Foreign" }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("publisher or issuer"),
      });
      const bytes = await readFile(signed!);
      const offset = bytes.readUInt32LE(60);
      bytes[offset + 8] ^= 1;
      const tampered = join(temp, "tampered.exe");
      await writeFile(tampered, bytes);
      expect(await run((service) => service.verifyAuthenticode(tampered))).toMatchObject({
        status: "rejected",
        signature: "embedded",
      });
      expect(await verifier.verifyAuthenticode(tampered, publisher!)).toMatchObject({ ok: false });
      const junction = join(temp, "junction");
      await symlink(system, junction, "junction");
      expect(await run((service) => service.inspectPath(junction))).toMatchObject({
        reparsePoint: true,
      });
      expect(
        await run((service) =>
          service.inspectPath(join(junction, basename(signed!))).pipe(Effect.flip),
        ),
      ).toMatchObject({ kind: "native" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
  150_000,
);

testOnWindows(
  "reports OS peer identities and exchanges duplex bytes across processes",
  async () => {
    const prefix = `nodex-test-${randomUUID()}`;
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WindowsDesktopTools;
        const listener = yield* service.listenPipe(prefix);
        expect((yield* service.enumeratePipes(prefix, 4)).names).toContain(listener.endpoint);
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            execFile(
              process.execPath,
              [
                "-e",
                `const client = require("node:net").connect(process.argv[1]);
           client.on("connect", () => client.write("ping"));
           client.once("data", data => {
             if (data.toString() !== "pong") process.exitCode = 1;
             client.destroy();
           });`,
                listener.endpoint,
              ],
              { env: nodeEnvironment(), windowsHide: true },
            ),
          ),
          (child) => Effect.promise(() => closeChild(child)),
        );
        const exited = once(child, "exit");
        const { peer, stream } = yield* listener.accept.pipe(Effect.timeout("15 seconds"));
        expect(peer).toEqual(yield* service.processIdentity(child.pid!));
        expect(basename(peer.imagePath).toLowerCase()).toBe(
          basename(process.execPath).toLowerCase(),
        );
        const received = yield* Effect.promise(() => once(stream, "data"));
        expect(String(received[0])).toBe("ping");
        stream.write("pong");
        expect(yield* Effect.promise(() => exited)).toEqual([0, null]);
        stream.destroy();

        const client = yield* service.connectPipe(listener.endpoint);
        const accepted = yield* listener.accept.pipe(Effect.timeout("15 seconds"));
        expect(client.peer).toEqual(yield* service.processIdentity(client.peer.pid));
        expect(accepted.peer).toEqual(yield* service.processIdentity(accepted.peer.pid));
        expect(client.peer.pid).not.toBe(accepted.peer.pid);
        expect(basename(client.peer.imagePath)).toBe("nodex-core.exe");
      }).pipe(Effect.scoped, Effect.provide(tools())),
    );
  },
);

testOnWindows("terminates a verified subtree in child-first order", async () => {
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
     const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true });
     process.stdout.write(String(child.pid) + "\\n");
     setTimeout(() => {}, 30000);`,
    ],
    { env: nodeEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    const exited = once(parent, "exit");
    const [published] = await once(parent.stdout, "data");
    const leaf = Number(String(published).trim());
    const root = await run((service) => service.processIdentity(parent.pid!));
    const children = await run((service) => service.descendants(root));
    expect(children.map(({ pid }) => pid)).toContain(leaf);
    expect(await run((service) => service.terminateSubtree(root))).toEqual([leaf, root.pid]);
    await exited;
    expect(await run((service) => service.processIdentity(leaf).pipe(Effect.flip))).toMatchObject({
      kind: "native",
    });
  } finally {
    await closeChild(parent);
  }
});

testOnWindows(
  "restores a disposable registration only if the installed value still matches",
  async () => {
    const host = `com.nodex.test_${randomUUID().replaceAll("-", "")}`;
    for (const [browser, view] of [
      ["chrome", "x86"],
      ["edge", "x64"],
    ] as const) {
      const key = { browser, view, host };
      const first = await run((service) =>
        service.writeRegistration(key, null, join(tmpdir(), "first.json")),
      );
      try {
        expect(await run((service) => service.readRegistration(key))).toEqual(first.installed);
        const second = await run((service) =>
          service.writeRegistration(key, first.installed, join(tmpdir(), "second.json")),
        );
        try {
          expect(await run((service) => service.restoreRegistration(key, first))).toBe(false);
        } finally {
          expect(await run((service) => service.restoreRegistration(key, second))).toBe(true);
        }
        expect(await run((service) => service.readRegistration(key))).toEqual(first.installed);
      } finally {
        expect(await run((service) => service.restoreRegistration(key, first))).toBe(true);
      }
      expect(await run((service) => service.readRegistration(key))).toBeNull();
    }
  },
);

const launcher = () => requiredNativeExecutable("core-server");
const standInEnvironment = () => ({
  SYSTEMROOT: process.env.SystemRoot!,
  ELECTRON_RUN_AS_NODE: "1",
  NODEX_DECLARED_VALUE: "ready",
});

function spawnStandIn(script: string, args: readonly string[] = []) {
  const server = nodeReplServerDefinition({
    windowsJobLauncher: launcher(),
    nodePath: process.execPath,
    codexCliPath: process.execPath,
    nodeReplPath: process.execPath,
    env: standInEnvironment(),
  });
  return spawn(server.command, [...server.args, "-e", script, ...args], {
    windowsHide: true,
    env: {
      ...process.env,
      NODE_REPL_HOST_SERVICES_PIPE_PATH: "foreign",
      sKy_CuA_NaTiVe_PiPe: "foreign",
      NODEX_DECLARED_VALUE: "foreign",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

testOnWindows(
  "passes a closed Windows environment and preserves Unicode arguments and stdio",
  async () => {
    const argument = "C:\\Nodex 测试\\path with spaces\\";
    const child = spawnStandIn(
      `process.stdin.once("data", (data) => {
      process.stdout.write(JSON.stringify({ argv: process.argv[1], input: data.toString(), env: process.env }) + "\\n");
    });`,
      [argument],
    );
    try {
      const output = createInterface({ input: child.stdout! });
      const result = once(output, "line");
      const exited = once(child, "exit");
      child.stdin!.end("MCP message");
      const [line] = await result;
      const received = JSON.parse(line);
      // Windows on ARM adds this to every process it creates; nothing passed it on.
      delete received.env.PROCESSOR_ARCHITECTURE;
      expect(received).toEqual({
        argv: argument,
        input: "MCP message",
        env: standInEnvironment(),
      });
      expect(await exited).toEqual([0, null]);
    } finally {
      await closeChild(child);
    }
  },
);

testOnWindows(
  "closing the Windows REPL launcher terminates the root and its entire job",
  async () => {
    const child = spawnStandIn(`
    const { spawn } = require("node:child_process");
    const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", windowsHide: true });
    process.stdout.write(JSON.stringify({ root: process.pid, leaf: leaf.pid }) + "\\n");
    setInterval(() => {}, 1000);
  `);
    try {
      const output = createInterface({ input: child.stdout! });
      const [line] = await once(output, "line");
      const { root, leaf } = JSON.parse(line);
      const repl = await run((service) => service.processIdentity(root));
      expect((await run((service) => service.descendants(repl))).map((peer) => peer.pid)).toContain(
        leaf,
      );
      const closed = once(child, "close");
      child.kill();
      await closed;
      for (const pid of [root, leaf])
        expect(
          await run((service) => service.processIdentity(pid).pipe(Effect.flip)),
        ).toMatchObject({ kind: "native" });
    } finally {
      await closeChild(child);
    }
  },
);

testOnWindows(
  "admits the launched verified-path peer and rejects a different OS image",
  async () => {
    await run((native) =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* native.processIdentity(process.pid);
          const listener = yield* native.listenPipe("codex-browser-use-nodex-integration");
          const authorize = makeWindowsBrowserPeerAuthorizer({
            native,
            host,
            launcher: launcher(),
            repl: process.execPath,
            node: process.execPath,
            mode: "packaged",
          });
          yield* native
            .connectPipe(listener.endpoint)
            .pipe(Effect.forkScoped({ startImmediately: true }));
          const foreign = yield* listener.accept.pipe(Effect.timeout("15 seconds"));
          expect(yield* authorize(foreign.peer)).toMatchObject({
            authorized: false,
            reason: "unverified-peer-image",
          });
          foreign.stream.destroy();
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              spawnStandIn(
                `const pipe = require("node:net").connect(process.argv[1]);
        pipe.on("data", () => pipe.destroy());
        pipe.on("error", () => process.exit(1));`,
                [listener.endpoint],
              ),
            ),
            (child) => Effect.promise(() => closeChild(child)),
          );
          const exited = once(child, "exit");
          const owned = yield* listener.accept.pipe(Effect.timeout("15 seconds"));
          expect(yield* authorize(owned.peer)).toEqual({ authorized: true });
          owned.stream.write("ready");
          expect(yield* Effect.promise(() => exited)).toEqual([0, null]);
          owned.stream.destroy();
        }),
      ),
    );
  },
);

const projectRoot = resolve(".");
const stagedRuntime = join(projectRoot, ".generated", "codex-runtime");
test.skipIf(
  process.platform !== "win32" ||
    (process.env.NODEX_REQUIRE_STAGED_DESKTOP_TOOLS !== "1" &&
      !existsSync(
        join(
          stagedRuntime,
          "agent-runtime",
          BROWSER_RUNTIME_BUNDLE_DIRECTORY,
          BROWSER_RUNTIME_MANIFEST_FILENAME,
        ),
      )),
)(
  "initializes the staged vendor Windows REPL over MCP stdio",
  async () => {
    expect(
      await probeWindowsDesktopTools({
        location: { isPackaged: false, projectRootPath: projectRoot },
        boundary: stagedRuntime,
        launcher: launcher(),
      }),
    ).toMatchObject({ status: "passed" });
  },
  210_000,
);
