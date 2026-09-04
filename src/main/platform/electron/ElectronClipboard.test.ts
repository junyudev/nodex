import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { NativeImage } from "electron";
import { it } from "@effect/vitest";
import { attachNodexStructuralClipboardWriteClaim } from "../../../shared/clipboard-paste";
import { makeElectronClipboardPort } from "./ElectronClipboard";

const writeClaim = "0199134e-cbb0-7000-8000-000000000003";
const pendingPromise = () => {
  let resolve!: () => void;
  // oxlint-disable-next-line effecttsgo/new-promise -- Models Electron's native Promise so the adapter must observe its actual completion.
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
const makeTarget = (overrides: Partial<Parameters<typeof makeElectronClipboardPort>[0]> = {}) => {
  let html = attachNodexStructuralClipboardWriteClaim("<p>Portable</p>", writeClaim);
  let text = "Portable";
  const port = makeElectronClipboardPort({
    nativeImage: {
      createFromBuffer: () => {
        throw new Error("unused");
      },
      createFromDataURL: () => {
        throw new Error("unused");
      },
    },
    writeText: () => Promise.resolve(),
    writePng: () => Promise.resolve(),
    native: {
      read: () => ({ generation: 1, html, text, fileUrls: [] }),
      update: (_generation, nextText, nextHtml) => {
        text = nextText;
        if (nextHtml !== undefined) html = nextHtml;
        return "written";
      },
    },
    ...overrides,
  });
  return { port, read: () => ({ html, text }) };
};

describe("Electron clipboard adapter", () => {
  it.effect("waits for the native PNG commit before reporting success", () =>
    Effect.gen(function* () {
      const entered = pendingPromise();
      const committed = pendingPromise();
      let completed = false;
      const { port } = makeTarget({
        writePng: (bytes) => {
          expect([...bytes]).toEqual([1, 2, 3]);
          entered.resolve();
          return committed.promise;
        },
      });
      const image = { isEmpty: () => false, toPNG: () => Buffer.from([1, 2, 3]) } as NativeImage;
      const fiber = yield* port.writeImage(image).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.promise(() => entered.promise);
      expect(completed).toBe(false);
      committed.resolve();
      yield* Fiber.join(fiber);
      expect(completed).toBe(true);
    }),
  );
  it.effect("rejects oversized text before invoking the native writer", () =>
    Effect.gen(function* () {
      let written = false;
      const { port } = makeTarget({
        writeText: () => {
          written = true;
          return Promise.resolve();
        },
      });
      expect(
        yield* port.writeText("x".repeat(8 * 1024 * 1024 + 1)).pipe(Effect.flip),
      ).toMatchObject({ reason: "too_large" });
      expect(written).toBe(false);
    }),
  );
  it.effect("fails the entire native read when the generation changes", () =>
    Effect.gen(function* () {
      const { port } = makeTarget({
        native: {
          read: () => {
            throw Object.assign(new Error("inconsistent_read"), { code: "inconsistent_read" });
          },
          update: () => "written",
        },
      });
      expect(yield* port.readPaste.pipe(Effect.flip)).toMatchObject({
        reason: "inconsistent_read",
      });
    }),
  );
  it.effect("enhances plain text without changing the claimed rich presentation", () =>
    Effect.gen(function* () {
      const { port, read } = makeTarget();
      const originalHtml = read().html;
      expect(
        yield* port.replaceClaimedPresentation({ writeClaim, text: "/resolved/file" }),
      ).toEqual({ ok: true });
      expect(read()).toEqual({ html: originalHtml, text: "/resolved/file" });
    }),
  );
  it.effect("reads the pending claim from the same rich presentation", () =>
    Effect.gen(function* () {
      const { port } = makeTarget();
      expect(yield* port.readPaste).toMatchObject({
        text: "Portable",
        structuralWriteClaim: writeClaim,
      });
    }),
  );
  it.effect("replaces only the currently claimed presentation", () =>
    Effect.gen(function* () {
      const { port, read } = makeTarget();
      expect(
        yield* port.replaceClaimedPresentation({
          writeClaim,
          html: "<p>Portable</p>",
          text: "/profile/assets/a.blob",
        }),
      ).toEqual({ ok: true });
      expect(read()).toEqual({ html: "<p>Portable</p>", text: "/profile/assets/a.blob" });
      expect(
        yield* port.replaceClaimedPresentation({ writeClaim, html: "<p>Older</p>", text: "Older" }),
      ).toEqual({ ok: false, failure: "superseded" });
    }),
  );
});
