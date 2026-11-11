/* @effect-diagnostics asyncFunction:off processEnv:off -- Native integration fixtures. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
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

testOnWindows("validates an embedded inbox signature and refuses its tampered copy", async () => {
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
    for (const candidate of candidates) {
      const path = join(system, candidate);
      const result = await run((service) => service.verifyAuthenticode(path).pipe(Effect.result));
      examined.push({ candidate, result });
      if (
        result._tag !== "Success" ||
        result.success.status !== "verified" ||
        !result.success.codeSigningEku
      )
        continue;
      expect(result.success.signature).toBe("embedded");
      expect(result.success.chain[0]?.subject).toBeTruthy();
      signed = path;
      break;
    }
    expect(signed, JSON.stringify(examined)).toBeDefined();
    const bytes = await readFile(signed!);
    const offset = bytes.readUInt32LE(60);
    bytes[offset + 8] ^= 1;
    const tampered = join(temp, "tampered.exe");
    await writeFile(tampered, bytes);
    expect(await run((service) => service.verifyAuthenticode(tampered))).toMatchObject({
      status: "rejected",
      signature: "embedded",
    });
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
});

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
