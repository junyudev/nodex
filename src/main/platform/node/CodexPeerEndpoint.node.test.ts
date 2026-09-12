/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- Real filesystem and socket election tests use scoped Node resources. */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";
import { acquireCodexPeerEndpointManager } from "./CodexPeerEndpoint";
import { CodexPeerClient } from "./CodexPeerClient";

const profile = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "nodex-peer-election-"))),
  (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
);

it.effect("keeps a shared router alive until its owner releases it", () =>
  Effect.gen(function* () {
    const home = yield* profile;
    const errors = vi.fn();
    const first = yield* acquireCodexPeerEndpointManager(home, errors);
    const second = yield* acquireCodexPeerEndpointManager(home, errors);
    yield* Effect.tryPromise(async () => {
      const endpoint = await first.getOrStartRouterEndpoint();
      const client = new CodexPeerClient(() => first.getOrStartRouterEndpoint(), errors);
      try {
        await client.waitUntilInitialized({ timeoutMs: 2_000 });
        expect(await second.getOrStartRouterEndpoint()).toBe(endpoint);
        expect((await lstat(endpoint)).mode & 0o777).toBe(0o600);
        expect((await lstat(dirname(endpoint))).mode & 0o777).toBe(0o700);
        await second.dispose();
        expect((await client.sendRequest("initialize", { clientType: "desktop" })).resultType).toBe(
          "success",
        );
        await first.dispose();
        await expect(first.getOrStartRouterEndpoint()).rejects.toThrow("disposed");
      } finally {
        client.dispose();
      }
      expect(errors).not.toHaveBeenCalled();
    });
  }).pipe(Effect.scoped),
);

it.effect("reports an occupied non-socket from bind without deleting the file", () =>
  Effect.gen(function* () {
    const home = yield* profile;
    const errors = vi.fn();
    const manager = yield* acquireCodexPeerEndpointManager(home, errors);
    yield* Effect.tryPromise(async () => {
      const endpoint = join(home, "ipc", "ipc.sock");
      await mkdir(dirname(endpoint), { recursive: true });
      await writeFile(endpoint, "occupied");
      expect(await manager.getOrStartRouterEndpoint()).toBe(endpoint);
      // EADDRINUSE is an election outcome, not an error reported to the service.
      await vi.waitFor(async () => expect((await lstat(endpoint)).isFile()).toBe(true));
      expect(errors).not.toHaveBeenCalled();
    });
  }).pipe(Effect.scoped),
);

for (const secure of [true, false]) {
  it.effect(`uses a legacy endpoint only with a private parent directory (${secure})`, () =>
    Effect.gen(function* () {
      const home = yield* profile;
      const key = createHash("sha256").update(home).digest("hex").slice(0, 16);
      const uid = process.getuid?.();
      const legacy = join(tmpdir(), "nodex-ipc", key, uid ? `ipc-${uid}.sock` : "ipc.sock");
      yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdir(dirname(legacy), { recursive: true, mode: 0o700 })),
        () => Effect.promise(() => rm(dirname(legacy), { recursive: true, force: true })),
      );
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createServer((socket) => socket.end())),
        (value) =>
          Effect.promise(() => new Promise<void>((resolve) => value.close(() => resolve()))),
      );
      const manager = yield* acquireCodexPeerEndpointManager(home, () => {});
      yield* Effect.tryPromise(async () => {
        await new Promise<void>((resolve) => server.listen(legacy, resolve));
        await chmod(dirname(legacy), secure ? 0o700 : 0o722);
        expect(await manager.getOrStartRouterEndpoint()).toBe(
          secure ? legacy : join(home, "ipc", "ipc.sock"),
        );
      });
    }).pipe(Effect.scoped),
  );
}
