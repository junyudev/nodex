import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import type { LocalAgentScan, LocalAgentScanOptions } from "../../../shared/local-agents";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { LocalAgentDiscovery } from "../../host-runtime/LocalAgentDiscovery";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { live } from "./LocalAgentsIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

type Handler = (
  event: IpcMainInvokeEvent,
  options?: LocalAgentScanOptions,
) => Effect.Effect<unknown, unknown>;

const event = (url = "app://-/index.html", subframe = false) => {
  const frame = { url };
  return {
    sender: { getType: () => "window", mainFrame: frame },
    senderFrame: subframe ? { ...frame } : frame,
  } as unknown as IpcMainInvokeEvent;
};

it.effect("admits only trusted top-level renderers and removes the query on scope close", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const snapshot: LocalAgentScan = {
      agents: [{ id: "antigravity", executable: "/bin/agy", version: "1.5.4", supported: true }],
    };
    const scans: (boolean | undefined)[] = [];
    const dependencies = Layer.mergeAll(
      mainConfigLayer(),
      Layer.succeed(ElectronIpc, ipc),
      Layer.succeed(
        LocalAgentDiscovery,
        LocalAgentDiscovery.of({
          scan: (options) =>
            Effect.sync(() => {
              scans.push(options?.fresh);
              return snapshot;
            }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Layer.build(live.pipe(Layer.provide(dependencies)));
      const handler = handlers.get("local-agents:scan")!;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(handler(event("https://example.com")))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(handler(event(undefined, true)))));
      assert.isEmpty(scans);
      assert.deepEqual(yield* handler(event()), snapshot);
      assert.deepEqual(yield* handler(event(), { fresh: true }), snapshot);
      assert.deepEqual(scans, [false, true]);
    }).pipe(Effect.scoped);
    assert.strictEqual(handlers.size, 0);
  }),
);
