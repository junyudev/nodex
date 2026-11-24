import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import { expect, vi } from "vite-plus/test";
import { CHANGELOG_PAGE_URL, type ChangelogFeed } from "../../../shared/changelog-feed";
import { testLayer as testMainConfig } from "../../app/MainConfig";
import { ChangelogFeedRuntime } from "../../host-runtime/ChangelogFeedRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { live } from "./ChangelogFeedIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

function event(url: string, subframe = false): IpcMainInvokeEvent {
  const frame = { url };
  return {
    sender: { getType: () => "window", mainFrame: frame },
    senderFrame: subframe ? { ...frame } : frame,
  } as unknown as IpcMainInvokeEvent;
}

it.effect("reads the feed only for a trusted top-level renderer", () =>
  Effect.gen(function* () {
    type Handler = (event: IpcMainInvokeEvent) => Effect.Effect<unknown, unknown>;
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.sync(() => {
          handlers.set(channel, handler);
        }),
      on: () => Effect.void,
    });
    const feed: ChangelogFeed = { schemaVersion: 1, url: CHANGELOG_PAGE_URL, releases: [] };
    const read = vi.fn(() => feed);
    yield* Layer.build(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            testMainConfig(),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(ChangelogFeedRuntime, { read: Effect.sync(read) }),
          ),
        ),
      ),
    );

    const handler = handlers.get("app:changelog:read")!;
    const trustedUrl = "app://-/index.html";
    expect(Exit.isFailure(yield* Effect.exit(handler(event("https://untrusted.test"))))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(handler(event(trustedUrl, true))))).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(yield* handler(event(trustedUrl))).toEqual(feed);
  }),
);
