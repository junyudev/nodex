import { it, assert } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import { testLayer as configLayer } from "../../app/MainConfig";
import { PageFileHtmlRuntime } from "../../host-runtime/PageFileHtmlRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { live } from "./PageFileHtmlIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));
type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, Error>;
const event = (url = "http://localhost:5173", kind = "window", main = true): IpcMainInvokeEvent => {
  const frame = { url };
  return {
    sender: { id: 42, getType: () => kind, mainFrame: main ? frame : {} },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
};

it.effect("only the trusted owning application frame can admit and release a preview", () => {
  const handlers = new Map<string, Handler>();
  const calls: unknown[] = [];
  const dependencies = Layer.mergeAll(
    configLayer({ rendererUrl: "http://localhost:5173" }),
    Layer.succeed(
      ElectronIpc,
      makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.sync(() => {
            handlers.set(channel, handler as Handler);
          }),
        on: () => Effect.void,
      }),
    ),
    Layer.succeed(PageFileHtmlRuntime, {
      createHost: () => {
        throw new Error("Not used by IPC");
      },
      admit: (owner, input) =>
        Effect.sync(() => {
          calls.push([owner.id, input]);
          return { status: "refused", message: "File unavailable" } as const;
        }),
      release: (owner, grant) => {
        calls.push([owner.id, grant]);
        return true;
      },
    }),
  );
  return Effect.gen(function* () {
    const input = {
      routingContext: { kind: "library" },
      pageId: "page",
      fileId: "file",
      logicalPath: "report.html",
      colorScheme: "dark",
    };
    const admit = handlers.get("page-file-html:admit")!;
    const release = handlers.get("page-file-html:release")!;
    for (const sender of [
      event("https://untrusted.example"),
      event(undefined, "webview"),
      event(undefined, "window", false),
    ]) {
      assert.equal((yield* Effect.result(admit(sender, input)))._tag, "Failure");
      assert.equal(
        (yield* Effect.result(release(sender, { grant: "a".repeat(64) })))._tag,
        "Failure",
      );
    }
    assert.deepEqual(calls, []);
    assert.equal(
      (yield* Effect.result(
        admit(event(), { ...input, routingContext: { kind: "library", projectId: "forged" } }),
      ))._tag,
      "Failure",
    );
    // Only a light or dark scheme reaches the guest's media emulation.
    assert.equal(
      (yield* Effect.result(admit(event(), { ...input, colorScheme: "sepia" })))._tag,
      "Failure",
    );
    assert.equal((yield* Effect.result(release(event(), { grant: "invalid" })))._tag, "Failure");
    assert.deepEqual(yield* admit(event(), input), {
      status: "refused",
      message: "File unavailable",
    });
    assert.isTrue(yield* release(event(), { grant: "a".repeat(64) }));
    assert.deepEqual(calls, [
      [42, input],
      [42, "a".repeat(64)],
    ]);
  }).pipe(Effect.provide(live.pipe(Layer.provide(dependencies))), Effect.scoped);
});
