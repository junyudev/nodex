import type { IpcMainInvokeEvent } from "electron";
import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { live } from "./McpAppDataIpc";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { testLayer } from "../../app/MainConfig";
import { McpAppSandboxRuntime } from "../../host-runtime/McpAppSandboxRuntime";
import { McpAppSandboxDataError } from "../../mcp-app/mcp-app-sandbox-host";
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  protocol: {},
  BrowserWindow: { fromWebContents: () => ({}) },
}));
type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;
const event = (kind = "window"): IpcMainInvokeEvent => {
  const frame = { url: "http://localhost:5173" };
  return {
    sender: { getType: () => kind, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
};
const make = Effect.fn("McpAppDataIpcTest.make")(function* (failure?: "failed" | "unavailable") {
  const handlers = new Map<string, Handler>();
  let clears = 0;
  const ipc = makeTestElectronIpc({
    handle: (channel: string, handler: Handler) =>
      Effect.sync(() => {
        handlers.set(channel, handler);
      }),
    on: () => Effect.void,
  });
  yield* Layer.build(
    live.pipe(
      Layer.provide(
        Layer.mergeAll(
          testLayer({ rendererUrl: "http://localhost:5173" }),
          Layer.succeed(ElectronIpc, ipc),
          Layer.succeed(McpAppSandboxRuntime, {
            appDataAvailable: () => failure !== "unavailable",
            clearAppData: Effect.suspend(() => {
              clears++;
              return failure
                ? Effect.fail(new McpAppSandboxDataError({ reason: failure }))
                : Effect.void;
            }),
          } as unknown as McpAppSandboxRuntime["Service"]),
        ),
      ),
    ),
  );
  return { handlers, clears: () => clears };
});
const context = { hostId: "local", projectId: null };
it.effect(
  "clears Profile-wide app data through trusted typed IPC without requiring agent authentication",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* make();
        const capability = h.handlers.get("mcp-app:data:capabilities")!;
        const clear = h.handlers.get("mcp-app:data:clear")!;
        assert.deepEqual(yield* capability(event(), context), { available: true });
        assert.deepEqual(yield* capability(event(), { ...context, hostId: "remote" }), {
          available: false,
        });
        assert.deepEqual(yield* clear(event(), context), {
          status: "success",
          value: undefined,
          refreshFailures: [],
        });
        assert.strictEqual(h.clears(), 1);
        for (const [sender, input, code] of [
          [event("webview"), context, "policy_denied"],
          [event(), { ...context, hostId: "remote" }, "unsupported"],
          [event(), {}, "invalid_input"],
        ] as const) {
          const result = yield* clear(sender, input) as Effect.Effect<
            import("../../../shared/codex-plugin-management").PluginMutationResult,
            unknown
          >;
          assert.ok("error" in result);
          if ("error" in result) assert.strictEqual(result.error.code, code);
        }
        assert.strictEqual(h.clears(), 1);
      }),
    ),
);
it.effect("exposes unavailable capability and returns typed clearing failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const failure of ["failed", "unavailable"] as const) {
        const h = yield* make(failure);
        assert.deepEqual(yield* h.handlers.get("mcp-app:data:capabilities")!(event(), context), {
          available: failure !== "unavailable",
        });
        const result = yield* h.handlers.get("mcp-app:data:clear")!(
          event(),
          context,
        ) as Effect.Effect<
          import("../../../shared/codex-plugin-management").PluginMutationResult,
          unknown
        >;
        assert.strictEqual(result.status, "failed");
        if ("error" in result)
          assert.strictEqual(
            result.error.code,
            failure === "failed" ? "service_unavailable" : "unsupported",
          );
      }
    }),
  ),
);
