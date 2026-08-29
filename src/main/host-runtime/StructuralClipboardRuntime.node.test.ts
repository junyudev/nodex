import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import type { RendererClientEvent } from "../codex/renderer-client-runtime-contracts";

import {
  attachNodexStructuralClipboardWriteClaim,
  type NodexClipboardEnvelopeV1,
} from "../../shared/clipboard-paste";
import {
  ElectronClipboard,
  type ElectronClipboardPort,
} from "../platform/electron/ElectronClipboard";
import { RendererClientRuntime } from "./RendererClientRuntime";
import {
  live,
  STRUCTURAL_CLIPBOARD_REGISTRATION_GRACE_MS,
  STRUCTURAL_CLIPBOARD_SESSION_TIMEOUT_MS,
  StructuralClipboardRuntime,
} from "./StructuralClipboardRuntime";

const firstClaim = "0199134e-cbb0-7000-8000-000000000003";
const secondClaim = "0199134e-cbb0-7000-8000-000000000004";

const envelope = (actionHint: "copy" | "cut"): NodexClipboardEnvelopeV1 => ({
  version: 1,
  profileId: "profile-1",
  libraryId: "library-1",
  storeEpoch: "epoch-1",
  bundleId: "bundle-1",
  capability: "a".repeat(64),
  manifestHash: "b".repeat(64),
  actionHint,
});

const makeClipboard = (initialClaim = firstClaim) => {
  let html = attachNodexStructuralClipboardWriteClaim("<p>Portable</p>", initialClaim);
  let text = "Portable";
  let currentClaim: string | null = initialClaim;
  const port: ElectronClipboardPort = {
    availableFormats: () => ["text/html", "text/plain"],
    readFormat: () => "",
    readHtml: () => html,
    readText: () => text,
    readStructuralDescriptor: () => null,
    readStructuralWriteClaim: () => currentClaim,
    writePresentation: (next) => {
      html = next.html;
      text = next.text;
      currentClaim = null;
    },
    replaceClaimedPresentation: () => ({ ok: false, failure: "superseded" }),
    writeImage: () => undefined,
    createImageFromBuffer: () => {
      throw new Error("unused");
    },
    createImageFromDataUrl: () => {
      throw new Error("unused");
    },
  };
  return {
    port,
    setClaim: (claim: string | null) => {
      currentClaim = claim;
    },
  };
};

const rendererClientLayer = (events: RendererClientRuntime["Service"]["events"] = Stream.empty) =>
  Layer.succeed(
    RendererClientRuntime,
    RendererClientRuntime.of({
      register: () => {
        throw new Error("unused");
      },
      ensureClient: () => {
        throw new Error("unused");
      },
      getClientIdForWebContentsId: () => null,
      getWebContentsIdForClientId: () => null,
      getClientCount: () => 0,
      getPendingRequestCount: () => 0,
      sendToClient: () => false,
      sendToClients: () => ({
        sentClientIds: [],
        unavailableClientIds: [],
        failedClientIds: [],
      }),
      broadcast: () => 0,
      request: () => Effect.never,
      queryThreadRole: () => Effect.never,
      requireThreadOwner: () => Effect.never,
      handleResponse: () => Effect.succeed(false),
      disposeClient: () => Effect.void,
      events,
    }),
  );

const withRuntime = (
  clipboard: ElectronClipboardPort,
  events: RendererClientRuntime["Service"]["events"] = Stream.empty,
) =>
  live.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(ElectronClipboard, ElectronClipboard.of(clipboard)),
        rendererClientLayer(events),
      ),
    ),
  );

it.effect("connects a target waiter that arrives before source registration", () =>
  Effect.gen(function* () {
    const clipboard = makeClipboard();
    const context = yield* Layer.build(withRuntime(clipboard.port));
    const runtime = Context.get(context, StructuralClipboardRuntime);
    const waiting = yield* Effect.forkChild(runtime.awaitResolution({ writeClaim: firstClaim }));
    yield* Effect.yieldNow;

    assert.deepEqual(
      yield* runtime.begin(
        {
          writeClaim: firstClaim,
          actionHint: "copy",
          libraryId: "library-1",
          storeEpoch: "epoch-1",
        },
        "client-11",
      ),
      { ok: true },
    );
    assert.deepEqual(
      yield* runtime.publish(
        {
          envelope: envelope("copy"),
          writeClaim: firstClaim,
          html: "<p>Portable</p>",
          text: "Portable",
        },
        "client-11",
      ),
      { ok: true },
    );
    assert.deepEqual(yield* Fiber.join(waiting), {
      kind: "ready",
      envelope: envelope("copy"),
      disposition: "structural",
    });
  }).pipe(Effect.scoped),
);

it.effect("keeps cut pending until source commit settles and safely falls back to copy", () =>
  Effect.gen(function* () {
    const clipboard = makeClipboard();
    const context = yield* Layer.build(withRuntime(clipboard.port));
    const runtime = Context.get(context, StructuralClipboardRuntime);
    yield* runtime.begin(
      {
        writeClaim: firstClaim,
        actionHint: "cut",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
      },
      "client-12",
    );
    yield* runtime.publish(
      {
        envelope: envelope("cut"),
        writeClaim: firstClaim,
        html: "<p>Portable</p>",
        text: "Portable",
      },
      "client-12",
    );
    const waiting = yield* Effect.forkChild(runtime.awaitResolution({ writeClaim: firstClaim }));
    yield* Effect.yieldNow;
    assert.isUndefined(waiting.pollUnsafe());

    assert.deepEqual(
      yield* runtime.settle({ writeClaim: firstClaim, outcome: "source_preserved" }, "client-12"),
      { ok: true },
    );
    assert.deepEqual(yield* Fiber.join(waiting), {
      kind: "ready",
      envelope: envelope("cut"),
      disposition: "copy_fallback",
    });
  }).pipe(Effect.scoped),
);

it.effect("does not let a timeout infer that an in-flight source cut was preserved", () =>
  Effect.gen(function* () {
    const clipboard = makeClipboard();
    const context = yield* Layer.build(withRuntime(clipboard.port));
    const runtime = Context.get(context, StructuralClipboardRuntime);
    yield* runtime.begin(
      {
        writeClaim: firstClaim,
        actionHint: "cut",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
      },
      "client-15",
    );
    yield* runtime.publish(
      {
        envelope: envelope("cut"),
        writeClaim: firstClaim,
        html: "<p>Portable</p>",
        text: "Portable",
      },
      "client-15",
    );
    const waiting = yield* Effect.forkChild(runtime.awaitResolution({ writeClaim: firstClaim }));

    yield* TestClock.adjust(STRUCTURAL_CLIPBOARD_SESSION_TIMEOUT_MS);
    assert.isUndefined(waiting.pollUnsafe());
    yield* runtime.settle({ writeClaim: firstClaim, outcome: "cut_committed" }, "client-15");
    assert.deepEqual(yield* Fiber.join(waiting), {
      kind: "ready",
      envelope: envelope("cut"),
      disposition: "structural",
    });
  }).pipe(Effect.scoped),
);

it.effect("supersedes an older pending claim after the newer native claim passes CAS", () =>
  Effect.gen(function* () {
    const clipboard = makeClipboard();
    const context = yield* Layer.build(withRuntime(clipboard.port));
    const runtime = Context.get(context, StructuralClipboardRuntime);
    yield* runtime.begin(
      {
        writeClaim: firstClaim,
        actionHint: "copy",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
      },
      "client-11",
    );
    const waiting = yield* Effect.forkChild(runtime.awaitResolution({ writeClaim: firstClaim }));

    clipboard.setClaim(secondClaim);
    assert.deepEqual(
      yield* runtime.begin(
        {
          writeClaim: secondClaim,
          actionHint: "copy",
          libraryId: "library-1",
          storeEpoch: "epoch-1",
        },
        "client-12",
      ),
      { ok: true },
    );
    assert.deepEqual(
      yield* runtime.publish(
        {
          envelope: { ...envelope("copy"), bundleId: "bundle-2" },
          writeClaim: secondClaim,
          html: "<p>New portable value</p>",
          text: "New portable value",
        },
        "client-12",
      ),
      { ok: true },
    );
    assert.deepEqual(yield* Fiber.join(waiting), {
      kind: "portable_fallback",
      reason: "superseded",
    });

    assert.deepEqual(
      yield* runtime.begin(
        {
          writeClaim: firstClaim,
          actionHint: "copy",
          libraryId: "library-1",
          storeEpoch: "epoch-1",
        },
        "client-11",
      ),
      { ok: false, failure: "superseded" },
    );
  }).pipe(Effect.scoped),
);

it.effect("settles a preparing source when its renderer client is disposed", () =>
  Effect.gen(function* () {
    const clipboard = makeClipboard();
    const events = yield* PubSub.unbounded<RendererClientEvent>({ replay: 1 });
    const context = yield* Layer.build(withRuntime(clipboard.port, Stream.fromPubSub(events)));
    yield* Effect.yieldNow;
    const runtime = Context.get(context, StructuralClipboardRuntime);
    yield* runtime.begin(
      {
        writeClaim: firstClaim,
        actionHint: "copy",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
      },
      "client-13",
    );
    const waiter = yield* Effect.forkChild(runtime.awaitResolution({ writeClaim: firstClaim }));
    yield* PubSub.publish(events, {
      kind: "disposed",
      clientId: "client-13",
      webContentsId: 13,
      reason: "destroyed",
    });
    yield* Effect.yieldNow;
    assert.deepEqual(yield* Fiber.join(waiter), {
      kind: "portable_fallback",
      reason: "source_closed",
    });
  }).pipe(Effect.scoped),
);

it.effect("does not infer a committed cut when its source renderer is disposed", () =>
  Effect.gen(function* () {
    const clipboard = makeClipboard();
    const events = yield* PubSub.unbounded<RendererClientEvent>({ replay: 1 });
    const context = yield* Layer.build(withRuntime(clipboard.port, Stream.fromPubSub(events)));
    yield* Effect.yieldNow;
    const runtime = Context.get(context, StructuralClipboardRuntime);
    yield* runtime.begin(
      {
        writeClaim: firstClaim,
        actionHint: "cut",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
      },
      "client-14",
    );
    yield* runtime.publish(
      {
        envelope: envelope("cut"),
        writeClaim: firstClaim,
        html: "<p>Portable</p>",
        text: "Portable",
      },
      "client-14",
    );
    const waiter = yield* Effect.forkChild(runtime.awaitResolution({ writeClaim: firstClaim }));
    yield* PubSub.publish(events, {
      kind: "disposed",
      clientId: "client-14",
      webContentsId: 14,
      reason: "destroyed",
    });
    yield* Effect.yieldNow;
    assert.deepEqual(yield* Fiber.join(waiter), {
      kind: "portable_fallback",
      reason: "source_closed",
    });
  }).pipe(Effect.scoped),
);

it.effect("bounds an unregistered waiter with the Effect clock", () =>
  Effect.gen(function* () {
    const clipboard = makeClipboard();
    const context = yield* Layer.build(withRuntime(clipboard.port));
    const runtime = Context.get(context, StructuralClipboardRuntime);
    const waiting = yield* Effect.forkChild(runtime.awaitResolution({ writeClaim: firstClaim }));
    yield* TestClock.adjust(STRUCTURAL_CLIPBOARD_REGISTRATION_GRACE_MS - 1);
    assert.isUndefined(waiting.pollUnsafe());
    yield* TestClock.adjust(1);
    assert.deepEqual(yield* Fiber.join(waiting), {
      kind: "portable_fallback",
      reason: "timeout",
    });
  }).pipe(Effect.scoped),
);
