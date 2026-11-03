import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import {
  ApplicationHostRuntime,
  type ApplicationHostNativePort,
  live,
} from "./ApplicationHostRuntime";

const makeNative = (): ApplicationHostNativePort => ({
  askForMicrophoneAccess: vi.fn(async () => true),
  getMicrophoneAccessStatus: vi.fn(() => "not-determined"),
  setDevelopmentDockIcon: vi.fn(),
  setDefaultProtocolClient: vi.fn(),
});

const build = (
  native: ApplicationHostNativePort,
  overrides: Parameters<typeof mainConfigLayer>[0],
) => Layer.build(live(native).pipe(Layer.provide(mainConfigLayer(overrides))));

describe("ApplicationHostRuntime", () => {
  it.effect("registers the development protocol handler from immutable Main config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = makeNative();
        const context = yield* build(native, {
          argv: ["electron", "./entry.js"],
          isDefaultApp: true,
          platform: "win32",
          runtimeBinaryPath: "/runtime/electron",
        });
        Context.get(context, ApplicationHostRuntime);

        expect(native.setDefaultProtocolClient).toHaveBeenCalledWith("nodex", "/runtime/electron", [
          expect.stringMatching(/entry\.js$/),
        ]);
        expect(native.setDevelopmentDockIcon).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("leaves packaged Windows protocol registration with the installer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = makeNative();
        yield* build(native, { platform: "win32", isPackaged: true });

        expect(native.setDefaultProtocolClient).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("requests macOS microphone access through the scoped host capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = makeNative();
        const context = yield* build(native, {
          platform: "darwin",
          projectRootPath: "/workspace/nodex",
        });
        const host = Context.get(context, ApplicationHostRuntime);
        yield* host.requestMicrophonePermission;

        expect(native.setDevelopmentDockIcon).toHaveBeenCalledWith(
          join("/workspace/nodex", "resources", "icon.png"),
        );
        expect(native.askForMicrophoneAccess).toHaveBeenCalledOnce();
      }),
    ),
  );
});
