import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import {
  corpusStreamChunks,
  RUNTIME_CORPORA,
} from "../../../scripts/scenarios/runtime/corpora/runtime-corpora";
import {
  mergeRuntimeWork,
  runtimeWorkTotal,
  type RuntimeWorkReading,
} from "../../shared/diagnostics/runtime-work";
import {
  conversationWorkHarness,
  counts,
  eventually,
  FIRST_CONTENT_ROUND_TRIPS,
  navigationRecords,
  OPEN_MAIN_WORK,
  OPEN_RENDERER_REQUESTS,
  openConversation,
  recorded,
  transcriptReplies,
} from "./AgentRuntimeConversationWork.test-support";
import { windowRuntimeWorkId } from "./AgentRuntimeWork";

/** Today's snapshot of runtime-short, and the patches of one dual-window reply to one window. */
const SHORT_SNAPSHOT_BYTES = 43_538;
const DUAL_WINDOW_STREAM_BYTES = 2_006;

it.live(
  "runtime-short: opening and switching back to a conversation does today's fixed work at each boundary",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const corpus = RUNTIME_CORPORA["runtime-short"];
        const harness = yield* conversationWorkHarness(corpus);
        const before = navigationRecords().length;

        const cold = yield* openConversation(harness, 1, corpus.turns.length);
        const coldMain = harness.mainWork.read(cold.mainWorkId);
        const coldRenderer = harness.rendererWork.read(cold.workId);
        console.info(
          JSON.stringify({
            corpus: corpus.id,
            cold: {
              main: counts(coldMain),
              renderer: counts(coldRenderer),
              snapshotBytes: coldMain["runtime.reply:thread.snapshot"]?.bytes,
              snapshotRows: coldMain["runtime.reply:thread.snapshot"]?.rows,
            },
          }),
        );
        cold.close();

        const back = yield* openConversation(harness, 1, corpus.turns.length);
        const backMain = harness.mainWork.read(back.mainWorkId);
        const backRenderer = harness.rendererWork.read(back.workId);
        back.close();

        // The snapshot read alone, as the serial path to first content.
        const probe = harness.mainWork;
        yield* Effect.promise(() =>
          harness.invoke(1, "agent-runtime:session:read", { ...harness.target, workId: "probe" }),
        );
        const probeReading = probe.read(windowRuntimeWorkId(1, "probe"));
        const roundTrips =
          1 +
          runtimeWorkTotal(probeReading, "core.read:").count +
          runtimeWorkTotal(probeReading, "runtime.request:").count;
        console.info(
          JSON.stringify({
            back: { main: counts(backMain), renderer: counts(backRenderer) },
            probe: counts(probeReading),
            roundTrips,
          }),
        );

        const records = navigationRecords().slice(before);
        expect(records.map(({ cohort, outcome, reason }) => ({ cohort, outcome, reason }))).toEqual(
          [
            { cohort: "cold", outcome: "success", reason: "content_visible" },
            { cohort: "warm", outcome: "success", reason: "content_visible" },
          ],
        );
        for (const record of records)
          expect(Object.keys(record.stages)).toEqual(
            expect.arrayContaining([
              "navigation_dispatched",
              "route_entered",
              "snapshot_requested",
              "snapshot_received",
              "projection_installed",
              "content_committed",
            ]),
          );

        // Each settled Turn installs its prompt, its reply and its checkpoint.
        expect(coldMain["runtime.reply:thread.snapshot"]?.rows).toBe(corpus.turns.length * 3);
        expect(coldMain["runtime.reply:thread.snapshot"]?.bytes).toBeLessThanOrEqual(
          SHORT_SNAPSHOT_BYTES,
        );
        for (const [main, renderer] of [
          [coldMain, coldRenderer],
          [backMain, backRenderer],
        ] as const) {
          expect(recorded(renderer, OPEN_RENDERER_REQUESTS)).toEqual(OPEN_RENDERER_REQUESTS);
          expect(recorded(main, OPEN_MAIN_WORK)).toEqual(OPEN_MAIN_WORK);
          expect(renderer["renderer.install"]).toEqual({
            count: 1,
            bytes: 0,
            rows: corpus.turns.length * 3,
          });
        }
        // An owner this harness disposed keeps nothing, so opening it again reads it again. A
        // window's own conversations stay warm after they leave; see the conversation registry.
        expect(counts(backMain)).toEqual(counts(coldMain));
        expect(roundTrips).toBe(FIRST_CONTENT_ROUND_TRIPS);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "dual-window: each window observes the same conversation and receives every streamed byte again",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const corpus = RUNTIME_CORPORA["dual-window"];
        const stream = corpus.stream!;
        const harness = yield* conversationWorkHarness(corpus);
        const windows = [
          yield* openConversation(harness, 1, corpus.turns.length),
          yield* openConversation(harness, 2, corpus.turns.length),
        ];
        const opened = windows.map(({ mainWorkId }) => harness.mainWork.read(mainWorkId));

        yield* harness.startStream;
        let streamed = "Stream baseline\n\n";
        const showsStream = () =>
          windows.every(({ owner }) => transcriptReplies(owner).includes(streamed));
        const replyTails = () =>
          windows.map(({ owner }) => transcriptReplies(owner).at(-1)?.slice(-80) ?? null);
        yield* eventually("both windows to show the stream's baseline", showsStream, replyTails);
        const atStart = windows.map(({ mainWorkId }) => harness.mainWork.read(mainWorkId));
        const rendererAtStart = windows.map(({ workId }) => harness.rendererWork.read(workId));
        for (const chunk of corpusStreamChunks(stream, stream.items[0]!)) {
          streamed += chunk;
          yield* harness.streamChunk(chunk);
          yield* eventually("both windows to show every streamed chunk", showsStream, replyTails);
        }
        const main = windows.map(({ mainWorkId }) => harness.mainWork.read(mainWorkId));
        const renderer = windows.map(({ workId }) => harness.rendererWork.read(workId));
        // Totals by boundary, whatever shape the protocol's frames take.
        const delta = (after: RuntimeWorkReading, before: RuntimeWorkReading, prefix: string) => {
          const [next, previous] = [after, before].map((reading) =>
            runtimeWorkTotal(reading, prefix),
          );
          return { count: next!.count - previous!.count, bytes: next!.bytes - previous!.bytes };
        };
        const perWindow = windows.map((_, index) => ({
          runtimeToMain: delta(main[index]!, atStart[index]!, "runtime.event:"),
          deliveries: delta(main[index]!, atStart[index]!, "renderer.delivery:"),
          leaves: delta(renderer[index]!, rendererAtStart[index]!, "renderer.leaf"),
          events: delta(renderer[index]!, rendererAtStart[index]!, "renderer.event:"),
        }));
        const allObserves = mergeRuntimeWork(opened)["runtime.request:events.observe"]?.count;
        console.info(
          JSON.stringify({
            corpus: corpus.id,
            observes: allObserves,
            perWindow,
            streamedBytes: Buffer.byteLength(streamed),
          }),
        );
        yield* harness.completeStream;
        for (const window of windows) window.close();

        // Each window holds its own upstream observation of the one Thread.
        expect(allObserves).toBe(corpus.observers);
        // Every paragraph reaches each window once, as the whole reply so far.
        for (const window of perWindow) {
          expect(window.runtimeToMain.count).toBe(
            corpusStreamChunks(stream, stream.items[0]!).length,
          );
          expect(window.runtimeToMain.bytes).toBeLessThanOrEqual(DUAL_WINDOW_STREAM_BYTES);
          expect(window.deliveries.count).toBe(window.runtimeToMain.count);
          expect(window.events.count).toBe(window.runtimeToMain.count);
          // Only the streamed reply's own leaf changes; its siblings stay untouched.
          expect(window.leaves.count).toBe(window.runtimeToMain.count);
        }
        // Runtime → Main bytes scale with the number of windows.
        expect(perWindow[1]!.runtimeToMain.bytes).toBe(perWindow[0]!.runtimeToMain.bytes);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
