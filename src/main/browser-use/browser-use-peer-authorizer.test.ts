import { describe, expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  createBrowserUsePeerAuthorizer,
  makeWindowsBrowserPeerAuthorizer,
} from "./browser-use-peer-authorizer";

describe("createBrowserUsePeerAuthorizer", () => {
  test("allows the explicit disabled policy without loading an addon", () => {
    const authorize = createBrowserUsePeerAuthorizer({
      addonPath: null,
      mode: "disabled",
      platform: "darwin",
    });

    expect(authorize({} as never)).toEqual({ authorized: true });
  });

  test("fails closed when packaged authorization has no addon", () => {
    const authorize = createBrowserUsePeerAuthorizer({
      addonPath: null,
      mode: "packaged",
      platform: "darwin",
    });

    expect(authorize({} as never)).toEqual({
      authorized: false,
      reason: "peer-authorization-addon-unavailable",
    });
  });

  test("does not infer a bypass from development peer verification", () => {
    const authorize = createBrowserUsePeerAuthorizer({
      addonPath: null,
      mode: "development",
      platform: "darwin",
    });

    expect(authorize({} as never)).toEqual({
      authorized: false,
      reason: "peer-authorization-addon-unavailable",
    });
  });
});

it.effect("admits a verified Windows image only in the owning Profile's process tree", () =>
  Effect.gen(function* () {
    const host = { pid: 10, creationTime: "100", imagePath: "C:/Nodex/Nodex.exe" };
    const launcher = { pid: 11, creationTime: "110", imagePath: "C:/Nodex/nodex-core.exe" };
    const repl = { pid: 12, creationTime: "120", imagePath: "C:/Bundle/node_repl.exe" };
    const node = { pid: 13, creationTime: "130", imagePath: "c:/bundle/node.exe" };
    const options = {
      host,
      launcher: launcher.imagePath,
      repl: repl.imagePath,
      node: "C:/Bundle/node.exe",
      native: { ancestors: () => Effect.succeed([repl, launcher, host]) },
    };
    const authorize = makeWindowsBrowserPeerAuthorizer({ ...options, mode: "packaged" });
    expect(yield* authorize(node)).toEqual({ authorized: true });
    expect(yield* authorize({ ...node, imagePath: "C:/Other/node.exe" })).toMatchObject({
      authorized: false,
      reason: "unverified-peer-image",
    });
    const other = makeWindowsBrowserPeerAuthorizer({
      ...options,
      host: { ...host, creationTime: "900" },
      mode: "packaged",
    });
    expect(yield* other(node)).toMatchObject({
      authorized: false,
      reason: "peer-outside-desktop-tool-launch",
    });
    const detached = { ...options, native: { ancestors: () => Effect.succeed([]) } };
    const strict = makeWindowsBrowserPeerAuthorizer({ ...detached, mode: "packaged" });
    const development = makeWindowsBrowserPeerAuthorizer({ ...detached, mode: "development" });
    expect(yield* strict(repl)).toMatchObject({ authorized: false });
    expect(yield* development(repl)).toMatchObject({ authorized: true });
  }),
);
